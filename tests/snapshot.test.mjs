import test from "node:test";
import assert from "node:assert/strict";
import { loadDir, findRow } from "./_helpers.mjs";
import { createFakeEmbedder, syntheticTable } from "./_fakeEmbedder.mjs";

const {
  schemaDocumentsToTable, prepareTexts, textKey, EMBED_TEXT_VERSION,
  buildVectorSnapshot, encodeVectorSnapshot, decodeVectorSnapshot, loadVectorSnapshot,
  createSemanticIndex
} = await import("../dist/index.js");

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const prepared = prepareTexts(bcrpp);

const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const row = (snap, i) => snap.matrix.subarray(i * snap.dims, (i + 1) * snap.dims);

/** A dense deterministic embedder (every component non-zero) with a space id and info. */
function denseEmbedder({ id = "dense:fp32", spaceId = "dense", dims = 128 } = {}) {
  const calls = { document: 0, query: 0, texts: [] };
  return {
    id, spaceId, calls,
    info: { model: "dense", dims },
    async load() {},
    async embed(texts, kind) {
      calls[kind] += texts.length;
      calls.texts.push(...texts);
      return texts.map((text) => {
        let h = 7;
        for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const v = new Float32Array(dims);
        let n = 0;
        for (let i = 0; i < dims; i += 1) {
          h = (Math.imul(h, 1103515245) + 12345) >>> 0;
          v[i] = (h % 1000) / 1000 - 0.45;
          n += v[i] * v[i];
        }
        n = Math.sqrt(n);
        for (let i = 0; i < dims; i += 1) v[i] /= n;
        return v;
      });
    }
  };
}

