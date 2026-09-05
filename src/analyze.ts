// Analyze a single property schema into the structured pieces of one data-dictionary row:
// data type, format, valid values, constraints, additional information and description.
//
// The interesting work is mixed types: an `anyOf`/`oneOf` that combines a measurement
// (a numeric/typed range) with categorical sentinel codes (structural missingness / skip
// codes). We classify each branch and present the measurement range in "Constraints" while
// the codes go to "Valid values", tagged so the renderer can show them as special codes.
//
// Whether a code is a sentinel or a substantive answer is a guess from its wording, so
// `x-value-kind: "sentinel" | "value"` lets a schema say which it is and skip the guess.

import type {
  ConstraintItem,
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
  SourceInfo,
  ValidValue,
  ValidValueKind
} from "./types";
import { describeEncodedContent, describeFormat, describePattern, formatLabel, isKnownFormat } from "./formats";
import type { ResolutionBase, SchemaRegistry } from "./registry";
import {
  asStringArray,
  cloneJson,
  compactObject,
  formatJsonValue,
  formatNumber,
  hasOwn,
  isRecord,
  isSchemaObject,
  jsonTypeOf,
  normalizeTypeArray,
  stableStringify,
  valueKey
} from "./utils";

export interface AnalyzeContext {
  registry: SchemaRegistry;
  base: ResolutionBase;
  source?: SourceInfo | undefined;
  maxDepth: number;
}

export interface PropertyAnalysis {
  dataType: string;
  format: string;
  validValues: ValidValue[];
  constraints: ConstraintItem[];
  additionalInformation: Record<string, JsonValue> | null;
  description: string;
}

