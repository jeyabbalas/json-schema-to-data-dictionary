// Contracts for the optional semantic-search layer.
//
// The library never imports an ML runtime. Consumers supply an `Embedder` (see
// `createTransformersEmbedder` for a reference adapter around @huggingface/transformers)
// and the library takes care of text preparation, caching, ranking and the UI.

export type EmbedKind = "document" | "query";

export interface Embedder {
  /**
   * Stable identity used in cache keys. Must change whenever the produced vectors would
   * change (model, quantization, pooling, document prefix).
   */
  readonly id: string;
  /** Model-specific cosine floor below which a hit is treated as unrelated. */
  readonly minScore?: number | undefined;
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

/** Persists document vectors between sessions (IndexedDB by default). Best-effort. */
export interface VectorCache {
  getMany(keys: readonly string[]): Promise<Map<string, Float32Array>>;
  putMany(entries: ReadonlyArray<readonly [key: string, vector: Float32Array]>): Promise<void>;
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
  | { state: "indexing"; done: number; total: number }
  | { state: "ready" }
  | { state: "error"; message: string };

export interface SemanticSearchQuery {
  /** Maximum number of hits to return. */
  limit?: number | undefined;
  /** Cosine floor; defaults to the embedder's `minScore`, then 0.5. */
  minScore?: number | undefined;
}

export interface SemanticIndex {
  /** Fulfilled once every row is embedded; rejected on error or `dispose()`. */
  readonly ready: Promise<void>;
  readonly status: SemanticStatus;
  /** Number of text chunks in the index (rows may contribute several chunks). */
  readonly size: number;
  subscribe(listener: (status: SemanticStatus) => void): () => void;
  /** Rows related to `query`, best first, above the similarity floor. */
  search(query: string, options?: SemanticSearchQuery): Promise<SemanticHit[]>;
  dispose(): void;
}
