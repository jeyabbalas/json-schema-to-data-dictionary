/*
 * Embedding worker for the demo's opt-in semantic search.
 *
 * Runs the text-embedding model off the main thread so indexing never janks the page.
 * It is a classic worker so it can importScripts() the library's IIFE bundle; Transformers.js
 * (ESM only) is pulled in with a dynamic import() the first time the model is needed. Model
 * weights are fetched from the Hugging Face Hub and cached by the browser (Cache API).
 *
 * Configuration travels in the worker URL's query string (stateless; one worker per model):
 *   v=<commit>               the deploy's cache-busting tag, reused for the bundle URL
 *   model=<id>               Hugging Face model id (default: MODEL below)
 *   device=auto|wasm|webgpu  execution device (default: wasm)
 *   dtype=<string>           quantisation, e.g. q8 / fp16 (default: q8)
 *   nogpu=1                  test hook: hide WebGPU so the WASM path is exercised
 */
var PARAMS = new URLSearchParams(self.location.search);

// A fresh app.js must never pair with a stale bundle: forward the deploy's ?v=<commit>.
var VERSION = PARAMS.get("v");
importScripts("json-schema-data-dictionary.global.js" + (VERSION ? "?v=" + encodeURIComponent(VERSION) : ""));

if (PARAMS.get("nogpu") === "1") {
  // Transformers.js detects WebGPU via navigator.gpu; removing the accessor makes it fall back.
  try { delete WorkerNavigator.prototype.gpu; } catch (e) {}
}

var TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
var MODEL = "Xenova/bge-small-en-v1.5"; // 33M params, 384-d, MIT; ~34 MB quantized

var API = self.JsonSchemaDataDictionary;

API.serveEmbedder(
  API.createTransformersEmbedder(
    function () {
      return import(TRANSFORMERS_URL).then(function (transformers) {
        transformers.env.allowLocalModels = false; // never probe /models/… on this origin
        return transformers;
      });
    },
    {
      model: PARAMS.get("model") || MODEL,
      dtype: PARAMS.get("dtype") || "q8",
      device: PARAMS.get("device") || "wasm"
    }
  )
);
