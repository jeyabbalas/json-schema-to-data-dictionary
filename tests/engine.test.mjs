import test from "node:test";
import assert from "node:assert/strict";
import { loadDir } from "./_helpers.mjs";
import { createFakeEmbedder, syntheticTable } from "./_fakeEmbedder.mjs";

const { schemaDocumentsToTable, createSearchEngine, createSemanticIndex, createLexicalIndex, lexicalDocumentsFromTable } = await import("../dist/index.js");

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await tick(5);
  }
}
const rows = (r) => r.results.map((x) => `${x.row}${x.exact ? "e" : "r"}`);

test("engine: synchronous lexical results without a semantic index", () => {
  const engine = createSearchEngine(syntheticTable());
  assert.equal(engine.status, undefined);
  assert.equal(engine.lexical.size, 4);
  const r = engine.search("Tobacco ");
  assert.equal(r.query, "Tobacco ");
  assert.equal(r.normalizedQuery, "tobacco");
  assert.deepEqual(rows(r), ["1e"]);
  assert.deepEqual(r.terms, ["tobacco"]);
  assert.equal(r.exactCount, 1);
  assert.equal(r.relatedCount, 0);
  assert.deepEqual(r.semantic, { state: "off", coverage: 0 });
  assert.equal(engine.current, r);
  assert.equal(r.results[0].keywordScore, 5, "'tobacco' is a prefix of the name tobacco_use");
  assert.deepEqual(r.results[0].matches[0], { field: "name", terms: ["tobacco"] });
  assert.equal(engine.search("height_cm").results[0].keywordScore, 6);
  assert.equal(engine.search("baseline").results[0].keywordScore, 3);

  const empty = engine.search("   ");
  assert.deepEqual(empty.results, []);
  assert.equal(empty.normalizedQuery, "");
  assert.equal(empty.semantic.state, "off");

  const docs = lexicalDocumentsFromTable(syntheticTable());
  const fromDocs = createSearchEngine(docs, { lexical: createLexicalIndex(docs) });
  assert.deepEqual(rows(fromDocs.search("height")), ["2e"]);
  engine.dispose();
  fromDocs.dispose();
});

test("engine: pending -> complete, one update per query, retyping is instant", async () => {
  const embedder = createFakeEmbedder();
  const index = createSemanticIndex(syntheticTable(), { embedder, cache: false });
  await index.ready;
  const engine = createSearchEngine(syntheticTable(), { semantic: index, debounceMs: 0, minQueryLength: 2 });
  const updates = [];
  engine.subscribe((r) => updates.push(r));

  const first = engine.search("climacteric");
  assert.equal(first.semantic.state, "pending");
  assert.deepEqual(first.results, []);
  assert.deepEqual(first.terms, ["climacteric"], "no lexical hit: the query tokens are the highlight fallback");
  await until(() => updates.length > 0);
  await tick(30);
  assert.equal(updates.length, 1, "exactly one update per query");
  const done = updates[0];
  assert.equal(done.normalizedQuery, "climacteric");
  assert.equal(done.semantic.state, "complete");
  assert.equal(done.semantic.coverage, 1);
  assert.deepEqual(rows(done), ["0r"]);
  assert.equal(done.relatedCount, 1);
  assert.ok(done.results[0].semanticScore > 0.3);
  assert.equal(done.results[0].keywordScore, 0);
  assert.equal(engine.current, done);

  const queryCalls = embedder.calls.query;
  const again = engine.search("climacteric");
  assert.equal(again.semantic.state, "complete", "cached: no pending state on retype");
  assert.deepEqual(rows(again), ["0r"]);
  await tick(20);
  assert.equal(updates.length, 1, "a cached query emits nothing");
  assert.equal(embedder.calls.query, queryCalls, "and embeds nothing");

  // Exact + related fused: "status" hits meno_status lexically; the synonym map relates nothing else.
  const status = engine.search("status");
  assert.equal(status.results[0].row, 0);
  assert.equal(status.results[0].exact, true);
  await until(() => engine.current.semantic.state === "complete");
  assert.equal(engine.current.exactCount, 1);
  engine.dispose();
  index.dispose();
});

test("engine: the latest query wins over a slow earlier one", async () => {
  const embedder = createFakeEmbedder({ delayMs: 30 });
  const index = createSemanticIndex(syntheticTable(), { embedder, cache: false });
  await index.ready;
  const engine = createSearchEngine(syntheticTable(), { semantic: index, debounceMs: 0, minQueryLength: 2 });
  const updates = [];
  engine.subscribe((r) => updates.push(r.normalizedQuery));
  engine.search("cigarette"); // -> tobacco_use (row 1), 30 ms later
  await tick(5);
  engine.search("climacteric"); // -> meno_status (row 0)
  await until(() => updates.length > 0);
  await tick(120);
  assert.deepEqual(updates, ["climacteric"], "the stale reply is never emitted");
  assert.deepEqual(rows(engine.current), ["0r"]);
  // ...but it was cached for its own query: retyping it is instant.
  assert.equal(engine.search("cigarette").semantic.state, "complete");
  assert.deepEqual(rows(engine.current), ["1r"]);
  engine.dispose();
  index.dispose();
});

