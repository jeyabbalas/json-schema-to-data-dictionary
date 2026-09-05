// Reference Embedder adapter for @huggingface/transformers (Transformers.js v4).
//
// The module is handed in (or lazily loaded through a function you provide); this file never
// imports it, so the library keeps zero runtime dependencies and the emitted types never
// mention the package. Works on the main thread, inside a worker and under Node.
//
// It drives `AutoTokenizer` + `AutoModel` directly instead of the `feature-extraction`
// pipeline, for three reasons the pipeline cannot express: LEAF-style models expose a
// `sentence_embedding` output (pooling + projection + normalisation baked into the graph) that
// the pipeline ignores; `last_token` pooling must follow the attention mask (the pipeline takes
// the last *padded* position, wrong for right-padding tokenizers as soon as a batch mixes
// lengths); and the tokenizer gets an explicit `max_length` so length-sorted batches waste no
// padding. Device and dtype resolve at `load()` ("auto" → WebGPU / WASM / Node CPU, with a
// per-model dtype table), so `id` is final only after `load()`, while `spaceId` — the identity
// of the vectors regardless of weight precision — is known up front and keys caches/snapshots.

import type { EmbedKind, Embedder, EmbedderInfo } from "./types";
import type { DtypeTable, ResolvedRuntime } from "./runtime";
import { resolveRuntime } from "./runtime";
import type { TensorLike } from "./pooling";
import { poolCls, poolLastToken, poolMean, takeSentenceEmbedding, truncateAndNormalize } from "./pooling";

export type PoolingMode = "cls" | "mean" | "last_token" | "sentence_embedding";

/** Structural stand-in for `import("@huggingface/transformers")`. */
export interface TransformersModuleLike {
  AutoTokenizer: { from_pretrained(model: string, options?: unknown): Promise<unknown> };
  AutoModel: { from_pretrained(model: string, options?: unknown): Promise<unknown> };
  env?: Record<string, unknown> | undefined;
}

/** A loaded tokenizer: `tokenizer(texts, options)` -> named int64 tensors. */
type TokenizerLike = (texts: string[], options: { padding: boolean; truncation: boolean; max_length: number }) => Promise<Record<string, TensorLike>> | Record<string, TensorLike>;

