import test from "node:test";
import assert from "node:assert/strict";

const {
  createTransformersEmbedder, KNOWN_EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL,
  detectWebGpu, resolveRuntime, DEFAULT_DTYPES,
  toFloat32, poolCls, poolMean, poolLastToken, takeSentenceEmbedding, truncateAndNormalize
} = await import("../dist/index.js");

// ---------------------------------------------------------------------------
// A stub of @huggingface/transformers' AutoTokenizer/AutoModel: whitespace tokens, int64
// tensors (BigInt64Array) padded on the RIGHT (like Jina's tokenizer), and a model whose
// outputs are deterministic functions of the token ids and positions, so expected vectors can
// be computed independently. Real tokens' hidden states depend on the token id only (so the
// padding side cannot matter); pad positions get large, position-dependent values: any
// pooling that leaks them breaks the expectation.

const hiddenValue = (id, s, k) => (id === 0 ? (1000 + s) * (k + 1) : id * 3 * (k + 1) + 0.5);
const sentenceValue = (sum, k) => sum + k;

function tensor(type, data, dims) {
  const t = { type, data, dims, disposed: false };
  t.dispose = () => { t.disposed = true; };
  return t;
}

function createStub({ hidden = 4, sentence = 6, failDevices = [], padSide = "right", withSentence = true, delayMs = 2 } = {}) {
  const seen = { tokenizer: [], model: [], calls: [], forwards: 0, disposed: 0, tensors: [] };
  const vocab = new Map();
  const idOf = (w) => {
    if (!vocab.has(w)) vocab.set(w, vocab.size + 1);
    return vocab.get(w);
  };
  const ids = (text) => text.split(/\s+/).filter(Boolean).map(idOf);
  let active = 0;
  const stats = { maxActive: 0 };

  const tokenizer = (texts, options) => {
    seen.calls.push({ texts: [...texts], options: { ...options } });
    const seqs = texts.map((t) => ids(t).slice(0, options.max_length ?? Infinity));
    const S = Math.max(1, ...seqs.map((s) => s.length));
    const B = texts.length;
    const inputIds = new BigInt64Array(B * S);
    const mask = new BigInt64Array(B * S);
    seqs.forEach((s, b) => {
      const offset = padSide === "right" ? 0 : S - s.length;
      s.forEach((id, i) => {
        inputIds[b * S + offset + i] = BigInt(id);
        mask[b * S + offset + i] = 1n;
      });
    });
    const enc = {
      input_ids: tensor("int64", inputIds, [B, S]),
      attention_mask: tensor("int64", mask, [B, S]),
      token_type_ids: tensor("int64", new BigInt64Array(B * S), [B, S])
    };
    seen.tensors.push(...Object.values(enc));
    return enc;
  };

  const model = async (enc) => {
    active += 1;
    stats.maxActive = Math.max(stats.maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    seen.forwards += 1;
    const [B, S] = enc.input_ids.dims;
    const tokenIds = enc.input_ids.data;
    const lh = new Float32Array(B * S * hidden);
    for (let b = 0; b < B; b += 1) {
      for (let s = 0; s < S; s += 1) {
        for (let k = 0; k < hidden; k += 1) lh[(b * S + s) * hidden + k] = hiddenValue(Number(tokenIds[b * S + s]), s, k);
      }
    }
    const out = { last_hidden_state: tensor("float32", lh, [B, S, hidden]) };
    if (withSentence) {
      const se = new Float32Array(B * sentence);
      for (let b = 0; b < B; b += 1) {
        let sum = 0;
        for (let s = 0; s < S; s += 1) sum += Number(tokenIds[b * S + s]);
        for (let k = 0; k < sentence; k += 1) se[b * sentence + k] = sentenceValue(sum, k);
      }
      out.sentence_embedding = tensor("float32", se, [B, sentence]);
    }
    seen.tensors.push(...Object.values(out));
    return out;
  };
  model.dispose = async () => { seen.disposed += 1; };

  const module = {
    AutoTokenizer: {
      async from_pretrained(name, opts) {
        seen.tokenizer.push({ name, opts });
        opts?.progress_callback?.({ status: "progress", file: "tokenizer.json", loaded: 10, total: 10 });
        return tokenizer;
      }
    },
    AutoModel: {
      async from_pretrained(name, opts) {
        seen.model.push({ name, opts });
        if (failDevices.includes(opts.device)) throw new Error(`no ${opts.device} here`);
        opts.progress_callback?.({ status: "progress", file: "model.onnx", loaded: 50, total: 100 });
        opts.progress_callback?.({ status: "progress", file: "model.onnx", loaded: 100, total: 100 });
        return model;
      }
    },
    env: {}
  };
  return { module, seen, stats, ids, hidden, sentence };
}

const normalize = (values) => {
  const n = Math.sqrt(values.reduce((s, x) => s + x * x, 0)) || 1;
  return values.map((x) => x / n);
};
const close = (actual, expected, label = "", eps = 1e-5) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i += 1) assert.ok(Math.abs(actual[i] - expected[i]) < eps, `${label}[${i}] ${actual[i]} vs ${expected[i]}`);
};
const expectCls = (stub, text) => normalize(Array.from({ length: stub.hidden }, (_, k) => hiddenValue(stub.ids(text)[0], 0, k)));
const expectMean = (stub, text) => {
  const ids = stub.ids(text);
  return normalize(Array.from({ length: stub.hidden }, (_, k) => ids.reduce((s, id, pos) => s + hiddenValue(id, pos, k), 0) / ids.length));
};
const expectLast = (stub, text) => {
  const ids = stub.ids(text);
  return normalize(Array.from({ length: stub.hidden }, (_, k) => hiddenValue(ids.at(-1), ids.length - 1, k)));
};
const expectSentence = (stub, text) => {
  const sum = stub.ids(text).reduce((a, b) => a + b, 0);
  return normalize(Array.from({ length: stub.sentence }, (_, k) => sentenceValue(sum, k)));
};

