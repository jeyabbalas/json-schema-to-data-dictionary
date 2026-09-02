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
  schemaDocumentsToTable, buildEmbedChunks, humanizeName, EMBED_TEXT_VERSION,
  createSemanticIndex, createMemoryVectorCache, createIndexedDbVectorCache, cacheKey,
  keywordScore, fuseRankings, rankResults,
  serveEmbedder, createWorkerEmbedder,
  createTransformersEmbedder, KNOWN_EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL
} = await import("../dist/index.js");

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));

test("humanizeName", () => {
  assert.equal(humanizeName("age_at_menarche"), "age at menarche");
  assert.equal(humanizeName("bodyMassIndex"), "body Mass Index");
  assert.equal(humanizeName("BMI"), "BMI");
  assert.equal(humanizeName("meno-age.v2"), "meno age v2");
});

test("buildEmbedChunks: identity chunk per row, values chunks for categoricals, no sentinels", () => {
  const chunks = buildEmbedChunks(bcrpp);
  assert.equal(new Set(chunks.map((c) => c.row)).size, bcrpp.rows.length, "every row has a chunk");

  const menoIdx = bcrpp.rows.indexOf(findRow(bcrpp, "meno_age"));
  const meno = chunks.filter((c) => c.row === menoIdx);
  assert.match(meno[0].text, /^meno age: /);
  assert.match(meno[0].text, /menopause/i);

  const valueChunks = chunks.filter((c) => /Values: /.test(c.text));
  assert.ok(valueChunks.length > 0, "categorical rows get a values chunk");
  for (const c of valueChunks) {
    const labels = c.text.slice(c.text.indexOf("Values: "));
    assert.doesNotMatch(labels, /Missing\/Unknown/, `sentinel codes are never embedded as values: ${labels}`);
  }
});

test("buildEmbedChunks: synthetic table shapes", () => {
  const chunks = buildEmbedChunks(syntheticTable());
  const byRow = (i) => chunks.filter((c) => c.row === i).map((c) => c.text);
  assert.deepEqual(byRow(0), [
    "meno status: Menopausal status at baseline",
    "meno status: Menopausal status at baseline. Values: Premenopausal; Postmenopausal"
  ]);
  assert.match(byRow(1)[1], /Former \(Quit more than a year ago\)/);
  assert.deepEqual(byRow(2), ["height cm: Standing height in centimetres"], "measurement ranges are not values chunks");
  assert.deepEqual(byRow(3), ["age: Age at questionnaire completion in years"]);

  const big = buildEmbedChunks(syntheticTable(28)); // 2 + 28 labels -> 12, 12, 6
  assert.equal(big.filter((c) => c.row === 1).length, 1 + 3);
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

test("createSemanticIndex: dispose rejects ready and search", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ delayMs: 10 }), cache: false });
  index.dispose();
  await assert.rejects(index.ready, /disposed/);
  await assert.rejects(index.search("x"), /disposed/);
});

test("createSemanticIndex: load failure becomes an error status", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ failLoad: "no model" }), cache: false });
  await assert.rejects(index.ready, /no model/);
  assert.equal(index.status.state, "error");
  assert.match(index.status.message, /no model/);
});

test("memory cache: retainOnly keeps only the given keys", async () => {
  const cache = createMemoryVectorCache();
  await cache.putMany([["a", new Float32Array([1])], ["b", new Float32Array([2])]]);
  await cache.retainOnly(["b", "missing"]);
  assert.deepEqual([...(await cache.getMany(["a", "b"])).keys()], ["b"]);
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
