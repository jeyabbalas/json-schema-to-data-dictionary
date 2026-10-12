// Analyze a single property schema into the structured pieces of one data-dictionary row:
// data type, format, valid values, constraints, additional information and description --
// plus the property's *shape*: the object fields, array items and tuple slots it declares,
// which extract.ts turns into rows of their own.
//
// The interesting work is mixed types: an `anyOf`/`oneOf` that combines a measurement
// (a numeric/typed range) with categorical sentinel codes (structural missingness / skip
// codes). We classify each branch and present the measurement range in "Constraints" while
// the codes go to "Valid values", tagged so the renderer can show them as special codes.
//
// Whether a code is a sentinel or a substantive answer is a guess from its wording, so
// `x-value-kind: "sentinel" | "value"` lets a schema say which it is and skip the guess.
//
// A variable need not be a scalar. An array's `items` schema is analysed with the very same
// machinery, and what it says is hoisted into the row: the item codes are the variable's
// Valid values, item ranges become "Each item: …" constraints, the item format is the Format.
// An object or array item is additionally kept in the shape, so the extractor can list its
// fields as nested rows (`visits[].date`).

import type {
  ConstraintItem,
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
  SourceInfo,
  ValidValue,
  ValidValueKind
} from "./types";
import { describeEncodedContent, describeFormat, describePattern, formatLabel } from "./formats";
import type { ResolutionBase, SchemaRegistry } from "./registry";
import { sourceAt } from "./paths";
import {
  asStringArray,
  cloneJson,
  compactObject,
  formatJsonValue,
  formatNumber,
  hasOwn,
  isJsonSchema,
  isRecord,
  isSchemaObject,
  jsonTypeOf,
  normalizeTypeArray,
  stableStringify,
  typeAlternatives,
  valueKey
} from "./utils";

export interface AnalyzeContext {
  registry: SchemaRegistry;
  base: ResolutionBase;
  source?: SourceInfo | undefined;
  maxDepth: number;
}

/** A schema together with what is needed to resolve its `$ref`s and to say where it lives. */
export interface SchemaRef {
  schema: JsonSchema;
  base: ResolutionBase;
  /** Location of `schema` itself: a JSON pointer into its document. */
  source?: SourceInfo | undefined;
  /** Set when `schema` is one branch of a `oneOf`/`anyOf`: the keyword and the 0-based branch. */
  union?: "oneOf" | "anyOf" | undefined;
  variant?: number | undefined;
}

export type PropertyShapeKind = "scalar" | "object" | "array" | "tuple" | "mixed";

/**
 * The container structure a property declares, after `$ref`/`allOf`/union resolution. The
 * extractor walks it to emit nested rows; nothing here is rendered directly.
 */
export interface PropertyShape {
  kind: PropertyShapeKind;
  /** The (post-`$ref`) schema objects that carried container keywords; the recursion guard compares these. */
  identities: ReadonlySet<JsonSchemaObject>;
  /** The schema the analysis started from; `required` and nested skip patterns are read from it. */
  self: SchemaRef;
  /** Union branches that declared object fields (their rules are conditional on the branch). */
  variants: SchemaRef[];
  /**
   * How many branches of the property's `oneOf`/`anyOf` can be an object, fields or not. When
   * one can, its fields are named by that ("when contact is an object").
   */
  unionObjects: ReadonlyMap<"oneOf" | "anyOf", number>;
  /** Field name -> every schema declaring it, in declaration order. */
  properties: Map<string, SchemaRef[]>;
  patternProperties: Map<string, SchemaRef[]>;
  /** A schema for the properties not named above, or `false` when the object is closed. */
  additionalProperties?: SchemaRef | false | undefined;
  unevaluatedProperties?: SchemaRef | false | undefined;
  /** Tuple positions (`prefixItems`, or the draft-07 `items` array). */
  prefixItems: SchemaRef[][];
  /** The schema of the (remaining) array items, analysed like a property of its own. */
  items?: { ref: SchemaRef; analysis: PropertyAnalysis } | undefined;
  /** `items: false`: nothing beyond the tuple positions. */
  itemsClosed: boolean;
}

export interface PropertyAnalysis {
  dataType: string;
  /** The JSON types the value may take ("integer", "string", "null" …), from `type` and the values listed; empty when the schema does not say. */
  types: string[];
  format: string;
  validValues: ValidValue[];
  constraints: ConstraintItem[];
  additionalInformation: Record<string, JsonValue> | null;
  /** `title` + `description` + `$comment` text, the comments last. */
  description: string;
  /** The `$comment` text alone (the last lines of `description`), or "". */
  comment: string;
  shape: PropertyShape;
}