/** A loaded model: `model(encoding)` -> named output tensors. */
interface ModelLike {
  (inputs: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
  dispose?: (() => Promise<unknown> | void) | undefined;
}

export interface TransformersEmbedderOptions {
  /** Hugging Face model id with ONNX weights. Default: {@link DEFAULT_EMBEDDING_MODEL}. */
  model?: string | undefined;
  /**
   * Weight precision ("fp32", "fp16", "q8", "q4f16", …). Default: "auto" — the known model's
   * per-device table (fp16 on WebGPU with `shader-f16`, q8 on WASM, fp32 on Node).
   */
  dtype?: string | undefined;
  /** Execution device ("webgpu", "wasm", "cpu", …). Default: "auto" (WebGPU → Node CPU → WASM). */
  device?: string | undefined;
  /** Pooling strategy. Default: from {@link KNOWN_EMBEDDING_MODELS}, else "mean". */
  pooling?: PoolingMode | undefined;
  /** Text prepended to queries (some models need an instruction). */
  queryPrefix?: string | undefined;
  /** Text prepended to documents. */
  documentPrefix?: string | undefined;
  /** Keep the first `dims` components (Matryoshka models) and renormalise. Default: the full vector. */
  dims?: number | undefined;
  /** Tokens per text (truncation + padding bound). Default: 256. */
  maxLength?: number | undefined;
  /** Cosine floor for "related" hits. Default: from the known-models table, else 0.25. */
  minScore?: number | undefined;
  /** Texts per model call. Default: 16. */
  batchSize?: number | undefined;
  /** Extra options merged into `AutoModel.from_pretrained()` (e.g. `revision`, `session_options`). */
  modelOptions?: Record<string, unknown> | undefined;
  /** Extra options merged into `AutoTokenizer.from_pretrained()`. */
  tokenizerOptions?: Record<string, unknown> | undefined;
  /** @deprecated Alias of `modelOptions` (kept from the pipeline-based adapter). */
  pipelineOptions?: Record<string, unknown> | undefined;
  /**
   * Retry on WASM when creating the WebGPU session fails. Default: true when `device` is
   * "auto", false when a device was requested explicitly.
   */
  fallbackToWasm?: boolean | undefined;
}

export interface KnownEmbeddingModel {
  pooling: PoolingMode;
  queryPrefix: string;
  documentPrefix: string;
  /** Native vector size. */
  fullDims: number;
  /** Recommended truncation when smaller than `fullDims` (Matryoshka models); default: full. */
  dims?: number | undefined;
  maxLength: number;
  /** Floor on the mean-centred cosine score (see `DEFAULT_MIN_SCORE`). */
  minScore: number;
  /** Weight precision per device. */
  dtype: DtypeTable;
  /** Devices the model is practical on; a warning is logged when it resolves elsewhere. */
  devices?: readonly string[] | undefined;
  /** Parameter count. */
  params: number;
  /** SPDX licence identifier of the weights. */
  license: string;
  notes?: string | undefined;
}

export const DEFAULT_EMBEDDING_MODEL = "MongoDB/mdbr-leaf-ir";

/**
 * Verified configurations. Other models work too — pass `pooling`/prefixes/`minScore` explicitly.
 *
 * Floors were calibrated with `npm run eval -- --calibrate --dtype q8` on the BCRPP fixture
 * (52 labelled queries): the floor sits just above the highest mean-centred score any row
 * reached for 12 nonsense queries ("asdfgh", "xyzzy plugh", "the", …). Noise ceilings: LEAF-IR
 * 0.241, bge-small 0.233, Jina v5 nano 0.271; the 10th percentile of the expected rows' scores
 * was 0.11 / 0.11 / 0.21, so some weakly related rows fall below the floor — the lexical index
 * covers those, and the floor only gates "related"-only rows.
 */
export const KNOWN_EMBEDDING_MODELS: Readonly<Record<string, KnownEmbeddingModel>> = {
  // LEAF-IR: the ONNX graph exposes `sentence_embedding` (pooling + Dense 384→768 + normalise);
  // `last_hidden_state` is the 384-d encoder output and must not be pooled by hand.
  "MongoDB/mdbr-leaf-ir": {
    pooling: "sentence_embedding",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    documentPrefix: "",
    fullDims: 768,
    maxLength: 256,
    minScore: 0.25, // noise ceiling 0.241 (2026-09 calibration)
    dtype: { webgpu: "fp16", webgpuNoF16: "fp32", wasm: "q8", cpu: "fp32" },
    params: 23e6,
    license: "Apache-2.0",
    notes: "BEIR nDCG@10 53.6; asymmetric retrieval (query instruction, bare documents)."
  },
  // Jina v5 nano: EuroBERT decoder, last-token pooling over the attention mask; right-padding
  // tokenizer. 239M parameters — practical on WebGPU only. Non-commercial licence.
  "jinaai/jina-embeddings-v5-text-nano-retrieval": {
    pooling: "last_token",
    queryPrefix: "Query: ",
    documentPrefix: "Document: ",
    fullDims: 768,
    maxLength: 256,
    minScore: 0.28, // noise ceiling 0.271 (2026-09 calibration)
    dtype: { webgpu: "q4f16", webgpuNoF16: "q8", wasm: "q8", cpu: "fp32" },
    devices: ["webgpu"],
    params: 239e6,
    license: "CC-BY-NC-4.0",
    notes: "Non-commercial use only. Matryoshka 32–768 dims."
  },
  // BGE: CLS pooling (per BAAI); v1.5 needs no query instruction.
  "Xenova/bge-small-en-v1.5": {
    pooling: "cls",
    queryPrefix: "",
    documentPrefix: "",
    fullDims: 384,
    maxLength: 256,
    minScore: 0.25,
    dtype: { webgpu: "fp16", webgpuNoF16: "fp32", wasm: "q8", cpu: "fp32" },
    params: 33e6,
    license: "MIT"
  },
  "Xenova/all-MiniLM-L6-v2": {
    pooling: "mean",
    queryPrefix: "",
    documentPrefix: "",
    fullDims: 384,
    maxLength: 256,
    minScore: 0.25,
    dtype: { webgpu: "fp16", webgpuNoF16: "fp32", wasm: "q8", cpu: "fp32" },
    params: 22e6,
    license: "Apache-2.0"
  }
};

const PREFIX = "[json-schema-data-dictionary]";
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${PREFIX} ${message}`);
}

interface Loaded {
  tokenizer: TokenizerLike;
  model: ModelLike;
  runtime: ResolvedRuntime;
}

export function createTransformersEmbedder(
  moduleOrLoader: TransformersModuleLike | (() => Promise<TransformersModuleLike>),
  options: TransformersEmbedderOptions = {}
): Embedder {
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const known = KNOWN_EMBEDDING_MODELS[model];
  if (!known && (options.pooling === undefined || options.minScore === undefined)) {
    warnOnce(`unknown:${model}`, `"${model}" is not a verified embedding model; pass explicit pooling/queryPrefix/minScore options.`);
  }
  const pooling: PoolingMode = options.pooling ?? known?.pooling ?? "mean";
  const queryPrefix = options.queryPrefix ?? known?.queryPrefix ?? "";
  const documentPrefix = options.documentPrefix ?? known?.documentPrefix ?? "";
  const minScore = options.minScore ?? known?.minScore ?? 0.25;
  const dims = options.dims !== undefined && options.dims > 0 ? Math.floor(options.dims) : known?.dims;
  const maxLength = Math.max(8, Math.floor(options.maxLength ?? known?.maxLength ?? 256));
  const requestedDtype = options.dtype ?? "auto";
  const requestedDevice = options.device ?? "auto";
  const fallbackToWasm = options.fallbackToWasm ?? requestedDevice === "auto";
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 16));
  const modelOptions = { ...(options.pipelineOptions ?? {}), ...(options.modelOptions ?? {}) };
  const tokenizerOptions = options.tokenizerOptions ?? {};

  // The vector space: everything that changes the vectors except the weight precision.
  const spaceId = `transformers:${model}:${pooling}:${dims ?? "full"}:${maxLength}:${documentPrefix}`;

  let loadPromise: Promise<Loaded> | undefined;
  let runtime: ResolvedRuntime | undefined;
  let observedDims: number | undefined;
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

  const createModel = async (mod: TransformersModuleLike, rt: ResolvedRuntime): Promise<ModelLike> =>
    (await mod.AutoModel.from_pretrained(model, {
      device: rt.device,
      dtype: rt.dtype,
      progress_callback: onProgressEvent,
      ...modelOptions
    })) as ModelLike;

  const doLoad = async (): Promise<Loaded> => {
    const mod = typeof moduleOrLoader === "function" ? await moduleOrLoader() : moduleOrLoader;
    let rt = await resolveRuntime({ device: requestedDevice, dtype: requestedDtype, ...(known ? { known } : {}) });
    if (known?.devices && !known.devices.includes(rt.device)) {
      warnOnce(`device:${model}:${rt.device}`, `"${model}" is verified on ${known.devices.join("/")} only; running on ${rt.device} may be very slow.`);
    }
    const tokenizer = (await mod.AutoTokenizer.from_pretrained(model, { progress_callback: onProgressEvent, ...tokenizerOptions })) as TokenizerLike;
    let loadedModel: ModelLike;
    try {
      loadedModel = await createModel(mod, rt);
    } catch (err) {
      if (rt.device !== "webgpu" || !fallbackToWasm) throw err;
      const wasmDtype = requestedDtype === "auto" ? (known?.dtype.wasm ?? "q8") : requestedDtype;
      console.warn(`${PREFIX} WebGPU session for "${model}" failed (${err instanceof Error ? err.message : String(err)}); retrying on WASM (${wasmDtype}).`);
      rt = { device: "wasm", dtype: wasmDtype, fromAuto: rt.fromAuto };
      loadedModel = await createModel(mod, rt);
    }
    runtime = rt;
    return { tokenizer, model: loadedModel, runtime: rt };
  };

  const load = (onProgress?: (fraction: number) => void): Promise<void> => {
    if (onProgress) progressListeners.add(onProgress);
    loadPromise ??= doLoad();
    return loadPromise.then(
      () => {
        emit(1);
        if (onProgress) progressListeners.delete(onProgress);
      },
      (err: unknown) => {
        if (onProgress) progressListeners.delete(onProgress);
        loadPromise = undefined; // allow a retry
        throw err;
      }
    );
  };

  const disposeAll = (tensors: Record<string, TensorLike> | undefined): void => {
    if (!tensors) return;
    for (const t of Object.values(tensors)) {
      try {
        t?.dispose?.();
      } catch {
        /* best-effort */
      }
    }
  };

  /** Tokenize + run + pool one batch of already-prefixed texts. */
  const embedBatch = async (loaded: Loaded, texts: string[]): Promise<Float32Array[]> => {
    const encoding = await loaded.tokenizer(texts, { padding: true, truncation: true, max_length: maxLength });
    let outputs: Record<string, TensorLike> | undefined;
    try {
      outputs = await loaded.model(encoding);
      let rows: Float32Array[];
      if (pooling === "sentence_embedding") {
        const t = outputs.sentence_embedding;
        if (!t) throw new Error(`Model "${model}" has no sentence_embedding output; use pooling "cls", "mean" or "last_token"`);
        rows = takeSentenceEmbedding(t);
      } else {
        const hidden = outputs.last_hidden_state ?? outputs.token_embeddings;
        if (!hidden) throw new Error(`Model "${model}" has no last_hidden_state output`);
        const mask = encoding.attention_mask;
        if (pooling === "cls") rows = poolCls(hidden);
        else {
          if (!mask) throw new Error("Tokenizer returned no attention_mask");
          rows = pooling === "mean" ? poolMean(hidden, mask) : poolLastToken(hidden, mask);
        }
      }
      if (rows.length !== texts.length) throw new Error(`Model returned ${rows.length} vectors for ${texts.length} texts`);
      return rows.map((r) => truncateAndNormalize(r, dims));
    } finally {
      disposeAll(outputs);
      disposeAll(encoding);
    }
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
      const loaded = await (loadPromise as Promise<Loaded>);
      const prefix = kind === "query" ? queryPrefix : documentPrefix;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize).map((t) => prefix + t);
        const vectors = await embedBatch(loaded, batch);
        const first = vectors[0];
        if (first && observedDims === undefined) observedDims = first.length;
        out.push(...vectors);
        if (i + batchSize < texts.length) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return out;
    });

  return {
    get id() {
      return `${spaceId}:${runtime?.dtype ?? requestedDtype}`;
    },
    get spaceId() {
      return spaceId;
    },
    minScore,
    get info(): EmbedderInfo {
      return {
        model,
        device: runtime?.device,
        dtype: runtime?.dtype,
        pooling,
        dims: dims ?? known?.fullDims ?? observedDims,
        maxLength,
        license: known?.license
      };
    },
    load,
    embed,
    async dispose() {
      const p = loadPromise;
      loadPromise = undefined;
      if (!p) return;
      const loaded = await p.catch(() => undefined);
      await loaded?.model.dispose?.();
    }
  };
}