function withFakeGpu(features, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const adapter = features === null ? null : { features: new Set(features) };
  Object.defineProperty(globalThis, "navigator", { value: { gpu: { requestAdapter: async () => adapter } }, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  });
}

function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  return Promise.resolve().then(fn).then(
    (v) => { console.warn = original; return { value: v, warnings }; },
    (e) => { console.warn = original; throw e; }
  );
}

const custom = (stub, extra = {}) => createTransformersEmbedder(stub.module, { model: "custom/model", pooling: "mean", minScore: 0.1, ...extra });

// ---------------------------------------------------------------------------

test("model table: LEAF is the default; every entry is complete", () => {
  assert.equal(DEFAULT_EMBEDDING_MODEL, "MongoDB/mdbr-leaf-ir");
  const leaf = KNOWN_EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL];
  assert.equal(leaf.pooling, "sentence_embedding");
  assert.equal(leaf.queryPrefix, "Represent this sentence for searching relevant passages: ");
  assert.equal(leaf.documentPrefix, "");
  assert.equal(leaf.fullDims, 768);
  assert.equal(leaf.license, "Apache-2.0");
  const jina = KNOWN_EMBEDDING_MODELS["jinaai/jina-embeddings-v5-text-nano-retrieval"];
  assert.equal(jina.pooling, "last_token");
  assert.deepEqual([jina.queryPrefix, jina.documentPrefix], ["Query: ", "Document: "]);
  assert.deepEqual(jina.devices, ["webgpu"]);
  assert.equal(jina.license, "CC-BY-NC-4.0");
  assert.equal(jina.dtype.webgpu, "q4f16");
  assert.equal(KNOWN_EMBEDDING_MODELS["Xenova/bge-small-en-v1.5"].pooling, "cls");
  assert.equal(KNOWN_EMBEDDING_MODELS["Xenova/all-MiniLM-L6-v2"].pooling, "mean");
  for (const [id, m] of Object.entries(KNOWN_EMBEDDING_MODELS)) {
    assert.ok(["cls", "mean", "last_token", "sentence_embedding"].includes(m.pooling), id);
    assert.equal(typeof m.queryPrefix, "string", id);
    assert.equal(typeof m.documentPrefix, "string", id);
    assert.ok(m.fullDims > 0 && m.maxLength > 0 && m.minScore > 0 && m.params > 0, id);
    assert.deepEqual(Object.keys(m.dtype).sort(), ["cpu", "wasm", "webgpu", "webgpuNoF16"], id);
    assert.equal(typeof m.license, "string", id);
  }
});

