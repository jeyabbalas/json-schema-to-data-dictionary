# JSON Schema → Data Dictionary

Turn one or more interlinked **JSON Schema** documents that describe a *tabular* JSON dataset
(an array of objects) into:

1. a flat, **spreadsheet-like data dictionary** (an array of row objects), and
2. an embeddable, **searchable HTML table** for the web.

JSON Schema is a great single source of truth for biomedical / epidemiological data
dictionaries — it both documents *and* validates the data. But it is not readable by domain
experts. This library lets the schema stay authoritative while everyone sees the *view* they
expect: data engineers read the schema, domain experts read the table.

- **Zero runtime dependencies.** Ships ESM + types and a single browser bundle. (Semantic
  search is opt-in and uses an embedding runtime you load yourself.)
- **Resolves `$ref` across documents** (file-position *and* `$id`-based), degrading gracefully.
- **Understands the hard cases**: mixed measurement/categorical variables, sentinel/missing
  codes, and `if/then` **skip patterns** (structural missingness) — the bread and butter of
  survey data.

## Install

```bash
npm install json-schema-data-dictionary
```

## Quick start

```ts
import { schemaDocumentsToTable, renderDataDictionary, tableToHtml, toPlainRows } from "json-schema-data-dictionary";

// 1. Build the dictionary from one or more interlinked schema documents.
const table = schemaDocumentsToTable([
  { uri: "https://example.org/dataset.json", schema: datasetSchema },   // type: array
  { uri: "https://example.org/demographics.json", schema: demographics }, // a category
  { uri: "https://example.org/labs.json", schema: labs }                  // a category
]);

// 2a. Render an interactive, searchable table into any container.
renderDataDictionary(document.querySelector("#dict"), table);

// 2b. …or get a self-contained HTML string (SSR / write to a file).
const html = tableToHtml(table);

// 2c. …or export to a spreadsheet.
const rows = toPlainRows(table);              // array of plain row objects (CSV/XLSX-ready)
```

Pass schemas as bare objects or as `{ uri, name, schema }`. The `uri` is the document's
retrieval location and is used as the base for resolving its relative `$ref`s — supply it
(e.g. the file path or canonical URL) when your documents reference each other.

### Finding the root

You can hand over a whole folder — the table schema, the component schemas it `$ref`s,
example data files, even several tables. `schemaDocumentsToTable` ranks the documents and
uses the best one: files that do not read like a JSON Schema are ignored, an array of
records beats an object, and a document another one `$ref`s into is a component rather
than a root. When several documents could be the table, the choice is reported in
`table.warnings`. `findSchemaRoots` returns the same ranking so you can offer it as a
choice, and `rootUri` / `rootIndex` pin one explicitly:

```ts
import { findSchemaRoots, schemaDocumentsToTable } from "json-schema-data-dictionary";

findSchemaRoots(documents);
// [{ index: 3, uri: "…/derived_variables.schema.json", name: "derived_variables.schema.json",
//    title: "BGS — Derived Variables table", arrayLike: true, referenced: false, variableCount: 60 }, …]

schemaDocumentsToTable(documents, { rootIndex: 3 });
```

## The output table

Each variable becomes one row with these columns:

| Column | What it holds |
| --- | --- |
| **Variable name** | The property key. |
| **Description** | `title` + `description` + `$comment` (the codebook text), following `$ref`s. |
| **Data type** | JSON type / built-in `format` (`date`, `email`, `uuid`, …), `categorical (…)`, `array of …`, or `… + coded values` for mixed types. |
| **Valid values** | `enum`/`const`/`oneOf`/`anyOf` members with labels (`enumDescriptions`, `x-enumDescriptions`, or branch `title`s). Substantive categories are kept visually separate from **special codes** (missing / N/A / skip sentinels); `x-value-kind` declares which is which. |
| **Constraints** | `required`, numeric ranges, lengths, patterns, array/object bounds, and **conditional** rules from skip patterns. |
| **Additional information** | Everything else — `default`, `examples`, `deprecated`, vendor `x-*` keywords, … — as a collapsible JSON tree. |

The dataset's own `title`/`description` are shown as a header, and each externally `$ref`'d
object schema becomes a **sub-heading** (e.g. *Demographics*, *Lab measurements*).

## Mixed types & skip patterns

Survey variables often mix a measurement with categorical **sentinel codes** for structural
missingness, and enforce questionnaire **skip patterns** with `if`/`then`. For example:

