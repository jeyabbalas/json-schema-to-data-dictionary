// Public data model for the JSON Schema -> data dictionary library.
//
// The seven user-facing keys on DataDictionaryRow are intentionally named exactly
// as the spreadsheet column headers so `toPlainRows()` and CSV export are trivial.

import type { Embedder, SemanticStatus, VectorCache } from "./search/types";
import type { VectorSnapshot } from "./search/snapshot";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonSchema = boolean | JsonSchemaObject;

/**
 * A structurally-typed view of a JSON Schema object. Every keyword we read is listed
 * explicitly for editor support; the index signature keeps unknown / non-standard
 * (e.g. `x-*`) keywords accessible so they can flow into "Additional information".
 */
export interface JsonSchemaObject {
  $id?: string;
  $schema?: string;
  $ref?: string;
  $dynamicRef?: string;
  $anchor?: string;
  $dynamicAnchor?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  $comment?: string;

  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;

  type?: string | string[];
  format?: string;
  contentEncoding?: string;
  contentMediaType?: string;
  contentSchema?: JsonSchema;

  enum?: JsonValue[];
  const?: JsonValue;
  // Non-standard but ubiquitous; treated as first-class per project requirements.
  enumDescriptions?: string[] | Record<string, string>;
  "x-enumDescriptions"?: string[] | Record<string, string>;
  /**
   * Declares whether this schema's `const`/`enum` members are substantive answers ("value")
   * or missing/NA codes ("sentinel"), overriding the wording-based guess. Readable on the
   * subschema carrying the value (e.g. a shared `$defs` entry), on a `$ref` sibling -- which
   * wins over the referenced default -- or on the property, as the default for its branches.
   */
  "x-value-kind"?: DeclaredValueKind;

  // Numeric
  multipleOf?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;

  // String
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // Array
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  contains?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minContains?: number;
  maxContains?: number;
  unevaluatedItems?: JsonSchema;

  // Object
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema;
  unevaluatedProperties?: JsonSchema;
  propertyNames?: JsonSchema;
  required?: string[];
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JsonSchema>;

  // Applicators
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;

  [keyword: string]: unknown;
}

/** A single document handed to the library, optionally with a retrieval URI / friendly name. */
export interface SchemaDocumentInput {
  /** Retrieval URI used as the base for resolving relative `$ref`s within this document. */
  uri?: string | undefined;
  /** Optional friendly name used in diagnostics and provenance. */
  name?: string | undefined;
  /** The JSON Schema document. */
  schema: JsonSchema;
}

/**
 * One step of a nested variable's path. `Variable name` is `formatVariablePath(__path)`:
 * `visits[].date` is `[property visits, items, property date]`.
 */
export type PathStep =
  | { kind: "property"; name: string }
  /** Every element of an array (`[]`). */
  | { kind: "items" }
  /** One position of a tuple (`prefixItems`), `[0]`. */
  | { kind: "index"; index: number }
  /** A `patternProperties` entry, `/regex/`. */
  | { kind: "pattern"; pattern: string }
  /** The schema of properties not named: `additionalProperties` / `unevaluatedProperties`, `*`. */
  | { kind: "additional"; keyword: "additionalProperties" | "unevaluatedProperties" };

/** Where a piece of information came from, for provenance and debugging. */
export interface SourceInfo {
  uri: string;
  pointer?: string | undefined;
  ref?: string | undefined;
  name?: string | undefined;
}

/** Classifies a valid value so the renderer can group substantive categories apart from special codes. */
export type ValidValueKind = "value" | "measurement" | "sentinel";

/**
 * What `x-value-kind` may say. "measurement" is derived from a branch's range, never declared,
 * so it is not offered here -- a schema that writes it is ignored.
 */
export type DeclaredValueKind = Exclude<ValidValueKind, "measurement">;

/** One allowed value (or value range) for a variable. */
export interface ValidValue {
  /** The concrete value (`const`/`enum` member). For a measurement range this is `null`. */
  value: JsonValue;
  /** Short human label (e.g. "White", "Premenopausal", or a range like "20–65"). */
  label?: string | undefined;
  /** Longer prose description of the value, when available. */
  description?: string | undefined;
  /**
   * Substantive category ("value"), a numeric/typed range ("measurement"), or a missing/NA
   * code ("sentinel"). Guessed from the value's label and the name of the `$ref` it came
   * from; set `x-value-kind` in the schema to declare it instead.
   */
  kind?: ValidValueKind | undefined;
  /**
   * When a skip pattern sets the variable to this value (e.g. "meno_status = 2 (Premenopausal)");
   * the conditions of several patterns are joined by " or ", a compound one in parentheses. Only
   * a pattern that pins the variable to this one value is listed here; one that allows a set of
   * values is a constraint of the row.
   */
  condition?: string | undefined;
  /** The schema author's `$comment` on this value (on its `const`/`enum` branch or the shared definition it came from). */
  comment?: string | undefined;
  source?: SourceInfo | undefined;
}

