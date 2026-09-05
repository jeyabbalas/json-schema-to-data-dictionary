// The search engine behind the component's search box. `search()` is synchronous: a lexical
// (BM25F) pass fused with the last known semantic hits for that query. Semantic lookups run
// asynchronously — debounced, latest-wins (one in flight, one pending) — and reach subscribers
// for the CURRENT query only. While the semantic index is still indexing, lookups score the
// chunks embedded so far and the current query is re-run as coverage grows (≥ 0.1) or time
// passes (≥ 750 ms), and once more when the index becomes ready. A small LRU of per-query
// results (lexical hits, semantic hits, fused ranking) makes retyping instant.
//
// The engine never owns the semantic index: the caller creates and disposes it.

import type { DataDictionaryTable } from "../types";
import type {
  LexicalDocument,
  LexicalHit,
  RankedResult,
  SearchEngine,
  SearchEngineOptions,
  SearchResult,
  SemanticHit,
  SemanticStatus
} from "./types";
import { createLexicalIndex, lexicalDocumentsFromTable } from "./lexical";
import { rankHybrid } from "./ranking";
import { createLru } from "./lru";

export type { SearchEngine, SearchEngineOptions, SearchResult, SemanticResultState } from "./types";

const RESULTS_CACHE = 32;
const RERUN_COVERAGE = 0.1;
const RERUN_MS = 750;
/** Purely numeric queries (codes, years) never trigger a semantic lookup. */
const NUMERIC_QUERY = /^[\d\s.,\-]+$/;

interface SemanticEntry {
  hits: SemanticHit[];
  /** Computed once the index was complete (otherwise over `coverage` of the chunks). */
  complete: boolean;
  coverage: number;
  time: number;
}

interface Entry {
  lexical: LexicalHit[];
  semantic?: SemanticEntry | undefined;
  error?: string | undefined;
  /** Fused ranking of `lexical` + `semantic.hits`, rebuilt when the semantic hits change. */
  ranked?: RankedResult[] | undefined;
  terms?: string[] | undefined;
}

