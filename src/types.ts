// Public data model for the JSON Schema -> data dictionary library.
//
// The seven user-facing keys on DataDictionaryRow are intentionally named exactly
// as the spreadsheet column headers so `toPlainRows()` and CSV export are trivial.

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

/** Where a piece of information came from, for provenance and debugging. */
export interface SourceInfo {
  uri: string;
  pointer?: string | undefined;
  ref?: string | undefined;
  name?: string | undefined;
}

/** Classifies a valid value so the renderer can group substantive categories apart from special codes. */
export type ValidValueKind = "value" | "measurement" | "sentinel";

/** One allowed value (or value range) for a variable. */
export interface ValidValue {
  /** The concrete value (`const`/`enum` member). For a measurement range this is `null`. */
  value: JsonValue;
  /** Short human label (e.g. "White", "Premenopausal", or a range like "20–65"). */
  label?: string | undefined;
  /** Longer prose description of the value, when available. */
  description?: string | undefined;
  /** Substantive category ("value"), a numeric/typed range ("measurement"), or a missing/NA code ("sentinel"). */
  kind?: ValidValueKind | undefined;
  /** Skip-pattern / conditional context under which the value applies (e.g. "when meno_status = 2"). */
  condition?: string | undefined;
  source?: SourceInfo | undefined;
}

/** One constraint expressed by the schema, rendered as a human-readable sentence. */
export interface ConstraintItem {
  /** The originating JSON Schema keyword (e.g. "minimum", "pattern", "required"). */
  keyword: string;
  /** The raw keyword value, kept for tooling. */
  value?: unknown;
  /** Human-readable rendering (e.g. "20 ≤ value ≤ 65"). */
  text: string;
  /** Conditional context, when the constraint only applies under an `if`/dependency. */
  condition?: string | undefined;
  source?: SourceInfo | undefined;
}

/**
 * A spreadsheet-shaped row. The seven literal keys are the table columns. The `__`
 * fields carry grouping/provenance metadata that renderers use but exports can drop.
 */
export interface DataDictionaryRow {
  "Variable name": string;
  "Description": string;
  "Data type": string;
  "Format": string;
  "Valid values": ValidValue[];
  "Constraints": ConstraintItem[];
  "Additional information": Record<string, JsonValue> | null;
  __category?: string | undefined;
  __source?: SourceInfo | undefined;
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

/** One effect of a conditional (skip-pattern) rule: a variable forced to a value/codes. */
export interface ConditionalEffect {
  variable: string;
  /** A single forced value (`const`) or a set of allowed values (`enum`). */
  value: JsonValue | JsonValue[];
  /** Resolved human label(s) for the value(s), when known (e.g. "Nonparous"). */
  label?: string | undefined;
}

/** A parsed `if/then` (or dependency) rule describing structural missingness / skip logic. */
export interface ConditionalRule {
  /** Human-readable trigger, e.g. "parous = 0" or "parous = 1 and parity = 1". */
  condition: string;
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
  /** Max recursion depth when summarising nested schemas. Default: 6. */
  maxDepth?: number | undefined;
}

export interface PlainRowsOptions {
  /** Convert complex columns to strings so the result exports directly to CSV/XLSX. Default: true. */
  stringifyComplexColumns?: boolean | undefined;
  /** Include the `__category`/`__source` metadata columns. Default: false. */
  includeInternalColumns?: boolean | undefined;
  /** Placeholder for empty cells. Default: "". */
  emptyCell?: string | undefined;
}

/** Options shared by the static HTML string and the interactive component. */
export interface RenderHtmlOptions {
  /** Override the dataset title shown in the header. */
  title?: string | undefined;
  /** Placeholder for empty cells. Default: "—". */
  emptyCell?: string | undefined;
  /** Search box placeholder text. */
  searchPlaceholder?: string | undefined;
  /** Show the copy / download-CSV controls. Default: true. */
  includeExport?: boolean | undefined;
  /** Start with category sections expanded. Default: true. */
  expandCategories?: boolean | undefined;
  /** Start with "Additional information" trees expanded. Default: false. */
  expandAdditionalInfo?: boolean | undefined;
  /** Colour theme. Default: "auto" (follows prefers-color-scheme). */
  theme?: "light" | "dark" | "auto" | undefined;
}

/** Options for the interactive {@link renderDataDictionary} mount. */
export interface RenderOptions extends RenderHtmlOptions {
  /** Render inside a Shadow DOM for full style isolation. Default: true. */
  shadow?: boolean | undefined;
  /** Replace the container's existing contents. Default: true. */
  replace?: boolean | undefined;
}