test("pooling helpers: toFloat32, cls, mean, last_token, sentence_embedding, truncateAndNormalize", () => {
  assert.deepEqual([...toFloat32(new BigInt64Array([1n, 0n, 2n]))], [1, 0, 2]);
  const f32 = new Float32Array([1, 2]);
  assert.equal(toFloat32(f32), f32, "Float32Array passes through");
  assert.deepEqual([...toFloat32(new Uint16Array([0x3c00, 0xc000, 0x0000]), "float16")], [1, -2, 0], "raw half-precision bits are decoded");
  assert.deepEqual([...toFloat32([0.5, 1.5])], [0.5, 1.5]);

  // [2, 3, 2]: row 0 has two real tokens (right padded), row 1 has three.
  const hidden = { data: new Float32Array([1, 2, 3, 4, 90, 90, 5, 6, 7, 8, 9, 10]), dims: [2, 3, 2] };
  const mask = { data: new BigInt64Array([1n, 1n, 0n, 1n, 1n, 1n]), dims: [2, 3] };
  assert.deepEqual(poolCls(hidden).map((v) => [...v]), [[1, 2], [5, 6]]);
  assert.deepEqual(poolMean(hidden, mask).map((v) => [...v]), [[2, 3], [7, 8]], "pads are excluded from the mean");
  assert.deepEqual(poolLastToken(hidden, mask).map((v) => [...v]), [[3, 4], [9, 10]], "the last position with mask 1");
  const leftMask = { data: new BigInt64Array([0n, 1n, 1n, 1n, 1n, 1n]), dims: [2, 3] };
  assert.deepEqual(poolLastToken(hidden, leftMask).map((v) => [...v]), [[90, 90], [9, 10]], "left padding: still the last real token");
  assert.deepEqual(poolMean(hidden, { data: [0, 0, 0, 1, 1, 1], dims: [2, 3] })[0], new Float32Array(2), "an all-masked row is zeros");
  assert.deepEqual(poolLastToken(hidden, { data: [0, 0, 0, 1, 1, 1], dims: [2, 3] })[0], new Float32Array(2));
  assert.deepEqual(takeSentenceEmbedding({ data: [1, 2, 3, 4, 5, 6], dims: [2, 3] }).map((v) => [...v]), [[1, 2, 3], [4, 5, 6]]);
  assert.throws(() => poolCls({ data: [], dims: [1, 2] }), /\[batch, seq, hidden\]/);

  const v = new Float32Array([3, 4, 12, 0]);
  close(truncateAndNormalize(v), [3 / 13, 4 / 13, 12 / 13, 0]);
  close(truncateAndNormalize(v, 2), [0.6, 0.8]);
  assert.notEqual(truncateAndNormalize(v), v, "always a new array");
  assert.deepEqual([...truncateAndNormalize(new Float32Array(3))], [0, 0, 0], "zero stays zero");
  assert.equal(truncateAndNormalize(v, 10).length, 4, "dims larger than the vector: unchanged length");
});

test("tokenizer call: padding/truncation/max_length; tokenizerOptions forwarded", async () => {
  const stub = createStub();
  const embedder = custom(stub, { maxLength: 32, tokenizerOptions: { revision: "r1" } });
  await embedder.embed(["alpha beta", "gamma"], "document");
  assert.deepEqual(stub.seen.calls[0].options, { padding: true, truncation: true, max_length: 32 });
  assert.equal(stub.seen.tokenizer[0].name, "custom/model");
  assert.equal(stub.seen.tokenizer[0].opts.revision, "r1");
  assert.equal(typeof stub.seen.tokenizer[0].opts.progress_callback, "function");

  const defaults = createStub();
  await custom(defaults).embed(["x"], "query");
  assert.equal(defaults.seen.calls[0].options.max_length, 256, "default maxLength");
  const leaf = createStub();
  await createTransformersEmbedder(leaf.module, {}).embed(["x"], "document");
  assert.equal(leaf.seen.calls[0].options.max_length, KNOWN_EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL].maxLength);
});

