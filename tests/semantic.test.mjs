import test from "node:test";
import assert from "node:assert/strict";
import { loadDir, findRow } from "./_helpers.mjs";
import { createFakeEmbedder, syntheticTable } from "./_fakeEmbedder.mjs";

// fake-indexeddb provides a pure-JS IndexedDB for the cache tests (skipped if absent).
let fakeIdb = false;
try {
  await import("fake-indexeddb/auto");
  fakeIdb = true;
} catch {
  fakeIdb = false;
}

const {
  schemaDocumentsToTable, buildEmbedChunks, prepareTexts, humanizeName, EMBED_TEXT_VERSION,
  createSemanticIndex, createMemoryVectorCache, createIndexedDbVectorCache, cacheKey,
  keywordScore, fuseRankings, rankResults,
  serveEmbedder, createWorkerEmbedder,
  createTransformersEmbedder, KNOWN_EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL
} = await import("../dist/index.js");

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await tick(2);
  }
}

test("humanizeName", () => {
  assert.equal(humanizeName("age_at_menarche"), "age at menarche");
  assert.equal(humanizeName("bodyMassIndex"), "body Mass Index");
  assert.equal(humanizeName("BMI"), "BMI");
  assert.equal(humanizeName("meno-age.v2"), "meno age v2");
});

test("buildEmbedChunks v2: identity chunk carries both names, drops regex formats; values chunks unchanged", () => {
  assert.equal(EMBED_TEXT_VERSION, 2);
  const chunks = buildEmbedChunks(bcrpp);
  assert.equal(new Set(chunks.map((c) => c.row)).size, bcrpp.rows.length, "every row has a chunk");

  const menoIdx = bcrpp.rows.indexOf(findRow(bcrpp, "meno_age"));
  const meno = chunks.filter((c) => c.row === menoIdx);
  assert.match(meno[0].text, /^meno age \(meno_age\): /);
  assert.match(meno[0].text, /menopause/i);

  const subject = chunks.find((c) => c.row === bcrpp.rows.indexOf(findRow(bcrpp, "subject_id")));
  assert.match(subject.text, /^subject id \(subject_id\): Subject ID/);
  assert.doesNotMatch(subject.text, /Matches pattern/, "regex formats are not embedded");

  const valueChunks = chunks.filter((c) => /Values: /.test(c.text));
  assert.ok(valueChunks.length > 0, "categorical rows get a values chunk");
  for (const c of valueChunks) {
    const labels = c.text.slice(c.text.indexOf("Values: "));
    assert.doesNotMatch(labels, /Missing\/Unknown/, `sentinel codes are never embedded as values: ${labels}`);
    assert.doesNotMatch(c.text, /^\S+ \(\S+\): /, "values chunks keep the v1 lead (humanised name only)");
  }
});

test("buildEmbedChunks v2: synthetic table shapes and fallbacks", () => {
  const chunks = buildEmbedChunks(syntheticTable());
  const byRow = (i) => chunks.filter((c) => c.row === i).map((c) => c.text);
  assert.deepEqual(byRow(0), [
    "meno status (meno_status): Menopausal status at baseline",
    "meno status: Menopausal status at baseline. Values: Premenopausal; Postmenopausal"
  ]);
  assert.match(byRow(1)[1], /Former \(Quit more than a year ago\)/);
  assert.deepEqual(byRow(2), ["height cm (height_cm): Standing height in centimetres"], "measurement ranges are not values chunks");
  assert.deepEqual(byRow(3), ["age: Age at questionnaire completion in years"], "the raw name is omitted when it equals the humanised form");

  const big = buildEmbedChunks(syntheticTable(28)); // 2 + 28 labels -> 12, 12, 6
  assert.equal(big.filter((c) => c.row === 1).length, 1 + 3);

  const table = syntheticTable();
  table.rows[0]["Format"] = "date";
  table.rows[1]["Description"] = "";
  table.rows[2]["Format"] = "Matches pattern ^[0-9]+$";
  const t = buildEmbedChunks(table);
  assert.equal(t.find((c) => c.row === 0).text, "meno status (meno_status): Menopausal status at baseline (date)");
  assert.equal(t.find((c) => c.row === 1).text, "tobacco use (tobacco_use) (string)", "no description: name(s) + data type");
  assert.equal(t.find((c) => c.row === 2).text, "height cm (height_cm): Standing height in centimetres");
  assert.equal(t.filter((c) => c.row === 1)[1].text, "tobacco use. Values: Never; Former (Quit more than a year ago)");
});

