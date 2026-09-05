// Precomputed vector snapshots (`.jsddvec`): every unique text of a dictionary embedded once
// (offline, in Node) so browsers skip indexing entirely. A snapshot is keyed by `textKey`
// (content hash + length) per text, so an edited description only re-embeds that text, and it
// is tagged with the embedding space and the text-template version so the index can refuse a
// stale file rather than mix vector spaces.
//
// Binary layout (little-endian):
//   "JSDDSNAP"                       8-byte magic
//   uint32 headerLength              a multiple of 4 (the JSON is space-padded)
//   UTF-8 JSON header                { format: "jsdd-vectors", version: 1, createdAt, embedderId,
//                                      spaceId, textVersion, dims, quantization, count, keys,
//                                      chunkRow?, chunkKey?, table? }
//   payload                          fp32: Float32Array(count × dims)
//                                    int8: Int8Array(count × dims), pad to 4, Float32Array(count) scales
// The payload offset is 12 + headerLength, a multiple of 4, so an fp32 matrix is a zero-copy
// view. int8 is symmetric per-vector quantisation (`scale = max|v| / 127`), ~4× smaller at
// cosine ≥ 0.999 to the original — Node 22 has no Float16Array, and int8 is smaller anyway.

import type { DataDictionaryTable } from "../types";
import type { Embedder } from "./types";
import { EMBED_TEXT_VERSION, prepareTexts } from "./text";
import { textKey } from "./cache";
import { truncateAndNormalize } from "./pooling";

export type SnapshotQuantization = "fp32" | "int8";

export interface VectorSnapshot {
  version: 1;
  /** `Embedder.id` of the embedder that produced the vectors. */
  embedderId: string;
  /** `Embedder.spaceId` (or `id`); the index only accepts a snapshot from its own space. */
  spaceId: string;
  /** `EMBED_TEXT_VERSION` the texts were built with. */
  textVersion: number;
  dims: number;
  /** How the vectors were stored ("fp32" for a freshly built snapshot). */
  quantization: SnapshotQuantization;
  count: number;
  /** `textKey` per vector (row of `matrix`). */
  keys: string[];
  /** Per chunk: index into the table's rows (informational). */
  chunkRow?: number[] | undefined;
  /** Per chunk: index into `keys` (informational). */
  chunkKey?: number[] | undefined;
  /** `count × dims` unit vectors, row-major. */
  matrix: Float32Array;
  createdAt?: string | undefined;
  table?: { title?: string | undefined; rows: number } | undefined;
}

export interface BuildVectorSnapshotOptions {
  embedder: Embedder;
  /** Keep the first `dims` components of every vector (Matryoshka models) and renormalise. */
  dims?: number | undefined;
  /** Texts per `embed()` call. Default: 16. */
  batchSize?: number | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/** Embed every unique text of `table` (background sentences included), longest texts first. */
export async function buildVectorSnapshot(table: DataDictionaryTable, options: BuildVectorSnapshotOptions): Promise<VectorSnapshot> {
  const { embedder } = options;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 16));
  const dims = options.dims !== undefined && options.dims > 0 ? Math.floor(options.dims) : undefined;
  if (embedder.load) await embedder.load();

  const prepared = prepareTexts(table);
  const texts = prepared.uniqueTexts;
  const total = texts.length;
  const order = texts.map((_, i) => i).sort((a, b) => (texts[b] as string).length - (texts[a] as string).length || a - b);

  const vectors: Array<Float32Array | undefined> = new Array<Float32Array | undefined>(total).fill(undefined);
  let width = 0;
  let done = 0;
  options.onProgress?.(0, total);
  for (let i = 0; i < order.length; i += batchSize) {
    const batch = order.slice(i, i + batchSize);
    const out = await embedder.embed(
      batch.map((t) => texts[t] as string),
      "document"
    );
    if (out.length !== batch.length) throw new Error(`Embedder returned ${out.length} vectors for ${batch.length} texts`);
    batch.forEach((t, k) => {
      const raw = out[k] as Float32Array;
      const v = dims !== undefined && raw.length > dims ? truncateAndNormalize(raw, dims) : raw;
      if (v.length === 0) throw new Error("Embedder returned empty vectors");
      if (width === 0) width = v.length;
      else if (v.length !== width) throw new Error("Embedder returned vectors of different lengths");
      vectors[t] = v;
    });
    done += batch.length;
    options.onProgress?.(done, total);
  }

  const matrix = new Float32Array(total * width);
  vectors.forEach((v, t) => {
    if (v) matrix.set(v, t * width);
  });
  return {
    version: 1,
    embedderId: embedder.id,
    spaceId: embedder.spaceId ?? embedder.id,
    textVersion: EMBED_TEXT_VERSION,
    dims: width,
    quantization: "fp32",
    count: total,
    keys: texts.map(textKey),
    chunkRow: prepared.chunkRow,
    chunkKey: prepared.chunkText,
    matrix,
    createdAt: new Date().toISOString(),
    table: { ...(table.title !== undefined ? { title: table.title } : {}), rows: table.rows.length }
  };
}

