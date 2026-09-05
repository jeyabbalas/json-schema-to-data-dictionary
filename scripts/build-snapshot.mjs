#!/usr/bin/env node
// Build a `.jsddvec` vector snapshot for a JSON Schema data dictionary with a Transformers.js
// model running in Node (ONNX Runtime on the CPU), so browsers that open the dictionary skip
// embedding entirely: the component fills its semantic index from the snapshot by content key
// and only embeds the texts that changed since the file was built.
//
//   node scripts/build-snapshot.mjs <schema file or dir> <out.jsddvec>
//        [--model <id>] [--dims <n>] [--int8|--fp32] [--dtype <d>] [--device cpu] [--batch <n>]
//
// Requires `npm run build` first (imports ../dist/index.js) and the dev dependency
// @huggingface/transformers; when it is missing an install hint is printed and the exit code
// is 2. Model weights are cached under <repo>/.cache/transformers (gitignored). Also usable as
// a module: `buildSnapshotFile({ input, output, model, dims, quantization, dtype, device })`.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const MODEL_CACHE_DIR = join(ROOT, ".cache", "transformers");
export const INSTALL_HINT =
  "@huggingface/transformers (a dev dependency) is not installed. Run `npm install`, or\n" +
  "`npm install --no-save @huggingface/transformers@^4.2.0`, then try again.";

const USAGE = `usage: node scripts/build-snapshot.mjs <schema file or dir> <out.jsddvec> [options]

  --model <id>     Hugging Face model id (default: the library's DEFAULT_EMBEDDING_MODEL)
  --dims <n>       keep the first n components of every vector (Matryoshka models)
  --int8 | --fp32  payload precision (default: int8, ~4x smaller at cosine >= 0.999)
  --dtype <d>      model weight precision, e.g. fp32 / q8 (default: auto -> fp32 on the CPU)
  --device <d>     execution device (default: cpu)
  --batch <n>      texts per model call (default: 16)`;

/** Import the built library, with a hint when `dist/` is missing. */
export async function loadLibrary() {
  try {
    return await import("../dist/index.js");
  } catch (err) {
    throw new Error(`Cannot import dist/index.js — run \`npm run build\` first (${err.message})`);
  }
}

/**
 * Import @huggingface/transformers configured for Node builds: weights cached inside the
 * repository, never resolved from a local `models/` path. Throws `ERR_TRANSFORMERS_MISSING`
 * (with the install hint as the message) when the package is not installed.
 */
export async function loadTransformers({ cacheDir = MODEL_CACHE_DIR } = {}) {
  let mod;
  try {
    mod = await import("@huggingface/transformers");
  } catch (err) {
    const e = new Error(INSTALL_HINT);
    e.code = "ERR_TRANSFORMERS_MISSING";
    e.cause = err;
    throw e;
  }
  mkdirSync(cacheDir, { recursive: true });
  mod.env.cacheDir = cacheDir;
  mod.env.allowLocalModels = false;
  return mod;
}

/** Every `.json` under a directory (recursively, sorted) or one file, as library document inputs. */
export function loadSchemaDocuments(input) {
  const root = resolve(input);
  const files = [];
  if (statSync(root).isDirectory()) {
    (function walk(d) {
      for (const entry of readdirSync(d).sort()) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".json")) files.push(p);
      }
    })(root);
  } else {
    files.push(root);
  }
  if (files.length === 0) throw new Error(`No .json files under ${root}`);
  return files.map((p) => ({ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) }));
}

/**
 * Build and write one snapshot. Returns `{ output, bytes, count, dims, quantization, model,
 * spaceId, embedderId, device, dtype, ms: { load, embed, total } }`.
 */
export async function buildSnapshotFile(options) {
  const { input, output, model, dims, quantization = "int8", dtype = "auto", device = "cpu", batchSize, log = () => {} } = options;
  const api = await loadLibrary();
  const modelId = model ?? api.DEFAULT_EMBEDDING_MODEL;
  const table = api.schemaDocumentsToTable(loadSchemaDocuments(input));
  const uniqueTexts = api.prepareTexts(table).uniqueTexts.length;
  log(`${basename(resolve(input))}: ${table.rows.length} variables, ${uniqueTexts} unique texts`);

  const started = performance.now();
  const embedder = api.createTransformersEmbedder(() => loadTransformers(), { model: modelId, device, dtype });
  // The adapter aggregates per-file progress, which dips when a new file (the model after the
  // tokenizer) joins the total; log only forward steps.
  let lastPct = -1;
  await embedder.load((fraction) => {
    const pct = Math.floor(fraction * 10) * 10;
    if (pct > lastPct && pct < 100) {
      lastPct = pct;
      log(`loading ${modelId}… ${pct}%`);
    }
  });
  const loadedAt = performance.now();
  log(`model ready in ${((loadedAt - started) / 1000).toFixed(1)} s (${embedder.info.device} · ${embedder.info.dtype})`);

  const snapshot = await api.buildVectorSnapshot(table, {
    embedder,
    dims,
    batchSize,
    onProgress: (done, total) => {
      if (done === total || done % 512 === 0) log(`embedded ${done} / ${total}`);
    }
  });
  const embeddedAt = performance.now();
  const bytes = api.encodeVectorSnapshot(snapshot, { quantization });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, new Uint8Array(bytes));
  await embedder.dispose?.();

  const ms = { load: loadedAt - started, embed: embeddedAt - loadedAt, total: performance.now() - started };
  const rate = ms.embed > 0 ? Math.round(snapshot.count / (ms.embed / 1000)) : 0;
  log(`wrote ${output}: ${snapshot.count} × ${snapshot.dims}-d ${quantization}, ${(bytes.byteLength / 1024).toFixed(1)} KB; embedding ${(ms.embed / 1000).toFixed(1)} s (${rate} texts/s)`);
  return {
    output,
    bytes: bytes.byteLength,
    count: snapshot.count,
    dims: snapshot.dims,
    quantization,
    model: modelId,
    spaceId: snapshot.spaceId,
    embedderId: snapshot.embedderId,
    device: embedder.info?.device,
    dtype: embedder.info?.dtype,
    ms
  };
}

/** Parse the CLI arguments (exported for tests/tooling). */
export function parseArgs(argv) {
  const out = { quantization: "int8", dtype: "auto", device: "cpu" };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--model") out.model = next();
    else if (arg === "--dims") out.dims = Number(next());
    else if (arg === "--int8") out.quantization = "int8";
    else if (arg === "--fp32") out.quantization = "fp32";
    else if (arg === "--dtype") out.dtype = next();
    else if (arg === "--device") out.device = next();
    else if (arg === "--batch") out.batchSize = Number(next());
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  [out.input, out.output] = positional;
  if (out.dims !== undefined && !(out.dims > 0)) throw new Error("--dims needs a positive number");
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }
  if (args.help || !args.input || !args.output) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  try {
    const result = await buildSnapshotFile({ ...args, log: (msg) => console.log(`[build-snapshot] ${msg}`) });
    console.log(`[build-snapshot] done in ${(result.ms.total / 1000).toFixed(1)} s — ${result.spaceId}`);
  } catch (err) {
    if (err.code === "ERR_TRANSFORMERS_MISSING") {
      console.error(`[build-snapshot] ${err.message}`);
      process.exit(2);
    }
    console.error(`[build-snapshot] ${err.stack ?? err.message}`);
    process.exit(1);
  }
}
