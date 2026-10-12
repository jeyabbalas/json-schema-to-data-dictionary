# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

Skip patterns that say exactly what the schema enforces, the schema's comments where readers
see them, and an Excel workbook instead of a CSV file.

### Added

- **Excel export.** `tableToXlsx(table, { title, includeSkipLogic, includeAbout, compress })`
  builds a formatted workbook, and it is what the download button now saves (`exportFormat:
  "csv"` restores the CSV file; *Copy* still copies CSV text). The *Data dictionary* sheet is laid
  out like the table: one code per line with the code bold, special codes under a *Special codes*
  line in amber, under a code the skip patterns that set it with the rule's comment, conditional
  constraints with theirs, notes, a frozen and filterable header, a heavier rule between
  categories. A *Skip logic* sheet lists every rule and an *About* sheet the dataset's
  description and notes, its categories, a key to the formatting and the metadata. The static
  HTML embeds the workbook so its button works offline. Written by `buildXlsx`, a small
  dependency-free `.xlsx` writer (also exported); the demo no longer loads ExcelJS.
- **Comments are shown.** A rule's `$comment` (and those of its clause and the property it
  constrains; for a `then`, its `if`'s, or that of the definition a bare `$ref` there names) is
  on each conditional constraint (`ConstraintItem.comment`) and under each code
  it sets, and is visible in the *Skip logic* panel (it was a tooltip there and nowhere else). A
  variable's `$comment` is a *Note* under its description (`row.__comment`; it is still the
  description's last line, for flat exports), a code's `$comment` — on its branch or on the shared
  definition it came from — is `ValidValue.comment` (it was dropped), and the comments of a
  category (`category.comment`, no longer merged into its description) and of the dataset
  (`table.comment` now also takes the row object's) are notes under their descriptions.
- `ConditionalEffect.kind` (`equals`, `oneOf`, `notEquals`, `notOneOf`, `required`, `absent`,
  `constraint`, `combination`, `forbidden`), `text`, `excluded` and `comment`;
  `ConstraintItem.comment` and `references`; `ValidValue.comment`; view model `RowVM.comment`,
  `CategoryVM.comment`, `ValueVM.comment`, `ConditionVM.comment`, `ConstraintVM.comment` and
  `references`, `RuleGroupVM.kind` and `text`; `splitDescription`, `validValuesCell`,
  `constraintsCell`, `XLSX_MEDIA_TYPE`; `PropertyAnalysis.types` (the JSON types a value may
  take); types `ConditionalEffectKind`, `XlsxExportOptions` and the `Xlsx*` writer types.
- A *HESP household panel* fixture and demo preset (`?preset=hesp`): 265 variables and 171
  skip-pattern and consistency rules of every shape this release reads. The demo opens with it
  (it opened with *COVID-19 surveillance*, still `?preset=covid`).
- **Skip patterns over nested data.** A rule can reach into a value: a field of an object, however
  deep (`point.tier = "platinum" or point is null`, `deep.l2.l3 is null`), an item of a list
  (`contains`, with `minContains`/`maxContains`: `people has at least 2 items where people[].age ≥
  70`; `items`: `people has only items where …`), a tuple position (`days[0] = "0001-01-01" or
  days[0] is absent`, with what its items' type lets through: `d[0] ≥ 70 or d[0] is null or d[0] is
  absent`; `items` beside `prefixItems` is about the items after them: `value has only items where
  item = "y" from value[1] on`), a list's or an object's size (`words has at least 2 items`, `value
  has at most 3 properties`) and distinct items. Each test says what passes it untested:
  `properties` and `required` pass a value that is not an object, `contains` and `items` one that is
  not a list, `maximum` a null item (`value has only items where (item ≤ 999 or item is null)`). A
  requirement inside a value is its field's: `point.x` reads `value must be present if point is an
  object (may be null)` (`value must be present (may be null)` when the condition needs a point
  anyway). A position has no row of its own: a rule that sets one is on its list's row, which names
  it (`days[0] = "0001-01-01" or absent` on `days`; `parts[0].k` is on `parts[].k`), and one that
  reads one is that row's, with a link to it (`triggers` are row names). These read as JSON before
  (`point matches {"properties":…}`). A rule inside a nested object or in each element of a list
  whose every effect is on that object's fields leaves out the case of an object that is not one: it
  has no fields to constrain. A rule in each element of a list says its fields are one item's:
  `people[].name = null in the same item`.
- **Rules a value makes of itself** — an `if`/`then`/`else` in a property's own schema, in its
  list's items, in a map's values or in one branch of a union — are constraints of its row, in
  words: `When value ≥ 1000, value ≥ 9007199254740990.`, `Each item: When value has at least 3
  items, value has only items where item is an integer.`, `When value is an integer and value ≥
  100, …` (from one branch of a union, where the test does not already say which values it is
  about). They read "Has a conditional (if/then) sub-rule." before.
- `ConditionalEffect.required`, `within` and `orAbsent`, `ConstraintItem.orAbsent`,
  `RuleGroupVM.qualifier`, `within` and `literals`: the *Skip logic* panel and sheet follow a value
  with what it leaves unsaid (`→ 999 Missing or absent`, `→ gold (required if point is an object)`),
  and a rule that sets a code but also lets the variable be absent keeps its sentence among the
  constraints beside the code's badge.
- The *Nested stress tests* example has skip patterns now, made up but true of every record of
  data-table's file: 18 rules (on the record, inside `key_order`, `odd_keys` — whose keys need
  quoting — and each person; some read or set a list's positions), `dependentRequired` inside
  `point` and the object branch of `shifty`, and 5 rules values make of themselves.

### Changed

- **Skip patterns read whatever shape they take.** A condition may use `anyOf`/`oneOf`/`allOf`/
  `not`, a range together with excluded codes (`income ≤ 0 and income ∉ {-777, -888}`), or a
  nested `if`; an effect may rule a value out (`value ≠ -666`), allow a range or codes (`1 ≤ value
  ≤ 12 or value is one of -777, -888, -999`), require the variable, or constrain several variables
  together (`at least one of these holds: checking_owned = 1; savings_owned = 1`). These read
  "Constrained when …" or "condition holds" before (162 of HESP's constraints). `then.required`,
  `then: false`, `else` and `dependentSchemas` say what they require too.
- **Codes read with their labels** in conditions and effects: `partner_present = 0 (No)`,
  `value = -666 (Not applicable / structural skip)`, each variable's own label, as in its Valid
  values. A "Label (code)" in the rule's comment names only a code the variable does not label,
  and only as the short phrase after its verb ("… are Nonsmoker (777)" → "Nonsmoker"). Before,
  the comment's words replaced the variable's label for a code a rule set: BCRPP's BBD codes read
  "(BBD type/year slots 2-4 are NA)", and a comment's label could contradict the code's own.
- A rule that allows a *set* of codes (`enum`) is a constraint of the row, no longer an "if …"
  on each code: it allows them, it sets none (`hrt_dur`'s 666, 777 and 888 each read "if
  meno_status = 2"). Only a rule that sets one value is shown on that value.
- A value a rule pins that the variable does not declare is listed as a special code only when it
  reads as one and the variable's own schema allows it; a count set to 0 (HESP's `mortgage_count`,
  `months_housing_arrears` …) is a measured value and stays a constraint, and a value the schema
  rejects (777 for a score of 0–100) is a contradiction, which a table warning names.
- Several rules that set one code are joined by "or" in `ValidValue.condition`, a compound
  condition in parentheses (`BBD_history = 0 (No) or BBD_number = 0`); "; " could read as "and".
- A condition on a property that may be absent says it also holds then (`smoker = 1 (Yes) or
  smoker is absent`): `properties` only tests what is there. So does the opposite of a test the
  `if` makes on a property it requires (an `else`, a `not`): `smoker ≠ 1 (Yes) or smoker is absent`,
  unless every record has it. And a rule's requirement on a variable that may be absent says it
  may be (`value = 999 (Missing) or absent`).
- A range tests only numbers and a pattern only strings, so a condition on a variable that also
  takes other values says they pass (`income ≥ 1 or income is a string`); a `type` beside a range
  is kept when it narrows the variable's own (`weight is an integer and weight ≤ 50`).
- Keywords a rule uses that the dictionary cannot put into words (`minProperties`,
  `patternProperties` …) are shown as written (`the record matches {"minProperties":5}`) and named
  in a table warning; an `if` of them read "always" and a clause of them was dropped.
  `dependentRequired` and `dependentSchemas` inside a clause are rules of their own, a nested rule
  carries the comment of the block around it, and a rule without a condition reads "In every
  record, …".
- A variable's own `title` comes first in its description and replaces the title of a shared
  definition it `$ref`s ("Cross-sectional household weight", not "Survey analysis weight …").
- A typed branch beside codes — a date, a string with a pattern, plain text — is the substantive
  value, like a range: an identifier with string codes is `string + coded values` with `matches
  ^HH[0-9]{8}$` listed above the codes (it listed only the codes); a date with a missing code is
  `date + coded values`. Disjoint ranges are all stated (`0 ≤ value ≤ 10 or 100 ≤ value ≤ 200`),
  and codes the measured branch excludes within its range are a constraint (`Measured value is
  never -666, -777, -888 or -999`).
- The flat export (`toPlainRows`, CSV) puts one value or constraint per line, the special codes
  after a `Special codes:` line and a comment after the value or constraint it explains, on the
  same line however it was written; downloaded CSV files start with a byte-order mark so Excel
  reads them as UTF-8.
- A `pattern` is described as itself (`Matches pattern …`): the guesses "US ZIP code" and "US
  Social Security Number" named any pattern of five, or three-two-four, digits.
- The opposite of a range on a variable that is only ever a number reads as the range it leaves
  (`id < 12`, was `not (id ≥ 12)`), and "or" inside "or" needs no parentheses.
- A condition leaves out what its other tests already make it: `point.tier = "it's"` needs a
  point that is an object (it read `point is an object and point.tier = "it's"`), `days[0] = …` a
  list with a first item (`days is an array and days has at least 1 item and …`), and `age ≥ 70`
  a number, of an age that is an integer or null (`age is an integer and age ≥ 70`; the type
  still rules a null age out). Tests of `oneOf` that cannot both hold read with "or" (`shifty is
  an integer or true or false`, was `exactly one of: …`), and a rule about one variable alone
  leaves out the values both sides pass untested (`When ids has at least 2 items, value has no
  repeated items.`, was `… or ids is null, … or value is null.`). A requirement leaves out what
  its condition rules out (`When people has at least 2 items where people[].age ≥ 70, value has at
  most 2 items.`, was `… or value is null.`).
- A rule that requires a variable says `value must be present`, and `(may be null)` where null
  will do (it read `a value is required`, which a null meets too).
- `dependentRequired` joins its fields with "and" (`point.x and point.y are also required`, was
  `point.x, point.y`), each a link to its row; in each element of a list it says the fields are
  one item's (`Required when visits[].glucose_mmol is present in the same item.`).
- `"type": "null"` in a clause reads and groups as `= null`, like `"const": null` (one group in
  the *Skip logic* panel and sheet). An `if`'s own `$comment` is the `then`'s alone: it no longer
  explains the `else` rule, whose condition is the opposite.
- The workbook's *Skip logic* sheet says what a rule requires about "value", as the dictionary's
  sentences do, with codes as JSON so `"4"` reads apart from `4` (`value = "gold" or absent`, was
  `= gold or absent`); its key says it lists the `if`/`then` rules, a `dependentRequired` rule
  being stated on its variables' rows, what `value must be present`, `x[0]` and `or value is null` mean,
  and that *Required* allows null where the type does.

### Fixed

- "Income decline" and other labels where *decline* is a noun were filed as special codes
  ("declined" still is), as were labels whose parenthesis mentions missingness: "Ever (unknown
  current or former)" is a category of ever-users.
- A range with an exclusive bound read as inclusive in Valid values (`0–100` for `0 < value ≤ 100`),
  and `minimum` with a stricter `exclusiveMinimum` stated the looser bound.
- An object whose rules between its fields are listed on those fields no longer also says "Has a
  conditional (if/then) sub-rule."
- Cells of the *Skip logic* sheet started with "=" (`= null`): stored as text, but Excel read
  them as formulas once edited. The writer now also quote-prefixes any text that starts with
  `=`, `+`, `-` or `@`.
- A *Skips N* chip counted the variable itself when a rule bounds a list by its own length
  ("Answers to ids set 2 other variables" of a rule on `ids` and one on `id`).

## 0.7.0 - 2026-10-11

A calmer table that you can size, and skip patterns you can follow.

### Added

- **Resizable columns.** Drag the edge of a column header to resize the column; double-click
  it (or press `Enter` on the focused edge) to fit the column to its content; the arrow keys
  nudge it, `Delete` returns it to its default, and *Reset widths* in the toolbar clears them
  all. The edges are focusable separators announced with their width. One custom property per
  column (`--dd-col-name`, `--dd-col-description`, …) sizes every table of the dictionary at
  once, so a resize costs one style write (10 ms per step on a 10,070-variable dictionary). The
  table dispatches `dd-column-resize` (`detail: { column, widths }`, bubbling and composed) and
  the new `columnWidths` option — on `renderDataDictionary` and `tableToHtml` alike — starts
  from saved widths. The element keeps the reader's widths across its own re-renders. The static
  HTML inlines the component's own resize code, so it behaves the same.
- **Skip patterns you can follow.** A code that a skip pattern sets says when, on the code
  itself (`777 Nonparous · if parous = 0`), with the variable it depends on as a link to its
  row. A variable that skip patterns read carries a *Skips N* chip under its name that opens a
  row beneath it listing what each of its answers sets (`if parous = 0 → 777 Nonparous ·
  age_preg1 … breastfeed_dur_b10`). The toolbar's *Skip logic* panel lists every rule the same
  way, grouped by the variable it reads. Following a link expands the target's section, pages
  its row in if it is not rendered yet, leaves a search that does not show it, and flashes it.
- `ConditionalRule.triggers` and, on conditional constraints, `ConstraintItem.triggers`: the
  variables a condition reads, by row name (`["parous", "parity"]`). A conditional constraint
  that pins the variable now carries the pinned value (or set) in `ConstraintItem.value`.
- View model: `ValueVM.conditions` (each skip pattern that sets the value, with its triggers),
  `ConstraintVM.triggers` and `onValues`, `RowVM.skipRules`, `RuleVM.triggers` and `groups`
  (effects grouped by the value they set), `ViewModel.names`; types `ConditionVM`,
  `RuleGroupVM`, `DataDictionaryColumn`, `ColumnWidths` and `ColumnResizeDetail`.
- The semantic-search status chip is exposed as `part="semantic-status"`.
- **EmbeddingGemma 2** (`onnx-community/embeddinggemma-2-ONNX`) is a verified model: the text
  model of Google's multimodal EmbeddingGemma 2, read from its `sentence_embedding` output with
  its task prefixes (`task: search result | query: `, `title: none | text: `), q4f16 on WebGPU
  (q4 without `shader-f16` and on WASM), a `minScore` of 0.20 (noise ceiling 0.195) and WebGPU
  only, like Jina v5 nano. It needs Transformers.js 4.3.1. On the labelled BCRPP queries,
  hybrid ranking reaches MRR 0.92, between LEAF-IR (0.90) and Jina v5 nano (0.94).
- `configOverrides` — an embedder option and a `KnownEmbeddingModel` field: config fields
  replaced before the model loads, read through the module's `AutoConfig` (a new optional
  member of `TransformersModuleLike`). EmbeddingGemma 2 sets its vision and audio encoders to
  `null`, so only the 157 MB text model and its tokenizer are downloaded.
- Demo: a *Nested stress tests* example (`?preset=nested`), the dictionary of the JSON file of
  [data-table](https://github.com/jeyabbalas/data-table)'s nested stress-test fixture: 21
  columns of lists, structs, maps and JSON values in five sections, 48 rows with the nested
  fields, each with the DuckDB type data-table gives it (`x-duckdb-type`) and examples from the
  data. The schema validates all 1,000 records of the file. A golden file pins its output.
- `PropertyShape.unionObjects`: how many branches of the property's `oneOf`/`anyOf` can be an
  object.

### Changed

- **A quieter look.** Neutral greys with one accent (indigo by default; `--dd-accent` still
  themes it), hairline rules instead of a card per category, neutral type badges (amber still
  marks mixed types and special codes), and a compact toolbar of icon buttons. *Expand all* and
  *Collapse all* are one button.
- **One sheet.** The tables scroll together in one viewport under a single sticky column header,
  with sticky category bars and the frozen variable column. Each category table keeps a header
  row for assistive technology, visually hidden. Give the element a height and the dictionary
  fills it, scrolling inside; without one it is as tall as its content, as before.
- Columns nobody has sized share out only the width beyond each column's minimum, so the table
  fits its viewport exactly whenever it can and scrolls sideways only when it cannot.
- The skip-pattern rules, the dataset metadata and the extraction warnings open as panels from
  the toolbar instead of collapsible bars above the table (the warnings were a footer). Their
  buttons — *Skip logic*, *Metadata*, *N warnings* — sit on a line of their own right under the
  search box, with the table's own controls (*Reset widths*, expand/collapse all, copy, CSV) at
  the far end of it; a dictionary with nothing to open keeps those controls beside the search box.
- In the rendered table, a skip pattern that pins a value is shown on that value only, no longer
  repeated as a constraint (`When parous = 0, value = 777 (Nonparous).`). `table.rows`, the CSV
  and spreadsheet exports and the search index are unchanged.
- A range in a skip-pattern condition reads as an inequality — `parous = 1 and 1 ≤ parity ≤ 2`
  (was `parity 1–2`) — and exclusive bounds are described (`x > 5`, `1 ≤ x < 3`) instead of
  `x is constrained`.
- **Nested types read one way only.** Elements that may be null read `array of nullable
  integer` (was `array of integer or null`), so an array of arrays reads `array of nullable
  array of nullable integer (nullable)` (was `array of array of integer or null or null
  (nullable)`). An element type that is a union is parenthesised — `array of (number or string
  or null)` — and in a union of shapes the array comes last: `integer or object or array of
  integer` (was `integer or array of integer or object`).
- A field of a union's only object alternative says so: `When contact is an object` and
  `Required when contact is an object` (were `In variant 2 of contact`, and `Required in variant
  2 of contact` followed by it). With several object alternatives a field still names its
  branch by position (`In variant 2 of c`), and `Required in variant 2 of c` is no longer
  followed by it. A union of an array's elements is named by them: `When events[] is an
  object` (was `… of events`).
- An array or object that must be empty says so: `maxProperties: 0` reads `Must be empty (no
  properties allowed)` (was `At most 0 properties`), and `maxItems: 0` reads like `items: false`.
- **Additional information** and the dataset metadata list their keywords directly instead of
  behind an `Object (N)` toggle. A value whose JSON fits in 60 characters is written out on its
  line (`examples: [[1, 2, 3]]`); a longer one collapses, its key in the summary
  (`▸ examples: Array (1)`); a string's own double quotes are shown as they are
  (`"STRUCT("name" VARCHAR)"`, was `"STRUCT(\"name\" VARCHAR)"`). *Expand additional
  information* (`expandAdditionalInfo`) opens those longer values one level.
- Demo: rebuilt around the dictionary. A slim app bar holds the source menu (examples, open
  files or a folder, the loaded documents and the root document), the semantic-search switch, an
  Export menu (HTML, Excel, CSV, copy) and settings (theme, display options); files and folders
  drop anywhere on the window; the dictionary fills the rest. While semantic search is on, the
  model in use sits beside its switch (*LEAF-IR*, *Jina v5 nano* or *EmbeddingGemma 2*) and
  opens a menu to switch models, each with its download size, parameter count and licence, and
  the device it runs on; the loading and indexing status follows it. Turning semantic search on
  or off, switching models or changing a display option keeps the query. Theme and column
  widths are remembered, and the exported HTML page uses the same full-window layout.
- Demo: a logo that shows what the app does: the JSON Schema logo (its braces, check and x), an
  arrow, then a spreadsheet, in the theme's accent. In an app bar narrower than 540 px it
  becomes a tile, which is also the favicon, and on a phone the example's name shortens before
  the model's does.
- Transformers.js 4.3.1 (was 4.2.0) in the demo, the README examples and the dev dependency.
  `npm run eval` evaluates LEAF-IR alone unless `--model` names others.

### Removed

- `Xenova/bge-small-en-v1.5` and `Xenova/all-MiniLM-L6-v2` are no longer verified models (in
  `KNOWN_EMBEDDING_MODELS` or the demo). They still load as unverified models when given their
  settings: `pooling: "cls"` for bge-small or `"mean"` for MiniLM, and `minScore: 0.25`.
  Without them the embedder warns and pools by mean.

### Fixed

- The column header now stays in view while the table scrolls. It was sticky inside a
  container that never scrolled vertically, so it scrolled away with the rows.
- A data type no longer breaks inside a word in a narrow column (`categoric` / `al
  (integer)`), and a nested field's name breaks between its parent path and its own name, or
  after a `.` of the parent path (`depth5.l2.l3.` / `l4.l5`), not inside a name.

### Maintenance

- `tests/perf-smoke.test.mjs` times the better of two renders, so a render that lands on a busy
  core while other test files run does not fail the budget.
- Development dependencies updated: TypeScript 6.0.3 (was 5.9.3), tsup 8.5.1 and happy-dom
  20.14.6, and the overrides that keep `npm ci` clean now resolve archiver 8, uuid 14 and fast-csv
  5.0.8. `npm audit` finds no vulnerabilities (a high-severity advisory in brace-expansion is
  gone), and `npm ci` prints no warnings. The type declarations are byte-for-byte what TypeScript
  5.9 produced. TypeScript 7 is not adopted yet: tsup bundles the declarations through
  TypeScript's JavaScript API, which 7.0 no longer ships.

## 0.6.0 - 2026-09-05

Variables of any JSON type.

### Added

- **Nested variables.** A property holding an array of objects, an object or an array of
  arrays no longer collapses to a type label: it keeps its row (`array of object` / `object`,
  with a `Fields: …` constraint naming what is inside) and every field inside it gets a row of
  its own right after it, named by its path — `visits[].date`, `address.city`,
  `contact.address.zip`, tuples `genotype[0]`, an inner array `readings[]`, open maps
  `biomarkers.*`, pattern properties `biomarkers./^il_[0-9]+$/`. Nested rows carry
  `__parent`, `__depth` and `__path` (a `PathStep[]`), sit in `table.rows` and in their
  category's `rows`, and so reach `toPlainRows` / `tableToCsv`, the lexical index and the
  semantic chunks unchanged. A field the enclosing object requires reads `Required within
  visits[]`; `if`/`then` and `dependentRequired` inside a nested object are collected with
  path-qualified names (`visits[].fasting = 0`) and join `table.conditionalRules`; a `oneOf`
  of shapes lists every alternative (`string or object`) and badges the fields of an object
  branch `In variant 2 of …` (`Required in variant 2 of …` when that branch requires them); a
  recursive definition is expanded once and then noted (`Recursive structure: same shape as
  events[]`). A tuple says `Exactly 2 item(s)`, `Up to 2 item(s)` or `1–2 items` according to
  its `minItems`; an array of tuples says `Each item: Exactly 2 item(s)`; an array of arrays
  keeps the rules of the innermost elements as `Each inner item: …`, so nothing is lost when
  the expansion is off. `SchemaToTableOptions.expandNested` (default `true`) turns the
  expansion off; `maxNestingDepth` (default 6) bounds it, with a warning when reached.
- The rendered table indents nested rows under their parent with a tree glyph, the parent path
  muted and the field's own name bold (`data-dd-depth`, `.dd-name-prefix` / `.dd-name-leaf`);
  the ranked results list shows them unindented with the full path. `RowVM` gains `depth`,
  `parent`, `namePrefix` and `nameLeaf`; `splitVariableName` and `formatVariablePath` are
  exported, as are the `PathStep`, `PropertyShape` and `SchemaRef` types
  (`analyzeProperty` now returns the property's `shape`).
- `toPlainRows(table, { includeInternalColumns: true })` adds a `Parent` column.
- `contains` is rendered (`Must contain an item matching: …`), `propertyNames` too
  (`Property names match pattern …`), and a closed object says `No other properties allowed`.
- Demo: a *Longitudinal cohort* preset (`?preset=longitudinal`) with repeated visits three
  levels deep, arrays of values with missing codes, a tuple, an open map and a recursive event.
- A golden-output test (`tests/golden.test.mjs`) pins the projection of every fixture.

### Changed

- **Arrays of scalars are hoisted into the row.** The item schema's codes, ranges and format
  are the variable's own — **Data type** reads `array of number + coded values` /
  `array of date` / `array of categorical (integer)`, the codes are in **Valid values**, the
  item constraints are prefixed `Each item:` and the item format is the **Format**. Item
  annotations join the description and item extras sit under `Additional information.items`.
- `humanizeName` treats brackets, quotes and `*` as separators (`visits[].date` → *visits
  date*, `genotype[0]` → *genotype 0*), so a path typed as words is an exact name match and the
  semantic identity chunk reads naturally. Names without them humanise exactly as before, so
  cached vectors and snapshots stay valid and `EMBED_TEXT_VERSION` remains 2.
- Items typed `["integer", "null"]` read `array of integer or null` (the `(nullable)` suffix
  is the array's own); `additionalItems`, `unevaluatedItems`, `dependentRequired` and
  `dependentSchemas` on a property are consumed rather than shown in **Additional information**.

### Fixed

- **A union of typed branches is no longer typed `any`.** `anyOf` / `oneOf` branches that
  declare a type or format but neither a range nor coded values (`{ "type": "string" }`,
  `{ "type": "null" }`, an object or array branch) contributed nothing to the row's type, so
  `oneOf: [string, object]` read `any`, `anyOf: [number, null]` lost its null and
  `oneOf: [date, const 999]` came out `integer`. The branch types are now merged
  (`string or object`, `number (nullable)`, `date` with its code).
- `type: ["string", "object"]` read `string`; it now reads `string or object`.

### Maintenance

- Lazy paging and the results list insert each page of rows through a `<template>` fragment
  rather than `insertAdjacentHTML`. Browsers parse both identically; the change lets the
  component tests run on happy-dom 20, which parses `insertAdjacentHTML` text without the
  context element and dropped the rows.
- Dev dependencies: `@happy-dom/global-registrator` 20 (Node 20+ for development; the
  published package still supports Node 18), and `overrides` pinning the transitive packages
  behind every `npm audit` finding and deprecation warning (adm-zip, sharp, global-agent,
  esbuild, uuid, archiver, unzipper, fast-csv, glob). `npm ci` reports no vulnerabilities and
  no deprecated packages. None of these ship with the library, which has no runtime dependencies.

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