interface NumericBounds {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

interface ShapeDraft {
  identities: Set<JsonSchemaObject>;
  variants: SchemaRef[];
  unionObjects: Map<"oneOf" | "anyOf", number>;
  properties: Map<string, SchemaRef[]>;
  patternProperties: Map<string, SchemaRef[]>;
  additionalProperties?: SchemaRef | false | undefined;
  unevaluatedProperties?: SchemaRef | false | undefined;
  prefixItems: SchemaRef[][];
  itemsClosed: boolean;
}

interface Accumulator {
  self: SchemaRef;
  jsonTypes: Set<string>;
  nullable: boolean;
  formats: Set<string>;
  encoding: { encoding?: string; mediaType?: string } | null;
  patterns: Set<string>;
  values: ValidValue[];
  numeric: NumericBounds;
  /** The ranges of a union's measured branches, when there are several: "0–10 or 100–200". */
  ranges: NumericBounds[];
  /** Values a `not` of `const`/`enum` rules out ("not": { "enum": [-666, -777] }). */
  excluded: JsonValue[];
  /** Values the measured branch of a mixed union rules out that its range would otherwise allow. */
  measurementExcluded: JsonValue[];
  minLength?: number;
  maxLength?: number;
  array: { minItems?: number; maxItems?: number; uniqueItems?: boolean; minContains?: number; maxContains?: number; contains?: BranchAnalysis };
  object: { minProperties?: number; maxProperties?: number; propertyNames?: BranchAnalysis };
  extraConstraints: ConstraintItem[];
  additional: Record<string, unknown>;
  /** `title` / `description` text, in the order met. */
  descriptions: string[];
  /** `$comment` text, kept apart so it reads as the author's note rather than the definition. */
  comments: string[];
  hasArray: boolean;
  hasObjectShape: boolean;
  /** The array's item schema, analysed with its own accumulator (hoisted at materialisation). */
  items?: { ref: SchemaRef; acc: Accumulator } | undefined;
  shape: ShapeDraft;
  mixed: boolean;
  measurementBaseTypes: Set<string>;
  /** `x-value-kind`, when the schema declares it explicitly. */
  valueKind?: ValidValueKind | undefined;
}

interface InternalContext extends AnalyzeContext {
  depth: number;
  refStack: Set<string>;
  /** Location of the schema object being visited (values keep `source`; shapes use this). */
  at: SourceInfo | undefined;
}

// Matched against a value's label and the name of the `$ref` it came from -- both terse --
// but never against its prose description, which can discuss missingness while describing a
// value that is not itself missing. `x-value-kind` overrides this guess entirely.
//
// Matched against `normalizeForMatch`ed text, so `dont_know`, `Dont-Know` and "don't know"
// are one case and every alternative can be written with plain spaces.
//
// Every alternative has to survive being a *fragment* of a longer label, because coding lists
// put sentinel words inside substantive categories: "Surgery (type not known)" and "Not known:
// on HRT" are reasons periods stopped, in a list that carries its real sentinel separately. So
// `not known` and `does not know` are deliberately absent -- they matched six such categories
// in one variable while gaining nothing a narrower spelling did not already catch. The trailing
// \b anchors matter for the same reason: "Ovarian suppression" is a therapy, "Not in formal
// education" is an answer, and sodium is spelled Na. "Decline" is a noun as often as a verb
// ("Income decline" is a kind of financial shock, "Cognitive decline" a diagnosis), so only
// "declined" and "decline to …" count. Add a word here only with a case that needs it;
// `x-value-kind` is the answer for wording this cannot safely infer.
const SENTINEL_WORDS =
  /(missing|unknown|not applicable|not assessed|not collected|not (?:on|in) (?:the )?(?:questionnaire|survey|form)\b|no answer|no response|refus|\bdeclined\b|\bdecline to\b|do(?:n'?t| not) know\b|prefer not|\bsuppressed\b|inapplicable|\bn\/a\b|skipped?)/;

/**
 * Fold the spellings a label or an identifier can take into one: case, curly apostrophes and
 * `_`/`-` separators. Without it the vocabulary has to carry a separator convention per
 * alternative, and `$defs/not_applicable` reads differently from "Not applicable".
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The def's name from a `$ref` -- the last pointer segment, never the path. Matching the whole
 * URI means a file called `common/missing_codes.json` turns every value reached through it
 * into a special code.
 */
function refDefName(ref: string): string {
  const hash = ref.indexOf("#");
  const segments = (hash === -1 ? "" : ref.slice(hash + 1)).split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === undefined) return "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
const CONVENTIONAL_SENTINEL_CODES = new Set<number>([666, 777, 888, 999, 6666, 7777, 8888, 9999]);

const ANNOTATION_KEYS = new Set(["title", "description", "$comment"]);
const HANDLED_KEYS = new Set([
  "$ref",
  "$dynamicRef",
  "$id",
  "$schema",
  "$anchor",
  "$dynamicAnchor",
  "$defs",
  "definitions",
  "type",
  "format",
  "contentEncoding",
  "contentMediaType",
  "enum",
  "const",
  "enumDescriptions",
  "x-enumDescriptions",
  "x-value-kind",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "required",
  "dependentRequired",
  "dependentSchemas",
  "multipleOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  ...ANNOTATION_KEYS
]);

/**
 * Constraints of an item that describe its own fields, kept verbatim when hoisted: "Fields:
 * date, weight" reads right on an array of objects. Item counts are not among them -- "Exactly
 * 2 item(s)" of a `[systolic, diastolic]` pair says nothing about the readings array itself.
 */
const ITEM_PASSTHROUGH_KEYWORDS = new Set(["properties", "additionalProperties", "unevaluatedProperties", "propertyNames"]);

/** Prefix of a hoisted item constraint. */
const ITEM_PREFIX = "Each item: ";
/** Prefix of a constraint an array item had itself hoisted from *its* items (an array of arrays). */
const INNER_ITEM_PREFIX = "Each inner item: ";

/** Names listed in a "Fields: …" constraint before the rest is summarised as a count. */
const MAX_LISTED_FIELDS = 20;

export function analyzeProperty(schema: JsonSchema, context: AnalyzeContext): PropertyAnalysis {
  const self: SchemaRef = { schema, base: context.base, ...(context.source ? { source: context.source } : {}) };
  const acc = newAccumulator(self);
  collect(schema, { ...context, depth: 0, refStack: new Set(), at: context.source }, acc);
  const { text: _text, ...analysis } = materialize(acc, "row");
  return analysis;
}

function newAccumulator(self: SchemaRef): Accumulator {
  return {
    self,
    jsonTypes: new Set(),
    nullable: false,
    formats: new Set(),
    encoding: null,
    patterns: new Set(),
    values: [],
    numeric: {},
    ranges: [],
    excluded: [],
    measurementExcluded: [],
    array: {},
    object: {},
    extraConstraints: [],
    additional: {},
    descriptions: [],
    comments: [],
    hasArray: false,
    hasObjectShape: false,
    shape: {
      identities: new Set(),
      variants: [],
      unionObjects: new Map(),
      properties: new Map(),
      patternProperties: new Map(),
      prefixItems: [],
      itemsClosed: false
    },
    mixed: false,
    measurementBaseTypes: new Set()
  };
}

function collect(schema: JsonSchema, ctx: InternalContext, acc: Accumulator): void {
  if (schema === true || ctx.depth > ctx.maxDepth) return;
  if (schema === false) {
    acc.extraConstraints.push({ keyword: "false", text: "No value is valid (schema is false)." });
    return;
  }

  // 2020-12 allows annotations/keywords alongside $ref; follow the ref then apply siblings.
  const beforeRef = acc.values.length;
  const refStart = acc.descriptions.length;
  let refTitle: string | undefined;
  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, ctx.base);
    if (loc) {
      const key = `${loc.retrievalUri}#${loc.pointer}`;
      if (!ctx.refStack.has(key)) {
        const nextStack = new Set(ctx.refStack).add(key);
        const source = ctx.registry.sourceFor(loc, ref);
        collect(loc.schema, {
          ...ctx,
          base: ctx.registry.baseOf(loc),
          source,
          at: source,
          depth: ctx.depth + 1,
          refStack: nextStack
        }, acc);
        if (isSchemaObject(loc.schema) && typeof loc.schema.title === "string") refTitle = loc.schema.title.trim();
      } else {
        acc.extraConstraints.push({ keyword: "$ref", text: `Recursive reference omitted: ${ref}.` });
        noteRecursiveTarget(loc.schema, acc);
      }
    }
  }

  // A block that exists only to state a rule (`{ "$comment": …, "if": …, "then": … }` inside
  // an object's allOf) annotates the rule, which the extractor collects and the skip-pattern
  // panel shows; its prose is not a description of the variable.
  if (!isConditionalOnly(schema)) {
    // The text a `$ref` brought in describes the shared definition ("Survey analysis weight");
    // the schema's own title and description name this use of it ("Cross-sectional household
    // weight"), so they come first, and an own title replaces the definition's.
    const fromRef = acc.descriptions.splice(refStart);
    collectAnnotations(schema, acc);
    const ownTitle = typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : undefined;
    acc.descriptions.push(...(ownTitle && refTitle ? fromRef.filter((text) => text !== refTitle) : fromRef));
  }
  collectValueKind(schema, acc, beforeRef);
  collectTypes(schema, acc);
  collectFormatAndContent(schema, acc);
  collectEnumConst(schema, ctx, acc);
  collectScalarConstraints(schema, acc);
  collectComposition(schema, ctx, acc);
  collectContainers(schema, ctx, acc);
  collectAdditional(schema, acc);
}

const CONDITIONAL_BLOCK_KEYS = new Set(["if", "then", "else", ...ANNOTATION_KEYS]);

function isConditionalOnly(schema: JsonSchemaObject): boolean {
  if (schema.if === undefined || (schema.then === undefined && schema.else === undefined)) return false;
  return Object.keys(schema).every((key) => CONDITIONAL_BLOCK_KEYS.has(key));
}

/**
 * A `$ref` back into a schema already being analysed is not followed; its declared type still
 * says what the value is ("array of object" rather than "array of any").
 */
function noteRecursiveTarget(target: JsonSchema, acc: Accumulator): void {
  if (!isSchemaObject(target)) return;
  for (const type of normalizeTypeArray(target.type)) {
    if (type === "null") acc.nullable = true;
    else acc.jsonTypes.add(type);
  }
  if (acc.jsonTypes.has("array") || target.items !== undefined || Array.isArray(target.prefixItems)) acc.hasArray = true;
  if (acc.jsonTypes.has("object") || isRecord(target.properties)) acc.hasObjectShape = true;
}

function collectAnnotations(schema: JsonSchemaObject, acc: Accumulator): void {
  if (typeof schema.title === "string" && schema.title.trim()) acc.descriptions.push(schema.title.trim());
  if (typeof schema.description === "string" && schema.description.trim()) acc.descriptions.push(schema.description.trim());
  if (typeof schema.$comment === "string" && schema.$comment.trim()) acc.comments.push(schema.$comment.trim());
}

/**
 * `x-value-kind` declares whether the schema's `const`/`enum` members are substantive answers
 * or missing/NA codes. It is read both from the subschema that carries the value (typically a
 * shared `$defs` entry) and from a `$ref` sibling. The sibling is the more local of the two,
 * so it re-stamps whatever the referenced schema contributed: `firstOwnValue` is where this
 * schema's `$ref` started pushing.
 */
function collectValueKind(schema: JsonSchemaObject, acc: Accumulator, firstOwnValue: number): void {
  const declared = schema["x-value-kind"];
  if (declared !== "value" && declared !== "sentinel") return;
  acc.valueKind = declared;
  for (let i = firstOwnValue; i < acc.values.length; i += 1) {
    const v = acc.values[i] as DraftValue;
    v.kind = declared;
    v.declaredKind = declared;
  }
}

function collectTypes(schema: JsonSchemaObject, acc: Accumulator): void {
  for (const type of normalizeTypeArray(schema.type)) {
    if (type === "null") acc.nullable = true;
    else acc.jsonTypes.add(type);
  }
}

function collectFormatAndContent(schema: JsonSchemaObject, acc: Accumulator): void {
  if (typeof schema.format === "string" && schema.format.trim()) {
    acc.formats.add(schema.format.trim());
    acc.jsonTypes.add("string");
  }
  if (typeof schema.contentEncoding === "string" || typeof schema.contentMediaType === "string") {
    acc.encoding = {
      ...(typeof schema.contentEncoding === "string" ? { encoding: schema.contentEncoding } : {}),
      ...(typeof schema.contentMediaType === "string" ? { mediaType: schema.contentMediaType } : {})
    };
    acc.jsonTypes.add("string");
  }
  if (typeof schema.pattern === "string") {
    acc.patterns.add(schema.pattern);
    acc.jsonTypes.add("string");
  }
}

function collectEnumConst(schema: JsonSchemaObject, ctx: InternalContext, acc: Accumulator): void {
  if (Array.isArray(schema.enum)) {
    const descriptions = schema.enumDescriptions ?? schema["x-enumDescriptions"];
    for (const [index, value] of schema.enum.entries()) {
      if (value === null) {
        acc.nullable = true;
        continue;
      }
      acc.values.push(declare(makeValue(value, enumDescriptionFor(value, index, descriptions), undefined, ctx.source), acc));
      acc.jsonTypes.add(jsonTypeOf(value));
    }
  }
  if (hasOwn(schema, "const")) {
    const value = schema.const as JsonValue;
    if (value === null) acc.nullable = true;
    else {
      // For a bare const the local title/description annotate the value itself.
      const label = typeof schema.title === "string" ? schema.title : undefined;
      const desc = typeof schema.description === "string" ? schema.description : undefined;
      acc.values.push(declare(makeValue(value, desc, label, ctx.source), acc));
      acc.jsonTypes.add(jsonTypeOf(value));
    }
  }
}

/** Stamp the kind in effect where the value was declared, if the schema declared one. */
function declare(v: ValidValue, acc: Accumulator): DraftValue {
  return acc.valueKind ? { ...v, kind: acc.valueKind, declaredKind: acc.valueKind } : v;
}

function collectScalarConstraints(schema: JsonSchemaObject, acc: Accumulator): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    if (typeof schema[key] === "number") acc.numeric[key] = schema[key] as number;
  }
  if (typeof schema.minLength === "number") acc.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") acc.maxLength = schema.maxLength;
}

