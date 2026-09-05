// Contracts for the search layer: the optional semantic index (bring your own Embedder), the
// lexical BM25F index, the hybrid ranking and the search engine that combines them.
//
// The library never imports an ML runtime. Consumers supply an `Embedder` (see
// `createTransformersEmbedder` for a reference adapter around @huggingface/transformers)
// and the library takes care of text preparation, caching, ranking and the UI.

export type EmbedKind = "document" | "query";

/** Resolved runtime facts about an embedder, populated after `load()`. */
export interface EmbedderInfo {
  model: string;
  device?: string | undefined;
  dtype?: string | undefined;
  pooling?: string | undefined;
  dims?: number | undefined;
  maxLength?: number | undefined;
  license?: string | undefined;
}

export interface Embedder {
  /**
   * Stable identity used in cache keys. Must change whenever the produced vectors would
   * change (model, quantization, pooling, document prefix).
   */
  readonly id: string;
  /**
   * Identity of the embedding *space* (model, pooling, prefixes, dims, max length) without
   * the weight precision. Vectors of one space are interchangeable for ranking, so caches and
   * snapshots are keyed by it when present, and by `id` otherwise.
   */
  readonly spaceId?: string | undefined;
  /** Model-specific cosine floor below which a hit is treated as unrelated. */
  readonly minScore?: number | undefined;
  /** Resolved runtime details, once known (typically after `load()`). */
  readonly info?: EmbedderInfo | undefined;
  /**
   * Embed texts into unit-length vectors (all of the same dimension, one per input).
   * Implementations must tolerate concurrent calls (serialize internally if needed).
   */
  embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]>;
  /** Optional eager initialisation (model download etc.). Must be idempotent. */
  load?(onProgress?: (fraction: number) => void): Promise<void>;
  /** Release resources. The library never calls this: the consumer owns the embedder. */
  dispose?(): void | Promise<void>;
}

/**
 * Persists document vectors between sessions (IndexedDB by default). Best-effort: the index
 * swallows every cache failure and simply re-embeds.
 */