/** One constraint expressed by the schema, rendered as a human-readable sentence. */
export interface ConstraintItem {
  /** The originating JSON Schema keyword (e.g. "minimum", "pattern", "required"). */
  keyword: string;
  /**
   * The raw keyword value, kept for tooling. For a skip pattern that pins the variable, the
   * value (`const`) or set of values (`enum`) it is pinned to.
   */
  value?: unknown;
  /** Human-readable rendering (e.g. "20 ≤ value ≤ 65"). */
  text: string;
  /** Conditional context, when the constraint only applies under an `if`/dependency. */
  condition?: string | undefined;
  /** Variables `condition` reads, by row name (`["parous", "parity"]`). */
  triggers?: string[] | undefined;
  /** Other variables `text` names: the rest of a group of which at least one must satisfy a rule. */
  references?: string[] | undefined;
  /** The schema author's `$comment` explaining the rule this constraint comes from. */
  comment?: string | undefined;
  source?: SourceInfo | undefined;
}

/**
 * A spreadsheet-shaped row. The seven literal keys are the table columns. The `__`
 * fields carry grouping/provenance/nesting metadata that renderers use but exports can drop.
 *
 * A variable can be any JSON value. A property holding an object, an array of objects or an
 * array of arrays keeps its row and is followed by one row per field inside it, named by path
 * (`visits[].date`, `address.city`); those rows carry `__parent` and `__depth`. An array of
 * scalars is a single row whose Valid values / Constraints / Format describe the items.
 */
export interface DataDictionaryRow {
  /** The property key, or the path of a nested field (`visits[].date`). */
  "Variable name": string;
  "Description": string;
  "Data type": string;
  "Format": string;
  "Valid values": ValidValue[];
  "Constraints": ConstraintItem[];
  "Additional information": Record<string, JsonValue> | null;
  __category?: string | undefined;
  __source?: SourceInfo | undefined;
  /**
   * The schema author's `$comment`s on the variable (joined by newlines). They are the last
   * lines of `Description` too, so a flat export keeps them; renderers show them as notes.
   */
  __comment?: string | undefined;
  /** Variable name of the row this one is a field of (`visits` for `visits[].date`); absent on top-level rows. */
  __parent?: string | undefined;
  /** Nesting depth: 0 for a property of the row object, 1 for a field inside one, and so on. */
  __depth?: number | undefined;
  /** Structured path of the variable; `Variable name` is its `formatVariablePath` rendering. */
  __path?: PathStep[] | undefined;
}

/** A sub-section of the dataset (e.g. "Demographics"), typically one external `$ref`'d schema. */
export interface DataDictionaryCategory {
  id: string;
  title: string;
  description?: string | undefined;
  comment?: string | undefined;
  rows: DataDictionaryRow[];
  additionalInformation?: Record<string, JsonValue> | null | undefined;
  source?: SourceInfo | undefined;
}

/**
 * What a rule requires of a variable: set to one value (`equals`), one of a set (`oneOf`), anything
 * but a value or set (`notEquals`, `notOneOf`), present (`required`), absent (`absent`), some other
 * constraint such as a range (`constraint`), a requirement it shares with other variables
 * (`combination`: "at least one of …"), or nothing at all — the condition is not allowed (`forbidden`).
 */
export type ConditionalEffectKind = "equals" | "oneOf" | "notEquals" | "notOneOf" | "required" | "absent" | "constraint" | "combination" | "forbidden";

/** One effect of a conditional (skip-pattern) rule on one variable. */
export interface ConditionalEffect {
  variable: string;
  /** A single forced value (`const`) or a set of allowed values (`enum`); `[]` for any other kind of effect. */
  value: JsonValue | JsonValue[];
  /** Resolved human label for a forced (or, for `notEquals`, the excluded) value, when known (e.g. "Nonparous"). */
  label?: string | undefined;
  /** What the effect is; absent on rules built before 0.8. */
  kind?: ConditionalEffectKind | undefined;
  /** The values a `notEquals` / `notOneOf` effect rules out. */
  excluded?: JsonValue[] | undefined;
  /** The requirement in words, about "value": "value ≠ -666 (Not applicable)", "1 ≤ value ≤ 12 or value is one of …". */
  text?: string | undefined;
  /** The `$comment` of the part of the rule that states this effect, when it has its own. */
  comment?: string | undefined;
}