function collectComposition(schema: JsonSchemaObject, ctx: InternalContext, acc: Accumulator): void {
  // allOf: a conjunction — merge every branch into this accumulator. A branch's own
  // `x-value-kind` stamps the values that branch contributes, but must not become the
  // property's default: allOf is unordered, so letting the last branch win would make the
  // answer depend on how the array happens to be written.
  if (Array.isArray(schema.allOf)) {
    const outer = acc.valueKind;
    schema.allOf.forEach((branch, i) => {
      collect(branch, { ...ctx, depth: ctx.depth + 1, at: sourceAt(ctx.at, ctx.base, ["allOf", String(i)]) }, acc);
      acc.valueKind = outer;
    });
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) handleUnion(schema.oneOf, "oneOf", ctx, acc);
  else if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) handleUnion(schema.anyOf, "anyOf", ctx, acc);

  if (schema.not !== undefined && isSchemaObject(schema.not)) {
    const inner = analyzeBranch(schema.not, { ...ctx, at: sourceAt(ctx.at, ctx.base, ["not"]) });
    const brief = briefOf(inner);
    if (brief) acc.extraConstraints.push({ keyword: "not", text: `Must not be: ${brief}.` });
    if (inner.values.length > 0) acc.excluded.push(...inner.values.map((v) => v.value));
  }

  if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
    // Property-level conditionals are summarised here; the rules themselves are collected by
    // extract.ts (row-object skip patterns, and those inside an object-shaped variable).
    acc.extraConstraints.push({ keyword: "if/then", text: "Has a conditional (if/then) sub-rule." });
  }
}

