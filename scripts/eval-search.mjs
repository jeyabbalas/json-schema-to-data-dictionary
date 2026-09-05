#!/usr/bin/env node
// Search-quality evaluation on the labelled BCRPP query set (tests/fixtures/search-eval.json):
// lexical-only, semantic-only and hybrid ranking, per embedding model, with real models running
// in Node through Transformers.js on the CPU. Reports recall@5, recall@10 and MRR overall and per
// tag, lists the misses, and can calibrate each model's `minScore` floor.
//
//   npm run eval -- [--model <id>]... [--dtype fp32] [--weights 0.5,0.8,1] [--calibrate]
//                   [--query-dtype q8] [--lexical-only] [--json] [--queries <file>] [--fixture <dir>]
//
// The models are downloaded once into .cache/transformers (gitignored). `npm test` never runs
// this; it needs the optional devDependency @huggingface/transformers.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluate, formatTable } from "./eval-metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = await import(pathToFileURL(join(ROOT, "dist", "index.js")).href);
const { schemaDocumentsToTable, createLexicalIndex, lexicalDocumentsFromTable, createSemanticIndex, createMemoryVectorCache, rankHybrid, createTransformersEmbedder, DEFAULT_EMBEDDING_MODEL, KNOWN_EMBEDDING_MODELS } = lib;

// --- arguments ---------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const fixtureDir = resolve(ROOT, args.fixture ?? "tests/fixtures/multiple_schema_2");
const queriesFile = resolve(ROOT, args.queries ?? "tests/fixtures/search-eval.json");
const models = args.model?.length ? args.model : [DEFAULT_EMBEDDING_MODEL, "Xenova/bge-small-en-v1.5"];
const weights = (args.weights ?? "0.5,0.8,1").split(",").map(Number).filter((w) => Number.isFinite(w));
const dtype = args.dtype ?? "fp32";
const maxRelated = Number(args["max-related"] ?? 10);
const TOP = 20;

const NONSENSE = ["asdfgh", "xyzzy plugh", "the", "qwerty", "lorem ipsum", "zzzz", "of and the", "blorptastic", "wqxrt", "hjkl", "aaaaaa", "foo bar baz"];

// --- data ---------------------------------------------------------------------------------------

const table = schemaDocumentsToTable(loadDir(fixtureDir));
const names = table.rows.map((r) => r["Variable name"]);
const queries = JSON.parse(readFileSync(queriesFile, "utf8")).queries;
const known = new Set(names);
for (const q of queries) for (const name of q.expect) if (!known.has(name)) console.warn(`search-eval.json: "${q.q}" expects unknown variable "${name}"`);

const lexical = createLexicalIndex(lexicalDocumentsFromTable(table));
const toNames = (hits) => hits.map((h) => names[h.row]);
const lexicalRun = async (q) => toNames(lexical.search(q, { limit: TOP }));

const report = { fixture: fixtureDir, rows: table.rows.length, queries: queries.length, systems: [], byTag: {}, misses: {}, calibration: {}, timings: {} };
const systems = [];
const lex = await evaluate(queries, lexicalRun);
systems.push({ system: "lexical", model: "-", ...lex.overall });
report.byTag.lexical = lex.byTag;
report.misses.lexical = misses(lex);

// --- models -------------------------------------------------------------------------------------