test("cls pooling takes position 0 and normalises", async () => {
  const stub = createStub();
  const embedder = custom(stub, { pooling: "cls" });
  const [a, b] = await embedder.embed(["one two three", "four"], "document");
  close(a, expectCls(stub, "one two three"), "a");
  close(b, expectCls(stub, "four"), "b");
  assert.ok(a instanceof Float32Array);
});

test("mean pooling is attention-mask weighted (right padding never leaks)", async () => {
  const stub = createStub();
  const embedder = custom(stub, { pooling: "mean" });
  const texts = ["one two three four", "five", "six seven"];
  const batched = await embedder.embed(texts, "document");
  texts.forEach((t, i) => close(batched[i], expectMean(stub, t), t));
  for (const t of texts) {
    const [single] = await embedder.embed([t], "document");
    close(single, batched[texts.indexOf(t)], `${t} batched == unbatched`);
  }
});

test("last_token pooling follows the mask: unequal-length batch equals unbatched, any padding side", async () => {
  for (const padSide of ["right", "left"]) {
    const stub = createStub({ padSide });
    const embedder = custom(stub, { pooling: "last_token" });
    const texts = ["one two three four five", "six", "seven eight"];
    const batched = await embedder.embed(texts, "document");
    texts.forEach((t, i) => close(batched[i], expectLast(stub, t), `${padSide} ${t}`));
    for (const t of texts) {
      const [single] = await embedder.embed([t], "document");
      close(single, batched[texts.indexOf(t)], `${padSide} ${t} batched == unbatched`);
    }
    assert.equal(stub.seen.calls[0].texts.length, 3, "one batch");
  }
});

test("sentence_embedding pooling reads the model's sentence_embedding output and ignores last_hidden_state", async () => {
  const stub = createStub({ hidden: 4, sentence: 6 });
  const embedder = custom(stub, { pooling: "sentence_embedding" });
  const [a, b] = await embedder.embed(["one two", "three"], "document");
  assert.equal(a.length, 6, "sentence_embedding width, not the hidden size");
  close(a, expectSentence(stub, "one two"), "a");
  close(b, expectSentence(stub, "three"), "b");
  assert.equal(embedder.info.dims, 6, "observed after the first embed for an unknown model");

  const without = createStub({ withSentence: false });
  await assert.rejects(custom(without, { pooling: "sentence_embedding" }).embed(["x"], "document"), /sentence_embedding/);
});

test("dims truncates and renormalises; it is part of spaceId", async () => {
  const stub = createStub();
  const embedder = custom(stub, { pooling: "cls", dims: 2 });
  const [v] = await embedder.embed(["one two"], "document");
  assert.equal(v.length, 2);
  const raw = Array.from({ length: 4 }, (_, k) => hiddenValue(stub.ids("one two")[0], 0, k));
  close(v, normalize(raw.slice(0, 2)));
  assert.ok(Math.abs(Math.sqrt(v[0] ** 2 + v[1] ** 2) - 1) < 1e-6);
  assert.equal(embedder.spaceId, "transformers:custom/model:cls:2:256:");
  assert.equal(embedder.info.dims, 2);
});

test("identity: spaceId is fixed, id carries the dtype resolved by load(), info fills in", async () => {
  const stub = createStub();
  const embedder = custom(stub, { documentPrefix: "D: ", queryPrefix: "Q: " });
  assert.equal(embedder.spaceId, "transformers:custom/model:mean:full:256:D: ");
  assert.equal(embedder.id, "transformers:custom/model:mean:full:256:D: :auto", "before load the dtype is still auto");
  assert.deepEqual(embedder.info, { model: "custom/model", device: undefined, dtype: undefined, pooling: "mean", dims: undefined, maxLength: 256, license: undefined });
  assert.equal(embedder.minScore, 0.1);

  await embedder.load();
  assert.equal(embedder.id, "transformers:custom/model:mean:full:256:D: :fp32", "unknown model on Node's CPU -> fp32");
  assert.equal(embedder.spaceId, "transformers:custom/model:mean:full:256:D: ");
  assert.deepEqual(embedder.info, { model: "custom/model", device: "cpu", dtype: "fp32", pooling: "mean", dims: undefined, maxLength: 256, license: undefined });
  assert.deepEqual(stub.seen.model[0].opts.device, "cpu");
  assert.deepEqual(stub.seen.model[0].opts.dtype, "fp32");

  await embedder.embed(["one"], "query");
  assert.deepEqual(stub.seen.calls.at(-1).texts, ["Q: one"]);
  await embedder.embed(["one"], "document");
  assert.deepEqual(stub.seen.calls.at(-1).texts, ["D: one"]);
  assert.equal(embedder.info.dims, 4, "observed vector size");

  const explicit = custom(createStub(), { dtype: "q8", device: "wasm" });
  assert.equal(explicit.id, "transformers:custom/model:mean:full:256::q8", "an explicit dtype is final before load");
});