function handleUnion(branches: JsonSchema[], keyword: "oneOf" | "anyOf", ctx: InternalContext, acc: Accumulator): void {
  const analyzed = branches.map((branch, index) => ({
    branch,
    index,
    analysis: analyzeBranch(branch, { ...ctx, at: sourceAt(ctx.at, ctx.base, [keyword, String(index)]) })
  }));
  acc.shape.unionObjects.set(keyword, analyzed.filter((b) => b.analysis.acc.hasObjectShape).length);

  // Every categorical value -- in a mixed union or a pure one -- resolves its kind here, so the
  // same code with the same label cannot come out `sentinel` in one field and `value` in another
  // just because the field happens to also carry a numeric range. An `x-value-kind` on the branch
  // wins; one on the property as a whole is the default for branches that declare none.
  const classify = (v: DraftValue, refName: string | undefined, declared: ValidValueKind | undefined): ValidValueKind => {
    // Declared at the value itself (possibly in a union nested inside this one) beats the
    // branch's declaration, which beats the property's, which beats the wording.
    const explicit = v.declaredKind ?? declared ?? acc.valueKind;
    if (explicit) return explicit;
    return isSentinelValue(v, refName) ? "sentinel" : "value";
  };
  // Once per branch, not once per value: a branch can carry a 200-member enum.
  const refNameOf = (branch: JsonSchema): string | undefined => (isSchemaObject(branch) ? refKeyword(branch) : undefined);

  const measurements = analyzed.filter((b) => b.analysis.isMeasurement);
  const categoricals = analyzed.filter((b) => !b.analysis.isMeasurement);

  const hasMeasurement = measurements.length > 0;
  const hasCategorical = categoricals.some((b) => b.analysis.values.length > 0);

  const mixed = hasMeasurement && hasCategorical;
  if (mixed) {
    // Mixed: measurement value + categorical sentinel codes.
    acc.mixed = true;
    for (const m of measurements) {
      for (const t of m.analysis.jsonTypes) acc.measurementBaseTypes.add(t);
      acc.nullable ||= m.analysis.acc.nullable;
      mergeNumeric(acc.numeric, m.analysis.numeric);
      if (hasNumericRange(m.analysis.numeric)) acc.ranges.push(m.analysis.numeric);
      if (m.analysis.minLength !== undefined) acc.minLength = m.analysis.minLength;
      if (m.analysis.maxLength !== undefined) acc.maxLength = m.analysis.maxLength;
      // What the measured value looks like (a date, an identifier's pattern) is the variable's
      // format, and the codes its `not` rules out are part of its definition: "-777 is never a
      // loss of 777".
      for (const f of m.analysis.formats) acc.formats.add(f);
      for (const pattern of m.analysis.patterns) acc.patterns.add(pattern);
      acc.encoding ??= m.analysis.acc.encoding;
      for (const v of m.analysis.acc.excluded) if (withinBounds(v, m.analysis.numeric)) acc.measurementExcluded.push(v);
      acc.values.push({
        value: null,
        kind: "measurement",
        label: measurementLabel(m.analysis),
        ...(m.analysis.description ? { description: m.analysis.description } : {}),
        ...(m.analysis.comment ? { comment: m.analysis.comment } : {}),
        ...(ctx.source ? { source: ctx.source } : {})
      });
    }
    for (const c of categoricals) {
      const refName = refNameOf(c.branch);
      for (const v of c.analysis.values) acc.values.push(withComment({ ...v, kind: classify(v, refName, c.analysis.valueKind) }, c.analysis.comment));
    }
  } else if (hasCategorical) {
    // Pure categorical: tag each value as substantive or sentinel.
    for (const c of categoricals) {
      const refName = refNameOf(c.branch);
      for (const v of c.analysis.values) {
        acc.values.push(withComment({ ...v, kind: classify(v, refName, c.analysis.valueKind) }, c.analysis.comment));
        acc.jsonTypes.add(jsonTypeOf(v.value));
      }
    }
  } else {
    // Union of measurements (several ranges, a date or a year …): every branch's facets are the
    // property's (absorbed below, in declaration order), and each range is kept so that disjoint
    // ones are all stated.
    for (const m of measurements) if (hasNumericRange(m.analysis.numeric)) acc.ranges.push(m.analysis.numeric);
  }

  // A branch that carries no codes -- a plain `{ "type": "string" }`, a format, `{ "type":
  // "null" }`, an object or an array, or (outside a mixed union) a range -- still says what the
  // value can be. Without this a union of such branches read "any", and `anyOf: [T, null]` lost
  // its null. The measured branches of a mixed union were taken apart above.
  for (const b of analyzed) {
    if (b.analysis.values.length > 0 || (mixed && b.analysis.isMeasurement)) continue;
    absorbBranch(acc, b.analysis.acc, {
      schema: b.branch,
      base: ctx.base,
      source: sourceAt(ctx.at, ctx.base, [keyword, String(b.index)]),
      union: keyword,
      variant: b.index
    });
  }
}

/**
 * Merge the typed and structural facets of a union branch into the property (a disjunction:
 * types and shapes accumulate, bounds keep the first seen). Values and annotations are not
 * merged -- a titled `const` names its value, not the property.
 */
function absorbBranch(acc: Accumulator, sub: Accumulator, branch: SchemaRef): void {
  for (const t of sub.jsonTypes) acc.jsonTypes.add(t);
  acc.nullable ||= sub.nullable;
  for (const f of sub.formats) acc.formats.add(f);
  for (const p of sub.patterns) acc.patterns.add(p);
  acc.encoding ??= sub.encoding;
  mergeNumeric(acc.numeric, sub.numeric);
  if (acc.minLength === undefined && sub.minLength !== undefined) acc.minLength = sub.minLength;
  if (acc.maxLength === undefined && sub.maxLength !== undefined) acc.maxLength = sub.maxLength;
  fillMissing(acc.array, sub.array);
  fillMissing(acc.object, sub.object);
  acc.hasArray ||= sub.hasArray;
  acc.hasObjectShape ||= sub.hasObjectShape;
  acc.extraConstraints.push(...sub.extraConstraints);

  const tag = branch.union !== undefined ? { union: branch.union, variant: branch.variant } : undefined;
  mergeShape(acc.shape, sub.shape, tag);
  if (sub.items) {
    if (!acc.items) acc.items = sub.items;
    else absorbBranch(acc.items.acc, sub.items.acc, sub.items.ref);
  }
  if (tag && hasObjectContent(sub.shape)) acc.shape.variants.push(branch);
}

/** Copy every bound `source` has that `target` lacks (the first branch to state one wins). */
function fillMissing<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(source) as Array<keyof T>) {
    if (target[key] === undefined && source[key] !== undefined) target[key] = source[key];
  }
}

function hasObjectContent(shape: ShapeDraft): boolean {
  return (
    shape.properties.size > 0 ||
    shape.patternProperties.size > 0 ||
    (shape.additionalProperties !== undefined && shape.additionalProperties !== false) ||
    (shape.unevaluatedProperties !== undefined && shape.unevaluatedProperties !== false)
  );
}

function mergeShape(into: ShapeDraft, from: ShapeDraft, tag: { union: "oneOf" | "anyOf"; variant: number | undefined } | undefined): void {
  const tagged = (ref: SchemaRef): SchemaRef => (tag ? { ...ref, union: tag.union, ...(tag.variant !== undefined ? { variant: tag.variant } : {}) } : ref);
  for (const id of from.identities) into.identities.add(id);
  for (const [name, refs] of from.properties) {
    const list = into.properties.get(name) ?? [];
    list.push(...refs.map(tagged));
    into.properties.set(name, list);
  }
  for (const [pattern, refs] of from.patternProperties) {
    const list = into.patternProperties.get(pattern) ?? [];
    list.push(...refs.map(tagged));
    into.patternProperties.set(pattern, list);
  }
  for (const key of ["additionalProperties", "unevaluatedProperties"] as const) {
    const value = from[key];
    if (value === undefined) continue;
    if (value === false) into[key] = false;
    else if (into[key] === undefined) into[key] = tagged(value);
  }
  from.prefixItems.forEach((refs, i) => {
    const list = into.prefixItems[i] ?? [];
    list.push(...refs.map(tagged));
    into.prefixItems[i] = list;
  });
  into.itemsClosed ||= from.itemsClosed;
  into.variants.push(...from.variants);
}

interface BranchAnalysis {
  jsonTypes: Set<string>;
  values: ValidValue[];
  numeric: NumericBounds;
  minLength?: number;
  maxLength?: number;
  formats: string[];
  patterns: string[];
  description: string;
  comment: string;
  isMeasurement: boolean;
  valueKind?: ValidValueKind;
  /** The branch's whole accumulator, for merging its typed/structural facets. */
  acc: Accumulator;
}

