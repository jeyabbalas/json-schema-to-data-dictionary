# JSON Schema → Data Dictionary

Turn one or more interlinked **JSON Schema** documents that describe a *tabular* JSON dataset
(an array of objects) into:

1. a flat, **spreadsheet-like data dictionary** (an array of row objects),
2. an embeddable, **searchable HTML table** for the web, and
3. a formatted **Excel workbook** for reviewers who live in spreadsheets.

JSON Schema is a great single source of truth for biomedical / epidemiological data
dictionaries — it both documents *and* validates the data. But it is not readable by domain
experts. This library lets the schema stay authoritative while everyone sees the *view* they
expect: data engineers read the schema, domain experts read the table.

- **Zero runtime dependencies.** Ships ESM + types and a single browser bundle, including its
  own `.xlsx` writer. (Semantic search is opt-in and uses an embedding runtime you load yourself.)
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
import { schemaDocumentsToTable, renderDataDictionary, tableToHtml, tableToXlsx, toPlainRows } from "json-schema-data-dictionary";

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
const xlsx = tableToXlsx(table);              // Uint8Array: a formatted Excel workbook
const rows = toPlainRows(table);              // array of plain row objects (CSV-ready)
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
| **Variable name** | The property key — or, for a field inside an array/object variable, its path (`visits[].date`, `address.city`). |
| **Description** | `title` + `description` (the codebook text), following `$ref`s — the variable's own `title` first, replacing the title of a shared definition it `$ref`s — then its `$comment`s, which the table and the workbook show as a **Note**. |
| **Data type** | JSON type / built-in `format` (`date`, `email`, `uuid`, …), `categorical (…)`, `array of …`, or `… + coded values` for mixed types. |
| **Valid values** | `enum`/`const`/`oneOf`/`anyOf` members with labels (`enumDescriptions`, `x-enumDescriptions`, or branch `title`s). Substantive categories are kept visually separate from **special codes** (missing / N/A / skip sentinels); `x-value-kind` declares which is which. A typed branch beside the codes — a range, a date, an identifier's pattern — is the substantive value (`20–65`, `any date`, `matches ^HH[0-9]{8}$`). A code's `$comment` (or its shared definition's) is shown under it. |
| **Constraints** | `required`, numeric ranges, lengths, patterns, array/object bounds (`Each item: …` for the items of an array, `Fields: …` for an object), and **conditional** rules from skip patterns. |
| **Additional information** | Everything else — `default`, `examples`, `deprecated`, vendor `x-*` keywords, … — as a JSON tree: each keyword on a line of its own, short values written out (`examples: [[1, 2, 3]]`) and longer ones collapsible. |

The dataset's own `title`/`description` are shown as a header, and each externally `$ref`'d
object schema becomes a **sub-heading** (e.g. *Demographics*, *Lab measurements*). A `$comment`
on the dataset (its root or row object) or on a category is kept apart from the description, as
`table.comment` / `category.comment`, and shown as a note.

### Nested variables: arrays and objects

A variable need not be a scalar. A property holding an **array of objects** (repeated visits,
events, measurements), an **object** (an address, a nested record) or an **array of arrays**
keeps its own row and is followed by one row per field inside it, named by its path:

```jsonc
"visits": {
  "description": "Study visits attended by the participant",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["date"],
    "properties": {
      "date":   { "type": "string", "format": "date", "description": "Visit date" },
      "weight": { "type": "number", "minimum": 30, "maximum": 250, "description": "Weight (kg)" }
    }
  }
},
"weights": {
  "description": "Self-reported weight at each visit (kg)",
  "type": "array",
  "items": { "anyOf": [{ "type": "number", "minimum": 30, "maximum": 250 }, { "const": 888, "title": "Missing" }] }
}
```

becomes four rows:

```
visits              array of object                  Fields: date, weight
  └ visits[].date     date                           Required within visits[]
  └ visits[].weight   number                         30 ≤ value ≤ 250
weights             array of number + coded values   Each item: Measured value: 30 ≤ value ≤ 250
                    Valid values: 30–250 (measured value) · 888 Missing
```

- **Arrays of scalars are not split.** The item schema's codes, ranges and format are the
  variable's own: they land in **Valid values**, **Constraints** (prefixed *Each item:*) and
  **Format**, and the type reads `array of date`, `array of categorical (integer)` or
  `array of number + coded values`. Elements that may be null read `array of nullable integer`
  (the array's own `(nullable)` comes last: `array of nullable array of nullable integer
  (nullable)`), and an element type that is itself a union is parenthesised:
  `array of (number or string or null)`.
- **Nested rows follow their parent**, indented in the rendered table with the parent path
  muted and the field's own name bold. They carry `__parent` (the parent's variable name),
  `__depth` (0 for a top-level variable) and `__path` (the structured path). Objects nest the
  same way (`address.city`, `contact.address.zip`); tuples (`prefixItems`) become
  `genotype[0]`, `genotype[1]`; an array of arrays gets a `readings[]` row for the inner array;
  an open map (`additionalProperties`) becomes `biomarkers.*` and a `patternProperties` entry
  `biomarkers./^il_[0-9]+$/`; a property name that is not a plain identifier is written
  `parent["odd name"]`. The parent row summarises the container (`Fields: date, weight`,
  `No other properties allowed`, item counts).
- A `oneOf`/`anyOf` of shapes lists every alternative (`string or object`, an array last:
  `integer or object or array of integer`) and the fields of its object branches, badged
  `When contact is an object` — or `In variant 2 of contact` when several alternatives are
  objects. A field the enclosing object requires reads `Required within visits[]`
  (`Required when contact is an object` when only a union branch requires it); `if`/`then` and
  `dependentRequired` inside a nested object, or inside each element of a list of objects, are
  qualified by the path (`visits[].fasting = 0`; in a list's elements `visits[].fasting = 0 in
  the same item`: the condition and what it sets are one visit's) and join `table.conditionalRules`. A rule can
  also reach into a value from outside — a field of an object, an item of a list, a tuple
  position — and reads in the same names (see [the table below](#mixed-types--skip-patterns)).
- A **recursive** definition (an event whose `follow_ups` are events) is expanded once and then
  noted (`Recursive structure: same shape as events[]`), and `maxNestingDepth` (default 6)
  bounds how deep the rows go. `expandNested: false` keeps one row per top-level property; the
  item rules of an array of scalars are hoisted either way.

Every row, nested ones included, is in `table.rows`, so the variable counter, the search index
and `toPlainRows` / `tableToCsv` all see them; `toPlainRows(table, { includeInternalColumns: true })`
adds a `Parent` column.

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
              777  Premenopausal at questionnaire
                   if meno_status = 2 (Premenopausal)
                     Skip pattern: premenopausal (meno_status=2) => age/reason at menopause are …
              888  Missing/Unknown
Constraints   Required · Measured value: 20 ≤ value ≤ 65
```

The measurement range goes to **Constraints**; the codes go to **Valid values**, badged apart
from real categories, each carrying the condition that sets it. In the data the pattern is also
a constraint (`When meno_status = 2 (Premenopausal), value = 777 (Premenopausal at questionnaire).`, with the
pinned `value`), which exports and search keep; the rendered table shows it once, on the code —
unless the rule also lets the variable be absent (`value = 999 (Missing) or absent`, `orAbsent`),
which the code alone would not say: then the sentence stays among the constraints too.
`dependentRequired` and `dependentSchemas` are surfaced as conditional constraints too, and all
`if/then` rules are collected into `table.conditionalRules`. Every rule, and every conditional
constraint, names the variables its condition reads (`triggers: ["parous", "parity"]`).

A rule says exactly what the schema enforces, whatever its shape:

| Schema | Reads |
| --- | --- |
| `if: { properties: { tenure: { enum: [4, 5] } } }` | `tenure ∈ {4 (Occupied without cash rent), 5 (Temporary …)}` — a code reads with the label the variable gives it (a "Label (777)" in the rule's comment labels only a code the variable does not) |
| `{ minimum: 1, maximum: 2 }` | `1 ≤ parity ≤ 2` (exclusive bounds: `x > 5`, `1 ≤ x < 3`) |
| `{ maximum: 0, not: { enum: [-777, -888] } }` | `income ≤ 0 and income ∉ {-777 (Refused), -888 (Don't know)}` |
| `if: { anyOf: [ … ] }` / `oneOf` / `not` / `allOf` | `a = 1 (Yes) or b = 1 (Yes)` / `exactly one of: …` (`shifty is an integer or true or false` when the branches cannot both hold) / `not (…)` / `… and …` |
| a property neither `required` nor in the `if`'s `required` | `smoker = 1 (Yes) or smoker is absent` (`properties` only tests what is there) |
| `{ minimum: 1 }` on a variable that is a number or `"NA"` | `income ≥ 1 or income is a string` (a range tests only numbers, a pattern only strings); `{ type: "integer", maximum: 50 }` of a number variable keeps its type: `weight is an integer and weight ≤ 50`; of an integer-or-null variable, `age ≤ 50` says it (a null age fails it) |
| `then: { properties: { x: { const: -666 } } }` | `value = -666 (Not applicable)` — shown on the code; `value = 999 (Missing) or absent` when some records lack `x` |
| `then: { properties: { x: { not: { const: -666 } } } }` | `value ≠ -666 (Not applicable)` |
| `then: { properties: { x: { enum: [1, 2, 6] } } }` | `value is one of 1 (…), 2 (…), 6 (…)` — a constraint, not a badge on each code: it allows them, it sets none |
| `then: { properties: { x: { anyOf: [{ minimum: 1, maximum: 12 }, { enum: [-777, -888] }] } } }` | `1 ≤ value ≤ 12 or value is one of -777 (Refused), -888 (…)` |
| `then: { anyOf: [{ properties: { a: { const: 1 } } }, …] }` | on `a`, `b`, …: `at least one of these holds: a = 1 (Yes); b = 1 (Yes)` |
| `then: { required: ["x"] }` / `then: false` | `value must be present` (`value must be present (may be null)` of a variable that can be null) / `Not allowed: <condition>.` |
| `else` / an `if` nested in a `then` | the opposite condition (`smoker ≠ 1 (Yes)`; `… or smoker is absent` when the `if` requires a property some records lack) / both conditions (`a = 1 and b = 0`) |
| `dependentRequired` / `dependentSchemas`, also inside a clause | `When a = 0 (No) and b is present, value must be present.` |
| `if: { properties: { point: { required: ["tier"], properties: { tier: { const: "gold" } } } } }` | `point.tier = "gold" or point is null` — a field inside an object reads as its row, and `properties`/`required` pass a value that is not an object (a nested field is absent when its object is absent or null); with `type: "object"`: `point.tier = "gold"` (a gold tier needs a point; "point is an object and" goes without saying, as does "days is an array and" before `days[0] = …`) |
| `then: { properties: { point: { required: ["x"], properties: { tier: { const: "gold" } } } } }` | on `point.x`: `value must be present if point is an object (may be null)` (just `value must be present (may be null)` when the condition needs a point, as `point.tier = "it's"` does); on `point.tier`: `value = "gold" or absent` |
| `{ contains: { required: ["age"], properties: { age: { minimum: 70 } } }, minContains: 2 }` | `people has at least 2 items where (people[].age ≥ 70 or people[].age is null or item is null) or people is null` — `item` is the element, `people[].age` its field |
| `{ items: { … } }` | `people has only items where …`; of a list of values, `value has only items where (item ≤ 999 or item is null)` |
| `{ contains: { const: "en" } }` / `{ minItems: 2 }` / `{ uniqueItems: true }` / `{ maxProperties: 3 }` | `langs includes "en" (English)` / `words has at least 2 items` / `value has no repeated items` / `value has at most 3 properties` (each `or … is null` when the variable can be null — except where nothing turns on it: a rule about one variable alone leaves out the values both sides pass, `When ids has at least 2 items, value has no repeated items.`, and a requirement leaves out what its condition rules out, `When people has at least 2 items where people[].age ≥ 70, value has at most 2 items.`) |
| `{ prefixItems: [{ const: "0001-01-01" }] }` | `days[0] = "0001-01-01" or days[0] is absent` (a list too short has no position 0); a position is one of the list's items, so a test a null item passes says so: `d[0] ≥ 70 or d[0] is null or d[0] is absent` |
| `{ prefixItems: [{ const: "x" }], items: { const: "y" } }` / `items: false` | `value has only items where item = "y" from value[1] on` / `value has at most 1 item` — beside `prefixItems`, `items` is about the items after those positions |
| `then: { properties: { days: { prefixItems: [{ const: "0001-01-01" }] } } }` | on `days`: `days[0] = "0001-01-01" or absent` — a position has no row of its own: it is its list's (`parts[0].k` is one of `parts[].k`), which names it, and a condition on it is a link there (`triggers` are row names) |
| a rule inside a nested object or a list's elements | named by the path; when every effect is on that object's fields, its condition leaves out "or point is null" — a point that is not an object has none of those fields. In a list's elements the condition ends `in the same item` (`people[].name = null in the same item`), and so does a `dependentRequired` there |
| an `if`/`then` on a property's own value (`"if": { "minimum": 1000 }, "then": { … }`) | one of its constraints, not a skip pattern: `When value ≥ 1000, value ≥ 9007199254740990.` (`Each item: …` for a list's items; `When value is an integer and …` from one branch of a union, where the test does not already say so) |
| keywords it cannot put into words (`minProperties` of the record, `patternProperties`, `propertyNames` …) | shown as written — `the record matches {"minProperties":5}`, `props matches {"propertyNames":…}` — and named in a table warning |

The rule's `$comment` — and those of its clause and the property it constrains, and for a `then`
those of its `if` (or of the definition a bare `$ref` there names) — is the rule's `description` and each conditional constraint's `comment`: the table shows it under the
condition it explains, in the *Skip logic* panel, and in the workbook. A value a rule pins that the
variable does not declare is listed as a special code only when it reads as one (`777`, or a label
like "Not applicable") and the variable's own schema allows it; a rule that sets a count to 0 pins
a measured value, and says so as a constraint, and one that sets a value the variable's schema
rejects is named in a table warning. A code several rules set is used when any of their
conditions holds (`ValidValue.condition` joins them with "or").

The rendered table lets you follow a pattern from either end: the variable named in a condition
is a link to its row, a variable that patterns read carries a **Skips N** chip under its name
that opens a row listing what each of its answers sets (`if meno_status = 2 → 777
Premenopausal at questionnaire · meno_age`, `→ one of 666 777 888 · hrt_dur`, `→ not -666 ·
move_reason`), and the **Skip logic** button under the search box opens a panel listing every
rule that way, grouped by the variable it reads, each with its comment. A value there is followed
by what it leaves unsaid: `→ 999 Missing or absent`, `→ gold (required if point is an object)`.
A chip counts the *other* variables a variable's answers set: a rule that bounds a list by its own
length sets no other.

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
`"value"` keeps it among the real categories. Those two are the only accepted values —
`"measurement"` is derived from a branch's range, never declared — and anything else is ignored.

The built-in vocabulary is deliberately small, because each word has to survive appearing
inside a longer label: `Surgery (type not known)` is a reason periods stopped, `Ovarian
suppression` is a treatment, and sodium is spelled `Na`. So reach for this keyword rather than
expecting wording to be read correctly — in particular when the label is a bare code and the
meaning lives in the `description`, or when an `enumDescriptions` entry is a sentence rather
than a name.

The nearest declaration wins: on the `const`/`enum` itself, then on the union branch, then on
the property. It is read through a `$ref` — so it belongs on the shared `$defs` entry that
defines a code, where it covers every use at once — and a declaration alongside the `$ref`
overrides what the referenced schema said. An `allOf` branch stamps only the values that branch
contributes, never the property's, since `allOf` is unordered. Unlike other `x-*` keywords it
does not appear in **Additional information**.

## Rendering

### Interactive component (recommended)

```ts
renderDataDictionary(container, table, options?);
```

Mounts a `<json-data-dictionary>` web component. By default it uses a **Shadow DOM** so its
styles never collide with your app. Features: instant search with highlighting + counts +
empty state (`/` to focus, `Esc` to clear), collapsible category sections, a sticky column
header and frozen variable column, [resizable columns](#column-widths), skip patterns you can
follow from either end (see [Mixed types & skip patterns](#mixed-types--skip-patterns)),
collapsible JSON trees, copy as CSV / download as an Excel workbook, and optional
[semantic search](#semantic-search-opt-in).

Give the element a height — or put it in a container that has one — and the dictionary fills it:
the title and toolbar stay put while the table scrolls inside, under its column header, with
the horizontal scrollbar always in reach. Without a height it is as tall as its content. A long
dataset description scrolls in a box of its own, at most `min(25vh, 200px)` tall
(`--dd-description-max-height` sets another bound).

```css
#dict { height: 80vh; }   /* renderDataDictionary(#dict, …) fills it */
```

While a query is typed the table becomes **one ranked results list**: rows whose variable name
equals the query first, then the other matches by relevance, each showing its category and,
with semantic search on, the *related* rows badged. Clearing the box restores the category
sections. Large dictionaries render lazily: the first `pageSize` rows (default 100) are
materialised up front and each category fills in as it scrolls into view (or via its *Show
more* button). Measured in Chrome on a 10,070-variable dictionary (1,045 categories): first
paint 0.2 s (was 7.4 s in 0.2), 35k elements (was 380k), 18–29 ms of script per keystroke
(was 0.4–1.1 s), 6 ms to clear the search box (was 2.4–3.3 s), 10 ms per step of a column
resize. Small dictionaries (up to five pages) are rendered in full. Nested fields (see [Nested variables](#nested-variables-arrays-and-objects))
sit indented under their parent with the parent path muted; the results list shows them
unindented with their full path, since it lists rows out of context.

Theme it from your page with CSS custom properties (they pierce the shadow boundary):

```css
#dict { --dd-accent: #2563eb; }            /* also: --dd-bg, --dd-fg, --dd-border, … */
json-data-dictionary::part(semantic-status) { display: none; }   /* if your page shows its own */
```

Need your app's CSS to cascade in instead? Opt out of isolation:

```ts
renderDataDictionary(container, table, { shadow: false });
```

Other options: `{ theme: "light" | "dark" | "auto", expandCategories, expandAdditionalInfo, includeExport, exportFormat: "xlsx" | "csv", searchPlaceholder, emptyCell, title, pageSize, resultsPageSize, columnWidths }`
(`pageSize: Infinity` disables lazy rendering; `resultsPageSize` is how many results are shown
before *Show more*, default 50). Rows are materialised on demand, so read the data through
`toPlainRows(table)` rather than by scraping the DOM.

#### Column widths

Readers resize a column by dragging the edge of its header; a double-click (or `Enter` on the
focused edge) fits the column to its content, the arrow keys nudge it (`Shift` for bigger
steps), `Delete` returns it to its default, and *Reset widths* in the toolbar clears them all.
Columns nobody has sized share the table's width; a sized one keeps its width, and the table
scrolls sideways when the columns outgrow it.

The table reports every change in a `dd-column-resize` event (bubbling and composed). Hand the
widths back to keep them across renders or visits:

```ts
const saved = JSON.parse(localStorage.getItem("widths") ?? "{}");
renderDataDictionary(container, table, { columnWidths: saved });   // { "Description": 420, … } in px
container.addEventListener("dd-column-resize", (e) => {
  localStorage.setItem("widths", JSON.stringify(e.detail.widths)); // detail: { column, widths }
});
```

From CSS, `--dd-col-name`, `--dd-col-description`, `--dd-col-type`, `--dd-col-format`,
`--dd-col-values`, `--dd-col-constraints` and `--dd-col-additional` set a column's width.

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
matches (`kg/m2`, `meno_`). Nested paths split the same way — `visits[].date` matches *date* and
*visits date* typed as words — and the full path typed as-is is an exact name match.

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
- Keyword and semantic rankings are fused with reciprocal-rank fusion: rows whose name equals
  the query come first; every other keyword match and up to `maxRelated` rows the model found on
  its own (badged *related*; hover the name for the similarity) follow in fused order, so a
  keyword match the model also ranks highly moves up, and a strongly related row can sit above a
  weak keyword match. Keyword search keeps working throughout — and if anything fails.

`semanticSearch` options: `cache` (a `VectorCache`, or `false` for memory only), `snapshot`
(precomputed vectors, see below), `dims` (Matryoshka truncation of the vectors), `maxRelated`
(default 10), `minScore` (similarity floor; defaults to the model's), `minQueryLength` (3),
`debounceMs` (250) and `onStatus(status)`. Scores are **mean-centred cosine similarities**: the
index subtracts the corpus' mean embedding before comparing, so unrelated rows sit near 0 and
related ones well above it, which is what makes one floor work across models.

#### Choosing a model

`createTransformersEmbedder(moduleOrLoader, { model, dtype, device, pooling, queryPrefix, documentPrefix, dims, maxLength, minScore, batchSize, configOverrides, modelOptions, tokenizerOptions })`
has verified configurations (`KNOWN_EMBEDDING_MODELS`) for these models. Throughput was
measured in Chrome 152 on an Intel MacBook on real dictionary text (≈ 180 characters per
chunk, batches of 16) unless noted; a 10,000-variable dictionary is about 13,000 chunks.
EmbeddingGemma 2 needs Transformers.js 4.3.1 or later.

| Model | Params | Download | Licence | WASM | WebGPU | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `MongoDB/mdbr-leaf-ir` (default) | 23M | 23 MB q8 · 46 MB fp16 | Apache-2.0 | 16 texts/s single-threaded, ~70 texts/s with threads (10k vars ≈ 3 min) | **~800 texts/s** fp16 (10k vars ≈ 16 s) | Best retrieval quality under 100M params (BEIR nDCG@10 53.6); uses the model's `sentence_embedding` output. |
| `jinaai/jina-embeddings-v5-text-nano-retrieval` | 239M | 124 MB q4f16 | **CC-BY-NC-4.0** (non-commercial use only) | impractical | ~60 texts/s q4f16 (10k vars ≈ 4 min) | Highest quality (MTEB-English-v2 71.0; best MRR on the labelled set), multilingual, 8k context. WebGPU only. |
| `onnx-community/embeddinggemma-2-ONNX` | 270M (text model) | 157 MB q4f16 + 32 MB tokenizer | Apache-2.0 | impractical | ~70 texts/s q4f16 on an M1 Pro, where LEAF-IR runs ~270 and Jina ~110 (10k vars ≈ 3 min) | The text model of Google's multimodal EmbeddingGemma 2 (Gemma 4): its vision and audio encoders are left out of the config, so their weights are never downloaded. Second-best MRR on the labelled set, 100+ languages, 8k context, Matryoshka 128–768. WebGPU only. |

Once embedded, the vectors of a 10,000-variable dictionary (13,400 chunks, 39 MB) come back from
IndexedDB in about 0.4 s on the next visit. On the labelled BCRPP query set (`npm run eval`),
hybrid ranking reaches MRR 0.90 with LEAF-IR, 0.92 with EmbeddingGemma 2 and 0.94 with Jina v5
nano, against 0.82 for keyword search alone.

Any other Transformers.js embedding model works if you pass `pooling` (`"cls"`, `"mean"`,
`"last_token"` — mask-aware, so right-padded batches are correct — or `"sentence_embedding"`
for exports that include their pooling head), the prefixes and `minScore` explicitly; a
multimodal checkpoint loads as a text model with `configOverrides` set to `null` for each
encoder it should leave out (`{ vision_config: null, audio_config: null }`). To not
depend on a third-party Hub repo, mirror the model files (`config.json`, `tokenizer.json`,
`tokenizer_config.json`, `special_tokens_map.json`, `onnx/model_*.onnx` and their
`.onnx_data` sidecars) into your own Hugging Face account and set `model: "<account>/<repo>"`.
After `load()` the embedder's `info` reports the resolved `device` and `dtype`.

#### Precomputed vectors (large dictionaries)

Embedding 10,000 variables on a laptop takes about 40 s on WebGPU and tens of minutes on WASM.
If you publish the dictionary, embed it once and ship the vectors next to the schema; the
browser then only embeds the query:

```bash
npm install --no-save @huggingface/transformers@4.3.1   # once, for the build step
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
serveEmbedder(createTransformersEmbedder(() => import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1"), {
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

Self-contained and interactive (search, collapse, column resizing, skip-pattern links,
export) without any framework — good for SSR or writing a report to disk. `columnWidths` works
here too. The page works offline, so the workbook its download button saves is built when the
page is and embedded in it (base64; `exportFormat: "csv"` embeds a CSV file instead, and
`includeExport: false` neither).

### Spreadsheet export

```ts
tableToXlsx(table)                                   // Uint8Array: the formatted Excel workbook (XLSX_MEDIA_TYPE)
toPlainRows(table)                                   // [{ "Variable name": …, … }]
toPlainRows(table, { stringifyComplexColumns: false }) // keep structured values
tableToCsv(table)                                    // RFC-4180 CSV string
```

The **workbook** is what the download button saves. Its *Data dictionary* sheet has one row per
variable, laid out like the table: one code per line with the code in bold, special codes under
a *Special codes* line in amber, under a code the skip patterns that set it with the rule's
comment in italics, conditional constraints with theirs, the variable's `$comment` as a *Note*,
and one keyword per line in *Additional information*. Its header is frozen and filters, a
heavier rule separates the categories, and the header repeats on printed pages. A *Skip logic*
sheet lists every `if`/`then` rule (condition, what it requires — about "value", as in
`value = "gold" or absent`, codes written as JSON so `"4"` reads apart from `4` — the variables,
its comment; a `dependentRequired` rule is stated on its variables' rows) and an *About*
sheet the dataset's description and notes, its categories with theirs, its special codes with
what each means, a key to the formatting and the dataset metadata. Options: `{ title, includeSkipLogic, includeAbout, compress }`. It is written by a
small built-in writer (`buildXlsx`, also exported) with no dependencies; text that starts like
a formula (`=`, `+`, `-`, `@`) is quote-prefixed, so it stays text when a cell is edited.

A flat cell has no formatting, so `toPlainRows` and the CSV put one value or constraint per
line, the special codes after a `Special codes:` line, and a rule's comment after its constraint
(`… — Note: …`); the `$comment`s of a variable are the last lines of its description. Save a CSV
with a byte-order mark (`"\uFEFF" + tableToCsv(table)`, as the download button does) so Excel
reads it as UTF-8.

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
| `tableToXlsx(table, options?)` | The formatted Excel workbook (`Uint8Array`); `XLSX_MEDIA_TYPE`. |
| `toPlainRows(table, options?)` / `tableToCsv(table, options?)` | Flat export: plain row objects / CSV. |
| `buildXlsx(workbook, options?)` | The dependency-free `.xlsx` writer behind `tableToXlsx`: sheets of rows of (rich-text) cells with styles, frozen panes, filters, merges. |
| `buildViewModel(table, options?)` / `splitDescription(row)` | The render-ready view model (for custom UIs); a row's description apart from its `$comment` lines. |
| `formatVariablePath(path)` / `splitVariableName(name, parent)` | Nested-field paths: the name of a `PathStep[]`, and the muted-prefix / leaf split a renderer shows. |
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
`items`/`prefixItems`/`contains` and nested `properties` at any depth (draft-07 `items` arrays
and `additionalItems` too), `required`/`dependentRequired`/`dependentSchemas`, and
`patternProperties` / `additionalProperties`.

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