test("known model on Node: auto -> cpu with the table's cpu dtype, prefixes and license applied", async () => {
  const stub = createStub();
  const embedder = createTransformersEmbedder(() => Promise.resolve(stub.module), {});
  assert.equal(embedder.spaceId, `transformers:${DEFAULT_EMBEDDING_MODEL}:sentence_embedding:full:256:`);
  assert.equal(embedder.minScore, KNOWN_EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL].minScore);
  await embedder.load();
  assert.equal(stub.seen.model[0].name, DEFAULT_EMBEDDING_MODEL);
  assert.equal(stub.seen.model[0].opts.device, "cpu");
  assert.equal(stub.seen.model[0].opts.dtype, "fp32");
  assert.equal(embedder.id, `${embedder.spaceId}:fp32`);
  assert.deepEqual(embedder.info, { model: DEFAULT_EMBEDDING_MODEL, device: "cpu", dtype: "fp32", pooling: "sentence_embedding", dims: 768, maxLength: 256, license: "Apache-2.0" });

  const [q] = await embedder.embed(["smoking"], "query");
  assert.equal(q.length, 6, "the sentence_embedding output is used");
  assert.deepEqual(stub.seen.calls.at(-1).texts, ["Represent this sentence for searching relevant passages: smoking"]);
  await embedder.embed(["smoking"], "document");
  assert.deepEqual(stub.seen.calls.at(-1).texts, ["smoking"], "documents carry no prefix");

  const explicit = createTransformersEmbedder(createStub().module, { dtype: "q8", device: "wasm" });
  await explicit.load();
  assert.equal(explicit.info.device, "wasm");
  assert.equal(explicit.info.dtype, "q8");
});

test("WebGPU: auto resolves to webgpu/fp16 with shader-f16; a failing session falls back to WASM", async () => {
  await withFakeGpu(["shader-f16"], async () => {
    const stub = createStub({ failDevices: ["webgpu"] });
    const embedder = createTransformersEmbedder(stub.module, {});
    const { warnings } = await captureWarnings(() => embedder.load());
    assert.deepEqual(stub.seen.model.map((m) => [m.opts.device, m.opts.dtype]), [["webgpu", "fp16"], ["wasm", "q8"]]);
    assert.equal(embedder.info.device, "wasm");
    assert.equal(embedder.info.dtype, "q8");
    assert.equal(embedder.id, `${embedder.spaceId}:q8`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /retrying on WASM/);
    assert.equal(stub.seen.tokenizer.length, 1, "the tokenizer is loaded once");
    await embedder.embed(["x"], "document");

    // An explicit device never falls back unless asked.
    const strict = createStub({ failDevices: ["webgpu"] });
    await assert.rejects(createTransformersEmbedder(strict.module, { device: "webgpu" }).load(), /no webgpu/);
    assert.equal(strict.seen.model.length, 1);
    const opted = createStub({ failDevices: ["webgpu"] });
    const e = createTransformersEmbedder(opted.module, { device: "webgpu", dtype: "fp32", fallbackToWasm: true });
    await captureWarnings(() => e.load());
    assert.deepEqual(opted.seen.model.map((m) => [m.opts.device, m.opts.dtype]), [["webgpu", "fp32"], ["wasm", "fp32"]], "an explicit dtype is kept on WASM");

    // A working WebGPU session.
    const ok = createStub();
    const gpu = createTransformersEmbedder(ok.module, {});
    await gpu.load();
    assert.deepEqual([gpu.info.device, gpu.info.dtype], ["webgpu", "fp16"]);
    assert.equal(gpu.id, `${gpu.spaceId}:fp16`);
  });

  await withFakeGpu([], async () => {
    const stub = createStub();
    const embedder = createTransformersEmbedder(stub.module, {});
    await embedder.load();
    assert.deepEqual([embedder.info.device, embedder.info.dtype], ["webgpu", "fp32"], "no shader-f16 -> the webgpuNoF16 dtype");
    const jina = createStub();
    const j = createTransformersEmbedder(jina.module, { model: "jinaai/jina-embeddings-v5-text-nano-retrieval" });
    await j.load();
    assert.equal(j.info.dtype, "q8");
  });

  await withFakeGpu(null, async () => {
    const stub = createStub();
    const embedder = createTransformersEmbedder(stub.module, {});
    await embedder.load();
    assert.deepEqual([embedder.info.device, embedder.info.dtype], ["wasm", "q8"], "navigator.gpu without an adapter (not Node): wasm");
  });
});