test("prepareTexts: background sentences first, interned unique texts, chunk maps", () => {
  const p = prepareTexts(bcrpp);
  assert.equal(p.backgroundCount, 12);
  assert.equal(p.chunks.length, buildEmbedChunks(bcrpp).length);
  assert.equal(p.chunkText.length, p.chunks.length);
  assert.equal(p.chunkRow.length, p.chunks.length);
  assert.equal(new Set(p.uniqueTexts).size, p.uniqueTexts.length, "texts are unique");
  p.chunks.forEach((c, i) => {
    assert.equal(p.uniqueTexts[p.chunkText[i]], c.text);
    assert.equal(p.chunkRow[i], c.row);
    assert.ok(p.chunkText[i] >= 12 || p.uniqueTexts.indexOf(c.text) < 12, "row texts come after the background");
  });
  assert.match(p.uniqueTexts[0], /^Identifier assigned/);

  const dup = syntheticTable();
  dup.rows[3]["Description"] = dup.rows[2]["Description"];
  dup.rows[3]["Variable name"] = dup.rows[2]["Variable name"];
  const d = prepareTexts(dup);
  assert.equal(d.chunks.length, 6, "two identity + values pairs, then two identical identity chunks");
  assert.equal(d.uniqueTexts.length, 12 + 5, "identical texts are interned once");
  assert.equal(d.chunkText[4], d.chunkText[5]);
  assert.deepEqual(d.chunkRow, [0, 0, 1, 1, 2, 3]);

  const empty = prepareTexts({ ...syntheticTable(), rows: [], categories: [] });
  assert.deepEqual(empty, { chunks: [], uniqueTexts: [], chunkText: [], chunkRow: [], backgroundCount: 0 });
});

test("cacheKey embeds the template version and varies by id and text", () => {
  assert.match(cacheKey("m", "t"), new RegExp(`^m\\|v${EMBED_TEXT_VERSION}\\|`));
  assert.notEqual(cacheKey("m", "a"), cacheKey("m", "b"));
  assert.notEqual(cacheKey("m", "a"), cacheKey("n", "a"));
});

test("createSemanticIndex: embeds through the cache and answers queries", async () => {
  const embedder = createFakeEmbedder();
  const cache = createMemoryVectorCache();
  const states = [];
  const index = createSemanticIndex(syntheticTable(), { embedder, cache, batchSize: 2 });
  index.subscribe((s) => states.push(s.state));
  await index.ready;
  assert.equal(index.status.state, "ready");
  assert.ok(states.includes("indexing"));
  assert.ok(states.at(-1) === "ready");
  assert.ok(index.size >= 4);
  assert.equal(index.coverage, 1);

  const hits = await index.search("climacteric");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].row, 0, "synonym of menopause finds meno_status");
  assert.ok(!hits.some((h) => h.row === 1));
  assert.equal((await index.search("climacteric", { limit: 1 })).length, 1);
  assert.equal((await index.search("climacteric", { minScore: 1.01 })).length, 0);
  assert.deepEqual(await index.search("   "), []);

  const docCalls = embedder.calls.document;
  const second = createSemanticIndex(syntheticTable(), { embedder, cache });
  await second.ready;
  assert.equal(embedder.calls.document, docCalls, "second index is served from the cache");

  const other = createFakeEmbedder({ id: "fake-bow-v2" });
  const third = createSemanticIndex(syntheticTable(), { embedder: other, cache });
  await third.ready;
  assert.ok(other.calls.document > 0, "a different embedder id misses the cache");
});

