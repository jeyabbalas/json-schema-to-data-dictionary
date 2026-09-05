// Pure pooling helpers over tensor-shaped data (`{ data, dims }`), used by the Transformers.js
// adapter to turn a model's outputs into one unit vector per text. They know nothing about
// the runtime: `data` may be a Float32Array, a Float16Array (or its raw uint16 bits on
// platforms without Float16Array), or an int64 BigInt64Array (attention masks), so every
// helper first widens to Float32 and reads masks with `Number()`.
//
// `poolLastToken` scans each row's mask from the end for the last real token, which makes it
// padding-side agnostic: Transformers.js' pipeline picks the last *padded* position, which is
// wrong for right-padding tokenizers (Jina) as soon as a batch mixes lengths.

/** The subset of a Transformers.js `Tensor` the pooling helpers read. */
export interface TensorLike {
  data: ArrayLike<number> | ArrayLike<bigint>;
  dims: number[];
  /** ONNX data type ("float32", "float16", "int64", …). Only "float16" changes how `data` is read. */
  type?: string | undefined;
  dispose?: (() => void) | undefined;
}

/** Widen tensor data to a Float32Array (a no-op for Float32Array inputs). */
export function toFloat32(data: ArrayLike<number> | ArrayLike<bigint>, type?: string): Float32Array {
  if (data instanceof Float32Array) return data;
  if (type === "float16" && data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = halfToFloat(data[i] as number);
    return out;
  }
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = Number((data as ArrayLike<number | bigint>)[i]);
  return out;
}

/** Rows of a `[batch, hidden]` tensor (e.g. LEAF's `sentence_embedding`). */
export function takeSentenceEmbedding(tensor: TensorLike): Float32Array[] {
  const [batch, hidden] = shape2(tensor);
  const flat = toFloat32(tensor.data, tensor.type);
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b += 1) out.push(flat.slice(b * hidden, (b + 1) * hidden));
  return out;
}

/** Position 0 of every sequence in a `[batch, seq, hidden]` tensor. */
export function poolCls(hidden: TensorLike): Float32Array[] {
  const [batch, seq, size] = shape3(hidden);
  const flat = toFloat32(hidden.data, hidden.type);
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b += 1) {
    const off = b * seq * size;
    out.push(flat.slice(off, off + size));
  }
  return out;
}

/** Mask-weighted mean over the sequence of a `[batch, seq, hidden]` tensor. */
export function poolMean(hidden: TensorLike, mask: TensorLike): Float32Array[] {
  const [batch, seq, size] = shape3(hidden);
  const flat = toFloat32(hidden.data, hidden.type);
  const m = mask.data as ArrayLike<number | bigint>;
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b += 1) {
    const v = new Float32Array(size);
    let count = 0;
    for (let s = 0; s < seq; s += 1) {
      if (Number(m[b * seq + s]) === 0) continue;
      count += 1;
      const off = (b * seq + s) * size;
      for (let k = 0; k < size; k += 1) v[k] = (v[k] as number) + (flat[off + k] as number);
    }
    if (count > 0) for (let k = 0; k < size; k += 1) v[k] = (v[k] as number) / count;
    out.push(v);
  }
  return out;
}

/** The last position whose mask is 1 (scanning from the end), per sequence. */
export function poolLastToken(hidden: TensorLike, mask: TensorLike): Float32Array[] {
  const [batch, seq, size] = shape3(hidden);
  const flat = toFloat32(hidden.data, hidden.type);
  const m = mask.data as ArrayLike<number | bigint>;
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b += 1) {
    let last = -1;
    for (let s = seq - 1; s >= 0; s -= 1) {
      if (Number(m[b * seq + s]) !== 0) {
        last = s;
        break;
      }
    }
    if (last < 0) {
      out.push(new Float32Array(size));
      continue;
    }
    const off = (b * seq + last) * size;
    out.push(flat.slice(off, off + size));
  }
  return out;
}

/**
 * Keep the first `dims` components (Matryoshka truncation) and scale to unit length. Always
 * returns a new array; a zero vector stays zero.
 */
export function truncateAndNormalize(v: Float32Array, dims?: number): Float32Array {
  const out = dims !== undefined && dims > 0 && dims < v.length ? v.slice(0, Math.floor(dims)) : v.slice();
  let sum = 0;
  for (let k = 0; k < out.length; k += 1) sum += (out[k] as number) * (out[k] as number);
  if (sum > 0) {
    const inv = 1 / Math.sqrt(sum);
    for (let k = 0; k < out.length; k += 1) out[k] = (out[k] as number) * inv;
  }
  return out;
}

function shape2(tensor: TensorLike): [number, number] {
  const dims = tensor.dims;
  if (dims.length !== 2) throw new Error(`Expected a [batch, hidden] tensor, got dims [${dims.join(", ")}]`);
  return [dims[0] as number, dims[1] as number];
}

function shape3(tensor: TensorLike): [number, number, number] {
  const dims = tensor.dims;
  if (dims.length !== 3) throw new Error(`Expected a [batch, seq, hidden] tensor, got dims [${dims.join(", ")}]`);
  return [dims[0] as number, dims[1] as number, dims[2] as number];
}

/** IEEE 754 binary16 bits -> number. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