test("detectWebGpu and resolveRuntime", async () => {
  assert.deepEqual(await detectWebGpu(), { available: false, f16: false }, "no WebGPU under Node");
  await withFakeGpu(["shader-f16"], async () => assert.deepEqual(await detectWebGpu(), { available: true, f16: true }));
  await withFakeGpu([], async () => assert.deepEqual(await detectWebGpu(), { available: true, f16: false }));
  await withFakeGpu(null, async () => assert.deepEqual(await detectWebGpu(), { available: false, f16: false }));

  assert.deepEqual(DEFAULT_DTYPES, { webgpu: "fp16", webgpuNoF16: "fp32", wasm: "q8", cpu: "fp32" });
  const none = { available: false, f16: false };
  assert.deepEqual(await resolveRuntime({ device: "auto", dtype: "auto", isNode: true, webgpu: none }), { device: "cpu", dtype: "fp32", fromAuto: true });
  assert.deepEqual(await resolveRuntime({ device: "auto", dtype: "auto", isNode: false, webgpu: none }), { device: "wasm", dtype: "q8", fromAuto: true });
  assert.deepEqual(await resolveRuntime({ device: "auto", dtype: "auto", webgpu: { available: true, f16: true } }), { device: "webgpu", dtype: "fp16", fromAuto: true });
  assert.deepEqual(await resolveRuntime({ device: "auto", dtype: "auto", webgpu: { available: true, f16: false } }), { device: "webgpu", dtype: "fp32", fromAuto: true });
  assert.deepEqual(await resolveRuntime({ device: "webgpu", dtype: "auto", webgpu: { available: true, f16: true } }), { device: "webgpu", dtype: "fp16", fromAuto: false });
  assert.deepEqual(await resolveRuntime({ device: "wasm", dtype: "fp16" }), { device: "wasm", dtype: "fp16", fromAuto: false }, "explicit values pass through");
  const jina = KNOWN_EMBEDDING_MODELS["jinaai/jina-embeddings-v5-text-nano-retrieval"];
  assert.equal((await resolveRuntime({ device: "auto", known: jina, webgpu: { available: true, f16: true } })).dtype, "q4f16");
  assert.equal((await resolveRuntime({ device: "wasm", known: jina })).dtype, "q8");
  assert.equal((await resolveRuntime({ device: "cpu", known: jina })).dtype, "fp32");
  assert.equal((await resolveRuntime({ device: "webnn-gpu" })).dtype, "fp32", "unknown devices use the cpu dtype");
  assert.deepEqual(await resolveRuntime(), { device: "cpu", dtype: "fp32", fromAuto: true }, "defaults under Node");
});

