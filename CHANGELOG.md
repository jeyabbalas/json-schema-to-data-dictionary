# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## 0.3.0 - 2026-09-05

Production-grade search and rendering for large dictionaries (10,000 variables).

### Added

- **Hybrid search.** A tokenised BM25F lexical index (`createLexicalIndex`,
  `lexicalDocumentsFromTable`) with as-you-type prefix matching, stemming, an
  AND-then-OR policy for multi-word queries and a substring fallback, fused with the
  semantic hits by reciprocal-rank fusion (`rankHybrid`); exact variable-name matches
  always rank first. `createSearchEngine` exposes the whole pipeline headlessly:
  a synchronous lexical `search()` plus semantic updates through `subscribe()`.
- **Search while indexing.** The semantic index answers queries from the rows embedded
  so far (`search(q, { partial: true })`, `loaded`, `coverage`, `indexing.coverage` in
  the status) and the widget refreshes the list as indexing progresses.
- **Precomputed vectors.** `buildVectorSnapshot` / `encodeVectorSnapshot` /
  `decodeVectorSnapshot` / `loadVectorSnapshot` and the `semanticSearch.snapshot`
  option: embed a dictionary once (`scripts/build-snapshot.mjs`, int8 or fp32,
  optional Matryoshka `dims`) and ship the `.jsddvec` file next to the schema; the
  browser then only embeds queries, and rows whose text changed are embedded live.
- **Verified model table.** `MongoDB/mdbr-leaf-ir` (23M, Apache-2.0) is the new default;
  `jinaai/jina-embeddings-v5-text-nano-retrieval` (239M, CC-BY-NC-4.0, WebGPU) is the
  high-quality option; `Xenova/bge-small-en-v1.5` and `Xenova/all-MiniLM-L6-v2` stay.
  `KNOWN_EMBEDDING_MODELS` carries pooling, prefixes, per-device dtypes, licence and
  parameter counts.
- **Transformers.js adapter** rebuilt on `AutoTokenizer` + `AutoModel`: `device: "auto"`
  (WebGPU with WASM fallback; CPU under Node), `dtype: "auto"`, mask-aware
  `last_token` pooling, `sentence_embedding` output support, `maxLength`, `dims`,
  `Embedder.info` (resolved device/dtype) and `Embedder.spaceId` (precision-agnostic
  identity used by the cache and snapshots). The worker RPC reports `info` after `load()`.
- Rendering options `pageSize` (lazy row materialisation per category, default 100;
  `Infinity` disables it) and `resultsPageSize` (results shown before *Show more*).
- Evaluation harness: `npm run eval` scores lexical, semantic and hybrid ranking on the
  labelled query set `tests/fixtures/search-eval.json` with real models (optional
  devDependency `@huggingface/transformers`) and `--calibrate` recommends `minScore`
  floors; a fake-embedder variant runs in `npm test`.
- **Root-schema detection for whole folders.** `findSchemaRoots` ranks the input documents
  by how likely each is to be the table's root: documents that do not read like a JSON
  Schema (example data, ledgers) are excluded, an array of records wins over an object,
  and a document another one `$ref`s into is treated as a component. Auto-detection no
  longer depends on input order, and a table built from several candidate roots says so
  in `warnings`.
- Demo: embedding-model picker with licence and download size, device chip
  ("WebGPU · fp16"), indexing ETA, precomputed vectors for the BCRPP preset (`npm run demo:vectors`), a local server
  that sends COOP/COEP (WASM threads; `COI=0` mimics GitHub Pages), and URL overrides
  (`?preset=…&semantic=1&model=…&device=…`) for automation. Dropped folders may now sit
  any number of directories above the schemas — every leading directory the selection
  shares is stripped, so dropping `study/` behaves exactly like `study/json_schema/` —
  and the root selector lists the detected table schemas first.

### Changed

- The interactive component renders large dictionaries lazily and shows every query as
  one ranked results list re-rendered from the view model with highlights baked in
  (rows never move or toggle individually); `table-layout: fixed` with a shared column
  grid and `content-visibility: auto` on category sections. Measured on 10,070
  variables in 1,045 categories (Chrome 152): first paint 7.4 s → 0.3 s, DOM nodes
  380,637 → 34,050, keystroke 0.4–1.1 s → 22–46 ms of script (about 160 ms to paint
  a page of results), clearing the box 2.4–3.3 s → 8 ms, collapse/expand all 3.6 s →
  20 ms; the JS heap grows by 3 MB instead of 54 MB.