/** The fake bag-of-words embedder with a space id (as a real adapter would report). */
function spacedFake(options = {}) {
  const e = createFakeEmbedder({ id: "fake:q8", ...options });
  e.spaceId = "fake-space";
  return e;
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

function parseHeader(bytes) {
  const u8 = new Uint8Array(bytes);
  const magic = String.fromCharCode(...u8.subarray(0, 8));
  const headerLength = new DataView(bytes).getUint32(8, true);
  const json = new TextDecoder().decode(u8.subarray(12, 12 + headerLength));
  return { magic, headerLength, header: JSON.parse(json), payloadOffset: 12 + headerLength };
}

test("buildVectorSnapshot embeds every unique text once, longest first, background included", async () => {
  const embedder = spacedFake();
  const progress = [];
  const snap = await buildVectorSnapshot(bcrpp, { embedder, onProgress: (done, total) => progress.push([done, total]) });
  const total = prepared.uniqueTexts.length;
  assert.equal(snap.version, 1);
  assert.equal(snap.count, total);
  assert.equal(snap.dims, 512);
  assert.equal(snap.quantization, "fp32");
  assert.equal(snap.embedderId, "fake:q8");
  assert.equal(snap.spaceId, "fake-space");
  assert.equal(snap.textVersion, EMBED_TEXT_VERSION);
  assert.deepEqual(snap.keys, prepared.uniqueTexts.map(textKey));
  assert.deepEqual(snap.chunkRow, prepared.chunkRow);
  assert.deepEqual(snap.chunkKey, prepared.chunkText);
  assert.deepEqual(snap.table, { title: bcrpp.title, rows: bcrpp.rows.length });
  assert.equal(snap.matrix.length, total * 512);
  assert.match(snap.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(embedder.calls.document, total, "every unique text exactly once");
  assert.equal(new Set(embedder.calls.texts).size, total);
  assert.ok(embedder.calls.texts.every((t, i) => i === 0 || embedder.calls.texts[i - 1].length >= t.length), "longest texts first");
  assert.ok(prepared.uniqueTexts.slice(0, prepared.backgroundCount).every((t) => embedder.calls.texts.includes(t)), "background sentences are included");
  assert.deepEqual(progress[0], [0, total]);
  assert.deepEqual(progress.at(-1), [total, total]);

  const [expected] = await embedder.embed([prepared.uniqueTexts[20]], "document");
  assert.deepEqual([...row(snap, 20)], [...expected], "rows follow uniqueTexts order");

  const truncated = await buildVectorSnapshot(syntheticTable(), { embedder: denseEmbedder(), dims: 32 });
  assert.equal(truncated.dims, 32);
  for (let i = 0; i < truncated.count; i += 1) assert.ok(Math.abs(norm(row(truncated, i)) - 1) < 1e-5, "truncated rows are renormalised");

  const empty = await buildVectorSnapshot({ ...syntheticTable(), rows: [], categories: [] }, { embedder: spacedFake() });
  assert.equal(empty.count, 0);
  assert.equal(empty.dims, 0);
});

test("fp32 encode/decode round trip is exact, 4-byte aligned and zero-copy", async () => {
  const snap = await buildVectorSnapshot(bcrpp, { embedder: spacedFake() });
  const bytes = encodeVectorSnapshot(snap);
  assert.ok(bytes instanceof ArrayBuffer);
  const { magic, headerLength, header, payloadOffset } = parseHeader(bytes);
  assert.equal(magic, "JSDDSNAP");
  assert.equal(headerLength % 4, 0);
  assert.equal(payloadOffset % 4, 0, "the matrix can be a typed-array view");
  assert.equal(bytes.byteLength, payloadOffset + snap.count * snap.dims * 4);
  assert.equal(header.format, "jsdd-vectors");
  assert.equal(header.version, 1);
  assert.equal(header.quantization, "fp32");
  assert.equal(header.count, snap.count);
  assert.equal(header.dims, 512);
  assert.equal(header.spaceId, "fake-space");
  assert.equal(header.embedderId, "fake:q8");
  assert.equal(header.textVersion, EMBED_TEXT_VERSION);
  assert.deepEqual(header.keys, snap.keys);
  assert.deepEqual(header.chunkRow, snap.chunkRow);
  assert.deepEqual(header.table, snap.table);
  assert.equal(typeof header.createdAt, "string");

  const decoded = decodeVectorSnapshot(bytes);
  assert.deepEqual([...decoded.matrix], [...snap.matrix]);
  assert.equal(decoded.matrix.buffer, bytes, "fp32 payload is a view over the file bytes");
  assert.deepEqual(decoded.keys, snap.keys);
  assert.deepEqual(decoded.chunkRow, snap.chunkRow);
  assert.deepEqual(decoded.chunkKey, snap.chunkKey);
  assert.deepEqual(decoded.table, snap.table);
  assert.equal(decoded.createdAt, snap.createdAt);
  assert.deepEqual(
    { ...decoded, matrix: undefined, keys: undefined, chunkRow: undefined, chunkKey: undefined },
    { ...snap, matrix: undefined, keys: undefined, chunkRow: undefined, chunkKey: undefined }
  );
});

test("int8 encode/decode: cosine >= 0.999 per vector, unit norm, ~4x smaller", async () => {
  const snap = await buildVectorSnapshot(bcrpp, { embedder: denseEmbedder({ dims: 768 }) });
  const fp32 = encodeVectorSnapshot(snap, { quantization: "fp32" });
  const int8 = encodeVectorSnapshot(snap, { quantization: "int8" });
  const { header, payloadOffset } = parseHeader(int8);
  assert.equal(header.quantization, "int8");
  const n = snap.count * snap.dims;
  assert.equal(int8.byteLength, payloadOffset + Math.ceil(n / 4) * 4 + snap.count * 4, "int8 payload + pad + fp32 scales");
  assert.ok(int8.byteLength < fp32.byteLength / 3.5, `${int8.byteLength} vs ${fp32.byteLength}`);

  const decoded = decodeVectorSnapshot(int8);
  assert.equal(decoded.quantization, "int8");
  assert.equal(decoded.count, snap.count);
  let worst = 1;
  for (let i = 0; i < snap.count; i += 1) {
    const c = cosine(row(decoded, i), row(snap, i));
    worst = Math.min(worst, c);
    assert.ok(Math.abs(norm(row(decoded, i)) - 1) < 1e-5, "dequantised rows are renormalised");
  }
  assert.ok(worst >= 0.999, `worst cosine ${worst}`);

  // A zero vector survives (scale 0).
  const zero = { ...snap, count: 1, keys: [snap.keys[0]], chunkRow: undefined, chunkKey: undefined, matrix: new Float32Array(snap.dims) };
  const z = decodeVectorSnapshot(encodeVectorSnapshot(zero, { quantization: "int8" }));
  assert.ok([...z.matrix].every((x) => x === 0));
});

test("decodeVectorSnapshot rejects bad magic, unsupported versions and truncated files", async () => {
  const snap = await buildVectorSnapshot(syntheticTable(), { embedder: spacedFake() });
  const bytes = encodeVectorSnapshot(snap);

  const badMagic = bytes.slice(0);
  new Uint8Array(badMagic)[0] = 0x58;
  assert.throws(() => decodeVectorSnapshot(badMagic), /bad magic/);
  assert.throws(() => decodeVectorSnapshot(new Uint8Array(100)), /bad magic/);
  assert.throws(() => decodeVectorSnapshot(new ArrayBuffer(4)), /truncated/);

  const badVersion = bytes.slice(0);
  const u8 = new Uint8Array(badVersion);
  const text = new TextDecoder().decode(u8.subarray(12, 12 + parseHeader(bytes).headerLength));
  const at = 12 + text.indexOf('"version":1') + '"version":'.length;
  u8[at] = "9".charCodeAt(0);
  assert.throws(() => decodeVectorSnapshot(badVersion), /version 9/);

  assert.throws(() => decodeVectorSnapshot(bytes.slice(0, bytes.byteLength - 8)), /truncated/);
  assert.throws(() => encodeVectorSnapshot({ ...snap, keys: snap.keys.slice(1) }), /keys\/count/);
});

test("loadVectorSnapshot: object passthrough, bytes, unaligned views and URLs", async () => {
  const snap = await buildVectorSnapshot(syntheticTable(), { embedder: spacedFake() });
  const bytes = encodeVectorSnapshot(snap, { quantization: "int8" });
  assert.equal(await loadVectorSnapshot(snap), snap);
  assert.deepEqual((await loadVectorSnapshot(bytes)).keys, snap.keys);
  assert.deepEqual((await loadVectorSnapshot(new Uint8Array(bytes))).keys, snap.keys);

  const padded = new Uint8Array(bytes.byteLength + 1);
  padded.set(new Uint8Array(bytes), 1);
  const unaligned = await loadVectorSnapshot(padded.subarray(1));
  assert.deepEqual([...unaligned.matrix], [...decodeVectorSnapshot(bytes).matrix], "an unaligned view is copied and decoded");

  // A Node Buffer view at an odd offset: Buffer.prototype.slice() returns a view, not a copy.
  const backing = Buffer.alloc(bytes.byteLength + 2);
  Buffer.from(bytes).copy(backing, 2);
  const buffered = backing.subarray(2);
  assert.equal(buffered.byteOffset % 4, 2, "the fixture is unaligned");
  assert.deepEqual([...decodeVectorSnapshot(buffered).matrix], [...decodeVectorSnapshot(bytes).matrix], "an unaligned Node Buffer decodes too");

  const requested = [];
  const fetchStub = async (url) => {
    requested.push(url);
    return url.endsWith("missing.jsddvec") ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } : { ok: true, status: 200, arrayBuffer: async () => bytes.slice(0) };
  };
  const fromUrl = await loadVectorSnapshot("https://example.test/vectors/x.jsddvec", fetchStub);
  assert.deepEqual(fromUrl.keys, snap.keys);
  await assert.rejects(loadVectorSnapshot("https://example.test/vectors/missing.jsddvec", fetchStub), /404/);
  assert.deepEqual(requested, ["https://example.test/vectors/x.jsddvec", "https://example.test/vectors/missing.jsddvec"]);
});

test("createSemanticIndex uses the snapshot: zero document embeds, same scores as embedding live", async () => {
  const builder = spacedFake();
  const snap = await buildVectorSnapshot(bcrpp, { embedder: builder });
  const bytes = encodeVectorSnapshot(snap);

  const live = createSemanticIndex(bcrpp, { embedder: spacedFake(), cache: false });
  await live.ready;

  for (const source of [bytes, new Uint8Array(bytes), snap]) {
    const embedder = spacedFake();
    const states = [];
    const index = createSemanticIndex(bcrpp, { embedder, cache: false, snapshot: source });
    index.subscribe((s) => states.push(s));
    await index.ready;
    assert.equal(embedder.calls.document, 0, "no document text is embedded");
    assert.equal(index.status.state, "ready");
    assert.equal(index.coverage, 1);
    const indexing = states.find((s) => s.state === "indexing");
    assert.deepEqual(indexing, { state: "indexing", done: snap.count, total: snap.count, coverage: 1 }, "the snapshot fills everything before the cache/embedder");

    for (const q of ["menopause", "tobacco", "body size"]) {
      const expected = await live.search(q, { minScore: -1 });
      const actual = await index.search(q, { minScore: -1 });
      assert.equal(actual.length, expected.length);
      assert.equal(actual[0].row, expected[0].row);
      actual.forEach((h, i) => assert.ok(Math.abs(h.score - expected[i].score) < 1e-6, `${q}: ${h.score} vs ${expected[i].score}`));
    }
  }

  // int8 vectors rank the same rows first.
  const embedder = spacedFake();
  const quantised = createSemanticIndex(bcrpp, { embedder, cache: false, snapshot: encodeVectorSnapshot(snap, { quantization: "int8" }) });
  await quantised.ready;
  assert.equal(embedder.calls.document, 0);
  const menoIdx = bcrpp.rows.indexOf(findRow(bcrpp, "meno_status"));
  const hits = await quantised.search("menopause");
  assert.ok(hits.length > 0);
  assert.ok(hits.slice(0, 3).some((h) => h.row === menoIdx), "meno_status is among the top hits");
});

test("only texts missing from the snapshot are embedded (an edited description)", async () => {
  const snap = await buildVectorSnapshot(bcrpp, { embedder: spacedFake() });
  const bytes = encodeVectorSnapshot(snap);
  const edited = { ...bcrpp, rows: bcrpp.rows.map((r) => ({ ...r })) };
  const target = edited.rows.find((r) => r["Variable name"] === "meno_age");
  target["Description"] = "Age in years when menstrual periods stopped for good.";

  const snapshotKeys = new Set(snap.keys);
  const expected = prepareTexts(edited).uniqueTexts.filter((t) => !snapshotKeys.has(textKey(t)));
  assert.ok(expected.length >= 1 && expected.length <= 3, `the edited row contributes ${expected.length} new texts`);

  const embedder = spacedFake();
  const index = createSemanticIndex(edited, { embedder, cache: false, snapshot: bytes });
  await index.ready;
  assert.deepEqual(new Set(embedder.calls.texts), new Set(expected), "only the changed texts are embedded");
  assert.equal(embedder.calls.document, expected.length);
  const hits = await index.search("menopause", { minScore: -1 });
  assert.equal(hits.length, bcrpp.rows.length, "every row is searchable");
});

test("snapshots from another text version, embedding space or with too few dims are ignored with a warning", async () => {
  const snap = await buildVectorSnapshot(syntheticTable(), { embedder: spacedFake() });
  const total = prepareTexts(syntheticTable()).uniqueTexts.length;

  for (const [label, bad, pattern] of [
    ["textVersion", { ...snap, textVersion: EMBED_TEXT_VERSION + 1 }, /text template/],
    ["spaceId", { ...snap, spaceId: "other-space" }, /embedding space/],
    ["version", { ...snap, version: 2 }, /version/]
  ]) {
    const embedder = spacedFake();
    const { warnings } = await captureWarnings(async () => {
      const index = createSemanticIndex(syntheticTable(), { embedder, cache: false, snapshot: bad });
      await index.ready;
      assert.equal(index.status.state, "ready", label);
    });
    assert.equal(warnings.length, 1, `${label}: exactly one warning`);
    assert.match(warnings[0], pattern);
    assert.equal(embedder.calls.document, total, `${label}: everything is embedded live`);
  }

  // A snapshot with fewer dims than the embedder produces cannot be used.
  const small = await buildVectorSnapshot(syntheticTable(), { embedder: denseEmbedder(), dims: 64 });
  const dense = denseEmbedder();
  const { warnings } = await captureWarnings(() => createSemanticIndex(syntheticTable(), { embedder: dense, cache: false, snapshot: small }).ready);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /64-d vectors/);
  assert.equal(dense.calls.document, total);

  // Undecodable bytes and a failing URL: one warning, then indexing proceeds.
  for (const source of [new Uint8Array(64), "https://example.test/nope.jsddvec"]) {
    const embedder = spacedFake();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    try {
      const result = await captureWarnings(() => createSemanticIndex(syntheticTable(), { embedder, cache: false, snapshot: source }).ready);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /Could not use the vector snapshot/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(embedder.calls.document, total);
  }
});

test("a larger snapshot is truncated to the index dims and renormalised", async () => {
  const full = await buildVectorSnapshot(bcrpp, { embedder: denseEmbedder() });
  assert.equal(full.dims, 128);
  const bytes = encodeVectorSnapshot(full);

  const reference = createSemanticIndex(bcrpp, { embedder: denseEmbedder(), cache: false, dims: 64 });
  await reference.ready;

  const embedder = denseEmbedder();
  const index = createSemanticIndex(bcrpp, { embedder, cache: false, dims: 64, snapshot: bytes });
  await index.ready;
  assert.equal(embedder.calls.document, 0, "128-d vectors serve a 64-d index");
  for (const q of ["menopause", "smoking status"]) {
    const expected = await reference.search(q, { minScore: -1 });
    const actual = await index.search(q, { minScore: -1 });
    assert.equal(actual.length, expected.length);
    actual.forEach((h, i) => {
      assert.equal(h.row, expected[i].row);
      assert.ok(Math.abs(h.score - expected[i].score) < 1e-5, `${q}: ${h.score} vs ${expected[i].score}`);
    });
  }

  // The adapter's own `dims` (reported through `info`) is honoured when the index has none.
  const adapter = denseEmbedder({ dims: 128 });
  adapter.info = { model: "dense", dims: 64 };
  const raw = adapter.embed.bind(adapter);
  adapter.embed = async (texts, kind) => (await raw(texts, kind)).map((v) => {
    const t = v.slice(0, 64);
    const n = norm(t);
    for (let i = 0; i < 64; i += 1) t[i] /= n;
    return t;
  });
  const viaInfo = createSemanticIndex(bcrpp, { embedder: adapter, cache: false, snapshot: bytes });
  await viaInfo.ready;
  assert.equal(adapter.calls.document, 0);
  const hits = await viaInfo.search("menopause", { minScore: -1 });
  assert.equal(hits.length, bcrpp.rows.length);
});

test("a snapshot URL is fetched with the global fetch", async () => {
  const snap = await buildVectorSnapshot(syntheticTable(), { embedder: spacedFake() });
  const bytes = encodeVectorSnapshot(snap, { quantization: "int8" });
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => bytes.slice(0) };
  };
  try {
    const embedder = spacedFake();
    const index = createSemanticIndex(syntheticTable(), { embedder, cache: false, snapshot: "/vectors/synthetic.jsddvec" });
    await index.ready;
    assert.deepEqual(urls, ["/vectors/synthetic.jsddvec"]);
    assert.equal(embedder.calls.document, 0);
    assert.equal((await index.search("climacteric"))[0].row, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