function analyzeBranch(branch: JsonSchema, ctx: InternalContext): BranchAnalysis {
  const sub = newAccumulator({ schema: branch, base: ctx.base, ...(ctx.at ? { source: ctx.at } : {}) });
  collect(branch, { ...ctx, depth: ctx.depth + 1 }, sub);
  const hasRange =
    sub.numeric.minimum !== undefined ||
    sub.numeric.maximum !== undefined ||
    sub.numeric.exclusiveMinimum !== undefined ||
    sub.numeric.exclusiveMaximum !== undefined ||
    sub.minLength !== undefined ||
    sub.maxLength !== undefined;
  // A branch is a "measurement" when it describes a number or a string -- a range, a format, a
  // pattern, or just its type -- without pinning it to specific categorical values (no
  // enum/const). Next to codes it is the substantive value: an identifier with string codes for
  // "not applicable" is "string + coded values", not a list of four codes.
  const typedValue = sub.jsonTypes.has("number") || sub.jsonTypes.has("integer") || sub.jsonTypes.has("string") || sub.formats.size > 0 || sub.patterns.size > 0;
  const isMeasurement = sub.values.length === 0 && !sub.hasArray && !sub.hasObjectShape && (hasRange || typedValue);
  return {
    jsonTypes: sub.jsonTypes,
    values: sub.values,
    numeric: sub.numeric,
    ...(sub.minLength !== undefined ? { minLength: sub.minLength } : {}),
    ...(sub.maxLength !== undefined ? { maxLength: sub.maxLength } : {}),
    formats: [...sub.formats],
    patterns: [...sub.patterns],
    description: joinDescriptions(sub.descriptions),
    comment: joinDescriptions(sub.comments),
    isMeasurement,
    ...(sub.valueKind ? { valueKind: sub.valueKind } : {}),
    acc: sub
  };
}

/**
 * Array and object keywords: bounds as constraints, and the *shape* -- tuple positions, the
 * item schema (analysed right here, with its own accumulator), the named fields, the pattern
 * and open-content schemas -- for the extractor. Both the 2020-12 spellings (`prefixItems` +
 * `items`) and the draft-07 ones (`items` as an array + `additionalItems`) are read.
 */
function collectContainers(schema: JsonSchemaObject, ctx: InternalContext, acc: Accumulator): void {
  const draft7Tuple = Array.isArray(schema.items) ? (schema.items as unknown as JsonSchema[]) : undefined;
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : draft7Tuple;
  const restKeyword = draft7Tuple ? "additionalItems" : schema.items !== undefined ? "items" : "unevaluatedItems";
  const rest = restKeyword === "additionalItems" ? schema.additionalItems : restKeyword === "items" ? schema.items : schema.unevaluatedItems;

  const isArray =
    acc.jsonTypes.has("array") ||
    schema.items !== undefined ||
    prefix !== undefined ||
    schema.additionalItems !== undefined ||
    schema.unevaluatedItems !== undefined ||
    schema.contains !== undefined;
  if (isArray) {
    acc.hasArray = true;
    let structural = false;
    if (prefix) {
      const keyword = draft7Tuple ? "items" : "prefixItems";
      prefix.forEach((slot, i) => {
        const list = acc.shape.prefixItems[i] ?? [];
        if (isJsonSchema(slot)) list.push({ schema: slot, base: ctx.base, source: sourceAt(ctx.at, ctx.base, [keyword, String(i)]) });
        acc.shape.prefixItems[i] = list;
      });
      structural = true;
    }
    if (rest === false) {
      acc.shape.itemsClosed = true;
      structural = true;
    } else if (rest === true || isSchemaObject(rest)) {
      const ref: SchemaRef = { schema: rest, base: ctx.base, source: sourceAt(ctx.at, ctx.base, [restKeyword]) };
      if (!acc.items) {
        const sub = newAccumulator(ref);
        // A property-level `x-value-kind` is the default for its items, as it is for its branches.
        sub.valueKind = acc.valueKind;
        acc.items = { ref, acc: sub };
      }
      collect(rest, { ...ctx, depth: ctx.depth + 1, at: ref.source }, acc.items.acc);
      structural = true;
    }
    for (const key of ["minItems", "maxItems", "minContains", "maxContains"] as const) {
      if (typeof schema[key] === "number") acc.array[key] = schema[key] as number;
    }
    if (typeof schema.uniqueItems === "boolean") acc.array.uniqueItems = schema.uniqueItems;
    if (isSchemaObject(schema.contains)) {
      acc.array.contains = analyzeBranch(schema.contains, { ...ctx, at: sourceAt(ctx.at, ctx.base, ["contains"]) });
    }
    if (structural) acc.shape.identities.add(schema);
  }

  const isObject =
    acc.jsonTypes.has("object") ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    isSchemaObject(schema.additionalProperties) ||
    isSchemaObject(schema.unevaluatedProperties) ||
    isSchemaObject(schema.propertyNames);
  if (isObject) {
    acc.hasObjectShape = true;
    for (const key of ["minProperties", "maxProperties"] as const) {
      if (typeof schema[key] === "number") acc.object[key] = schema[key] as number;
    }
    let structural = false;
    if (isRecord(schema.properties)) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (!isJsonSchema(sub)) continue;
        const list = acc.shape.properties.get(name) ?? [];
        list.push({ schema: sub, base: ctx.base, source: sourceAt(ctx.at, ctx.base, ["properties", name]) });
        acc.shape.properties.set(name, list);
        structural = true;
      }
    }
    if (isRecord(schema.patternProperties)) {
      for (const [pattern, sub] of Object.entries(schema.patternProperties)) {
        if (!isJsonSchema(sub)) continue;
        const list = acc.shape.patternProperties.get(pattern) ?? [];
        list.push({ schema: sub, base: ctx.base, source: sourceAt(ctx.at, ctx.base, ["patternProperties", pattern]) });
        acc.shape.patternProperties.set(pattern, list);
        structural = true;
      }
    }
    for (const key of ["additionalProperties", "unevaluatedProperties"] as const) {
      const sub = schema[key];
      if (sub === false) {
        acc.shape[key] = false;
        structural = true;
      } else if (isSchemaObject(sub) || sub === true) {
        if (acc.shape[key] === undefined) acc.shape[key] = { schema: sub, base: ctx.base, source: sourceAt(ctx.at, ctx.base, [key]) };
        structural = true;
      }
    }
    if (isSchemaObject(schema.propertyNames)) {
      acc.object.propertyNames = analyzeBranch(schema.propertyNames, { ...ctx, at: sourceAt(ctx.at, ctx.base, ["propertyNames"]) });
    }
    if (structural) acc.shape.identities.add(schema);
  }
}

function collectAdditional(schema: JsonSchemaObject, acc: Accumulator): void {
  for (const key of Object.keys(schema)) {
    if (HANDLED_KEYS.has(key)) continue;
    // Everything not mapped to a dedicated column (default/examples/deprecated/readOnly/
    // writeOnly/contentSchema, x-* vendor keywords, etc.) flows into Additional information.
    acc.additional[key] = cloneJson(schema[key]);
  }
}

// ---------------------------------------------------------------------------
// Materialisation: turn the accumulator into the row's column strings/objects.
// ---------------------------------------------------------------------------

/**
 * `mode` says how nullability reads: a nullable property is "integer (nullable)", a nullable
 * item is "array of nullable integer" -- the suffix belongs to the array as a whole.
 */
function materialize(acc: Accumulator, mode: "row" | "item"): Materialized {
  // Values from a bare `const`/`enum` never passed through a union, so nothing has classified
  // them yet. Run the same rule here: a code should not mean one thing written as `enum` and
  // another written as a `oneOf` of titled consts.
  for (const v of acc.values as DraftValue[]) {
    if (v.kind === undefined) v.kind = acc.valueKind ?? (isSentinelValue(v) ? "sentinel" : "value");
    delete v.declaredKind;
  }
  // The item schema is a property in its own right; whatever it says about a single element
  // is hoisted into this row (Valid values, "Each item: …" constraints, the Format).
  const item = acc.items ? materialize(acc.items.acc, "item") : undefined;
  const additional = { ...acc.additional, ...(item?.additionalInformation ? { items: item.additionalInformation } : {}) };
  const text = joinDescriptions(item ? [...acc.descriptions, item.text] : acc.descriptions);
  const comment = joinDescriptions(item ? [...acc.comments, item.comment] : acc.comments);
  return {
    dataType: dataTypeText(acc, item?.dataType, mode),
    types: typesOf(acc),
    format: formatText(acc) || item?.format || "",
    validValues: dedupeValues(item ? [...acc.values, ...item.validValues] : acc.values),
    constraints: buildConstraints(acc, item),
    additionalInformation: plainAdditional(additional),
    description: joinDescriptions([text, comment]),
    comment,
    text,
    shape: finalizeShape(acc, item)
  };
}

