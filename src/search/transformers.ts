// Reference Embedder adapter for @huggingface/transformers (Transformers.js v3/v4).
//
// The module is handed in (or lazily loaded through a function you provide); this file never
// imports it, so the library keeps zero runtime dependencies and the emitted types never
// mention the package. Works on the main thread and inside a worker.

import type { EmbedKind, Embedder } from "./types";

/** Structural stand-in for `import("@huggingface/transformers")`. */
export interface TransformersModuleLike {
  pipeline(task: string, model?: string, options?: unknown): Promise<unknown>;
}

interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
  dispose?: () => void;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: "cls" | "mean"; normalize: boolean }): Promise<TensorLike>;
  dispose?: () => Promise<void> | void;
}

export interface TransformersEmbedderOptions {
  /** Hugging Face model id with ONNX weights. Default: {@link DEFAULT_EMBEDDING_MODEL}. */
  model?: string | undefined;
  /** Weight precision ("q8", "fp16", "fp32", "q4", …). Default: "q8". */
  dtype?: string | undefined;
  /** Execution device ("wasm", "webgpu", …). Default: "wasm". */
  device?: string | undefined;
  /** Pooling strategy. Default: from {@link KNOWN_EMBEDDING_MODELS}, else "mean". */
  pooling?: "cls" | "mean" | undefined;
  /** Text prepended to queries (some models need an instruction). */
  queryPrefix?: string | undefined;
  /** Text prepended to documents. */
  documentPrefix?: string | undefined;
  /** Cosine floor for "related" hits. Default: from the known-models table, else 0.5. */
  minScore?: number | undefined;
  /** Texts per model call. Default: 16. */
  batchSize?: number | undefined;
  /** Extra options merged into `pipeline()` (e.g. `revision`, `session_options`). */
  pipelineOptions?: Record<string, unknown> | undefined;
}

export interface KnownEmbeddingModel {
  pooling: "cls" | "mean";
  queryPrefix: string;
  documentPrefix: string;
  /** Floor on the mean-centred cosine score, calibrated on the BCRPP fixture. */
  minScore: number;
}

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * Verified configurations. Other models work too — pass `pooling`/prefixes/`minScore` explicitly.
 *
 * Floors were calibrated on the BCRPP fixture (106 variables) with q8 weights, on mean-centred
 * scores: for both models nonsense queries ("asdfgh", "xyzzy plugh", "the") never exceeded
 * 0.23 while genuinely related rows scored 0.25-0.63 (e.g. "tobacco" -> the smoking_* rows,
 * "body size" -> bmi/height/waist/hip). Raw (uncentred) BGE scores cluster in 0.55-0.75 and
 * are not separable by a fixed floor, which is why the index centres them.
 */
export const KNOWN_EMBEDDING_MODELS: Readonly<Record<string, KnownEmbeddingModel>> = {
  // BGE: CLS pooling (per BAAI); v1.5 needs no query instruction.
  "Xenova/bge-small-en-v1.5": { pooling: "cls", queryPrefix: "", documentPrefix: "", minScore: 0.25 },
  "Xenova/all-MiniLM-L6-v2": { pooling: "mean", queryPrefix: "", documentPrefix: "", minScore: 0.25 }
};

const warned = new Set<string>();

export function createTransformersEmbedder(
  moduleOrLoader: TransformersModuleLike | (() => Promise<TransformersModuleLike>),
  options: TransformersEmbedderOptions = {}
): Embedder {
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const known = KNOWN_EMBEDDING_MODELS[model];
  if (!known && (options.pooling === undefined || options.minScore === undefined) && !warned.has(model)) {
    warned.add(model);
    console.warn(`[json-schema-data-dictionary] "${model}" is not a verified embedding model; pass explicit pooling/queryPrefix/minScore options.`);
  }
  const pooling = options.pooling ?? known?.pooling ?? "mean";
  const queryPrefix = options.queryPrefix ?? known?.queryPrefix ?? "";
  const documentPrefix = options.documentPrefix ?? known?.documentPrefix ?? "";
  const minScore = options.minScore ?? known?.minScore ?? 0.25;
  const dtype = options.dtype ?? "q8";
  const device = options.device ?? "wasm";
  const batchSize = Math.max(1, options.batchSize ?? 16);
  // Device is excluded: it does not change the vectors. The document prefix does.
  const id = `transformers:${model}:${dtype}:${pooling}:${documentPrefix}`;

  let extractorPromise: Promise<FeatureExtractor> | undefined;
  const progressListeners = new Set<(fraction: number) => void>();
  const files = new Map<string, { loaded: number; total: number }>();

  const emit = (fraction: number): void => {
    for (const listener of progressListeners) {
      try {
        listener(fraction);
      } catch {
        /* ignore listener errors */
      }
    }
  };

  // Transformers.js reports per-file download progress; aggregate into one fraction.
  const onProgressEvent = (event: unknown): void => {
    if (typeof event !== "object" || event === null) return;
    const e = event as { status?: unknown; file?: unknown; name?: unknown; loaded?: unknown; total?: unknown };
    if (e.status !== "progress" || typeof e.loaded !== "number" || typeof e.total !== "number" || e.total <= 0) return;
    files.set(String(e.file ?? e.name ?? ""), { loaded: e.loaded, total: e.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    emit(total > 0 ? Math.min(1, loaded / total) : 0);
  };

  const load = (onProgress?: (fraction: number) => void): Promise<void> => {
    if (onProgress) progressListeners.add(onProgress);
    extractorPromise ??= (async () => {
      const mod = typeof moduleOrLoader === "function" ? await moduleOrLoader() : moduleOrLoader;
      const pipe = await mod.pipeline("feature-extraction", model, {
        dtype,
        device,
        progress_callback: onProgressEvent,
        ...(options.pipelineOptions ?? {})
      });
      return pipe as FeatureExtractor;
    })();
    return extractorPromise.then(
      () => {
        emit(1);
        if (onProgress) progressListeners.delete(onProgress);
      },
      (err: unknown) => {
        if (onProgress) progressListeners.delete(onProgress);
        extractorPromise = undefined; // allow a retry
        throw err;
      }
    );
  };

  // ONNX Runtime sessions must not run concurrently: serialize every embed() call.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const embed = (texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]> =>
    enqueue(async () => {
      await load();
      const extractor = await (extractorPromise as Promise<FeatureExtractor>);
      const prefix = kind === "query" ? queryPrefix : documentPrefix;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize).map((t) => prefix + t);
        const tensor = await extractor(batch, { pooling, normalize: true });
        const d = tensor.dims[tensor.dims.length - 1] ?? 0;
        const flat = tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
        for (let r = 0; r < batch.length; r += 1) out.push(flat.slice(r * d, (r + 1) * d));
        tensor.dispose?.();
        if (i + batchSize < texts.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return out;
    });

  return {
    id,
    minScore,
    load,
    embed,
    async dispose() {
      const p = extractorPromise;
      extractorPromise = undefined;
      if (!p) return;
      const extractor = await p.catch(() => undefined);
      await extractor?.dispose?.();
    }
  };
}
