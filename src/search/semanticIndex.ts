// The semantic index: embeds every row's chunks (through the cache), keeps ONE raw
// Float32Array matrix over the chunks and answers queries with brute-force mean-centred
// cosine similarity. Centring happens algebraically at query time —
//   score(c) = (qc · v_c − qc · μ) / ‖v_c − μ‖   with   qc = normalize(q − μ)
// — which equals normalising centred copies up front but keeps a single copy of the matrix
// and lets μ evolve while indexing. Vectors arrive progressively (a precomputed snapshot
// first, then the cache, then the embedder: background sentences before anything, then the
// longest texts first), so `search(q, { partial: true })` answers over the chunks embedded so
// far and `coverage` tells how much of the index that is. At data dictionary scale (thousands
// of chunks × a few hundred dimensions) a query is a few milliseconds, so no
// approximate-nearest-neighbour structure is needed.

import type { DataDictionaryTable } from "../types";
import type { Embedder, SemanticHit, SemanticIndex, SemanticSearchQuery, SemanticStatus, VectorCache } from "./types";
import type { VectorSnapshot, VectorSnapshotSource } from "./snapshot";
import { EMBED_TEXT_VERSION, prepareTexts } from "./text";
import { cacheKey, createDefaultVectorCache, createMemoryVectorCache, textKey } from "./cache";
import { loadVectorSnapshot } from "./snapshot";
import { truncateAndNormalize } from "./pooling";
import { createLru } from "./lru";

export interface SemanticIndexOptions {
  embedder: Embedder;
  /** `undefined` -> IndexedDB when available; `false` -> memory only. */
  cache?: VectorCache | false | undefined;
  /** Texts per `embed()` call while indexing. Default: 16. */
  batchSize?: number | undefined;
  /**
   * Keep only the first `dims` components of every document and query vector (Matryoshka
   * models) and renormalise. Part of the cache namespace.
   */
  dims?: number | undefined;
  /** Fresh vectors are written to the cache every `flushEvery` vectors (and at the end). Default: 2000. */
  flushEvery?: number | undefined;
  /**
   * Precomputed vectors for this dictionary: a `.jsddvec` snapshot as bytes, a decoded
   * `VectorSnapshot`, or a URL to fetch. Texts found in it (by content key) are never sent
   * to the embedder; a snapshot from another embedding space, text-template version or with
   * too few dimensions is ignored with a `console.warn`, as is a failed load.
   */
  snapshot?: VectorSnapshotSource | undefined;
}

/** Default floor on the mean-centred cosine score (see {@link SemanticHit}). */
export const DEFAULT_MIN_SCORE = 0.25;

const QUERY_VECTOR_CACHE = 64;

