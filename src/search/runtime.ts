// Execution-runtime resolution for the Transformers.js adapter: which device runs the model
// and at which weight precision. "auto" prefers WebGPU when an adapter can be acquired, the
// ONNX CPU provider under Node, and single-threaded WASM elsewhere; the dtype then follows a
// per-device table (fp16 needs the `shader-f16` WebGPU feature, so the probe reports it).
// Everything here is environment sniffing only — no ML runtime is imported.

/** What a WebGPU probe found. */
export interface WebGpuSupport {
  /** `navigator.gpu.requestAdapter()` returned an adapter. */
  available: boolean;
  /** The adapter exposes the `shader-f16` feature (fp16 weights run natively). */
  f16: boolean;
}

/** Weight precision per resolved device. */
export interface DtypeTable {
  webgpu: string;
  /** WebGPU without `shader-f16`. */
  webgpuNoF16: string;
  wasm: string;
  /** Node's ONNX Runtime CPU provider. */
  cpu: string;
}

/** Dtypes for models without a verified entry: fp16 on WebGPU, q8 on WASM, fp32 otherwise. */
export const DEFAULT_DTYPES: Readonly<DtypeTable> = { webgpu: "fp16", webgpuNoF16: "fp32", wasm: "q8", cpu: "fp32" };

export interface ResolveRuntimeOptions {
  /** "auto" (default), "webgpu", "wasm", "cpu", or any device string Transformers.js accepts. */
  device?: string | undefined;
  /** "auto" (default) or an explicit dtype ("fp32", "fp16", "q8", "q4f16", …). */
  dtype?: string | undefined;
  /** The model's per-device dtype table (see `KNOWN_EMBEDDING_MODELS`). */
  known?: { dtype: DtypeTable } | undefined;
  /** Override the Node detection (default: `process.versions.node` present and no `navigator.gpu`). */
  isNode?: boolean | undefined;
  /** Skip the probe and use this result instead. */
  webgpu?: WebGpuSupport | undefined;
}

export interface ResolvedRuntime {
  device: string;
  dtype: string;
  /** The device came from "auto" (a failing WebGPU session may then fall back to WASM). */
  fromAuto: boolean;
}

interface GpuLike {
  requestAdapter?: (options?: unknown) => Promise<{ features?: { has(name: string): boolean } | undefined } | null>;
}

function navigatorGpu(): GpuLike | undefined {
  const nav = (globalThis as { navigator?: { gpu?: GpuLike | undefined } | undefined }).navigator;
  return nav?.gpu ?? undefined;
}

/** True under Node (or Bun/Deno exposing `process.versions.node`) when no WebGPU is exposed. */
export function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: unknown } | undefined } | undefined }).process;
  return typeof proc?.versions?.node === "string" && navigatorGpu() === undefined;
}

/** Probe WebGPU: `navigator.gpu.requestAdapter()` plus the `shader-f16` feature. Never throws. */
export async function detectWebGpu(): Promise<WebGpuSupport> {
  const gpu = navigatorGpu();
  if (!gpu || typeof gpu.requestAdapter !== "function") return { available: false, f16: false };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { available: false, f16: false };
    let f16 = false;
    try {
      f16 = adapter.features?.has("shader-f16") ?? false;
    } catch {
      f16 = false;
    }
    return { available: true, f16 };
  } catch {
    return { available: false, f16: false };
  }
}

/** Resolve "auto" device/dtype requests into concrete values (explicit values pass through). */
export async function resolveRuntime(options: ResolveRuntimeOptions = {}): Promise<ResolvedRuntime> {
  const wantDevice = options.device ?? "auto";
  const wantDtype = options.dtype ?? "auto";
  const table = options.known?.dtype ?? DEFAULT_DTYPES;

  // The probe is only needed when WebGPU is a candidate (auto) or its f16 support matters
  // (explicit webgpu with an auto dtype).
  let webgpu: WebGpuSupport | undefined = options.webgpu;
  const needsProbe = wantDevice === "auto" || (wantDevice === "webgpu" && wantDtype === "auto");
  if (needsProbe && !webgpu) webgpu = await detectWebGpu();

  let device = wantDevice;
  let fromAuto = false;
  if (wantDevice === "auto") {
    fromAuto = true;
    if (webgpu?.available) device = "webgpu";
    else if (options.isNode ?? isNodeRuntime()) device = "cpu";
    else device = "wasm";
  }

  let dtype = wantDtype;
  if (wantDtype === "auto") {
    if (device === "webgpu") dtype = webgpu?.f16 ? table.webgpu : table.webgpuNoF16;
    else if (device === "wasm") dtype = table.wasm;
    else dtype = table.cpu;
  }
  return { device, dtype, fromAuto };
}