/**
 * The JSON types the value may take: declared, of the measured value of a mixed union, and of
 * the values listed. Unknown (empty) when a measured value says nothing of its type.
 */
function typesOf(acc: Accumulator): string[] {
  const types = new Set([...acc.jsonTypes, ...acc.measurementBaseTypes]);
  if (types.size === 0 && acc.values.some((v) => v.kind === "measurement")) return [];
  for (const v of acc.values) if (v.kind !== "measurement") types.add(jsonTypeOf(v.value));
  if (acc.nullable) types.add("null");
  return [...types];
}

/** An analysis plus its description without the comments, which an array's row joins with its item's. */
type Materialized = PropertyAnalysis & { text: string };

function finalizeShape(acc: Accumulator, item: PropertyAnalysis | undefined): PropertyShape {
  const s = acc.shape;
  const kind: PropertyShapeKind =
    acc.hasArray && acc.hasObjectShape ? "mixed" : acc.hasArray ? (s.prefixItems.length > 0 ? "tuple" : "array") : acc.hasObjectShape ? "object" : "scalar";
  return {
    kind,
    identities: s.identities,
    self: acc.self,
    variants: s.variants,
    unionObjects: s.unionObjects,
    properties: s.properties,
    patternProperties: s.patternProperties,
    ...(s.additionalProperties !== undefined ? { additionalProperties: s.additionalProperties } : {}),
    ...(s.unevaluatedProperties !== undefined ? { unevaluatedProperties: s.unevaluatedProperties } : {}),
    prefixItems: s.prefixItems.map((refs) => refs ?? []),
    ...(acc.items && item ? { items: { ref: acc.items.ref, analysis: item } } : {}),
    itemsClosed: s.itemsClosed
  };
}

function dataTypeText(acc: Accumulator, itemLabel: string | undefined, mode: "row" | "item"): string {
  // A nullable element reads "nullable integer", or -- in a union -- lists null as one more
  // alternative, so that it cannot be mistaken for the array's own "(nullable)": an array of
  // arrays reads "array of nullable array of nullable integer".
  const nn = (s: string): string => {
    if (!acc.nullable) return s;
    if (mode === "row") return `${s} (nullable)`;
    return isUnionLabel(s) ? `${s} or null` : `nullable ${s}`;
  };

  if (acc.mixed) {
    const formats = [...acc.formats].map((f) => formatLabel(f)).join(" / ");
    const base = [...acc.measurementBaseTypes].filter(Boolean).map((t) => (t === "string" && formats ? formats : t));
    const baseLabel = base.length ? [...new Set(base)].join(" or ") : "value";
    return nn(`${baseLabel} + coded values`);
  }
  if (acc.encoding) {
    const enc = acc.encoding.encoding?.toLowerCase() === "base64" ? "base64" : acc.encoding.encoding;
    return nn(enc ? `binary (${enc})` : "binary");
  }

  // The scalar, object and array faces of the value are listed side by side ("string or
  // object"): a union of shapes is a real thing in a JSON dataset. The array comes last, so
  // that nothing after it reads as part of its element type, and an element type that is a
  // union is parenthesised: "integer or object or array of (string or null)".
  const parts: string[] = [];
  const scalar = scalarTypeText(acc);
  if (scalar) parts.push(scalar);
  if (acc.hasObjectShape) parts.push("object");
  if (acc.hasArray) parts.push(itemLabel ? `array of ${isUnionLabel(itemLabel) ? `(${itemLabel})` : itemLabel}` : "array");
  if (parts.length === 0) return acc.nullable ? "null" : "any";
  return nn([...new Set(parts)].join(" or "));
}

function isUnionLabel(label: string): boolean {
  return typeAlternatives(label).length > 1;
}

function scalarTypeText(acc: Accumulator): string {
  if (acc.formats.size > 0) return [...acc.formats].map((f) => formatLabel(f)).join(" / ");

  // "categorical" claims the field is a coded enumeration, so it needs at least one real
  // category: a sparse coding table that declares nothing but missing/NA codes is a plain
  // typed field that happens to have special codes, not a categorical one. Array- or
  // object-valued members (`enum: [[1, 2], [3]]`) are the container's business.
  const coded = acc.values.filter((v) => v.kind !== "measurement" && !isContainerValue(v.value));
  if (coded.length >= 2 && coded.some((v) => v.kind !== "sentinel")) {
    return `categorical (${baseTypeOfValues(coded, acc)})`;
  }
  const scalarTypes = [...acc.jsonTypes].filter((t) => t !== "object" && t !== "array" && t !== "null");
  const types = scalarTypes.length ? scalarTypes : coded.length ? [baseTypeOfValues(coded, acc)] : [];
  return [...new Set(types)].join(" or ");
}

function isContainerValue(value: JsonValue): boolean {
  return typeof value === "object" && value !== null;
}

function baseTypeOfValues(values: ValidValue[], acc: Accumulator): string {
  const fromTypes = [...acc.jsonTypes].filter((t) => t !== "null" && t !== "object" && t !== "array");
  if (fromTypes.length === 1) return fromTypes[0]!;
  const valueTypes = [...new Set(values.map((v) => jsonTypeOf(v.value)))];
  return valueTypes.length === 1 ? valueTypes[0]! : "value";
}

function formatText(acc: Accumulator): string {
  const parts: string[] = [];
  for (const f of acc.formats) parts.push(describeFormat(f));
  if (acc.encoding) parts.push(describeEncodedContent(acc.encoding.encoding, acc.encoding.mediaType));
  // Only surface a `pattern` as the format when there is no named format already.
  if (acc.formats.size === 0) {
    for (const p of acc.patterns) parts.push(describePattern(p));
  }
  return parts.filter(Boolean).join("; ");
}

