#!/usr/bin/env node
// Demo wrapper around build-snapshot.mjs: precomputed vectors for the demo's BCRPP preset
// (`npm run demo:vectors`, part of `npm run demo`; also run by the Pages deploy). Writes
//   demo/vectors/bcrpp.<model-slug>.jsddvec   int8 snapshot for the default embedding model
//   demo/vectors/manifest.json                { "bcrpp": [{ model, file, bytes, spaceId }] }
// (both gitignored). An existing file is reused when it is still valid — same text-template
// version, same embedding space, every current text present — and rebuilt otherwise;
// `--force` always rebuilds and `--dtype <d>` overrides the weight precision (default q8: the
// fastest CPU build, and what WASM browsers compute anyway; the space id excludes the dtype).
// Without @huggingface/transformers installed the step is skipped with a warning (exit 0) so
// the demo still builds — just without precomputed vectors.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, buildSnapshotFile, loadLibrary, loadSchemaDocuments, loadTransformers } from "./build-snapshot.mjs";

const FIXTURE = join(ROOT, "tests", "fixtures", "multiple_schema_2");
const OUT_DIR = join(ROOT, "demo", "vectors");
const PRESET = "bcrpp";
const TAG = "[demo:vectors]";

/** `MongoDB/mdbr-leaf-ir` -> `mongodb-mdbr-leaf-ir`. */
export const modelSlug = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Why an existing snapshot cannot serve the current fixture/model (undefined when it can). */
function staleReason(api, file, table, spaceId) {
  let snap;
  try {
    snap = api.decodeVectorSnapshot(readFileSync(file));
  } catch (err) {
    return `cannot decode ${file} (${err.message})`;
  }
  if (snap.textVersion !== api.EMBED_TEXT_VERSION) return `text template v${snap.textVersion} (now v${api.EMBED_TEXT_VERSION})`;
  if (snap.spaceId !== spaceId) return `embedding space ${snap.spaceId} (now ${spaceId})`;
  const keys = new Set(snap.keys);
  const missing = api.prepareTexts(table).uniqueTexts.filter((t) => !keys.has(api.textKey(t))).length;
  if (missing > 0) return `${missing} text(s) of the fixture are not in the snapshot`;
  return undefined;
}

export async function buildDemoVectors({ force = false, dtype = "q8", log = (msg) => console.log(`${TAG} ${msg}`) } = {}) {
  const api = await loadLibrary();
  const model = api.DEFAULT_EMBEDDING_MODEL;
  const file = `${PRESET}.${modelSlug(model)}.jsddvec`;
  const out = join(OUT_DIR, file);
  const table = api.schemaDocumentsToTable(loadSchemaDocuments(FIXTURE));
  // The space id needs no model download: it is derived from the configuration alone.
  const spaceId = api.createTransformersEmbedder(() => Promise.reject(new Error("not loaded")), { model }).spaceId;

  let entry;
  if (!force && existsSync(out)) {
    const reason = staleReason(api, out, table, spaceId);
    if (reason) log(`rebuilding ${file}: ${reason}`);
    else {
      entry = { model, file: `vectors/${file}`, bytes: statSync(out).size, spaceId };
      log(`${file} is up to date (${entry.bytes} bytes)`);
    }
  }
  if (!entry) {
    try {
      await loadTransformers();
    } catch (err) {
      if (err.code !== "ERR_TRANSFORMERS_MISSING") throw err;
      console.warn(`${TAG} skipped — ${err.message.split("\n")[0]} The demo will index in the browser instead.`);
      return { skipped: true };
    }
    const result = await buildSnapshotFile({ input: FIXTURE, output: out, model, quantization: "int8", dtype, device: "cpu", log });
    entry = { model, file: `vectors/${file}`, bytes: result.bytes, spaceId: result.spaceId };
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { [PRESET]: [entry] };
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest.json: ${entry.file} (${entry.bytes} bytes, ${entry.spaceId})`);
  return { skipped: false, manifest, output: out };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const dtypeAt = argv.indexOf("--dtype");
  try {
    await buildDemoVectors({ force: argv.includes("--force"), ...(dtypeAt >= 0 && argv[dtypeAt + 1] ? { dtype: argv[dtypeAt + 1] } : {}) });
  } catch (err) {
    console.error(`${TAG} ${err.stack ?? err.message}`);
    process.exit(1);
  }
}