const MAGIC = "JSDDSNAP";
const FORMAT = "jsdd-vectors";
const HEADER_OFFSET = 12;

export interface EncodeVectorSnapshotOptions {
  /** Default: "fp32". */
  quantization?: SnapshotQuantization | undefined;
}

interface SnapshotHeader {
  format: string;
  version: number;
  createdAt?: string | undefined;
  embedderId: string;
  spaceId: string;
  textVersion: number;
  dims: number;
  quantization: SnapshotQuantization;
  count: number;
  keys: string[];
  chunkRow?: number[] | undefined;
  chunkKey?: number[] | undefined;
  table?: { title?: string | undefined; rows: number } | undefined;
}

/** Serialise a snapshot into the `.jsddvec` binary layout. */
export function encodeVectorSnapshot(snapshot: VectorSnapshot, options: EncodeVectorSnapshotOptions = {}): ArrayBuffer {
  const quantization = options.quantization ?? "fp32";
  const { count, dims } = snapshot;
  if (snapshot.keys.length !== count) throw new Error("Snapshot keys/count mismatch");
  if (snapshot.matrix.length !== count * dims) throw new Error("Snapshot matrix/dims mismatch");

  const header: SnapshotHeader = {
    format: FORMAT,
    version: 1,
    createdAt: snapshot.createdAt ?? new Date().toISOString(),
    embedderId: snapshot.embedderId,
    spaceId: snapshot.spaceId,
    textVersion: snapshot.textVersion,
    dims,
    quantization,
    count,
    keys: snapshot.keys,
    ...(snapshot.chunkRow ? { chunkRow: snapshot.chunkRow } : {}),
    ...(snapshot.chunkKey ? { chunkKey: snapshot.chunkKey } : {}),
    ...(snapshot.table ? { table: snapshot.table } : {})
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headerLength = Math.ceil(json.length / 4) * 4;

  const n = count * dims;
  const payloadLength = quantization === "fp32" ? n * 4 : Math.ceil(n / 4) * 4 + count * 4;
  const buffer = new ArrayBuffer(HEADER_OFFSET + headerLength + payloadLength);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i += 1) bytes[i] = MAGIC.charCodeAt(i);
  new DataView(buffer).setUint32(8, headerLength, true);
  bytes.set(json, HEADER_OFFSET);
  bytes.fill(0x20, HEADER_OFFSET + json.length, HEADER_OFFSET + headerLength);

  const payload = HEADER_OFFSET + headerLength;
  if (quantization === "fp32") {
    new Float32Array(buffer, payload, n).set(snapshot.matrix);
  } else {
    const q = new Int8Array(buffer, payload, n);
    const scales = new Float32Array(buffer, payload + Math.ceil(n / 4) * 4, count);
    const m = snapshot.matrix;
    for (let r = 0; r < count; r += 1) {
      const off = r * dims;
      let max = 0;
      for (let k = 0; k < dims; k += 1) max = Math.max(max, Math.abs(m[off + k] as number));
      const scale = max / 127;
      scales[r] = scale;
      if (scale === 0) continue;
      for (let k = 0; k < dims; k += 1) q[off + k] = Math.max(-127, Math.min(127, Math.round((m[off + k] as number) / scale)));
    }
  }
  return buffer;
}

