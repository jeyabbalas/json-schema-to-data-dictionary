/*
 * Embedding worker for the demo's opt-in semantic search.
 *
 * Runs the text-embedding model off the main thread so indexing never janks the page.
 * It is a classic worker so it can importScripts() the library's IIFE bundle; Transformers.js
 * (ESM only) is pulled in with a dynamic import() the first time the model is needed. Model
 * weights are fetched from the Hugging Face Hub and cached by the browser (Cache API).
 */
importScripts("json-schema-data-dictionary.global.js");

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
    { model: MODEL, dtype: "q8", device: "wasm" }
  )
);