/** A parsed `if/then` (or dependency) rule describing structural missingness / skip logic. */
export interface ConditionalRule {
  /** Human-readable trigger, e.g. "parous = 0" or "parous = 1 and parity = 1". */
  condition: string;
  /** Variables the condition reads, by row name, in the order it names them (`["parous", "parity"]`). */
  triggers?: string[] | undefined;
  /** Authoring prose for the rule, typically from the block's `$comment`. */
  description?: string | undefined;
  effects: ConditionalEffect[];
  source?: SourceInfo | undefined;
}

/** The flattened data dictionary for one tabular dataset. */
export interface DataDictionaryTable {
  title?: string | undefined;
  description?: string | undefined;
  comment?: string | undefined;
  /** All rows in document order (also grouped under `categories`). */
  rows: DataDictionaryRow[];
  /** Rows grouped into sub-sections for display. */
  categories: DataDictionaryCategory[];
  /** Dataset-level conditional / skip-pattern rules. */
  conditionalRules: ConditionalRule[];
  /** Root-schema metadata not captured elsewhere. */
  additionalInformation?: Record<string, JsonValue> | null | undefined;
  /** Non-fatal extraction issues (e.g. unresolved `$ref`s). */
  warnings: string[];
  source?: SourceInfo | undefined;
}

/**
 * A document that could be the root of the data dictionary, as ranked by `findSchemaRoots`.
 *
 * Users often hand the whole project folder to the tool, so the input mixes the table schema
 * with the component schemas it `$ref`s, unrelated data files and sometimes several tables.
 * A candidate is a document that reads like a JSON Schema; the ranking prefers an array of
 * records (a table) that nothing else references.
 */
export interface SchemaRootCandidate {
  /** Position in the input array (usable as `SchemaToTableOptions.rootIndex`). */
  index: number;
  /** Retrieval URI of the document (its `uri`, or a synthetic one). */
  uri: string;
  /** The document's `name`, when the input carried one. */
  name?: string | undefined;
  /** The schema's `title`, when it has one. */
  title?: string | undefined;
  /** The document describes an array of records — i.e. a table. */
  arrayLike: boolean;
  /** Another document `$ref`s into this one, so it is probably a component, not the root. */
  referenced: boolean;
  /** How many variables the row object would contribute (0 when it is not a table). */
  variableCount: number;
}

export interface SchemaToTableOptions {
  /** Resolve the root table schema from this URI instead of auto-detecting it. */
  rootUri?: string | undefined;
  /** Use this input document as root when `rootUri` is not supplied. */
  rootIndex?: number | undefined;
  /** Emit `patternProperties` as pseudo-variable rows like `/regex/`. Default: true. */
  includePatternProperties?: boolean | undefined;
  /** Emit open `additionalProperties`/`unevaluatedProperties` as a pseudo-variable row. Default: true. */
  includeOpenContentRows?: boolean | undefined;
  /** Attach `__source` provenance to rows. Default: true. */
  includeSource?: boolean | undefined;
  /** Treat object schemas referenced from `items.allOf` as category sections. Default: true. */
  splitAllOfObjectCategories?: boolean | undefined;
  /** Max recursion depth when summarising nested schemas (`$ref`/branch traversal per variable). Default: 6. */
  maxDepth?: number | undefined;
  /**
   * Emit a row for every field of an object-shaped variable, an array of objects or an array
   * of arrays (`visits[].date`). `false` keeps one row per top-level property; the item rules of
   * an array of scalars are hoisted into the row either way. Default: true.
   */
  expandNested?: boolean | undefined;
  /** Deepest nested-field level emitted as rows (0 = top-level rows only). Default: 6. */
  maxNestingDepth?: number | undefined;
}

/** Options for the Excel workbook (`tableToXlsx`). */
export interface XlsxExportOptions {
  /** Title in the workbook's properties and on its About sheet. Default: the table's title. */
  title?: string | undefined;
  /** Add the "Skip logic" sheet listing every rule (when the table has any). Default: true. */
  includeSkipLogic?: boolean | undefined;
  /** Add the "About" sheet: the dataset's description and notes, its categories, a key to the formatting. Default: true. */
  includeAbout?: boolean | undefined;
  /** DEFLATE-compress the file. Default: true. */
  compress?: boolean | undefined;
}

export interface PlainRowsOptions {
  /** Convert complex columns to strings so the result exports directly to CSV/XLSX. Default: true. */
  stringifyComplexColumns?: boolean | undefined;
  /** Include the `__category`/`__parent`/`__source` metadata columns (`Category`, `Parent`, `Source`). Default: false. */
  includeInternalColumns?: boolean | undefined;
  /** Placeholder for empty cells. Default: "". */
  emptyCell?: string | undefined;
}

