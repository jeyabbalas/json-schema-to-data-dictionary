# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## 0.5.0 - 2026-09-05

### Fixed

- **Vectors written while the IndexedDB cache was pruning were silently dropped.** `retainOnly`
  released its in-memory mirror as soon as its own write was done, so a `putMany` that had
  landed on that mirror meanwhile scheduled a write that found nothing to persist — and still
  resolved. Two indexes sharing the default cache (two components on a page, or a component
  re-mounted as the previous index finished) hit this. The mirror is now released only once
  every pending write has committed.
- **Disposing a semantic index no longer discards the vectors embedded since the last flush**
  (up to `flushEvery`, 2,000 by default, plus the batch in flight). A re-created index for the
  same dictionary — a re-mounted component, which the demo does on every display-option change —
  resumes from the cache instead of embedding those texts again.
- **`decodeVectorSnapshot` accepts an unaligned Node `Buffer`.** The realignment used
  `slice()`, which on a `Buffer` returns another view, so the typed-array view then threw a
  `RangeError`.
- `createSearchEngine` collapses inner whitespace in `normalizedQuery`, as documented, so
  `smoking  status` and `smoking status` share one results-cache entry and one query embedding.
- Demo: the WebGPU-only model is offered only when a WebGPU adapter can actually be acquired
  (`detectWebGpu()`), not whenever `navigator.gpu` exists; without one the picker falls back to
  the default model and says so.

## 0.4.0 - 2026-09-05

### Added

- **`x-value-kind`.** A schema can now declare whether a `const`/`enum` member is a
  substantive answer (`"value"`) or a missing/NA code (`"sentinel"`) instead of leaving it
  to be inferred from wording. Read from the subschema carrying the value (e.g. a shared
  `$defs` entry), from a `$ref` sibling — which overrides the referenced default — or from
  the property, as the default for its branches. It is consumed rather than passed through,
  so it no longer shows up in **Additional information**.

### Fixed

- **A code no longer changes meaning because of its neighbours.** In a mixed union
  (a measurement branch plus coded branches) every categorical value was force-tagged
  `sentinel`, bypassing the classifier that a pure categorical union used. The same code
  with the same label could therefore come out `sentinel` in one variable and `value` in
  another. Both paths now classify through one function.
- **"Do not know" is recognised.** The sentinel vocabulary matched `don't know` / `dont
  know` but not `do not know`; `suppressed` and `not on the questionnaire` are recognised
  too. The vocabulary stays deliberately small: every word in it has to survive appearing
  as a *fragment* of a longer label, because coding lists put sentinel words inside real
  categories — "Surgery (type not known)" is a reason periods stopped, not missing data.
  `x-value-kind` is the answer for wording the vocabulary cannot safely infer.
- **A description that mentions missingness no longer makes the value missing.** The
  classifier matched the value's prose `description`, so a substantive value documented as
  *"…not a missingness sentinel"* was filed under **special codes**. It now reads the label
  and the `$ref` name, falling back to the description only when there is no label.
- **A bare `enum`/`const` is classified like the `oneOf` spelling.** Values that never passed
  through a union were left untagged, so `enum: [1, 2, 999]` rendered `999` as a real category
  and embedded it for search while the equivalent `oneOf` of titled consts did not.
- **A `$ref` is read by its def name, not its path.** The whole URI was matched, so a shared
  file called `common/missing_codes.json` turned every value reached through it into a special
  code. Identifier spellings (`dont_know`, `not_applicable`), kebab-case and the U+2019
  apostrophe are now folded to one form before matching.
- **`x-value-kind` precedence is well-defined.** The nearest declaration wins — value, then
  branch, then property. Grouping branches into a nested union no longer discards a per-member
  declaration; an `allOf` branch no longer retags the property's own values or lets array order
  decide the answer; and a declaration beside a `$ref` overrides the referenced schema even when
  that schema holds the union. The keyword's published type is now `"value" | "sentinel"`
  (`DeclaredValueKind`) rather than the wider `ValidValueKind`.
- **A field with no real categories is no longer typed `categorical`.** The check counted
  sentinels as categories, so a sparse coding table that declares nothing but missing/NA
  codes was badged `categorical (integer)` beside a values cell holding no categories. It
  now reports the underlying type, and the **special codes** separator is only drawn when
  there is something above it to separate.
- **`x-value-kind` no longer leaks into dataset metadata.** It was excluded from the row-level
  passthrough but not the category- and table-level one, so it could appear in **Additional
  information** while having no effect there.
- **The data-type badge is a rectangle again.** A long type (`categorical (integer)`) wraps
  to three lines in a narrow Data type column, and the pill radius rounded that block into a
  circle; it is `6px` now, matching inline code chips.

Between them these change which values render under **special codes** and which are indexed
for semantic search. A coded value in a numeric field whose label the vocabulary does not
recognise is now shown as a real category rather than a special code — set `x-value-kind`
where the wording is not decisive.

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