export interface VectorCache {
  getMany(keys: readonly string[]): Promise<Map<string, Float32Array>>;
  putMany(entries: ReadonlyArray<readonly [key: string, vector: Float32Array]>): Promise<void>;
  /**
   * Delete every entry whose key is not in `keys`. The index calls this once a dictionary is
   * fully cached, so the cache only ever holds the most recently indexed dictionary instead of
   * accumulating one set of vectors per schema ever opened. Optional: a cache without it keeps
   * everything.
   */
  retainOnly?(keys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * One semantically matching row: `row` indexes `table.rows`. `score` is the cosine similarity
 * after subtracting the corpus mean vector (mean-centred), so unrelated rows sit near 0 and
 * related ones well above it, regardless of how compressed the raw model scores are.
 */
export interface SemanticHit {
  row: number;
  score: number;
}

export type SemanticStatus =
  | { state: "loading"; progress: number | undefined }
  /** `done`/`total` count unique texts; `coverage` is the fraction of chunks already searchable. */
  | { state: "indexing"; done: number; total: number; coverage: number }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface SemanticSearchQuery {
  /** Maximum number of hits to return. */
  limit?: number | undefined;
  /** Cosine floor; defaults to the embedder's `minScore`, then 0.25. */
  minScore?: number | undefined;
  /**
   * Search while indexing: waits only for the cache to be read (`loaded`) and scores the chunks
   * embedded so far. Default: false (waits for `ready`).
   */
  partial?: boolean | undefined;
}

export interface SemanticIndex {
  /** Fulfilled once every row is embedded; rejected on error or `dispose()`. */
  readonly ready: Promise<void>;
  /** Fulfilled once cached vectors are in place and partial searches can run. */
  readonly loaded: Promise<void>;
  readonly status: SemanticStatus;
  /** Number of text chunks in the index (rows may contribute several chunks). */
  readonly size: number;
  /** Fraction of chunks that are searchable right now (1 once ready). */
  readonly coverage: number;
  subscribe(listener: (status: SemanticStatus) => void): () => void;
  /** Rows related to `query`, best first, above the similarity floor. */
  search(query: string, options?: SemanticSearchQuery): Promise<SemanticHit[]>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Lexical (BM25F) index

/** Fields of a lexical document, in match-priority order. */
export type LexicalField = "name" | "description" | "values" | "category" | "format" | "other";

/** Per-row texts fed to the lexical index (see `lexicalDocumentFromRow`). */
export interface LexicalDocument {
  /** Raw variable name. */
  name: string;
  description: string;
  /** One line per valid value, sentinel codes included. */
  values: string;
  /** Category title (indexed lexically, never embedded). */
  category: string;
  /** Format and data type. */
  format: string;
  /** Constraints and "Additional information" text. */
  other: string;
  /** Lower-cased blob of every column; the substring fallback searches it. */
  all: string;
}

/** Surface terms that matched in one field of a row ("why did this row match?"). */
export interface LexicalMatch {
  field: LexicalField;
  /** Surface forms to highlight, longest first. */
  terms: string[];
}

export interface LexicalHit {
  /** Position of the document in the indexed list (= index into `table.rows`). */
  row: number;
  /** BM25F score plus name bonuses (0.5 for substring-only rows). */
  score: number;
  /** The whole query equals the raw or humanised variable name. */
  exactName: boolean;
  /** The whole query is a prefix of the raw or humanised variable name. */
  namePrefix: boolean;
  /** Matched only through the 0.2.0 substring predicate (`all.includes(query)`). */
  substringOnly: boolean;
  matches: LexicalMatch[];
}

/** `auto` = AND over the non-stop-word tokens, falling back to OR when nothing matches. */
export type LexicalSearchMode = "auto" | "and" | "or";

export interface LexicalSearchOptions {
  limit?: number | undefined;
  /** Default: "auto". */
  mode?: LexicalSearchMode | undefined;
  /** Match the last query token as a prefix (as-you-type). Default: true. */
  prefixLastToken?: boolean | undefined;
}

export interface LexicalIndexOptions {
  /** Stop words are indexed but optional under AND. `false` disables the list. Default: a small English list. */
  stopWords?: Iterable<string> | false | undefined;
  /** Prefix expansions kept per token (the most frequent ones). Default: 64. */
  maxExpansions?: number | undefined;
  /** Shortest token that is expanded as a prefix. Default: 2. */
  minPrefixLength?: number | undefined;
}

export interface LexicalIndex {
  /** Number of documents. */
  readonly size: number;
  /** Number of distinct surface terms. */
  readonly vocabularySize: number;
  /** Hits sorted by `exactName` desc, score desc, row asc. Synchronous. */
  search(query: string, options?: LexicalSearchOptions): LexicalHit[];
  /** Normalised query tokens (for highlighting fallbacks). */
  tokens(query: string): string[];
}

// ---------------------------------------------------------------------------
// Hybrid ranking and the search engine

export interface RankedResult {
  row: number;
  /** Fused score (higher is better; only comparable within one query). */
  score: number;
  /** True for lexical matches, false for semantic-only ("related") rows. */
  exact: boolean;
  /** The whole query equals the variable name (ranked first). */
  exactName: boolean;
  /** Legacy buckets: 6 exact name, 5 name prefix, 4 name, 3 description, 2 values, 1 elsewhere, 0 related. */
  keywordScore: number;
  /** BM25F score (0 for related rows). */
  lexicalScore: number;
  semanticScore?: number | undefined;
  /** Where the query matched (empty for related rows). */
  matches: LexicalMatch[];
}

export interface FusionOptions {
  /** Reciprocal-rank-fusion constant. Default: 60. */
  k?: number | undefined;
  /** Default: 1. */
  lexicalWeight?: number | undefined;
  /** Default: 1. */
  semanticWeight?: number | undefined;
}

export interface RankHybridOptions extends FusionOptions {
  /** Maximum number of semantic-only rows appended to the lexical matches. */
  maxRelated: number;
}

export type SemanticResultState = "off" | "skipped" | "pending" | "partial" | "complete" | "error";

export interface SearchResult {
  /** The query as typed. */
  query: string;
  /** Trimmed, lower-cased, whitespace-collapsed query (the cache key). */
  normalizedQuery: string;
  /** Sorted best-first: every lexical hit plus up to `maxRelated` related rows. */
  results: RankedResult[];
  /** Matched surface terms, longest first (for highlighting); `[]` means highlight the raw query. */
  terms: string[];
  exactCount: number;
  relatedCount: number;
  semantic: {
    state: SemanticResultState;
    /** Fraction of the semantic index the hits were computed over (1 when complete). */
    coverage: number;
    message?: string | undefined;
  };
}

export interface SearchEngineOptions {
  /** Semantic index to fuse with (owned by the caller; never disposed by the engine). */
  semantic?: SemanticIndex | undefined;
  /** Pre-built lexical index; default: built from the table / documents. */
  lexical?: LexicalIndex | undefined;
  /** Maximum number of semantic-only rows. Default: 10. */
  maxRelated?: number | undefined;
  /** Cosine floor for related rows. Default: the embedder's `minScore`, then 0.25. */
  minScore?: number | undefined;
  /** Shortest query that triggers a semantic lookup. Default: 3. */
  minQueryLength?: number | undefined;
  /** Idle time before a semantic lookup runs. Default: 250 ms. */
  debounceMs?: number | undefined;
  fusion?: FusionOptions | undefined;
}

export interface SearchEngine {
  /**
   * Synchronous lexical pass fused with the last known semantic hits for the query; schedules
   * the (debounced, latest-wins) semantic lookup whose result arrives through `subscribe`.
   */
  search(query: string): SearchResult;
  /** Asynchronous updates for the CURRENT query only. */
  subscribe(callback: (result: SearchResult) => void): () => void;
  readonly current: SearchResult | undefined;
  readonly status: SemanticStatus | undefined;
  readonly lexical: LexicalIndex;
  /** Stops timers and subscriptions. Never disposes the semantic index. */
  dispose(): void;
}