test("Jina outside WebGPU warns once; unknown models warn about missing options", async () => {
  const { warnings } = await captureWarnings(async () => {
    const stub = createStub();
    const a = createTransformersEmbedder(stub.module, { model: "jinaai/jina-embeddings-v5-text-nano-retrieval" });
    await a.load();
    assert.deepEqual([a.info.device, a.info.dtype, a.info.pooling, a.info.license], ["cpu", "fp32", "last_token", "CC-BY-NC-4.0"]);
    await a.embed(["x"], "query");
    assert.deepEqual(stub.seen.calls.at(-1).texts, ["Query: x"]);
    await a.embed(["x"], "document");
    assert.deepEqual(stub.seen.calls.at(-1).texts, ["Document: x"]);
    await createTransformersEmbedder(createStub().module, { model: "jinaai/jina-embeddings-v5-text-nano-retrieval" }).load();
  });
  assert.equal(warnings.filter((w) => /webgpu only/.test(w)).length, 1, "warned once for the same model/device");

  const unknown = await captureWarnings(() => createTransformersEmbedder(createStub().module, { model: "someone/new-model" }));
  assert.equal(unknown.warnings.filter((w) => /not a verified embedding model/.test(w)).length, 1);
  const again = await captureWarnings(() => createTransformersEmbedder(createStub().module, { model: "someone/new-model" }));
  assert.equal(again.warnings.length, 0, "only once per model");
  const complete = await captureWarnings(() => createTransformersEmbedder(createStub().module, { model: "someone/other-model", pooling: "cls", minScore: 0.2 }));
  assert.equal(complete.warnings.length, 0, "explicit pooling + minScore: no warning");
});

test("pipelineOptions is a deprecated alias of modelOptions; both reach AutoModel.from_pretrained", async () => {
  const stub = createStub();
  const embedder = custom(stub, { pipelineOptions: { revision: "p", subfolder: "onnx" }, modelOptions: { session_options: { x: 1 }, revision: "m" } });
  await embedder.load();
  const opts = stub.seen.model[0].opts;
  assert.equal(opts.revision, "m", "modelOptions wins over the alias");
  assert.equal(opts.subfolder, "onnx");
  assert.deepEqual(opts.session_options, { x: 1 });
  assert.equal(opts.device, "cpu");
  assert.equal(opts.dtype, "fp32");
  assert.equal(typeof opts.progress_callback, "function");
});

test("serial queue, batching, progress aggregation, tensor disposal and dispose()", async () => {
  const stub = createStub();
  const embedder = custom(stub, { batchSize: 2 });
  const progress = [];
  await embedder.load((p) => progress.push(p));
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.some((p) => p > 0 && p < 1), "aggregated per-file progress");
  // tokenizer 10/10 alone reads 1, then the model's 50/100 pulls the aggregate down to 60/110.
  assert.ok(progress.some((p) => Math.abs(p - 60 / 110) < 1e-9), `aggregate over every file seen so far: ${progress}`);
  assert.ok(progress.every((p) => p >= 0 && p <= 1));

  const vectors = await embedder.embed(["a b", "c", "d e f"], "document");
  assert.equal(vectors.length, 3);
  assert.equal(stub.seen.forwards, 2, "3 texts with batchSize 2 -> 2 model calls");
  assert.ok(stub.seen.tensors.every((t) => t.disposed), "input and output tensors are disposed");

  await Promise.all([embedder.embed(["x"], "query"), embedder.embed(["y"], "query"), embedder.embed(["z"], "document")]);
  assert.equal(stub.stats.maxActive, 1, "model calls never overlap");
  assert.equal(stub.seen.model.length, 1, "the model is created once");

  await embedder.dispose();
  assert.equal(stub.seen.disposed, 1);
  await embedder.dispose();
  assert.equal(stub.seen.disposed, 1, "idempotent");
  await embedder.embed(["again"], "query");
  assert.equal(stub.seen.model.length, 2, "reloaded after dispose");
});

test("a failed load can be retried", async () => {
  let attempts = 0;
  const stub = createStub();
  const embedder = custom(stub, {});
  const flaky = createTransformersEmbedder(() => {
    attempts += 1;
    return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(stub.module);
  }, { model: "custom/model", pooling: "mean", minScore: 0.1 });
  await assert.rejects(flaky.load(), /offline/);
  await flaky.load();
  assert.equal(attempts, 2);
  assert.equal(flaky.info.device, "cpu");
  await embedder.embed(["ok"], "query");
});