interface NumericBounds {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

interface Accumulator {
  jsonTypes: Set<string>;
  nullable: boolean;
  formats: Set<string>;
  encoding: { encoding?: string; mediaType?: string } | null;
  patterns: Set<string>;
  values: ValidValue[];
  numeric: NumericBounds;
  minLength?: number;
  maxLength?: number;
  array: { minItems?: number; maxItems?: number; uniqueItems?: boolean; minContains?: number; maxContains?: number; hasContains?: boolean };
  object: { minProperties?: number; maxProperties?: number };
  extraConstraints: ConstraintItem[];
  additional: Record<string, unknown>;
  descriptions: string[];
  hasArray: boolean;
  arrayItemLabel?: string;
  hasObjectShape: boolean;
  mixed: boolean;
  measurementBaseTypes: Set<string>;
  /** `x-value-kind`, when the schema declares it explicitly. */
  valueKind?: ValidValueKind | undefined;
}

interface InternalContext extends AnalyzeContext {
  depth: number;
  refStack: Set<string>;
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
// education" is an answer, and sodium is spelled Na. Add a word here only with a case that
// needs it; `x-value-kind` is the answer for wording this cannot safely infer.
const SENTINEL_WORDS =
  /(missing|unknown|not applicable|not assessed|not collected|not (?:on|in) (?:the )?(?:questionnaire|survey|form)\b|no answer|no response|refus|declin|do(?:n'?t| not) know\b|prefer not|\bsuppressed\b|inapplicable|\bn\/a\b|skipped?)/;

/**
 * Fold the spellings a label or an identifier can take into one: case, curly apostrophes and
 * `_`/`-` separators. Without it the vocabulary has to carry a separator convention per
 * alternative, and `$defs/not_applicable` reads differently from "Not applicable".
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
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
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "required",
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

export function analyzeProperty(schema: JsonSchema, context: AnalyzeContext): PropertyAnalysis {
  const acc = newAccumulator();
  collect(schema, { ...context, depth: 0, refStack: new Set() }, acc);
  return materialize(acc);
}

function newAccumulator(): Accumulator {
  return {
    jsonTypes: new Set(),
    nullable: false,
    formats: new Set(),
    encoding: null,
    patterns: new Set(),
    values: [],
    numeric: {},
    array: {},
    object: {},
    extraConstraints: [],
    additional: {},
    descriptions: [],
    hasArray: false,
    hasObjectShape: false,
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
  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, ctx.base);
    if (loc) {
      const key = `${loc.retrievalUri}#${loc.pointer}`;
      if (!ctx.refStack.has(key)) {
        const nextStack = new Set(ctx.refStack).add(key);
        collect(loc.schema, {
          ...ctx,
          base: ctx.registry.baseOf(loc),
          source: ctx.registry.sourceFor(loc, ref),
          depth: ctx.depth + 1,
          refStack: nextStack
        }, acc);
      } else {
        acc.extraConstraints.push({ keyword: "$ref", text: `Recursive reference omitted: ${ref}.` });
      }
    }
  }

  collectAnnotations(schema, acc);
  collectValueKind(schema, acc, beforeRef);
  collectTypes(schema, acc);
  collectFormatAndContent(schema, acc);
  collectEnumConst(schema, ctx, acc);
  collectScalarConstraints(schema, acc);
  collectComposition(schema, ctx, acc);
  collectArrayObject(schema, ctx, acc);
  collectAdditional(schema, acc);
}

function collectAnnotations(schema: JsonSchemaObject, acc: Accumulator): void {
  if (typeof schema.title === "string" && schema.title.trim()) acc.descriptions.push(schema.title.trim());
  if (typeof schema.description === "string" && schema.description.trim()) acc.descriptions.push(schema.description.trim());
  if (typeof schema.$comment === "string" && schema.$comment.trim()) acc.descriptions.push(schema.$comment.trim());
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
    for (const branch of schema.allOf) {
      collect(branch, { ...ctx, depth: ctx.depth + 1 }, acc);
      acc.valueKind = outer;
    }
  }

  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length > 0) handleUnion(union, ctx, acc);

  if (schema.not !== undefined && isSchemaObject(schema.not)) {
    const inner = analyzeBranch(schema.not, ctx);
    const brief = briefOf(inner);
    if (brief) acc.extraConstraints.push({ keyword: "not", text: `Must not be: ${brief}.` });
  }

  if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
    // Property-level conditionals are summarised here; row-object skip patterns are handled in extract.
    acc.extraConstraints.push({ keyword: "if/then", text: "Has a conditional (if/then) sub-rule." });
  }
}

function handleUnion(branches: JsonSchema[], ctx: InternalContext, acc: Accumulator): void {
  const analyzed = branches.map((branch) => ({ branch, analysis: analyzeBranch(branch, ctx) }));

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

  if (hasMeasurement && hasCategorical) {
    // Mixed: measurement value + categorical sentinel codes.
    acc.mixed = true;
    for (const m of measurements) {
      for (const t of m.analysis.jsonTypes) acc.measurementBaseTypes.add(t);
      mergeNumeric(acc.numeric, m.analysis.numeric);
      if (m.analysis.minLength !== undefined) acc.minLength = m.analysis.minLength;
      if (m.analysis.maxLength !== undefined) acc.maxLength = m.analysis.maxLength;
      acc.values.push({
        value: null,
        kind: "measurement",
        label: measurementLabel(m.analysis),
        ...(m.analysis.description ? { description: m.analysis.description } : {}),
        ...(ctx.source ? { source: ctx.source } : {})
      });
    }
    for (const c of categoricals) {
      const refName = refNameOf(c.branch);
      for (const v of c.analysis.values) acc.values.push({ ...v, kind: classify(v, refName, c.analysis.valueKind) });
    }
  } else if (hasCategorical) {
    // Pure categorical: tag each value as substantive or sentinel.
    for (const c of categoricals) {
      const refName = refNameOf(c.branch);
      for (const v of c.analysis.values) {
        acc.values.push({ ...v, kind: classify(v, refName, c.analysis.valueKind) });
        acc.jsonTypes.add(jsonTypeOf(v.value));
      }
    }
  } else {
    // Union of measurements (e.g. several numeric ranges): merge as plain constraints.
    for (const m of measurements) {
      for (const t of m.analysis.jsonTypes) acc.jsonTypes.add(t);
      mergeNumeric(acc.numeric, m.analysis.numeric);
    }
  }
}

interface BranchAnalysis {
  jsonTypes: Set<string>;
  values: ValidValue[];
  numeric: NumericBounds;
  minLength?: number;
  maxLength?: number;
  description: string;
  isMeasurement: boolean;
  valueKind?: ValidValueKind;
}

function analyzeBranch(branch: JsonSchema, ctx: InternalContext): BranchAnalysis {
  const sub = newAccumulator();
  collect(branch, { ...ctx, depth: ctx.depth + 1 }, sub);
  const hasRange =
    sub.numeric.minimum !== undefined ||
    sub.numeric.maximum !== undefined ||
    sub.numeric.exclusiveMinimum !== undefined ||
    sub.numeric.exclusiveMaximum !== undefined ||
    sub.minLength !== undefined ||
    sub.maxLength !== undefined;
  // A branch is a "measurement" when it constrains a numeric/string value but does not pin
  // it to specific categorical values (no enum/const).
  const isMeasurement = sub.values.length === 0 && (hasRange || sub.jsonTypes.has("number") || sub.jsonTypes.has("integer"));
  return {
    jsonTypes: sub.jsonTypes,
    values: sub.values,
    numeric: sub.numeric,
    ...(sub.minLength !== undefined ? { minLength: sub.minLength } : {}),
    ...(sub.maxLength !== undefined ? { maxLength: sub.maxLength } : {}),
    description: joinDescriptions(sub.descriptions),
    isMeasurement,
    ...(sub.valueKind ? { valueKind: sub.valueKind } : {})
  };
}

function collectArrayObject(schema: JsonSchemaObject, ctx: InternalContext, acc: Accumulator): void {
  const isArray = acc.jsonTypes.has("array") || schema.items !== undefined || Array.isArray(schema.prefixItems);
  if (isArray) {
    acc.hasArray = true;
    if (isSchemaObject(schema.items) || schema.items === true) {
      // Reuse the internal walker (shared depth + refStack) so self-referential item
      // schemas terminate, then read off just the data-type label.
      const sub = newAccumulator();
      collect(schema.items as JsonSchema, { ...ctx, depth: ctx.depth + 1 }, sub);
      acc.arrayItemLabel = dataTypeText(sub);
    }
    for (const key of ["minItems", "maxItems", "minContains", "maxContains"] as const) {
      if (typeof schema[key] === "number") acc.array[key] = schema[key] as number;
    }
    if (typeof schema.uniqueItems === "boolean") acc.array.uniqueItems = schema.uniqueItems;
    if (schema.contains !== undefined) acc.array.hasContains = true;
  }

  const isObject = acc.jsonTypes.has("object") || isRecord(schema.properties) || isRecord(schema.patternProperties);
  if (isObject) {
    acc.hasObjectShape = true;
    for (const key of ["minProperties", "maxProperties"] as const) {
      if (typeof schema[key] === "number") acc.object[key] = schema[key] as number;
    }
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

function materialize(acc: Accumulator): PropertyAnalysis {
  // Values from a bare `const`/`enum` never passed through a union, so nothing has classified
  // them yet. Run the same rule here: a code should not mean one thing written as `enum` and
  // another written as a `oneOf` of titled consts.
  for (const v of acc.values as DraftValue[]) {
    if (v.kind === undefined) v.kind = acc.valueKind ?? (isSentinelValue(v) ? "sentinel" : "value");
    delete v.declaredKind;
  }
  return {
    dataType: dataTypeText(acc),
    format: formatText(acc),
    validValues: dedupeValues(acc.values),
    constraints: buildConstraints(acc),
    additionalInformation: plainAdditional(acc.additional),
    description: joinDescriptions(acc.descriptions)
  };
}

function dataTypeText(acc: Accumulator): string {
  const nn = (s: string): string => (acc.nullable ? `${s} (nullable)` : s);

  if (acc.mixed) {
    const base = [...acc.measurementBaseTypes].filter(Boolean);
    const baseLabel = base.length ? base.join(" or ") : "value";
    return nn(`${baseLabel} + coded values`);
  }
  if (acc.encoding) {
    const enc = acc.encoding.encoding?.toLowerCase() === "base64" ? "base64" : acc.encoding.encoding;
    return nn(enc ? `binary (${enc})` : "binary");
  }
  if (acc.hasArray) return nn(acc.arrayItemLabel ? `array of ${acc.arrayItemLabel}` : "array");
  if (acc.formats.size > 0) return nn([...acc.formats].map((f) => formatLabel(f)).join(" / "));

  // "categorical" claims the field is a coded enumeration, so it needs at least one real
  // category: a sparse coding table that declares nothing but missing/NA codes is a plain
  // typed field that happens to have special codes, not a categorical one.
  const coded = acc.values.filter((v) => v.kind !== "measurement");
  if (coded.length >= 2 && coded.some((v) => v.kind !== "sentinel")) {
    return nn(`categorical (${baseTypeOfValues(coded, acc)})`);
  }
  const scalarTypes = [...acc.jsonTypes].filter((t) => t !== "object" || !acc.hasObjectShape);
  const types = scalarTypes.length ? scalarTypes : coded.length ? [baseTypeOfValues(coded, acc)] : [];
  if (acc.hasObjectShape && types.every((t) => t === "object")) return nn("object");
  if (types.length === 0) return acc.nullable ? "null" : "any";
  return nn([...new Set(types)].join(" or "));
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

function buildConstraints(acc: Accumulator): ConstraintItem[] {
  const out: ConstraintItem[] = [];

  const numericText = numericRangeText(acc.numeric);
  if (numericText) {
    out.push({ keyword: "range", value: cloneJson(acc.numeric), text: acc.mixed ? `Measured value: ${numericText}` : numericText });
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
    if (typeof a.minItems === "number" || typeof a.maxItems === "number") {
      out.push({ keyword: "items", text: itemsRangeText(a.minItems, a.maxItems) });
    }
    if (a.uniqueItems === true) out.push({ keyword: "uniqueItems", text: "Items must be unique" });
    if (typeof a.minContains === "number") out.push({ keyword: "minContains", text: `At least ${a.minContains} matching item(s)` });
    if (typeof a.maxContains === "number") out.push({ keyword: "maxContains", text: `At most ${a.maxContains} matching item(s)` });
  }

  if (acc.hasObjectShape) {
    if (typeof acc.object.minProperties === "number") out.push({ keyword: "minProperties", text: `At least ${acc.object.minProperties} propert${acc.object.minProperties === 1 ? "y" : "ies"}` });
    if (typeof acc.object.maxProperties === "number") out.push({ keyword: "maxProperties", text: `At most ${acc.object.maxProperties} propert${acc.object.maxProperties === 1 ? "y" : "ies"}` });
  }

  out.push(...acc.extraConstraints);
  return dedupeConstraints(out);
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
  const text = /\p{L}/u.test(label) ? label : (v.description ?? "");
  if (text.trim() && SENTINEL_WORDS.test(normalizeForMatch(text))) return true;
  if (typeof v.value === "number" && CONVENTIONAL_SENTINEL_CODES.has(v.value)) return true;
  return false;
}

function measurementLabel(b: BranchAnalysis): string {
  const numeric = numericRangeLabel(b.numeric);
  if (numeric) return numeric;
  const length = lengthRangeLabel(b.minLength, b.maxLength);
  if (length) return length;
  const types = [...b.jsonTypes].filter((t) => t !== "null");
  return types.length ? `any ${types.join(" or ")}` : "measured value";
}

function numericRangeLabel(n: NumericBounds): string {
  const lo = n.minimum ?? n.exclusiveMinimum;
  const hi = n.maximum ?? n.exclusiveMaximum;
  if (lo !== undefined && hi !== undefined) return `${formatNumber(lo)}–${formatNumber(hi)}`;
  if (lo !== undefined) return `${n.exclusiveMinimum !== undefined ? ">" : "≥"} ${formatNumber(lo)}`;
  if (hi !== undefined) return `${n.exclusiveMaximum !== undefined ? "<" : "≤"} ${formatNumber(hi)}`;
  return "";
}

function numericRangeText(n: NumericBounds): string {
  const hasLo = n.minimum !== undefined || n.exclusiveMinimum !== undefined;
  const hasHi = n.maximum !== undefined || n.exclusiveMaximum !== undefined;
  if (!hasLo && !hasHi) return "";
  const loOp = n.exclusiveMinimum !== undefined ? "<" : "≤";
  const hiOp = n.exclusiveMaximum !== undefined ? "<" : "≤";
  const lo = n.minimum ?? n.exclusiveMinimum;
  const hi = n.maximum ?? n.exclusiveMaximum;
  if (hasLo && hasHi) return `${formatNumber(lo as number)} ${loOp} value ${hiOp} ${formatNumber(hi as number)}`;
  if (hasLo) return `value ${n.exclusiveMinimum !== undefined ? ">" : "≥"} ${formatNumber(lo as number)}`;
  return `value ${n.exclusiveMaximum !== undefined ? "<" : "≤"} ${formatNumber(hi as number)}`;
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
  if (min !== undefined && max !== undefined) return `${min}–${max} items`;
  if (min !== undefined) return `At least ${min} item(s)`;
  return `At most ${max} item(s)`;
}

function mergeNumeric(target: NumericBounds, src: NumericBounds): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    if (src[key] !== undefined && target[key] === undefined) target[key] = src[key];
  }
}

function briefOf(b: BranchAnalysis): string {
  if (b.values.length) return b.values.map((v) => formatJsonValue(v.value)).join(", ");
  const range = numericRangeLabel(b.numeric);
  const types = [...b.jsonTypes].join(" or ");
  return [types, range].filter(Boolean).join(" ");
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