function buildConstraints(acc: Accumulator, item: PropertyAnalysis | undefined): ConstraintItem[] {
  const out: ConstraintItem[] = [];

  // Disjoint ranges from a union's branches are all stated ("0 ≤ value ≤ 10 or 100 ≤ value ≤ 200").
  const ranges = distinctRanges(acc.ranges);
  const numericText = ranges.length > 1 ? ranges.map(numericRangeText).join(" or ") : numericRangeText(acc.numeric);
  if (numericText) {
    out.push({ keyword: "range", value: cloneJson(acc.numeric), text: acc.mixed ? `Measured value: ${numericText}` : numericText });
  }
  if (acc.measurementExcluded.length > 0) {
    const values = [...new Map(acc.measurementExcluded.map((v) => [valueKey(v), v])).values()];
    out.push({ keyword: "not", value: values, text: `Measured value is never ${listOr(values.map((v) => formatJsonValue(v)))}` });
  }
  if (typeof acc.numeric.multipleOf === "number") {
    out.push({ keyword: "multipleOf", value: acc.numeric.multipleOf, text: `Multiple of ${formatNumber(acc.numeric.multipleOf)}` });
  }

  const lengthText = lengthRangeText(acc.minLength, acc.maxLength);
  if (lengthText) out.push({ keyword: "length", text: lengthText });

  // Surface pattern as a constraint too when it is also acting as the format descriptor
  // is not the case (format present) — otherwise it is already in the Format column.
  if (acc.formats.size > 0) {
    for (const p of acc.patterns) out.push({ keyword: "pattern", value: p, text: `Matches pattern ${p}` });
  }

  if (acc.hasArray) {
    const a = acc.array;
    const positions = acc.shape.prefixItems.length;
    if (positions > 0 && acc.shape.itemsClosed) {
      // A closed tuple: the positions are the whole array. Only `minItems` makes them all
      // mandatory -- without it a shorter array (or an empty one) is valid.
      const max = Math.min(positions, a.maxItems ?? positions);
      const min = Math.min(a.minItems ?? 0, max);
      const text = min === max ? `Exactly ${max} item(s)` : min === 0 ? `Up to ${max} item(s)` : `${min}–${max} items`;
      out.push({ keyword: "prefixItems", value: positions, text });
    } else {
      if (positions > 0) out.push({ keyword: "prefixItems", value: positions, text: `First ${positions} item(s) are positional` });
      else if (acc.shape.itemsClosed) out.push({ keyword: "items", value: false, text: "Must be empty (no items allowed)" });
      if (typeof a.minItems === "number" || typeof a.maxItems === "number") {
        out.push({ keyword: "items", text: itemsRangeText(a.minItems, a.maxItems) });
      }
    }
    if (a.uniqueItems === true) out.push({ keyword: "uniqueItems", text: "Items must be unique" });
    if (a.contains) out.push({ keyword: "contains", text: `Must contain an item matching: ${briefOf(a.contains) || "the contains schema"}` });
    if (typeof a.minContains === "number") out.push({ keyword: "minContains", text: `At least ${a.minContains} matching item(s)` });
    if (typeof a.maxContains === "number") out.push({ keyword: "maxContains", text: `At most ${a.maxContains} matching item(s)` });
  }

  if (acc.hasObjectShape) {
    if (typeof acc.object.minProperties === "number") out.push({ keyword: "minProperties", text: `At least ${acc.object.minProperties} propert${acc.object.minProperties === 1 ? "y" : "ies"}` });
    if (typeof acc.object.maxProperties === "number") {
      const max = acc.object.maxProperties;
      out.push({ keyword: "maxProperties", text: max === 0 ? "Must be empty (no properties allowed)" : `At most ${max} propert${max === 1 ? "y" : "ies"}` });
    }
    const fields = [...acc.shape.properties.keys()];
    if (fields.length > 0) {
      const listed = fields.length > MAX_LISTED_FIELDS ? `${fields.slice(0, MAX_LISTED_FIELDS).join(", ")}, … (+${fields.length - MAX_LISTED_FIELDS} more)` : fields.join(", ");
      out.push({ keyword: "properties", value: fields, text: `Fields: ${listed}` });
    }
    if (acc.shape.additionalProperties === false) out.push({ keyword: "additionalProperties", value: false, text: "No other properties allowed" });
    else if (acc.shape.unevaluatedProperties === false) out.push({ keyword: "unevaluatedProperties", value: false, text: "No other properties allowed" });
    if (acc.object.propertyNames) out.push({ keyword: "propertyNames", text: propertyNamesText(acc.object.propertyNames) });
  }

  // What the item schema says about one element. Constraints that describe the item's own
  // fields ("Fields: date, weight" of an array of objects) read right as they are; the rest
  // apply per element. A rule an array item had itself hoisted from *its* items ("Each item:
  // value ≥ 0" of an array of arrays) is kept too, one level further in, so the row says it
  // even when no `name[]` row is emitted (`expandNested: false`).
  if (item) {
    for (const c of item.constraints) {
      if (ITEM_PASSTHROUGH_KEYWORDS.has(c.keyword) || c.text.startsWith(INNER_ITEM_PREFIX)) out.push(c);
      else if (c.text.startsWith(ITEM_PREFIX)) out.push({ ...c, text: `${INNER_ITEM_PREFIX}${c.text.slice(ITEM_PREFIX.length)}` });
      else out.push({ ...c, text: `${ITEM_PREFIX}${c.text}` });
    }
  }

  out.push(...acc.extraConstraints);
  return dedupeConstraints(out);
}

function distinctRanges(ranges: NumericBounds[]): NumericBounds[] {
  const seen = new Map<string, NumericBounds>();
  for (const r of ranges) seen.set(stableStringify(r), r);
  return [...seen.values()];
}