test("createSemanticIndex: cache keys use spaceId when present, and dims namespaces + truncates", async () => {
  const cache = createMemoryVectorCache();
  const a = createFakeEmbedder({ id: "model:q8" });
  a.spaceId = "model";
  await createSemanticIndex(syntheticTable(), { embedder: a, cache }).ready;
  const texts = prepareTexts(syntheticTable()).uniqueTexts;
  assert.equal((await cache.getMany(texts.map((t) => cacheKey("model", t)))).size, texts.length, "keys are built from spaceId");

  const b = createFakeEmbedder({ id: "model:fp16" });
  b.spaceId = "model";
  await createSemanticIndex(syntheticTable(), { embedder: b, cache }).ready;
  assert.equal(b.calls.document, 0, "another precision of the same space reuses every vector");

  // A dense deterministic embedder (128-d, every component non-zero) so truncation to 64
  // dimensions never yields a zero vector (the bag-of-words fake is sparse).
  const dense = () => {
    const calls = { document: 0, query: 0 };
    return {
      id: "dense:q8",
      spaceId: "dense",
      calls,
      async embed(texts, kind) {
        calls[kind] += texts.length;
        return texts.map((text) => {
          let h = 7;
          for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          const v = new Float32Array(128);
          let n = 0;
          for (let i = 0; i < 128; i += 1) {
            h = (Math.imul(h, 1103515245) + 12345) >>> 0;
            v[i] = (h % 1000) / 1000 + 0.05;
            n += v[i] * v[i];
          }
          n = Math.sqrt(n);
          for (let i = 0; i < 128; i += 1) v[i] /= n;
          return v;
        });
      }
    };
  };
  const c = dense();
  const truncated = createSemanticIndex(syntheticTable(), { embedder: c, cache, dims: 64 });
  await truncated.ready;
  assert.equal(c.calls.document, texts.length, "dims is a separate namespace: everything is embedded");
  const stored = await cache.getMany(texts.map((t) => cacheKey("dense|d64", t)));
  assert.equal(stored.size, texts.length);
  for (const v of stored.values()) {
    assert.equal(v.length, 64);
    let n = 0;
    for (const x of v) n += x * x;
    assert.ok(Math.abs(n - 1) < 1e-5, "truncated vectors are renormalised");
  }
  const hits = await truncated.search("anything at all", { minScore: -1 });
  assert.equal(hits.length, 4, "query vectors are truncated the same way and every row scores");
  assert.ok(hits.every((h) => Number.isFinite(h.score) && Math.abs(h.score) <= 1 + 1e-6));
  const d = dense();
  await createSemanticIndex(syntheticTable(), { embedder: d, cache, dims: 64 }).ready;
  assert.equal(d.calls.document, 0, "the dims namespace is cached too");
  const e = dense();
  await createSemanticIndex(syntheticTable(), { embedder: e, cache }).ready;
  assert.equal(e.calls.document, texts.length, "no dims: a different namespace");
});

test("createSemanticIndex: dispose rejects ready, loaded and search", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ delayMs: 10 }), cache: false });
  index.dispose();
  await assert.rejects(index.ready, /disposed/);
  await assert.rejects(index.loaded, /disposed/);
  await assert.rejects(index.search("x"), /disposed/);
  await assert.rejects(index.search("x", { partial: true }), /disposed/);
});

test("createSemanticIndex: load failure becomes an error status", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ failLoad: "no model" }), cache: false });
  await assert.rejects(index.ready, /no model/);
  assert.equal(index.status.state, "error");
  assert.match(index.status.message, /no model/);
  await assert.rejects(index.search("x", { partial: true }), /no model/);
  assert.equal(index.coverage, 0);
});