if (!args["lexical-only"]) {
  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch {
    console.error("The eval needs the optional devDependency: npm install --no-save @huggingface/transformers@4.2.0");
    process.exit(2);
  }
  transformers.env.cacheDir = join(ROOT, ".cache", "transformers");
  transformers.env.allowLocalModels = false;
  const loader = async () => transformers;

  for (const model of models) {
    const embedder = createTransformersEmbedder(loader, { model, device: "cpu", dtype });
    const t0 = performance.now();
    await embedder.load();
    const loadMs = performance.now() - t0;
    const index = createSemanticIndex(table, { embedder, cache: createMemoryVectorCache() });
    const t1 = performance.now();
    await index.ready;
    const indexMs = performance.now() - t1;
    report.timings[model] = { loadMs: Math.round(loadMs), indexMs: Math.round(indexMs), chunks: index.size, textsPerSec: Math.round(index.size / (indexMs / 1000)) };
    console.error(`${model}: loaded in ${Math.round(loadMs)} ms (${embedder.info?.device ?? "?"} · ${embedder.info?.dtype ?? dtype}), indexed ${index.size} chunks in ${Math.round(indexMs)} ms`);

    const floor = embedder.minScore ?? KNOWN_EMBEDDING_MODELS[model]?.minScore ?? 0.25;
    const semanticRun = async (q) => toNames(await index.search(q, { limit: TOP, minScore: -1 }));
    const sem = await evaluate(queries, semanticRun);
    systems.push({ system: "semantic", model, ...sem.overall });
    report.byTag[`semantic:${model}`] = sem.byTag;
    report.misses[`semantic:${model}`] = misses(sem);

    for (const w of weights) {
      const hybridRun = async (q) => {
        const lexHits = lexical.search(q, { limit: TOP });
        const semHits = await index.search(q, { limit: maxRelated + lexHits.length, minScore: floor });
        return toNames(rankHybrid(lexHits, semHits, { maxRelated, semanticWeight: w })).slice(0, TOP);
      };
      const hyb = await evaluate(queries, hybridRun);
      systems.push({ system: `hybrid w=${w}`, model, ...hyb.overall });
      report.byTag[`hybrid(${w}):${model}`] = hyb.byTag;
      report.misses[`hybrid(${w}):${model}`] = misses(hyb);
    }

    if (args.calibrate) report.calibration[model] = await calibrate(index, queries, floor);

    if (args["query-dtype"] && lib.buildVectorSnapshot) {
      // Cross-precision: documents from a snapshot built with `dtype`, queries from another dtype.
      const snapshot = await lib.buildVectorSnapshot(table, { embedder });
      const queryEmbedder = createTransformersEmbedder(loader, { model, device: "cpu", dtype: args["query-dtype"] });
      const cross = createSemanticIndex(table, { embedder: queryEmbedder, cache: createMemoryVectorCache(), snapshot });
      await cross.ready;
      const crossRun = async (q) => toNames(await cross.search(q, { limit: TOP, minScore: -1 }));
      const res = await evaluate(queries, crossRun);
      systems.push({ system: `semantic q:${args["query-dtype"]}`, model, ...res.overall });
      await queryEmbedder.dispose?.();
    }
    await embedder.dispose?.();
  }
}

report.systems = systems;

// --- output -------------------------------------------------------------------------------------

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${table.rows.length} variables · ${queries.length} queries · fixture ${fixtureDir}\n`);
  console.log(formatTable(systems, ["system", "model", "n", "mrr", "recall@5", "recall@10"]));
  for (const [key, byTag] of Object.entries(report.byTag)) {
    if (!key.startsWith("hybrid(") && key !== "lexical") continue;
    console.log(`\nPer tag — ${key}`);
    console.log(formatTable(Object.entries(byTag).map(([tag, m]) => ({ tag, ...m })), ["tag", "n", "mrr", "recall@5", "recall@10"]));
  }
  for (const [key, list] of Object.entries(report.misses)) {
    if (!list.length) continue;
    console.log(`\nMisses — ${key}`);
    for (const m of list) console.log(`  ${m.q.padEnd(28)} missed ${m.missed.join(", ")}  |  top: ${m.top.join(", ")}`);
  }
  for (const [model, c] of Object.entries(report.calibration)) {
    console.log(`\nCalibration — ${model}: noise ceiling ${c.noise.toFixed(3)} (max mean-centred score of any row for ${NONSENSE.length} nonsense queries), ` +
      `signal p10 ${c.signal.toFixed(3)} (10th percentile of expected rows' scores), current floor ${c.floor} → recommended minScore ${c.recommended.toFixed(2)}`);
  }
  if (Object.keys(report.timings).length) {
    console.log("\nTimings (Node, CPU)");
    console.log(formatTable(Object.entries(report.timings).map(([model, t]) => ({ model, ...t })), ["model", "loadMs", "indexMs", "chunks", "textsPerSec"]));
  }
}

// --- helpers ------------------------------------------------------------------------------------

function misses(result) {
  return result.perQuery.filter((r) => r.missed.length).map((r) => ({ q: r.q, missed: r.missed, top: r.ranked.slice(0, 5) }));
}

async function calibrate(index, queries, floor) {
  let noise = -Infinity;
  for (const q of NONSENSE) for (const hit of await index.search(q, { minScore: -1 })) noise = Math.max(noise, hit.score);
  const scores = [];
  for (const query of queries) {
    if (query.tags?.includes("typo")) continue;
    const hits = await index.search(query.q, { minScore: -1 });
    const byRow = new Map(hits.map((h) => [names[h.row], h.score]));
    for (const name of query.expect) if (byRow.has(name)) scores.push(byRow.get(name));
  }
  scores.sort((a, b) => a - b);
  const signal = scores.length ? scores[Math.floor(scores.length * 0.1)] : NaN;
  const recommended = Math.min(noise + 0.02, (noise + signal) / 2);
  return { noise, signal, floor, recommended };
}

function loadDir(dir) {
  const docs = [];
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) docs.push({ uri: pathToFileURL(p).href, name, schema: JSON.parse(readFileSync(p, "utf8")) });
    }
  })(dir);
  return docs;
}

function parseArgs(argv) {
  const out = { model: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const flag = ["calibrate", "json", "lexical-only"].includes(key);
    const value = flag ? true : argv[i + 1];
    if (!flag) i += 1;
    if (key === "model") out.model.push(value);
    else out[key] = value;
  }
  return out;
}