/** "a", "a or b", "a, b or c". */
function listOr(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function propertyNamesText(b: BranchAnalysis): string {
  if (b.patterns.length) return `Property names match pattern ${b.patterns.join(", ")}`;
  if (b.values.length) return `Property names are one of: ${b.values.map((v) => formatJsonValue(v.value)).join(", ")}`;
  const length = lengthRangeLabel(b.minLength, b.maxLength);
  return length ? `Property names are ${length}` : "Property names are constrained";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A value while it is being built. `declaredKind` records that the kind came from an
 * `x-value-kind` rather than from wording, so re-tagging passes leave it alone and grouping
 * branches into a nested union cannot silently reverse the author. Stripped in `materialize`.
 */
interface DraftValue extends ValidValue {
  declaredKind?: ValidValueKind;
}

/**
 * A union branch's `$comment` -- its own, or the one of the shared definition it `$ref`s -- is
 * about the values that branch contributes. A value that already has one (from a union nested
 * in the branch) keeps it: that comment is the more specific.
 */
function withComment(v: DraftValue, comment: string): DraftValue {
  return comment && !v.comment ? { ...v, comment } : v;
}

function makeValue(value: JsonValue, description: string | undefined, label: string | undefined, source: SourceInfo | undefined): ValidValue {
  return {
    value,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(source ? { source } : {})
  };
}

function enumDescriptionFor(value: JsonValue, index: number, descriptions: JsonSchemaObject["enumDescriptions"]): string | undefined {
  if (Array.isArray(descriptions)) return descriptions[index];
  if (isRecord(descriptions)) {
    const direct = descriptions[String(value)];
    if (typeof direct === "string") return direct;
    const stable = descriptions[stableStringify(value)];
    if (typeof stable === "string") return stable;
  }
  return undefined;
}

export function isSentinelValue(v: ValidValue, refName?: string): boolean {
  if (refName && SENTINEL_WORDS.test(normalizeForMatch(refDefName(refName)))) return true;
  // A label is a terse name for the value itself; a description is prose about it, and prose
  // that merely mentions missingness is not evidence the value *is* missing -- one of these
  // descriptions reads "a substantive response, not a missingness sentinel". So read the
  // description only when the label is not a name at all: codebooks that put the code in the
  // title ("-3") and the meaning in the description have nothing else to go on.
  const label = v.label?.trim() ?? "";
  // A parenthesis qualifies the label's head: "Ever (unknown current or former)" is a category
  // of ever-users, "Missing (not collected)" is missing. Read the head when it has words.
  const head = label.replace(/\([^()]*\)/g, " ").trim();
  const text = /\p{L}/u.test(head) ? head : /\p{L}/u.test(label) ? label : (v.description ?? "");
  if (text.trim() && SENTINEL_WORDS.test(normalizeForMatch(text))) return true;
  if (typeof v.value === "number" && CONVENTIONAL_SENTINEL_CODES.has(v.value)) return true;
  return false;
}

function measurementLabel(b: BranchAnalysis): string {
  const numeric = numericRangeLabel(b.numeric);
  if (numeric) return numeric;
  const length = lengthRangeLabel(b.minLength, b.maxLength);
  if (b.formats.length > 0) return [`any ${b.formats.map((f) => formatLabel(f)).join(" / ")}`, length].filter(Boolean).join(", ");
  if (b.patterns.length > 0) return [`matches ${b.patterns.join(" and ")}`, length].filter(Boolean).join(", ");
  if (length) return length;
  const types = [...b.jsonTypes].filter((t) => t !== "null");
  return types.length ? `any ${types.join(" or ")}` : "measured value";
}

/**
 * The bounds a range enforces: of `minimum` and `exclusiveMinimum` the stricter one (both may
 * be given), and likewise for the maximum.
 */
function effectiveBounds(n: NumericBounds): { lo?: number; loExclusive: boolean; hi?: number; hiExclusive: boolean } {
  const loExclusive = n.exclusiveMinimum !== undefined && (n.minimum === undefined || n.exclusiveMinimum >= n.minimum);
  const hiExclusive = n.exclusiveMaximum !== undefined && (n.maximum === undefined || n.exclusiveMaximum <= n.maximum);
  const lo = loExclusive ? n.exclusiveMinimum : n.minimum;
  const hi = hiExclusive ? n.exclusiveMaximum : n.maximum;
  return { ...(lo !== undefined ? { lo } : {}), loExclusive, ...(hi !== undefined ? { hi } : {}), hiExclusive };
}

function hasNumericRange(n: NumericBounds): boolean {
  return n.minimum !== undefined || n.maximum !== undefined || n.exclusiveMinimum !== undefined || n.exclusiveMaximum !== undefined;
}

/** `value` satisfies the range (a non-number satisfies any range: it is ruled out by type, not by bounds). */
function withinBounds(value: JsonValue, n: NumericBounds): boolean {
  if (typeof value !== "number") return true;
  const { lo, loExclusive, hi, hiExclusive } = effectiveBounds(n);
  if (lo !== undefined && (loExclusive ? value <= lo : value < lo)) return false;
  if (hi !== undefined && (hiExclusive ? value >= hi : value > hi)) return false;
  return true;
}

/** A compact range for the code column: "20–65"; an exclusive bound reads as an inequality ("0 < value ≤ 100"). */
function numericRangeLabel(n: NumericBounds): string {
  const { lo, loExclusive, hi, hiExclusive } = effectiveBounds(n);
  if (lo !== undefined && hi !== undefined) return loExclusive || hiExclusive ? numericRangeText(n) : `${formatNumber(lo)}–${formatNumber(hi)}`;
  if (lo !== undefined) return `${loExclusive ? ">" : "≥"} ${formatNumber(lo)}`;
  if (hi !== undefined) return `${hiExclusive ? "<" : "≤"} ${formatNumber(hi)}`;
  return "";
}

function numericRangeText(n: NumericBounds): string {
  const { lo, loExclusive, hi, hiExclusive } = effectiveBounds(n);
  const loOp = loExclusive ? "<" : "≤";
  const hiOp = hiExclusive ? "<" : "≤";
  if (lo !== undefined && hi !== undefined) return `${formatNumber(lo)} ${loOp} value ${hiOp} ${formatNumber(hi)}`;
  if (lo !== undefined) return `value ${loExclusive ? ">" : "≥"} ${formatNumber(lo)}`;
  if (hi !== undefined) return `value ${hiExclusive ? "<" : "≤"} ${formatNumber(hi)}`;
  return "";
}

function lengthRangeLabel(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return min === max ? `${min} chars` : `${min}–${max} chars`;
  if (min !== undefined) return `≥ ${min} chars`;
  if (max !== undefined) return `≤ ${max} chars`;
  return "";
}

function lengthRangeText(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) {
    return min === max ? `Exactly ${min} character(s)` : `Length ${min}–${max} characters`;
  }
  if (min !== undefined) return `At least ${min} character(s)`;
  if (max !== undefined) return `At most ${max} character(s)`;
  return "";
}

function itemsRangeText(min?: number, max?: number): string {
  if (max === 0) return "Must be empty (no items allowed)";
  if (min !== undefined && max !== undefined) return `${min}–${max} items`;
  if (min !== undefined) return `At least ${min} item(s)`;
  return `At most ${max} item(s)`;
}

function mergeNumeric(target: NumericBounds, src: NumericBounds): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    if (src[key] !== undefined && target[key] === undefined) target[key] = src[key];
  }
}

/** A branch in a few words: its values, or its type/format with a range and pattern. */
function briefOf(b: BranchAnalysis): string {
  if (b.values.length) return b.values.map((v) => formatJsonValue(v.value)).join(", ");
  const types = b.formats.length ? b.formats.map((f) => formatLabel(f)).join(" / ") : [...b.jsonTypes].join(" or ");
  const range = numericRangeLabel(b.numeric) || lengthRangeLabel(b.minLength, b.maxLength);
  const pattern = b.patterns.length ? `matching ${b.patterns.join(", ")}` : "";
  return [types, range, pattern].filter(Boolean).join(" ");
}

function joinDescriptions(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join("\n");
}

function dedupeValues(values: ValidValue[]): ValidValue[] {
  const seen = new Set<string>();
  const out: ValidValue[] = [];
  for (const v of values) {
    const key = `${v.kind ?? ""}|${valueKey(v.value)}|${v.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function dedupeConstraints(items: ConstraintItem[]): ConstraintItem[] {
  const seen = new Set<string>();
  const out: ConstraintItem[] = [];
  for (const item of items) {
    const key = `${item.keyword}|${item.text}|${item.condition ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function plainAdditional(info: Record<string, unknown>): Record<string, JsonValue> | null {
  const compact = compactObject(info);
  return Object.keys(compact).length > 0 ? (compact as Record<string, JsonValue>) : null;
}

export function refKeyword(schema: JsonSchemaObject): string | undefined {
  if (typeof schema.$ref === "string") return schema.$ref;
  if (typeof schema.$dynamicRef === "string") return schema.$dynamicRef;
  return undefined;
}

/** Annotation text from a schema (title / description / $comment), for category headings. */
export function describeAnnotations(schema: JsonSchema): string {
  if (!isSchemaObject(schema)) return "";
  const parts: string[] = [];
  if (typeof schema.title === "string") parts.push(schema.title);
  if (typeof schema.description === "string") parts.push(schema.description);
  if (typeof schema.$comment === "string") parts.push(schema.$comment);
  return joinDescriptions(parts);
}

/** Required property names accumulated across `$ref` and `allOf`. */
export function collectRequired(schema: JsonSchema, registry: SchemaRegistry, base: ResolutionBase, maxDepth: number): Set<string> {
  const required = new Set<string>();
  const visited = new Set<string>();
  function visit(current: JsonSchema, currentBase: ResolutionBase, depth: number): void {
    if (depth > maxDepth || !isSchemaObject(current)) return;
    const ref = refKeyword(current);
    if (ref) {
      const loc = registry.resolve(ref, currentBase);
      if (loc) {
        const key = `${loc.retrievalUri}#${loc.pointer}`;
        if (!visited.has(key)) {
          visited.add(key);
          visit(loc.schema, registry.baseOf(loc), depth + 1);
        }
      }
    }
    for (const name of asStringArray(current.required)) required.add(name);
    if (Array.isArray(current.allOf)) current.allOf.forEach((b) => visit(b, currentBase, depth + 1));
  }
  visit(schema, base, 0);
  return required;
}