- Embedding chunks (template v2) include the raw variable name next to its humanised
  form and omit regex formats; `EMBED_TEXT_VERSION` is 2.
- The IndexedDB cache stores one record per dictionary (database version 2) instead of
  one per text; length-sorted batches and progressive flushes make indexing resumable.
- CSV export text is built on first use instead of on every render.

### Fixed

- Batched embeddings of last-token models (Jina) were computed on padding tokens for
  every text shorter than the longest in the batch.
- LEAF-IR's `sentence_embedding` output is used instead of a raw CLS vector.
- The toolbar buttons (expand/collapse all, copy, download) were inert in 0.2.0 because
  they read the wrong data attribute; `/` and `Esc` now work inside the Shadow DOM.
- `</script` inside schema text no longer breaks the static HTML's inline script.

### Breaking

- `DEFAULT_EMBEDDING_MODEL` is `MongoDB/mdbr-leaf-ir`; `createTransformersEmbedder`
  defaults to `device: "auto"` and `dtype: "auto"`, and `TransformersModuleLike` needs
  `AutoTokenizer`/`AutoModel` instead of `pipeline` (`pipelineOptions` is a deprecated
  alias of `modelOptions`). `Embedder.id` is final only after `load()`.
- Cached vectors are re-embedded once (new text template, new cache layout); the old
  per-text IndexedDB store is dropped.
- `SemanticStatus` `indexing` gains a required `coverage`; `RankedResult` gains
  `exactName`, `lexicalScore` and `matches`.
- Keyword search in the component shows the ranked results list instead of filtering
  rows in place, and rows are materialised lazily, so DOM scraping of `[data-dd-row]`
  is no longer exhaustive — use `toPlainRows`. The static `tableToHtml` output is
  unchanged.
- Root auto-detection ranks the candidates instead of taking the first array-like
  document, so an input with several table schemas may resolve to a different root than
  in 0.2.0. Pass `rootUri` or `rootIndex` to pin one.

## 0.2.0 - 2026-09-02

### Added

- **Opt-in semantic search** for the interactive component: pass
  `semanticSearch: { embedder }` to also surface semantically related variables
  ("smoking" finds the tobacco rows). The library stays dependency-free: bring an
  `Embedder`. A `createTransformersEmbedder` adapter for Transformers.js v4 is
  included, plus `serveEmbedder` / `createWorkerEmbedder` to run it in a Web Worker.
- Ranked results view while a query is active: keyword matches first (variable
  name, then description, then values), then up to `maxRelated` related rows badged
  *related*; the category layout is restored when the box is cleared. A status chip
  reports model download, indexing and errors; keyword search keeps working throughout.
- IndexedDB vector cache (`jsdd-semantic`) keyed by model and text hash, so
  embeddings persist across sessions and only changed rows are re-embedded. The
  cache holds only the most recently indexed dictionary: indexing a different
  schema deletes the previous one's vectors (`VectorCache.retainOnly`), so storage
  never grows with the number of schemas opened. Scores are mean-centred cosine
  similarities with a model-agnostic default floor of 0.25.
- Headless API: `createSemanticIndex`, `buildEmbedChunks`, `rankResults`,
  `keywordScore`, `fuseRankings`, `createIndexedDbVectorCache`,
  `createMemoryVectorCache`, and the `Embedder`, `VectorCache`, `SemanticIndex`,
  `SemanticStatus` and `SemanticSearchOptions` types.
- Demo: a "Semantic search" toggle backed by an embedding worker
  (`Xenova/bge-small-en-v1.5`) with a main-thread fallback; `npm run demo:serve`.

### Changed

- `RowVM` gains `index`, `category` and `searchFields`; `ResolvedOptions` gains
  `semanticSearch`. Rendered markup is unchanged unless `semanticSearch` is
  configured, and `tableToHtml` remains keyword-only.

### Fixed

- The search counter no longer covers the browser's native clear ("×") button:
  the input pads itself by the counter's width, so the button is drawn beside it.

## 0.1.0 - 2026-06-22

Initial release: `schemaDocumentsToTable`, `renderDataDictionary` (the
`<json-data-dictionary>` web component), `tableToHtml`, `toPlainRows` /
`tableToCsv`, cross-document `$ref` resolution, mixed measurement / sentinel-code
variables and `if`/`then` skip patterns.