```jsonc
// meno_age
{
  "title": "Age at menopause (years)",
  "$comment": "Source coding: Age in years; 777 - Premenopausal; 888 - Missing/Unknown.",
  "anyOf": [
    { "type": "number", "minimum": 20, "maximum": 65, "not": { "enum": [777, 888] } },
    { "const": 777, "title": "Premenopausal at questionnaire" },
    { "$ref": "../common/defs.json#/$defs/missing3" }      // 888 = Missing/Unknown
  ]
}
// elsewhere, a row-level rule:  if meno_status = 2  then meno_age = 777
```

becomes a single, readable row:

```
Data type     number + coded values
Valid values  20–65            (measured value)
              ── special codes ──
              777  Premenopausal at questionnaire   ↳ when meno_status = 2
              888  Missing/Unknown
Constraints   Required · Measured value: 20 ≤ value ≤ 65 · When meno_status = 2, value = 777
```

The measurement range goes to **Constraints**; the codes go to **Valid values**, badged apart
from real categories, each carrying the condition that triggers it. `dependentRequired` and
`dependentSchemas` are surfaced as conditional constraints too, and all `if/then` rules are
collected into `table.conditionalRules` for a dataset-level *skip patterns* panel.

### Saying which codes are special: `x-value-kind`

Whether `-7` means *"none of the listed options apply"* (a real answer) or *"not recorded"* (a
special code) is not something JSON Schema states, so it is guessed from the value's label and
the name of the `$ref` it came from — plus the conventional `666`/`777`/`888`/`999` codes. When
the wording does not give it away, say so:

```jsonc
"$defs": {
  "dont_know":         { "const": -1, "title": "Do not know",       "x-value-kind": "sentinel" },
  "none_of_the_above": { "const": -7, "title": "None of the above", "x-value-kind": "value" }
}
```

`"sentinel"` files the value under **special codes** and keeps it out of the semantic index;
`"value"` keeps it among the real categories. The built-in vocabulary is deliberately small,
because each word has to survive appearing inside a longer label — `Surgery (type not known)`
is a reason periods stopped, not missing data — so reach for this keyword rather than expecting
the wording to be read correctly. It is read from the subschema that carries the
`const`/`enum` (typically a shared `$defs` entry), from a `$ref` sibling — which overrides the
referenced default — or from the property itself, as the default for its branches. Unlike other
`x-*` keywords it does not appear in **Additional information**.

## Rendering

### Interactive component (recommended)

```ts
renderDataDictionary(container, table, options?);
```

