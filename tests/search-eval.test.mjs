// Search-quality regression test on the labelled BCRPP query set with the deterministic fake
// embedder (no model download). Real models are scored by `npm run eval`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaDocumentsToTable, createLexicalIndex, lexicalDocumentsFromTable, createSemanticIndex, createMemoryVectorCache, rankHybrid, createSearchEngine } from "../dist/index.js";
import { evaluate } from "../scripts/eval-metrics.mjs";
import { FIXTURES, loadDir } from "./_helpers.mjs";
import { createFakeEmbedder } from "./_fakeEmbedder.mjs";

const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const names = table.rows.map((r) => r["Variable name"]);
const all = JSON.parse(readFileSync(join(FIXTURES, "search-eval.json"), "utf8")).queries;
// Semantic and typo queries need a real model; everything else must be answered lexically.
const lexicalSet = all.filter((q) => !q.tags.includes("semantic") && !q.tags.includes("typo"));
const toNames = (hits) => hits.map((h) => names[h.row]);

test("search-eval: every expected variable exists in the fixture", () => {
  const known = new Set(names);
  for (const q of all) for (const name of q.expect) assert.ok(known.has(name), `"${q.q}" expects unknown variable ${name}`);
  assert.ok(lexicalSet.length >= 30);
});

test("search-eval: lexical ranking answers the lexical subset", async () => {
  const lexical = createLexicalIndex(lexicalDocumentsFromTable(table));
  const res = await evaluate(lexicalSet, async (q) => toNames(lexical.search(q, { limit: 20 })));
  const failures = res.perQuery.filter((r) => r["recall@10"] < 1).map((r) => `${r.q}: missed ${r.missed.join(", ")} (top: ${r.ranked.slice(0, 5).join(", ")})`);
  assert.ok(res.overall["recall@10"] >= 0.9, `recall@10 ${res.overall["recall@10"].toFixed(3)}\n${failures.join("\n")}`);
  assert.ok(res.overall.mrr >= 0.7, `MRR ${res.overall.mrr.toFixed(3)}\n${failures.join("\n")}`);
});

test("search-eval: hybrid ranking keeps the lexical answers and adds related rows", async () => {
  const embedder = createFakeEmbedder();
  const index = createSemanticIndex(table, { embedder, cache: createMemoryVectorCache() });
  await index.ready;
  const lexical = createLexicalIndex(lexicalDocumentsFromTable(table));
  const hybrid = async (q) => {
    const lexHits = lexical.search(q, { limit: 20 });
    const semHits = await index.search(q, { limit: 10 + lexHits.length });
    return toNames(rankHybrid(lexHits, semHits, { maxRelated: 10 })).slice(0, 20);
  };
  const lex = await evaluate(lexicalSet, async (q) => toNames(lexical.search(q, { limit: 20 })));
  const hyb = await evaluate(lexicalSet, hybrid);
  assert.ok(hyb.overall["recall@10"] >= lex.overall["recall@10"] - 1e-9, `hybrid ${hyb.overall["recall@10"]} < lexical ${lex.overall["recall@10"]}`);

  // The fake embedder's synonyms stand in for a real model: related-only rows appear badged.
  const engine = createSearchEngine(table, { semantic: index, debounceMs: 0, maxRelated: 10 });
  const related = await new Promise((resolve) => {
    const seen = [];
    engine.subscribe((r) => {
      if (r.normalizedQuery !== "climacteric") return;
      resolve(r.results.filter((x) => !x.exact).map((x) => names[x.row]));
    });
    seen.push(engine.search("climacteric"));
  });
  assert.ok(related.some((n) => n.startsWith("meno_")), `related rows for "climacteric": ${related.join(", ")}`);
  const cigarette = await new Promise((resolve) => {
    engine.subscribe((r) => {
      if (r.normalizedQuery === "cigarette") resolve(r.results.filter((x) => !x.exact).map((x) => names[x.row]));
    });
    engine.search("cigarette");
  });
  assert.ok(cigarette.some((n) => n.startsWith("smoking_")), `related rows for "cigarette": ${cigarette.join(", ")}`);
  engine.dispose();
  index.dispose();
});