test("createSemanticIndex: progressive indexing — loaded, coverage, background first, partial search", async () => {
  const embedder = createFakeEmbedder({ delayMs: 3 });
  const index = createSemanticIndex(bcrpp, { embedder, cache: false, batchSize: 4 });
  const statuses = [];
  index.subscribe((s) => statuses.push(s));
  await index.loaded;
  assert.equal(index.status.state, "indexing");
  assert.deepEqual(index.status, { state: "indexing", done: 0, total: prepareTexts(bcrpp).uniqueTexts.length, coverage: 0 });
  assert.equal(index.coverage, 0);
  assert.deepEqual(await index.search("menopause", { partial: true }), [], "nothing embedded yet");

  await until(() => index.coverage > 0.05);
  const hits = await index.search("menopause", { partial: true, minScore: -1 });
  assert.equal(index.status.state, "indexing", "still indexing after the partial search");
  const prepared = prepareTexts(bcrpp);
  const embedded = new Set(embedder.calls.texts);
  const embeddedRows = new Set(prepared.chunks.filter((c) => embedded.has(c.text)).map((c) => c.row));
  assert.ok(hits.length > 0, "partial searches answer over the embedded chunks");
  assert.ok(hits.every((h) => embeddedRows.has(h.row)), "and never return rows that are not embedded yet");
  assert.ok(embeddedRows.size < bcrpp.rows.length);

  await index.ready;
  const indexing = statuses.filter((s) => s.state === "indexing");
  assert.ok(indexing.length > 5);
  assert.ok(indexing.every((s, i) => i === 0 || (s.coverage >= indexing[i - 1].coverage && s.done >= indexing[i - 1].done)), "coverage and done never decrease");
  assert.equal(indexing.at(-1).coverage, 1);
  assert.equal(index.coverage, 1);
  const documentTexts = embedder.calls.texts.filter((t) => t !== "menopause"); // the query embed interleaves
  assert.deepEqual(new Set(documentTexts.slice(0, 12)), new Set(prepared.uniqueTexts.slice(0, 12)), "the background sentences are embedded first");
  const rest = documentTexts.slice(12);
  assert.ok(rest.every((t, i) => i === 0 || rest[i - 1].length >= t.length), "then the longest texts first");
  assert.equal(documentTexts.length, prepared.uniqueTexts.length, "every unique text exactly once");
  assert.equal(new Set(documentTexts).size, prepared.uniqueTexts.length);

  const complete = await index.search("menopause", { partial: true });
  assert.deepEqual(complete, await index.search("menopause"), "partial == full once ready");
});

test("createSemanticIndex: query vectors go through an LRU", async () => {
  const embedder = createFakeEmbedder();
  const index = createSemanticIndex(syntheticTable(), { embedder, cache: false });
  await index.ready;
  await index.search("climacteric");
  const calls = embedder.calls.query;
  await index.search("climacteric");
  await index.search(" climacteric ");
  await Promise.all([index.search("cigarette"), index.search("cigarette")]);
  assert.equal(embedder.calls.query, calls + 1, "repeated (and concurrent) queries embed once");
});

test("createSemanticIndex: scores at ready equal the 0.2.0 algorithm (centred copies) within 1e-6", async () => {
  const embedder = createFakeEmbedder();
  const index = createSemanticIndex(bcrpp, { embedder, cache: false });
  await index.ready;

  // The 0.2.0 algorithm: mean over the unique texts (background included), normalised centred
  // copies in Float32, cosine = dot product, best chunk per row.
  const prepared = prepareTexts(bcrpp);
  const vectors = await embedder.embed(prepared.uniqueTexts, "document");
  const dim = vectors[0].length;
  const mu = new Float32Array(dim);
  for (const v of vectors) for (let k = 0; k < dim; k += 1) mu[k] = mu[k] + v[k] / vectors.length;
  const centre = (v) => {
    const out = new Float32Array(dim);
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      out[k] = v[k] - mu[k];
      sum += out[k] * out[k];
    }
    const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let k = 0; k < dim; k += 1) out[k] *= inv;
    return out;
  };
  const centred = vectors.map(centre);
  let compared = 0;
  for (const q of ["menopause", "tobacco", "body size", "breast cancer family history", "xyzzy"]) {
    const [qv] = await embedder.embed([q], "query");
    const qc = centre(qv);
    const best = new Map();
    prepared.chunks.forEach((c, ci) => {
      const v = centred[prepared.chunkText[ci]];
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += v[k] * qc[k];
      if (!best.has(c.row) || dot > best.get(c.row)) best.set(c.row, dot);
    });
    const expected = [...best].map(([row, score]) => ({ row, score })).sort((a, b) => b.score - a.score || a.row - b.row);
    const actual = await index.search(q, { minScore: -1 });
    assert.equal(actual.length, expected.length, `${q}: every row scores`);
    assert.equal(actual[0].row, expected[0].row, `${q}: same best row`);
    // Rows with near-identical texts tie within float rounding, so compare per row, not per rank.
    for (const h of actual) {
      assert.ok(Math.abs(h.score - best.get(h.row)) < 1e-6, `${q}: row ${h.row} ${h.score} vs ${best.get(h.row)}`);
      compared += 1;
    }
    assert.ok(actual.every((h, i) => i === 0 || actual[i - 1].score >= h.score), "sorted best first");
  }
  assert.ok(compared > 400);
});