test("engine: skipped / off / error states, lexical search keeps working", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder(), cache: false });
  await index.ready;
  const engine = createSearchEngine(syntheticTable(), { semantic: index, debounceMs: 0, minQueryLength: 3 });
  assert.equal(engine.search("cl").semantic.state, "skipped", "shorter than minQueryLength");
  assert.equal(engine.search("777, 888").semantic.state, "skipped", "purely numeric");
  assert.equal(engine.search("").semantic.state, "skipped");
  assert.equal(engine.status.state, "ready");
  engine.dispose();

  const broken = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ failLoad: "offline" }), cache: false });
  await broken.ready.catch(() => {});
  const errored = createSearchEngine(syntheticTable(), { semantic: broken, debounceMs: 0 });
  const r = errored.search("tobacco");
  assert.deepEqual(rows(r), ["1e"]);
  assert.equal(r.semantic.state, "error");
  assert.equal(r.semantic.message, "offline");
  errored.dispose();
});

test("engine: partial results while indexing, then complete once ready", async () => {
  const embedder = createFakeEmbedder({ delayMs: 4 });
  const index = createSemanticIndex(bcrpp, { embedder, cache: false, batchSize: 3 });
  const engine = createSearchEngine(bcrpp, { semantic: index, debounceMs: 0 });
  const updates = [];
  engine.subscribe((r) => updates.push(r));
  const first = engine.search("menopause");
  assert.equal(first.semantic.state, "pending");
  assert.ok(first.exactCount >= 3, "lexical hits are there immediately");
  await index.ready;
  await until(() => engine.current.semantic.state === "complete");
  const states = updates.map((u) => u.semantic.state);
  assert.ok(states.includes("partial"), `saw a partial update: ${states.join(",")}`);
  assert.equal(states.at(-1), "complete");
  assert.ok(states.every((s) => s === "partial" || s === "complete"));
  const coverages = updates.map((u) => u.semantic.coverage);
  assert.ok(coverages.every((c, i) => i === 0 || c >= coverages[i - 1]), `coverage never decreases: ${coverages.join(",")}`);
  assert.equal(coverages.at(-1), 1);
  assert.ok(updates.at(-1).exactCount >= 3);
  assert.ok(updates.at(-1).relatedCount <= 10);
  assert.ok(updates.every((u) => u.normalizedQuery === "menopause"));
  engine.dispose();
  index.dispose();
});

test("engine: results LRU (32) and maxRelated", async () => {
  const docs = lexicalDocumentsFromTable(bcrpp);
  const real = createLexicalIndex(docs);
  let calls = 0;
  const counting = {
    get size() { return real.size; },
    get vocabularySize() { return real.vocabularySize; },
    search: (q, o) => { calls += 1; return real.search(q, o); },
    tokens: (q) => real.tokens(q)
  };
  const engine = createSearchEngine(docs, { lexical: counting });
  engine.search("meno");
  engine.search("meno");
  engine.search("MENO ");
  assert.equal(calls, 1, "the same normalised query is served from the results cache");
  for (let i = 0; i < 32; i += 1) engine.search(`q${i}`);
  engine.search("meno");
  assert.equal(calls, 34, "evicted after 32 other queries");
  engine.dispose();

  const embedder = createFakeEmbedder();
  const index = createSemanticIndex(bcrpp, { embedder, cache: false });
  await index.ready;
  const capped = createSearchEngine(bcrpp, { semantic: index, debounceMs: 0, maxRelated: 3, minScore: 0.05 });
  capped.search("cigarette");
  await until(() => capped.current.semantic.state === "complete");
  assert.ok(capped.current.relatedCount <= 3);
  assert.ok(capped.current.relatedCount >= 1);
  assert.ok(capped.current.results.filter((r) => !r.exact).every((r) => r.semanticScore >= 0.05));
  capped.dispose();
  index.dispose();
});

test("engine: terms for highlighting", async () => {
  const engine = createSearchEngine(bcrpp);
  assert.deepEqual(engine.search("_.+$").terms, [], "substring-only matches: highlight the raw query");
  assert.equal(engine.search("_.+$").exactCount, 1);
  const sisters = engine.search("sister").terms;
  assert.ok(sisters.includes("sisters"), `surface forms of the stem: ${sisters.join(",")}`);
  const both = engine.search("smoking status").terms;
  assert.deepEqual(both.slice(0, 2), ["smoking", "status"], "longest first");
  assert.deepEqual(engine.search("xyzzy").terms, ["xyzzy"], "nothing matched: the query tokens");
  engine.dispose();
});

test("engine: dispose stops updates and never disposes the index", async () => {
  const index = createSemanticIndex(syntheticTable(), { embedder: createFakeEmbedder({ delayMs: 10 }), cache: false });
  await index.ready;
  const engine = createSearchEngine(syntheticTable(), { semantic: index, debounceMs: 0, minQueryLength: 2 });
  const updates = [];
  engine.subscribe((r) => updates.push(r));
  engine.search("climacteric");
  engine.dispose();
  await tick(60);
  assert.deepEqual(updates, []);
  assert.equal(index.status.state, "ready");
  assert.ok((await index.search("climacteric")).length >= 1, "the index still works");
  assert.deepEqual(rows(engine.search("tobacco")), ["1e"], "lexical search still answers after dispose");
  index.dispose();
});