Mounts a `<json-data-dictionary>` web component. By default it uses a **Shadow DOM** so its
styles never collide with your app. Features: instant search with highlighting + counts +
empty state (`/` to focus, `Esc` to clear), collapsible category sections, a frozen variable
column, collapsible JSON trees, copy / download-CSV, and optional
[semantic search](#semantic-search-opt-in).

While a query is typed the table becomes **one ranked results list**: rows whose variable name
equals the query first, then the other matches by relevance, each showing its category and,
with semantic search on, the *related* rows badged. Clearing the box restores the category
sections. Large dictionaries render lazily: the first `pageSize` rows (default 100) are
materialised up front and each category fills in as it scrolls into view (or via its *Show
more* button). Measured in Chrome on a 10,070-variable dictionary (1,045 categories): first
paint 0.3 s (was 7.4 s in 0.2), 34k DOM nodes (was 380k), 22–46 ms of script per keystroke
(was 0.4–1.1 s), 8 ms to clear the search box (was 2.4–3.3 s). Small dictionaries (up to five
pages) are rendered in full.

Theme it from your page with CSS custom properties (they pierce the shadow boundary):

```css
#dict { --dd-accent: #2563eb; }            /* also: --dd-bg, --dd-fg, --dd-border, … */
```

Need your app's CSS to cascade in instead? Opt out of isolation:

```ts
renderDataDictionary(container, table, { shadow: false });
```

Other options: `{ theme: "light" | "dark" | "auto", expandCategories, expandAdditionalInfo, includeExport, searchPlaceholder, emptyCell, title, pageSize, resultsPageSize }`
(`pageSize: Infinity` disables lazy rendering; `resultsPageSize` is how many results are shown
before *Show more*, default 50). Rows are materialised on demand, so read the data through
`toPlainRows(table)` rather than by scraping the DOM.

You can also use the element directly:

```html
<json-data-dictionary id="dict"></json-data-dictionary>
<script type="module">
  import "json-schema-data-dictionary";          // registers the element
  document.querySelector("#dict").table = table; // assign the DataDictionaryTable
</script>
```

### Search

Keyword search needs nothing else and works on every dictionary size. It is a tokenised
BM25F index over the variable name (raw and split: `age_preg1` also matches *age preg*),
description, value labels, category title, format and constraints, with **as-you-type prefix
matching** of the last word (`menop` finds the menopause rows), plural/singular stemming, and
an AND-then-OR policy for multi-word queries (*age at first birth* → `age_preg1`). Exact and
prefix name matches always rank first, and anything the 0.2 substring search matched still
matches (`kg/m2`, `meno_`).

The headless pieces are exported: `createLexicalIndex(lexicalDocumentsFromTable(table))`,
`rankHybrid(lexicalHits, semanticHits, { maxRelated })` and
`createSearchEngine(table, { semantic?, maxRelated, minQueryLength, debounceMs })`, whose
`search(query)` is synchronous for the lexical part and streams semantic hits through
`subscribe()`.

### Semantic search (opt-in)

For power users, the interactive component can also surface **semantically related
variables** — the tobacco rows for the query *smoking*, `bmi` for *body size* — entirely in the
browser, using a small text-embedding model that *you* load. The library stays
dependency-free: it only needs an object implementing the `Embedder` contract, and ships a
reference adapter for [Transformers.js](https://huggingface.co/docs/transformers.js).

```ts
import { renderDataDictionary, createTransformersEmbedder } from "json-schema-data-dictionary";

// Defaults: MongoDB/mdbr-leaf-ir (23M params, 768-d, Apache-2.0, 23 MB q8), device "auto"
// (WebGPU when available, else WASM), dtype "auto" (fp16 on WebGPU, q8 on WASM).
const embedder = createTransformersEmbedder(() => import("@huggingface/transformers"));
renderDataDictionary(container, table, { semanticSearch: { embedder } });
```

What happens:

- Every row becomes short natural-language chunks (name + description; name + category labels)
  and is embedded **once**, in length-sorted batches. Vectors are cached in IndexedDB
  (`jsdd-semantic`, one record per dictionary) keyed by model + text hash, so reloading the
  same schema is instant and only changed rows are re-embedded. The cache holds the most
  recently indexed dictionary. Transformers.js caches the model weights in the browser's Cache
  API.
- **Search works while indexing**: related rows come from the part of the dictionary embedded
  so far, the status chip shows the progress, and the list refreshes as more rows land.
- Keyword and semantic rankings are fused with reciprocal-rank fusion: exact name matches
  first, then keyword matches boosted by semantic closeness, then up to `maxRelated` rows the
  model found on its own, badged *related* (hover the name for the similarity). Keyword search
  keeps working throughout — and if anything fails.

`semanticSearch` options: `cache` (a `VectorCache`, or `false` for memory only), `snapshot`
(precomputed vectors, see below), `dims` (Matryoshka truncation of the vectors), `maxRelated`
(default 10), `minScore` (similarity floor; defaults to the model's), `minQueryLength` (3),
`debounceMs` (250) and `onStatus(status)`. Scores are **mean-centred cosine similarities**: the
index subtracts the corpus' mean embedding before comparing, so unrelated rows sit near 0 and
related ones well above it, which is what makes one floor work across models.

#### Choosing a model

`createTransformersEmbedder(moduleOrLoader, { model, dtype, device, pooling, queryPrefix, documentPrefix, dims, maxLength, minScore, batchSize, modelOptions, tokenizerOptions })`
has verified configurations (`KNOWN_EMBEDDING_MODELS`) for these models. Throughput was
measured in Chrome 152 on an Intel MacBook on real dictionary text (≈ 180 characters per
chunk, batches of 16); a 10,000-variable dictionary is about 13,000 chunks.

| Model | Params | Download | Licence | WASM | WebGPU | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `MongoDB/mdbr-leaf-ir` (default) | 23M | 23 MB q8 · 46 MB fp16 | Apache-2.0 | 16 texts/s single-threaded, ~70 texts/s with threads (10k vars ≈ 3 min) | **~800 texts/s** fp16 (10k vars ≈ 16 s) | Best retrieval quality under 100M params (BEIR nDCG@10 53.6); uses the model's `sentence_embedding` output. |
| `jinaai/jina-embeddings-v5-text-nano-retrieval` | 239M | 124 MB q4f16 | **CC-BY-NC-4.0** (non-commercial use only) | impractical | ~60 texts/s q4f16 (10k vars ≈ 4 min) | Highest quality (MTEB-English-v2 71.0; best MRR on the labelled set), multilingual, 8k context. WebGPU only. |
| `Xenova/bge-small-en-v1.5` | 33M | 34 MB q8 | MIT | 8 texts/s single-threaded | ~200 texts/s fp16 | The 0.2 default; weaker on abbreviations (*BMI*). |
| `Xenova/all-MiniLM-L6-v2` | 23M | 22 MB q8 | Apache-2.0 | ~16 texts/s | ~330 texts/s | Fastest; lowest retrieval quality. |

Once embedded, the vectors of a 10,000-variable dictionary (13,400 chunks, 39 MB) come back from
IndexedDB in about 0.4 s on the next visit. On the labelled BCRPP query set (`npm run eval`),
hybrid ranking reaches MRR 0.90 with LEAF-IR, 0.89 with bge-small and 0.94 with Jina v5 nano,
against 0.82 for keyword search alone.

Any other Transformers.js embedding model works if you pass `pooling` (`"cls"`, `"mean"`,
`"last_token"` — mask-aware, so right-padded batches are correct — or `"sentence_embedding"`
for exports that include their pooling head), the prefixes and `minScore` explicitly. To not
depend on a third-party Hub repo, mirror the model files (`config.json`, `tokenizer.json`,
`tokenizer_config.json`, `special_tokens_map.json`, `onnx/model_*.onnx` and their
`.onnx_data` sidecars) into your own Hugging Face account and set `model: "<account>/<repo>"`.
After `load()` the embedder's `info` reports the resolved `device` and `dtype`.

#### Precomputed vectors (large dictionaries)

Embedding 10,000 variables on a laptop takes about 40 s on WebGPU and tens of minutes on WASM.
If you publish the dictionary, embed it once and ship the vectors next to the schema; the
browser then only embeds the query:

```bash
npm install --no-save @huggingface/transformers@4.2.0   # once, for the build step
node scripts/build-snapshot.mjs path/to/schemas dictionary.jsddvec --int8   # ~1,500 texts/s on a CPU
```

```ts
renderDataDictionary(container, table, { semanticSearch: { embedder, snapshot: "dictionary.jsddvec" } });
```

The snapshot (`buildVectorSnapshot` / `encodeVectorSnapshot` / `decodeVectorSnapshot` /
`loadVectorSnapshot`) stores int8 or fp32 vectors keyed by the same text hashes as the cache,
so a stale snapshot still works: rows whose text changed are embedded live. It must be built
with the same model, pooling, prefixes and `dims` (the `spaceId`); precision may differ (an fp32
snapshot serves fp16 or q8 queries). A 10,000-variable dictionary is ≈ 10 MB at 768 dimensions
int8, ≈ 3.4 MB with `dims: 256`.

#### Running in a worker

Run the model off the main thread by serving it from a Web Worker (this is what the demo does):

```js
// embed-worker.js — a classic worker so it can importScripts() the browser bundle
importScripts("json-schema-data-dictionary.global.js");
const { serveEmbedder, createTransformersEmbedder } = JsonSchemaDataDictionary;
const params = new URLSearchParams(self.location.search);          // e.g. ?model=…&device=auto
serveEmbedder(createTransformersEmbedder(() => import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0"), {
  model: params.get("model") ?? undefined, device: params.get("device") ?? "auto"
}));

// main thread
const embedder = await createWorkerEmbedder(new Worker("embed-worker.js?model=MongoDB%2Fmdbr-leaf-ir&device=auto"));
renderDataDictionary(container, table, { semanticSearch: { embedder } });
```

WebGPU is used inside the worker when the browser exposes it (Chrome/Edge 113+, Safari 26,
Firefox on Windows) and falls back to WASM otherwise. Multithreaded WASM additionally needs a
cross-origin-isolated page (`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`); GitHub Pages does not send those headers, which
is the case for the demo. On first use the browser downloads the model weights from
huggingface.co (and Transformers.js from the CDN you chose); nothing else leaves the browser.

Headless use: `createSemanticIndex(table, { embedder, snapshot?, dims? })` exposes `ready`,
`loaded`, `status`, `coverage`, `subscribe()` and `search(query, { limit, minScore, partial })`
without the widget. The static `tableToHtml` output stays keyword-only.

### Static HTML string

```ts
const html = tableToHtml(table, options?);   // inline <style> + markup + a small inline <script>
```

Self-contained and interactive (search/collapse/export) without any framework — good for SSR
or writing a report to disk.

### Spreadsheet export

```ts
toPlainRows(table)                                   // [{ "Variable name": …, … }]
toPlainRows(table, { stringifyComplexColumns: false }) // keep structured values
tableToCsv(table)                                    // RFC-4180 CSV string
```

### Drop-in `<script>` (no build step)

```html
<script src="node_modules/json-schema-data-dictionary/dist/json-schema-data-dictionary.global.js"></script>
<script>
  const { schemaDocumentsToTable, renderDataDictionary } = JsonSchemaDataDictionary;
  renderDataDictionary(document.querySelector("#dict"), schemaDocumentsToTable([/* … */]));
</script>
```

See [`examples/index.html`](examples/index.html) for a live demo and
[`examples/generate.mjs`](examples/generate.mjs) for building a static page.

## API

| Export | Description |
| --- | --- |
| `schemaDocumentsToTable(input, options?)` | Build a `DataDictionaryTable` from schema documents. |
| `findSchemaRoots(input)` | Rank the documents that could be the table's root (for a root picker). |
| `renderDataDictionary(container, table, options?)` | Mount the interactive component; returns the element. |
| `tableToHtml(table, options?)` | Static, self-contained HTML string. |
| `defineDataDictionaryElement(tag?)` | Register the `<json-data-dictionary>` custom element. |
| `toPlainRows(table, options?)` / `tableToCsv(table, options?)` | Spreadsheet export. |
| `buildViewModel(table, options?)` | The render-ready view model (for custom UIs). |
| `createTransformersEmbedder(module, options?)` | `Embedder` adapter for Transformers.js (opt-in semantic search); `KNOWN_EMBEDDING_MODELS`, `DEFAULT_EMBEDDING_MODEL`, `detectWebGpu()`. |
| `createSearchEngine(table, options?)` | Headless hybrid search: synchronous lexical `search()`, semantic hits via `subscribe()`. |
| `createLexicalIndex(docs, options?)` / `lexicalDocumentsFromTable(table)` / `rankHybrid(...)` | The BM25F index and the fusion behind it. |
| `createSemanticIndex(table, options)` | Headless semantic index: `ready`, `loaded`, `status`, `coverage`, `search()`. |
| `buildVectorSnapshot` / `encodeVectorSnapshot` / `decodeVectorSnapshot` / `loadVectorSnapshot` | Precomputed vectors (`.jsddvec`). |
| `serveEmbedder(embedder)` / `createWorkerEmbedder(port)` | Run any embedder inside a Web Worker. |
| `createIndexedDbVectorCache(options?)` / `createMemoryVectorCache()` | Vector caches for the index (`getMany`, `putMany`, `retainOnly`, `clear`). |
| `analyzeProperty(schema, ctx)` / `SchemaRegistry` | Lower-level building blocks. |
| `STRING_FORMATS`, `describeFormat`, `formatLabel` | The built-in format catalog. |

Supported keywords include the full draft 2020-12 vocabulary (and draft-07 spellings):
`$ref`/`$dynamicRef`, `$id`/`$anchor`, `$defs`/`definitions`, `allOf`/`anyOf`/`oneOf`/`not`,
`if`/`then`/`else`, `enum`/`const` (+ `enumDescriptions` / `x-enumDescriptions` /
`x-value-kind`), every
`format`, `contentEncoding`/`contentMediaType`, all numeric/string/array/object constraints,
`required`/`dependentRequired`/`dependentSchemas`, and `patternProperties` /
`additionalProperties`.

## Develop

```bash
npm install
npm run build      # tsup -> dist/ (ESM + .d.ts + browser bundle)
npm test           # node:test over the fixtures in tests/fixtures
npm run example    # writes examples/dictionary.html
npm run demo       # builds the demo/ site; then `npm run demo:serve` (workers need http://; COI=0 mimics GitHub Pages)
npm run eval       # search-quality metrics on the labelled BCRPP query set with real models (see below)
```

`npm run eval` scores lexical-only, semantic-only and hybrid ranking (recall@5/10, MRR, per tag)
on `tests/fixtures/search-eval.json` for each `--model`, and `--calibrate` prints the
recommended `minScore` per model. It needs the optional devDependency
`@huggingface/transformers` (installed by `npm install`; models are cached in `.cache/`).
`npm run demo:vectors` builds the demo's precomputed vectors the same way and skips quietly
when the dependency is absent.

## License

MIT