test("memory cache: retainOnly keeps only the given keys", async () => {
  const cache = createMemoryVectorCache();
  await cache.putMany([["a", new Float32Array([1])], ["b", new Float32Array([2])]]);
  await cache.retainOnly(["b", "missing"]);
  assert.deepEqual([...(await cache.getMany(["a", "b"])).keys()], ["b"]);
});

test("createSemanticIndex: progressive flushes (flushEvery) and a final put", async () => {
  const inner = createMemoryVectorCache();
  const puts = [];
  const cache = {
    getMany: (keys) => inner.getMany(keys),
    putMany: (entries) => { puts.push(entries.length); return inner.putMany(entries); },
    retainOnly: (keys) => inner.retainOnly(keys),
    clear: () => inner.clear()
  };
  const embedder = createFakeEmbedder({ delayMs: 1 });
  const index = createSemanticIndex(bcrpp, { embedder, cache, batchSize: 5, flushEvery: 20 });
  await until(() => puts.length > 0);
  assert.equal(index.status.state, "indexing", "vectors are persisted before the index is ready");
  await index.ready;
  const total = prepareTexts(bcrpp).uniqueTexts.length;
  assert.ok(puts.length >= Math.floor(total / 20), `flushed ${puts.length} times`);
  assert.equal(puts.reduce((a, b) => a + b, 0), total, "every fresh vector is written exactly once");
  assert.ok(puts.slice(0, -1).every((n) => n >= 20));
  const keys = prepareTexts(bcrpp).uniqueTexts.map((t) => cacheKey(embedder.id, t));
  assert.equal((await inner.getMany(keys)).size, total);
});

test("createSemanticIndex: the cache holds only the most recently indexed dictionary", async () => {
  const embedder = createFakeEmbedder();
  const cache = createMemoryVectorCache();
  const followUp = () => {
    const t = syntheticTable();
    for (const row of t.rows) row["Description"] = `Follow-up visit: ${row["Description"]}`;
    return t;
  };
  const keysOf = (table) => [...new Set(buildEmbedChunks(table).map((c) => c.text))].map((t) => cacheKey(embedder.id, t));
  const tableA = syntheticTable();
  const tableB = followUp();

  await createSemanticIndex(tableA, { embedder, cache }).ready;
  assert.equal((await cache.getMany(keysOf(tableA))).size, keysOf(tableA).length, "A is cached");

  await createSemanticIndex(tableB, { embedder, cache }).ready;
  assert.equal((await cache.getMany(keysOf(tableB))).size, keysOf(tableB).length, "B is cached");
  assert.equal((await cache.getMany(keysOf(tableA))).size, 0, "A's vectors are deleted once B is indexed");

  // The same dictionary again (a re-render builds a new table object with identical texts):
  // nothing is deleted and nothing is re-embedded, background sentences included.
  const fresh = createFakeEmbedder();
  await createSemanticIndex(followUp(), { embedder: fresh, cache }).ready;
  assert.equal(fresh.calls.document, 0, "re-indexing the same dictionary is served entirely from the cache");

  await createSemanticIndex(tableA, { embedder: fresh, cache }).ready;
  assert.ok(fresh.calls.document > 0, "A is embedded again after B replaced it");
  assert.equal((await cache.getMany(keysOf(tableB))).size, 0, "and B is gone in turn");

  // A cache without retainOnly is left alone.
  const bare = { getMany: async () => new Map(), putMany: async () => {}, clear: async () => {} };
  const index = createSemanticIndex(tableA, { embedder, cache: bare });
  await index.ready;
  assert.equal(index.status.state, "ready");
});