export function createSearchEngine(
  source: DataDictionaryTable | readonly LexicalDocument[],
  options: SearchEngineOptions = {}
): SearchEngine {
  const lexical = options.lexical ?? createLexicalIndex("rows" in source ? lexicalDocumentsFromTable(source) : source);
  const semantic = options.semantic;
  const maxRelated = Math.max(0, Math.floor(options.maxRelated ?? 10));
  const minScore = options.minScore;
  const minQueryLength = Math.max(1, Math.floor(options.minQueryLength ?? 3));
  const debounceMs = Math.max(0, options.debounceMs ?? 250);
  const fusion = options.fusion ?? {};
  const entries = createLru<string, Entry>(RESULTS_CACHE);
  const listeners = new Set<(result: SearchResult) => void>();

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = false;
  let pending: string | undefined;
  let currentRaw = "";
  let currentQ = "";
  let current: SearchResult | undefined;

  const normalize = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");
  const usable = (): boolean => semantic !== undefined && semantic.status.state !== "error";
  const eligible = (q: string): boolean => usable() && q.length >= minQueryLength && !NUMERIC_QUERY.test(q);

  const entryFor = (q: string): Entry => {
    let entry = entries.get(q);
    if (!entry) {
      entry = { lexical: lexical.search(q) };
      entries.set(q, entry);
    }
    return entry;
  };

  const semanticState = (q: string, entry: Entry | undefined): SearchResult["semantic"] => {
    if (!semantic) return { state: "off", coverage: 0 };
    const status = semantic.status;
    const coverage = semantic.coverage;
    if (status.state === "error") return { state: "error", coverage, message: status.message };
    if (!q || !eligible(q) || !entry) return { state: "skipped", coverage };
    if (entry.error !== undefined) return { state: "error", coverage, message: entry.error };
    const s = entry.semantic;
    if (!s) return { state: "pending", coverage };
    return s.complete ? { state: "complete", coverage: 1 } : { state: "partial", coverage: s.coverage };
  };

  /** Matched surface terms across the lexical hits, longest first; see `SearchResult.terms`. */
  const collectTerms = (ranked: readonly RankedResult[], q: string): string[] => {
    const set = new Set<string>();
    let lexicalRows = 0;
    for (const r of ranked) {
      if (!r.exact) continue;
      lexicalRows += 1;
      for (const m of r.matches) for (const t of m.terms) set.add(t);
    }
    if (set.size > 0) return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    // Only the substring fallback matched: highlight the raw query. No lexical hit at all
    // (related rows only, or nothing): fall back to the query tokens.
    return lexicalRows > 0 ? [] : lexical.tokens(q);
  };

  const buildResult = (raw: string, q: string, entry: Entry): SearchResult => {
    if (!entry.ranked || !entry.terms) {
      entry.ranked = rankHybrid(entry.lexical, entry.semantic?.hits, { maxRelated, ...fusion });
      entry.terms = collectTerms(entry.ranked, q);
    }
    let exactCount = 0;
    for (const r of entry.ranked) if (r.exact) exactCount += 1;
    return {
      query: raw,
      normalizedQuery: q,
      results: entry.ranked,
      terms: entry.terms,
      exactCount,
      relatedCount: entry.ranked.length - exactCount,
      semantic: semanticState(q, entry)
    };
  };

  const emit = (result: SearchResult): void => {
    for (const listener of [...listeners]) {
      try {
        listener(result);
      } catch {
        /* a listener must not break the engine */
      }
    }
  };

  /** Re-emit the current query if `q` is still it. */
  const publish = (q: string): void => {
    if (disposed || q !== currentQ) return;
    current = buildResult(currentRaw, q, entryFor(q));
    emit(current);
  };

  const runSemantic = (q: string): void => {
    if (disposed || !semantic || !eligible(q)) return;
    if (inflight) {
      pending = q;
      return;
    }
    const entry = entryFor(q);
    const partial = semantic.status.state !== "ready";
    const coverageBefore = semantic.coverage;
    inflight = true;
    semantic
      .search(q, { limit: maxRelated + entry.lexical.length, partial, ...(minScore !== undefined ? { minScore } : {}) })
      .then(
        (hits) => {
          if (disposed) return;
          const complete = !partial || coverageBefore >= 1;
          entry.semantic = { hits, complete, coverage: complete ? 1 : semantic.coverage, time: Date.now() };
          entry.error = undefined;
          entry.ranked = undefined;
          publish(q);
        },
        (err: unknown) => {
          if (disposed) return;
          entry.error = err instanceof Error ? err.message : String(err);
          publish(q);
        }
      )
      .then(() => {
        inflight = false;
        const next = pending;
        pending = undefined;
        if (next !== undefined && !disposed && next === currentQ) runSemantic(next);
      });
  };

  const schedule = (q: string): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runSemantic(q);
    }, debounceMs);
  };

  const search = (raw: string): SearchResult => {
    const q = normalize(raw);
    currentRaw = raw;
    currentQ = q;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
    if (!q) {
      current = { query: raw, normalizedQuery: q, results: [], terms: [], exactCount: 0, relatedCount: 0, semantic: semanticState(q, undefined) };
      return current;
    }
    const entry = entryFor(q);
    if (!disposed && semantic && eligible(q) && entry.error === undefined) {
      const s = entry.semantic;
      // Hits computed over a partial index are refreshed once the index is complete; while it
      // is still indexing, the status subscription below re-runs them as coverage grows.
      if (!s || (!s.complete && semantic.status.state === "ready")) schedule(q);
    }
    current = buildResult(raw, q, entry);
    return current;
  };

  const onStatus = (status: SemanticStatus): void => {
    if (disposed) return;
    const q = currentQ;
    if (!q) return;
    if (status.state === "error") {
      publish(q);
      return;
    }
    if (!eligible(q) || timer !== undefined) return;
    const entry = entries.get(q);
    if (!entry || entry.error !== undefined) return;
    const s = entry.semantic;
    if (status.state === "ready") {
      if (!s?.complete) runSemantic(q);
    } else if (status.state === "indexing" && !inflight) {
      if (!s) runSemantic(q);
      else if (!s.complete && (status.coverage - s.coverage >= RERUN_COVERAGE || Date.now() - s.time >= RERUN_MS)) runSemantic(q);
    }
  };
  const unsubscribe = semantic?.subscribe(onStatus);

  return {
    search,
    subscribe(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    get current() {
      return current;
    },
    get status() {
      return semantic?.status;
    },
    get lexical() {
      return lexical;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      unsubscribe?.();
      listeners.clear();
    }
  };
}
