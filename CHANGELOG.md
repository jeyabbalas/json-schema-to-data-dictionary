# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

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
  embeddings persist across sessions and only changed rows are re-embedded. Scores
  are mean-centred cosine similarities with a model-agnostic default floor of 0.25.
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