test("IndexedDB cache: round trip, views, foreign values, retainOnly, clear", { skip: fakeIdb ? false : "fake-indexeddb not installed" }, async () => {
  const dbName = `jsdd-test-${Date.now()}`;
  const cache = createIndexedDbVectorCache({ dbName });
  const big = new Float32Array([9, 9, 4, 5, 6, 9]);
  await cache.putMany([
    ["a", new Float32Array([1, 2, 3])],
    ["view", big.subarray(2, 5)]
  ]);
  const got = await cache.getMany(["a", "view", "missing"]);
  assert.deepEqual([...got.get("a")], [1, 2, 3]);
  assert.deepEqual([...got.get("view")], [4, 5, 6], "a view is stored as its own vector");
  assert.equal(got.has("missing"), false);

  await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("vectors", "readwrite");
      tx.objectStore("vectors").put("not a vector", "x");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  assert.equal((await cache.getMany(["x"])).has("x"), false, "foreign values are ignored");

  await cache.retainOnly(["view", "missing"]);
  const remaining = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onsuccess = () => {
      const db = req.result;
      const keysReq = db.transaction("vectors").objectStore("vectors").getAllKeys();
      keysReq.onsuccess = () => { db.close(); resolve(keysReq.result); };
      keysReq.onerror = () => reject(keysReq.error);
    };
    req.onerror = () => reject(req.error);
  });
  assert.deepEqual(remaining, ["view"], "retainOnly deletes every other key, foreign values included");

  await cache.clear();
  assert.equal((await cache.getMany(["view"])).size, 0);
});

const F = (name, description = "", values = "", extra = "") => ({
  name, description, values, all: [name, description, values, extra].join("  ").toLowerCase()
});

test("keywordScore buckets", () => {
  assert.equal(keywordScore(F("age"), "age"), 6);
  assert.equal(keywordScore(F("age_at_menarche"), "age"), 5);
  assert.equal(keywordScore(F("meno_age"), "age"), 4);
  assert.equal(keywordScore(F("x", "age at diagnosis"), "age"), 3);
  assert.equal(keywordScore(F("x", "", "1 = age"), "age"), 2);
  assert.equal(keywordScore(F("x", "", "", "{age}"), "age"), 1);
  assert.equal(keywordScore(F("x"), "age"), 0);
  assert.equal(keywordScore(F("age"), ""), 0);
});

test("fuseRankings: rows in both lists rank first", () => {
  const fused = fuseRankings([
    [{ row: 1, score: 1 }, { row: 2, score: 0.5 }],
    [{ row: 2, score: 0.9 }, { row: 3, score: 0.8 }]
  ]);
  assert.deepEqual(fused.map((h) => h.row), [2, 1, 3]);
});

