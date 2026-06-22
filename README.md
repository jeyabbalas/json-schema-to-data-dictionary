# json-schema-data-dictionary

Turn one or more interlinked **JSON Schema** documents that describe a *tabular* JSON dataset
(an array of objects) into:

1. a flat, **spreadsheet-like data dictionary** (an array of row objects), and
2. an embeddable, **searchable HTML table** for the web.

JSON Schema is a great single source of truth for biomedical / epidemiological data
dictionaries — it both documents *and* validates the data. But it is not readable by domain
experts. This library lets the schema stay authoritative while everyone sees the *view* they
expect: data engineers read the schema, domain experts read the table.

- **Zero runtime dependencies.** Ships ESM + types and a single browser bundle.
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

## The output table

Each variable becomes one row with these columns:

| Column | What it holds |
| --- | --- |
| **Variable name** | The property key. |
| **Description** | `title` + `description` + `$comment` (the codebook text), following `$ref`s. |
| **Data type** | JSON type / built-in `format` (`date`, `email`, `uuid`, …), `categorical (…)`, `array of …`, or `… + coded values` for mixed types. |
| **Valid values** | `enum`/`const`/`oneOf`/`anyOf` members with labels (`enumDescriptions`, `x-enumDescriptions`, or branch `title`s). Substantive categories are kept visually separate from **special codes** (missing / N/A / skip sentinels). |
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

## Rendering

### Interactive component (recommended)

```ts
renderDataDictionary(container, table, options?);
```

Mounts a `<json-data-dictionary>` web component. By default it uses a **Shadow DOM** so its
styles never collide with your app. Features: instant search with highlighting + counts +
empty state (`/` to focus, `Esc` to clear), collapsible category sections, a frozen variable
column, collapsible JSON trees, and copy / download-CSV.

Theme it from your page with CSS custom properties (they pierce the shadow boundary):

```css
#dict { --dd-accent: #2563eb; }            /* also: --dd-bg, --dd-fg, --dd-border, … */
```

Need your app's CSS to cascade in instead? Opt out of isolation:

```ts
renderDataDictionary(container, table, { shadow: false });
```

Other options: `{ theme: "light" | "dark" | "auto", expandCategories, expandAdditionalInfo, includeExport, searchPlaceholder, emptyCell, title }`.

You can also use the element directly:

```html
<json-data-dictionary id="dict"></json-data-dictionary>
<script type="module">
  import "json-schema-data-dictionary";          // registers the element
  document.querySelector("#dict").table = table; // assign the DataDictionaryTable
</script>
```

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
| `renderDataDictionary(container, table, options?)` | Mount the interactive component; returns the element. |
| `tableToHtml(table, options?)` | Static, self-contained HTML string. |
| `defineDataDictionaryElement(tag?)` | Register the `<json-data-dictionary>` custom element. |
| `toPlainRows(table, options?)` / `tableToCsv(table, options?)` | Spreadsheet export. |
| `buildViewModel(table, options?)` | The render-ready view model (for custom UIs). |
| `analyzeProperty(schema, ctx)` / `SchemaRegistry` | Lower-level building blocks. |
| `STRING_FORMATS`, `describeFormat`, `formatLabel` | The built-in format catalog. |

Supported keywords include the full draft 2020-12 vocabulary (and draft-07 spellings):
`$ref`/`$dynamicRef`, `$id`/`$anchor`, `$defs`/`definitions`, `allOf`/`anyOf`/`oneOf`/`not`,
`if`/`then`/`else`, `enum`/`const` (+ `enumDescriptions` / `x-enumDescriptions`), every
`format`, `contentEncoding`/`contentMediaType`, all numeric/string/array/object constraints,
`required`/`dependentRequired`/`dependentSchemas`, and `patternProperties` /
`additionalProperties`.

## Develop

```bash
npm install
npm run build      # tsup -> dist/ (ESM + .d.ts + browser bundle)
npm test           # node:test over the fixtures in tests/fixtures
npm run example    # writes examples/dictionary.html
```

## License

MIT