/** Parse a `.jsddvec` buffer. Throws on an unknown magic or version; int8 payloads are dequantised. */
export function decodeVectorSnapshot(bytes: ArrayBuffer | Uint8Array): VectorSnapshot {
  // Typed-array views need 4-byte alignment; copy an unaligned view once.
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteOffset % 4 !== 0) u8 = u8.slice();
  if (u8.length < HEADER_OFFSET) throw new Error("Not a vector snapshot (truncated)");
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error("Not a vector snapshot (bad magic)");
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLength = view.getUint32(8, true);
  if (headerLength % 4 !== 0 || HEADER_OFFSET + headerLength > u8.length) throw new Error("Not a vector snapshot (bad header length)");

  let header: SnapshotHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(u8.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength))) as SnapshotHeader;
  } catch {
    throw new Error("Not a vector snapshot (bad header)");
  }
  if (header.format !== FORMAT) throw new Error("Not a vector snapshot (bad format)");
  if (header.version !== 1) throw new Error(`Unsupported vector snapshot version ${String(header.version)}`);
  const { count, dims, quantization } = header;
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(dims) || dims <= 0) throw new Error("Vector snapshot has invalid dims/count");
  if (!Array.isArray(header.keys) || header.keys.length !== count) throw new Error("Vector snapshot keys/count mismatch");
  if (quantization !== "fp32" && quantization !== "int8") throw new Error(`Unsupported vector snapshot quantization ${String(quantization)}`);

  const n = count * dims;
  const payload = u8.byteOffset + HEADER_OFFSET + headerLength;
  let matrix: Float32Array;
  if (quantization === "fp32") {
    if (payload + n * 4 > u8.byteOffset + u8.byteLength) throw new Error("Vector snapshot payload truncated");
    matrix = new Float32Array(u8.buffer, payload, n);
  } else {
    const scalesAt = payload + Math.ceil(n / 4) * 4;
    if (scalesAt + count * 4 > u8.byteOffset + u8.byteLength) throw new Error("Vector snapshot payload truncated");
    const q = new Int8Array(u8.buffer, payload, n);
    const scales = new Float32Array(u8.buffer, scalesAt, count);
    matrix = new Float32Array(n);
    for (let r = 0; r < count; r += 1) {
      const off = r * dims;
      const scale = scales[r] as number;
      let sum = 0;
      for (let k = 0; k < dims; k += 1) {
        const x = (q[off + k] as number) * scale;
        matrix[off + k] = x;
        sum += x * x;
      }
      // Restore unit length (quantisation shortens vectors slightly).
      if (sum > 0) {
        const inv = 1 / Math.sqrt(sum);
        for (let k = 0; k < dims; k += 1) matrix[off + k] = (matrix[off + k] as number) * inv;
      }
    }
  }

  return {
    version: 1,
    embedderId: String(header.embedderId ?? ""),
    spaceId: String(header.spaceId ?? ""),
    textVersion: Number(header.textVersion),
    dims,
    quantization,
    count,
    keys: header.keys.map(String),
    ...(Array.isArray(header.chunkRow) ? { chunkRow: header.chunkRow } : {}),
    ...(Array.isArray(header.chunkKey) ? { chunkKey: header.chunkKey } : {}),
    matrix,
    ...(typeof header.createdAt === "string" ? { createdAt: header.createdAt } : {}),
    ...(header.table && typeof header.table === "object" ? { table: header.table } : {})
  };
}

/** Minimal `fetch` shape (so tests can stub it and the type never mentions the DOM). */
export type SnapshotFetch = (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export type VectorSnapshotSource = VectorSnapshot | ArrayBuffer | Uint8Array | string;

function isSnapshot(value: unknown): value is VectorSnapshot {
  return typeof value === "object" && value !== null && (value as { matrix?: unknown }).matrix instanceof Float32Array && Array.isArray((value as { keys?: unknown }).keys);
}

/** Resolve a snapshot from an object, bytes, or a URL (fetched with `fetch`). */
export async function loadVectorSnapshot(source: VectorSnapshotSource, fetchImpl?: SnapshotFetch): Promise<VectorSnapshot> {
  if (typeof source === "string") {
    const f = fetchImpl ?? ((globalThis as { fetch?: SnapshotFetch }).fetch as SnapshotFetch | undefined);
    if (!f) throw new Error("fetch is not available to load the vector snapshot");
    const res = await f(source);
    if (!res.ok) throw new Error(`Vector snapshot request failed (${String(res.status ?? "error")}): ${source}`);
    return decodeVectorSnapshot(await res.arrayBuffer());
  }
  if (isSnapshot(source)) return source;
  return decodeVectorSnapshot(source);
}