test("rankResults: keyword buckets first, related capped, no duplicates", () => {
  const fields = [
    F("smoking_status", "Smoking status"),
    F("x", "notes about smoking"),
    F("cig_per_day", "Cigarettes per day"),
    F("copd", "Chronic obstructive"),
    F("other", "", "", "smoking")
  ];
  const hits = [{ row: 2, score: 0.9 }, { row: 0, score: 0.85 }, { row: 3, score: 0.8 }, { row: 4, score: 0.7 }];
  const ranked = rankResults(fields, "smoking", hits, 1);
  assert.deepEqual(ranked.map((r) => r.row), [0, 1, 4, 2]);
  assert.deepEqual(ranked.map((r) => r.exact), [true, true, true, false]);
  assert.equal(ranked[3].semanticScore, 0.9);
  assert.equal(new Set(ranked.map((r) => r.row)).size, ranked.length);
  assert.deepEqual(ranked.map((r) => [r.exactName, r.lexicalScore, r.matches]), [[false, 5, []], [false, 3, []], [false, 1, []], [false, 0, []]], "v2 fields are filled in");
  assert.equal(rankResults([F("smoking")], "smoking", undefined, 0)[0].exactName, true);

  const keywordOnly = rankResults(fields, "smoking", undefined, 5);
  assert.deepEqual(keywordOnly.map((r) => r.row), [0, 1, 4]);
  assert.ok(keywordOnly.every((r) => r.exact));

  const uncapped = rankResults(fields, "smoking", hits, 10);
  assert.deepEqual([...uncapped.map((r) => r.row)].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(rankResults(fields, "zzz", hits, 0), []);
});

test("worker RPC: round trip over a MessageChannel", async () => {
  const { port1, port2 } = new MessageChannel();
  const fake = createFakeEmbedder({ minScore: 0.42, failOn: "boom" });
  const stop = serveEmbedder(fake, port1);
  try {
    const remote = await createWorkerEmbedder(port2);
    assert.equal(remote.id, fake.id);
    assert.equal(remote.minScore, 0.42);

    const progress = [];
    await remote.load((p) => progress.push(p));
    assert.deepEqual(progress, [0.5, 1]);

    const [a, b] = await remote.embed(["tobacco use", "age"], "document");
    const [la, lb] = await fake.embed(["tobacco use", "age"], "document");
    assert.deepEqual([...a], [...la]);
    assert.deepEqual([...b], [...lb]);
    assert.equal(a.length, 512);

    await assert.rejects(remote.embed(["boom"], "query"), /fail: boom/);
    await remote.dispose();
  } finally {
    stop();
    port1.close();
  }
});

test("createTransformersEmbedder: option resolution, batching, prefixes, serial queue", async () => {
  const seen = { pipelines: [], calls: [], disposed: false };
  let active = 0;
  let maxActive = 0;
  const stubModule = {
    async pipeline(task, model, options) {
      seen.pipelines.push({ task, model, options });
      options.progress_callback({ status: "progress", file: "a", loaded: 50, total: 100 });
      options.progress_callback({ status: "progress", file: "b", loaded: 100, total: 100 });
      const extractor = async (texts, opts) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        seen.calls.push({ texts, opts });
        const d = 4;
        const data = new Float32Array(texts.length * d);
        texts.forEach((t, i) => { data[i * d] = t.length; data[i * d + 1] = 1; });
        return { data, dims: [texts.length, d] };
      };
      extractor.dispose = async () => { seen.disposed = true; };
      return extractor;
    }
  };

  const embedder = createTransformersEmbedder(() => Promise.resolve(stubModule), { batchSize: 2 });
  assert.equal(embedder.id, `transformers:${DEFAULT_EMBEDDING_MODEL}:q8:cls:`);
  assert.equal(embedder.minScore, KNOWN_EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL].minScore);

  const progress = [];
  await embedder.load((p) => progress.push(p));
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.some((p) => p > 0 && p < 1));

  const [v1, , v3] = await embedder.embed(["ab", "abc", "abcd"], "document");
  assert.equal(v1.length, 4);
  assert.equal(v1[0], 2);
  assert.equal(v3[0], 4);
  assert.equal(seen.calls.length, 2, "3 texts with batchSize 2 -> 2 model calls");
  assert.equal(seen.calls[0].opts.pooling, "cls");
  assert.equal(seen.calls[0].opts.normalize, true);

  await Promise.all([embedder.embed(["x"], "query"), embedder.embed(["y"], "query")]);
  assert.equal(maxActive, 1, "embed calls never overlap");
  assert.equal(seen.pipelines.length, 1, "the pipeline is created once");
  assert.equal(seen.pipelines[0].task, "feature-extraction");
  assert.equal(seen.pipelines[0].options.dtype, "q8");
  assert.equal(seen.pipelines[0].options.device, "wasm");

  const custom = createTransformersEmbedder(stubModule, {
    model: "custom/model", pooling: "mean", queryPrefix: "Q: ", documentPrefix: "D: ", minScore: 0.1, dtype: "fp32"
  });
  await custom.embed(["t"], "query");
  assert.deepEqual(seen.calls.at(-1).texts, ["Q: t"]);
  assert.equal(seen.calls.at(-1).opts.pooling, "mean");
  await custom.embed(["t"], "document");
  assert.deepEqual(seen.calls.at(-1).texts, ["D: t"]);
  assert.equal(custom.id, "transformers:custom/model:fp32:mean:D: ");
  assert.equal(custom.minScore, 0.1);

  await embedder.dispose();
  assert.equal(seen.disposed, true);
});
