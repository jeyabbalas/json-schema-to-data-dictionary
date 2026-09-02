// The semantic index: embeds every row's chunks (through the cache), keeps one flat
// Float32Array matrix, and answers queries with brute-force cosine similarity. At data
// dictionary scale (thousands of chunks × a few hundred dimensions) that is a few
// milliseconds, so no approximate-nearest-neighbour structure is needed.

import type { DataDictionaryTable } from "../types";
import type { Embedder, SemanticHit, SemanticIndex, SemanticSearchQuery, SemanticStatus, VectorCache } from "./types";
import { BACKGROUND_TEXTS, buildEmbedChunks } from "./text";
import { cacheKey, createDefaultVectorCache, createMemoryVectorCache } from "./cache";

export interface SemanticIndexOptions {
  embedder: Embedder;
  /** `undefined` -> IndexedDB when available; `false` -> memory only. */
  cache?: VectorCache | false | undefined;
  /** Texts per `embed()` call while indexing. Default: 16. */
  batchSize?: number | undefined;
}

/** Default floor on the mean-centred cosine score (see {@link SemanticHit}). */
export const DEFAULT_MIN_SCORE = 0.25;

export function createSemanticIndex(table: DataDictionaryTable, options: SemanticIndexOptions): SemanticIndex {
  const { embedder } = options;
  const cache: VectorCache = options.cache === false ? createMemoryVectorCache() : (options.cache ?? createDefaultVectorCache());
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const listeners = new Set<(status: SemanticStatus) => void>();

  let status: SemanticStatus = { state: "loading", progress: undefined };
  let disposed = false;
  let matrix: Float32Array | undefined;
  let mean: Float32Array | undefined;
  let dim = 0;
  let chunkRow: number[] = [];
  let rejectReady: ((err: Error) => void) | undefined;

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

  async function build(): Promise<void> {
    setStatus({ state: "loading", progress: undefined });
    if (embedder.load) await embedder.load((f) => setStatus({ state: "loading", progress: clamp01(f) }));
    if (disposed) throw disposedError();

    const chunks = buildEmbedChunks(table);
    chunkRow = chunks.map((c) => c.row);

    // Identical texts (repeated question blocks, shared code lists) embed once. The generic
    // background sentences are embedded too (never searched) to anchor the mean vector.
    const uniqueTexts: string[] = [];
    const textIndex = new Map<string, number>();
    const intern = (text: string): number => {
      let i = textIndex.get(text);
      if (i === undefined) {
        i = uniqueTexts.length;
        uniqueTexts.push(text);
        textIndex.set(text, i);
      }
      return i;
    };
    const chunkText = chunks.map((c) => intern(c.text));
    if (chunks.length > 0) for (const text of BACKGROUND_TEXTS) intern(text);

    const keys = uniqueTexts.map((t) => cacheKey(embedder.id, t));
    let cached = new Map<string, Float32Array>();
    try {
      cached = await cache.getMany(keys);
    } catch {
      /* persistence is best-effort */
    }
    if (disposed) throw disposedError();

    const vectors: Array<Float32Array | undefined> = keys.map((k) => cached.get(k));
    const missing: number[] = [];
    vectors.forEach((v, i) => {
      if (!v) missing.push(i);
    });
    const total = uniqueTexts.length;
    let done = total - missing.length;
    setStatus({ state: "indexing", done, total });

    const fresh: Array<readonly [string, Float32Array]> = [];
    for (let i = 0; i < missing.length; i += batchSize) {
      if (disposed) throw disposedError();
      const batch = missing.slice(i, i + batchSize);
      const out = await embedder.embed(
        batch.map((j) => uniqueTexts[j] as string),
        "document"
      );
      if (out.length !== batch.length) throw new Error(`Embedder returned ${out.length} vectors for ${batch.length} texts`);
      batch.forEach((j, k) => {
        const v = out[k] as Float32Array;
        vectors[j] = v;
        fresh.push([keys[j] as string, v]);
      });
      done += batch.length;
      setStatus({ state: "indexing", done, total });
      await yieldToEventLoop();
    }
    if (disposed) throw disposedError();

    const first = vectors.find((v): v is Float32Array => v !== undefined);
    dim = first ? first.length : 0;
    if (total > 0 && dim === 0) throw new Error("Embedder returned empty vectors");
    for (const v of vectors) {
      if (!v || v.length !== dim) throw new Error("Embedding dimension mismatch — Embedder.id must be unique per model configuration");
    }

    // Embedding spaces are anisotropic (every vector shares a large common component, which
    // is why unrelated texts still score 0.5+). Subtracting the mean over the corpus plus the
    // background sentences and re-normalising spreads the scores: unrelated ≈ 0, related ≫ 0.
    const mu = new Float32Array(dim);
    for (const v of vectors as Float32Array[]) for (let k = 0; k < dim; k += 1) mu[k] = (mu[k] as number) + (v[k] as number) / vectors.length;
    mean = mu;
    const m = new Float32Array(chunks.length * dim);
    chunks.forEach((_, ci) => centerInto(m, ci * dim, vectors[chunkText[ci] as number] as Float32Array, mu));
    matrix = m;

    if (fresh.length) {
      try {
        await cache.putMany(fresh);
      } catch {
        /* best-effort */
      }
    }
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

  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    build().then(resolve, (err: unknown) => {
      if (!disposed) setStatus({ state: "error", message: errorMessage(err) });
      reject(err instanceof Error ? err : new Error(errorMessage(err)));
    });
  });
  ready.catch(() => {
    /* consumers observe `status`; avoid unhandled rejections */
  });

  async function search(query: string, opts: SemanticSearchQuery = {}): Promise<SemanticHit[]> {
    if (disposed) throw disposedError();
    await ready;
    if (disposed) throw disposedError();
    const q = query.trim();
    const m = matrix;
    if (!q || !m || dim === 0) return [];

    const [qv] = await embedder.embed([q], "query");
    if (!qv || qv.length !== dim) throw new Error("Query embedding dimension mismatch");
    const qn = new Float32Array(dim);
    centerInto(qn, 0, qv, mean as Float32Array);

    const best = new Map<number, number>();
    const n = chunkRow.length;
    for (let ci = 0; ci < n; ci += 1) {
      const off = ci * dim;
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += (m[off + k] as number) * (qn[k] as number);
      const row = chunkRow[ci] as number;
      const prev = best.get(row);
      if (prev === undefined || dot > prev) best.set(row, dot);
    }

    const floor = opts.minScore ?? embedder.minScore ?? DEFAULT_MIN_SCORE;
    const hits: SemanticHit[] = [];
    for (const [row, score] of best) if (score >= floor) hits.push({ row, score });
    hits.sort((a, b) => b.score - a.score || a.row - b.row);
    return opts.limit === undefined ? hits : hits.slice(0, Math.max(0, opts.limit));
  }

  return {
    ready,
    get status() {
      return status;
    },
    get size() {
      return chunkRow.length;
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
      mean = undefined;
      listeners.clear();
      rejectReady?.(disposedError());
    }
  };
}

/** Writes normalize(v - mean) into `target` at `offset`. */
function centerInto(target: Float32Array, offset: number, v: Float32Array, mean: Float32Array): void {
  let sum = 0;
  for (let k = 0; k < v.length; k += 1) {
    const x = (v[k] as number) - (mean[k] as number);
    target[offset + k] = x;
    sum += x * x;
  }
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let k = 0; k < v.length; k += 1) target[offset + k] = (target[offset + k] as number) * inv;
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