/** A column of the rendered table, named like its header (and the row key it shows). */
export type DataDictionaryColumn =
  | "Variable name"
  | "Description"
  | "Data type"
  | "Format"
  | "Valid values"
  | "Constraints"
  | "Additional information";

/** Column widths in CSS pixels. A column left out keeps its default, proportional width. */
export type ColumnWidths = Partial<Record<DataDictionaryColumn, number>>;

/** `detail` of the `dd-column-resize` event a rendered table dispatches when a reader resizes a column. */
export interface ColumnResizeDetail {
  /** The column that changed, or `null` when every width was reset. */
  column: DataDictionaryColumn | null;
  /** Every width the reader has set, to hand back as `columnWidths` on a later render. */
  widths: ColumnWidths;
}

/** Options shared by the static HTML string and the interactive component. */
export interface RenderHtmlOptions {
  /** Override the dataset title shown in the header. */
  title?: string | undefined;
  /** Placeholder for empty cells. Default: "—". */
  emptyCell?: string | undefined;
  /** Search box placeholder text. */
  searchPlaceholder?: string | undefined;
  /** Show the copy / download controls. Default: true. */
  includeExport?: boolean | undefined;
  /**
   * What the download button saves: a formatted Excel workbook (`"xlsx"`, the default — codes,
   * special codes, skip patterns and notes keep their formatting) or a plain CSV file (`"csv"`).
   * The copy button always copies CSV text.
   */
  exportFormat?: "xlsx" | "csv" | undefined;
  /** Start with category sections expanded. Default: true. */
  expandCategories?: boolean | undefined;
  /** Start with "Additional information" trees expanded. Default: false. */
  expandAdditionalInfo?: boolean | undefined;
  /** Colour theme. Default: "auto" (follows prefers-color-scheme). */
  theme?: "light" | "dark" | "auto" | undefined;
  /**
   * Start with these column widths (px). Readers resize columns by dragging the header edges
   * (double-click fits a column to its content); the table reports every change in a
   * `dd-column-resize` event, whose `detail.widths` can be handed back here to keep them.
   */
  columnWidths?: ColumnWidths | undefined;
}

/**
 * Opt-in semantic search for the interactive component. Bring an {@link Embedder} (see
 * `createTransformersEmbedder`); the component embeds every row once (cached in IndexedDB),
 * and while a query is active shows one ranked results list: every keyword match plus up to
 * `maxRelated` semantically related rows.
 */
export interface SemanticSearchOptions {
  embedder: Embedder;
  /**
   * Vector cache. Default: IndexedDB when available, holding only the most recently indexed
   * dictionary. `false` keeps vectors in memory only.
   */
  cache?: VectorCache | false | undefined;
  /** Maximum number of semantic-only ("related") rows added to the results. Default: 10. */
  maxRelated?: number | undefined;
  /** Cosine floor for related rows. Default: the embedder's `minScore`, then 0.25. */
  minScore?: number | undefined;
  /** Shortest query that triggers a semantic lookup. Default: 3. */
  minQueryLength?: number | undefined;
  /** Idle time before a semantic lookup runs. Default: 250 ms. */
  debounceMs?: number | undefined;
  /** Observe model loading / indexing / readiness / errors. */
  onStatus?: ((status: SemanticStatus) => void) | undefined;
  /**
   * Precomputed vectors for this dictionary (a `.jsddvec` snapshot built with
   * `buildVectorSnapshot`): bytes, a decoded `VectorSnapshot`, or a URL to fetch. Texts found
   * in it are never embedded in the browser; a snapshot from another embedding space or
   * text-template version is ignored with a warning.
   */
  snapshot?: VectorSnapshot | ArrayBuffer | Uint8Array | string | undefined;
  /** Keep the first `dims` components of every vector (Matryoshka models) and renormalise. */
  dims?: number | undefined;
}

/** Options for the interactive {@link renderDataDictionary} mount. */
export interface RenderOptions extends RenderHtmlOptions {
  /** Render inside a Shadow DOM for full style isolation. Default: true. */
  shadow?: boolean | undefined;
  /** Replace the container's existing contents. Default: true. */
  replace?: boolean | undefined;
  /** Enable semantic search (switches the search UI to a ranked results list). */
  semanticSearch?: SemanticSearchOptions | undefined;
  /**
   * Rows materialised per category page. Dictionaries of up to 5 × `pageSize` rows render
   * every row up front; larger ones render the first `pageSize` rows and page the rest in as
   * their sections scroll into view (or via "Show more"). `Infinity` renders everything.
   * Default: 100.
   */
  pageSize?: number | undefined;
  /** Result rows shown per page while a query is active ("Show more" appends a page). Default: 50. */
  resultsPageSize?: number | undefined;
}