export function createSemanticIndex(table: DataDictionaryTable, options: SemanticIndexOptions): SemanticIndex {
  const { embedder } = options;
  const cache: VectorCache = options.cache === false ? createMemoryVectorCache() : (options.cache ?? createDefaultVectorCache());
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 16));
  const flushEvery = Math.max(1, Math.floor(options.flushEvery ?? 2000));
  const dims = options.dims !== undefined && options.dims > 0 ? Math.floor(options.dims) : undefined;
  const listeners = new Set<(status: SemanticStatus) => void>();
  const queryVectors = createLru<string, Promise<Float32Array>>(QUERY_VECTOR_CACHE);

  let status: SemanticStatus = { state: "loading", progress: undefined };
  let disposed = false;
  let loadedDone = false;

  // Chunks and texts (fixed once loaded).
  const rowCount = table.rows.length;
  let chunkRow: number[] = [];
  let chunkCount = 0;
  let textChunks: number[][] = [];
  let filled = new Uint8Array(0);
  let textFilled = new Uint8Array(0);
  let filledChunks = 0;

  // Vectors: one raw matrix, a running sum for the mean, lazily refreshed μ and per-chunk norms.
  let dim = 0;
  let matrix: Float32Array | undefined;
  let sum: Float64Array | undefined;
  let sumCount = 0;
  let meanVersion = 0;
  let mu: Float64Array | undefined;
  let muVersion = -1;
  let norms: Float32Array | undefined;
  let normsVersion = -1;

  // Query scratch (rows), reused across searches.
  const rowBest = new Float64Array(rowCount);
  const rowSeen = new Uint8Array(rowCount);
  const rowsTouched = new Int32Array(rowCount);

  const disposedError = (): Error => new Error("Semantic index disposed");

  const setStatus = (next: SemanticStatus): void => {
    if (disposed) return;
    status = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* a listener must not break indexing */
      }
    }
  };

  const coverage = (): number => {
    if (!loadedDone) return 0;
    return chunkCount === 0 ? 1 : filledChunks / chunkCount;
  };

  /** Truncate to `dims` (when set) and renormalise. */
  const prepareVector = (v: Float32Array): Float32Array => {
    if (dims === undefined || v.length <= dims) return v;
    const t = v.slice(0, dims);
    let s = 0;
    for (let k = 0; k < t.length; k += 1) s += (t[k] as number) * (t[k] as number);
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let k = 0; k < t.length; k += 1) t[k] = (t[k] as number) * inv;
    return t;
  };

  const ensureDim = (v: Float32Array): void => {
    if (dim === 0) {
      if (v.length === 0) throw new Error("Embedder returned empty vectors");
      dim = v.length;
      matrix = new Float32Array(chunkCount * dim);
      sum = new Float64Array(dim);
    } else if (v.length !== dim) {
      throw new Error("Embedding dimension mismatch — Embedder.id must be unique per model configuration");
    }
  };

  /** Write one unique text's vector into every chunk that uses it and fold it into the mean. */
  const fillText = (t: number, v: Float32Array): void => {
    if (textFilled[t] === 1 || !matrix || !sum) return;
    textFilled[t] = 1;
    for (let k = 0; k < dim; k += 1) sum[k] = (sum[k] as number) + (v[k] as number);
    sumCount += 1;
    for (const ci of textChunks[t] ?? []) {
      matrix.set(v, ci * dim);
      filled[ci] = 1;
      filledChunks += 1;
    }
    meanVersion += 1;
  };

  let resolveLoaded: () => void = () => {};
  let rejectLoaded: (err: Error) => void = () => {};
  const loaded = new Promise<void>((resolve, reject) => {
    resolveLoaded = resolve;
    rejectLoaded = reject;
  });
  loaded.catch(() => {
    /* consumers observe `status`; avoid unhandled rejections */
  });

  async function build(): Promise<void> {
    setStatus({ state: "loading", progress: undefined });
    if (embedder.load) await embedder.load((f) => setStatus({ state: "loading", progress: clamp01(f) }));
    if (disposed) throw disposedError();

    const prepared = prepareTexts(table);
    const { uniqueTexts, backgroundCount } = prepared;
    const total = uniqueTexts.length;
    chunkRow = prepared.chunkRow;
    chunkCount = chunkRow.length;
    textChunks = Array.from({ length: total }, () => []);
    prepared.chunkText.forEach((t, ci) => (textChunks[t] as number[]).push(ci));
    filled = new Uint8Array(chunkCount);
    textFilled = new Uint8Array(total);

    // Precision-independent namespace: q8/fp16/fp32 vectors of one model are interchangeable.
    const spaceId = embedder.spaceId ?? embedder.id;
    const space = `${spaceId}${dims !== undefined ? `|d${dims}` : ""}`;
    const keys = uniqueTexts.map((t) => cacheKey(space, t));

    // Precomputed vectors first: texts found in the snapshot (by content key) never reach the
    // cache or the embedder. Larger vectors are truncated to the wanted size and renormalised.
    if (options.snapshot !== undefined) {
      try {
        const snap = await loadVectorSnapshot(options.snapshot);
        if (disposed) throw disposedError();
        const wanted = dims ?? embedder.info?.dims;
        const problem = snapshotProblem(snap, spaceId, wanted);
        if (problem) {
          console.warn(`[json-schema-data-dictionary] Ignoring the vector snapshot: ${problem}.`);
        } else {
          const at = new Map<string, number>();
          snap.keys.forEach((k, i) => at.set(k, i));
          const width = wanted !== undefined && snap.dims > wanted ? wanted : snap.dims;
          for (let t = 0; t < total; t += 1) {
            const i = at.get(textKey(uniqueTexts[t] as string));
            if (i === undefined) continue;
            const row = snap.matrix.subarray(i * snap.dims, (i + 1) * snap.dims);
            const v = width < snap.dims ? truncateAndNormalize(row, width) : row;
            ensureDim(v);
            fillText(t, v);
          }
        }
      } catch (err) {
        if (disposed) throw err;
        console.warn(`[json-schema-data-dictionary] Could not use the vector snapshot: ${errorMessage(err)}`);
      }
    }

    let cached = new Map<string, Float32Array>();
    try {
      const unfilled = keys.filter((_, t) => textFilled[t] === 0);
      if (unfilled.length > 0) cached = await cache.getMany(unfilled);
    } catch {
      /* persistence is best-effort */
    }
    if (disposed) throw disposedError();

    const missing: number[] = [];
    for (let t = 0; t < total; t += 1) {
      if (textFilled[t] === 1) continue; // served by the snapshot
      const raw = cached.get(keys[t] as string);
      const v = raw ? prepareVector(raw) : undefined;
      // A cached vector of another size is a stale entry: re-embed rather than fail.
      if (v && v.length > 0 && (dim === 0 || v.length === dim)) {
        ensureDim(v);
        fillText(t, v);
      } else {
        missing.push(t);
      }
    }
    loadedDone = true;
    setStatus({ state: "indexing", done: sumCount, total, coverage: coverage() });
    resolveLoaded();

    // Background sentences first (they anchor the mean), then the longest texts first: batches
    // of similar length waste the least padding.
    const byLengthDesc = (a: number, b: number): number => (uniqueTexts[b] as string).length - (uniqueTexts[a] as string).length || a - b;
    const order = [
      ...missing.filter((t) => t < backgroundCount).sort(byLengthDesc),
      ...missing.filter((t) => t >= backgroundCount).sort(byLengthDesc)
    ];

    let fresh: Array<readonly [string, Float32Array]> = [];
    const flush = async (): Promise<void> => {
      const batch = fresh;
      fresh = [];
      if (batch.length === 0) return;
      try {
        await cache.putMany(batch);
      } catch {
        /* best-effort */
      }
    };

    for (let i = 0; i < order.length; i += batchSize) {
      if (disposed) throw disposedError();
      const batch = order.slice(i, i + batchSize);
      const out = await embedder.embed(
        batch.map((t) => uniqueTexts[t] as string),
        "document"
      );
      if (disposed) throw disposedError();
      if (out.length !== batch.length) throw new Error(`Embedder returned ${out.length} vectors for ${batch.length} texts`);
      batch.forEach((t, k) => {
        const v = prepareVector(out[k] as Float32Array);
        ensureDim(v);
        fillText(t, v);
        fresh.push([keys[t] as string, v]);
      });
      setStatus({ state: "indexing", done: sumCount, total, coverage: coverage() });
      // Progress survives a closed tab: persist every `flushEvery` fresh vectors.
      if (fresh.length >= flushEvery) await flush();
      await yieldToEventLoop();
    }
    if (disposed) throw disposedError();
    if (total > 0 && dim === 0) throw new Error("Embedder returned empty vectors");

    await flush();
    // The cache holds one dictionary at a time: vectors of previously indexed schemas (or of an
    // older text template / embedder) are deleted so storage does not grow without bound.
    // Re-indexing the same dictionary yields the same keys, so nothing is lost or re-embedded.
    if (disposed) throw disposedError();
    if (cache.retainOnly) {
      try {
        await cache.retainOnly(keys);
      } catch {
        /* best-effort */
      }
    }
    setStatus({ state: "ready" });
  }

  let rejectReady: ((err: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    build().then(resolve, (err: unknown) => {
      if (!disposed) setStatus({ state: "error", message: errorMessage(err) });
      const error = err instanceof Error ? err : new Error(errorMessage(err));
      rejectLoaded(error);
      reject(error);
    });
  });
  ready.catch(() => {
    /* consumers observe `status`; avoid unhandled rejections */
  });

  /** Query vectors go through a small LRU so retyping a query never re-embeds it. */
  const queryVector = (q: string): Promise<Float32Array> => {
    const hit = queryVectors.get(q);
    if (hit) return hit;
    const p = embedder.embed([q], "query").then((out) => {
      const v = out[0];
      if (!v) throw new Error("Embedder returned no query vector");
      return prepareVector(v);
    });
    queryVectors.set(q, p);
    p.catch(() => queryVectors.delete(q));
    return p;
  };

  /** μ and the per-chunk ‖v − μ‖ for the current mean (recomputed only when μ changed). */
  const refreshMean = (m: Float32Array): void => {
    if (!mu || muVersion !== meanVersion) {
      mu = new Float64Array(dim);
      const s = sum as Float64Array;
      for (let k = 0; k < dim; k += 1) mu[k] = (s[k] as number) / sumCount;
      muVersion = meanVersion;
    }
    if (!norms || normsVersion !== meanVersion) {
      const n = norms ?? new Float32Array(chunkCount);
      for (let ci = 0; ci < chunkCount; ci += 1) {
        if (filled[ci] === 0) continue;
        const off = ci * dim;
        let acc = 0;
        for (let k = 0; k < dim; k += 1) {
          const x = (m[off + k] as number) - (mu[k] as number);
          acc += x * x;
        }
        n[ci] = Math.sqrt(acc);
      }
      norms = n;
      normsVersion = meanVersion;
    }
  };

  async function search(query: string, opts: SemanticSearchQuery = {}): Promise<SemanticHit[]> {
    if (disposed) throw disposedError();
    if (opts.partial) {
      await loaded;
      if (status.state === "error") throw new Error(status.message);
    } else {
      await ready;
    }
    if (disposed) throw disposedError();
    const q = query.trim();
    if (!q || chunkCount === 0 || filledChunks === 0 || dim === 0) return [];

    const qv = await queryVector(q);
    if (disposed) throw disposedError();
    const m = matrix;
    if (!m || filledChunks === 0) return [];
    if (qv.length !== dim) throw new Error("Query embedding dimension mismatch");
    refreshMean(m);
    const centre = mu as Float64Array;
    const chunkNorm = norms as Float32Array;

    // qc = normalize(q − μ); score(c) = (qc · v_c − qc · μ) / ‖v_c − μ‖.
    const qc = new Float64Array(dim);
    let qn = 0;
    for (let k = 0; k < dim; k += 1) {
      const x = (qv[k] as number) - (centre[k] as number);
      qc[k] = x;
      qn += x * x;
    }
    if (qn === 0) return [];
    qn = Math.sqrt(qn);
    let qmu = 0;
    for (let k = 0; k < dim; k += 1) {
      qc[k] = (qc[k] as number) / qn;
      qmu += (qc[k] as number) * (centre[k] as number);
    }

    let touched = 0;
    for (let ci = 0; ci < chunkCount; ci += 1) {
      if (filled[ci] === 0) continue;
      const nrm = chunkNorm[ci] as number;
      if (nrm === 0) continue;
      const off = ci * dim;
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += (qc[k] as number) * (m[off + k] as number);
      const score = (dot - qmu) / nrm;
      const row = chunkRow[ci] as number;
      if (rowSeen[row] === 0) {
        rowSeen[row] = 1;
        rowsTouched[touched++] = row;
        rowBest[row] = score;
      } else if (score > (rowBest[row] as number)) {
        rowBest[row] = score;
      }
    }

    const floor = opts.minScore ?? embedder.minScore ?? DEFAULT_MIN_SCORE;
    const hits: SemanticHit[] = [];
    for (let i = 0; i < touched; i += 1) {
      const row = rowsTouched[i] as number;
      const score = rowBest[row] as number;
      rowSeen[row] = 0;
      if (score >= floor) hits.push({ row, score });
    }
    hits.sort((a, b) => b.score - a.score || a.row - b.row);
    return opts.limit === undefined ? hits : hits.slice(0, Math.max(0, opts.limit));
  }

  return {
    ready,
    loaded,
    get status() {
      return status;
    },
    get size() {
      return chunkCount;
    },
    get coverage() {
      return coverage();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search,
    dispose() {
      if (disposed) return;
      disposed = true;
      matrix = undefined;
      sum = undefined;
      mu = undefined;
      norms = undefined;
      listeners.clear();
      queryVectors.clear();
      const error = disposedError();
      rejectLoaded(error);
      rejectReady?.(error);
    }
  };
}

/** Why a snapshot cannot serve this index (undefined when it can). */
function snapshotProblem(snap: VectorSnapshot, spaceId: string, wanted: number | undefined): string | undefined {
  if (snap.version !== 1) return `unsupported version ${String(snap.version)}`;
  if (snap.textVersion !== EMBED_TEXT_VERSION) return `it was built with text template v${snap.textVersion} (this build uses v${EMBED_TEXT_VERSION})`;
  if (snap.spaceId !== spaceId) return `it belongs to embedding space "${snap.spaceId}" (this index uses "${spaceId}")`;
  if (wanted !== undefined && snap.dims < wanted) return `it holds ${snap.dims}-d vectors (this index needs ${wanted}-d)`;
  return undefined;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
