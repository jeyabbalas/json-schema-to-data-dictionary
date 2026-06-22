// Analyze a single property schema into the structured pieces of one data-dictionary row:
// data type, format, valid values, constraints, additional information and description.
//
// The interesting work is mixed types: an `anyOf`/`oneOf` that combines a measurement
// (a numeric/typed range) with categorical sentinel codes (structural missingness / skip
// codes). We classify each branch and present the measurement range in "Constraints" while
// the codes go to "Valid values", tagged so the renderer can show them as special codes.

import type {
  ConstraintItem,
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
  SourceInfo,
  ValidValue
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
}

interface InternalContext extends AnalyzeContext {
  depth: number;
  refStack: Set<string>;
}

const SENTINEL_WORDS =
  /(missing|unknown|not\s*applicable|not\s*assessed|not\s*collected|no\s*answer|no\s*response|refus|declin|don'?t\s*know|prefer\s*not|inapplicable|\bn\/?a\b|skipped?)/i;
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
      acc.values.push(makeValue(value, enumDescriptionFor(value, index, descriptions), undefined, ctx.source));
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
      acc.values.push(makeValue(value, desc, label, ctx.source));
      acc.jsonTypes.add(jsonTypeOf(value));
    }
  }
}

function collectScalarConstraints(schema: JsonSchemaObject, acc: Accumulator): void {
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    if (typeof schema[key] === "number") acc.numeric[key] = schema[key] as number;
  }
  if (typeof schema.minLength === "number") acc.minLength = schema.minLength;
  if (typeof schema.maxLength === "number") acc.maxLength = schema.maxLength;
}

function collectComposition(schema: JsonSchemaObject, ctx: InternalContext, acc: Accumulator): void {
  // allOf: a conjunction — merge every branch into this accumulator.
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) collect(branch, { ...ctx, depth: ctx.depth + 1 }, acc);
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
      for (const v of c.analysis.values) acc.values.push({ ...v, kind: "sentinel" });
    }
  } else if (hasCategorical) {
    // Pure categorical: tag each value as substantive or sentinel.
    for (const c of categoricals) {
      const refName = isSchemaObject(c.branch) ? refKeyword(c.branch) : undefined;
      for (const v of c.analysis.values) {
        acc.values.push({ ...v, kind: isSentinelValue(v, refName) ? "sentinel" : "value" });
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
    isMeasurement
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

  const substantive = acc.values.filter((v) => v.kind !== "measurement");
  if (substantive.length >= 2) return nn(`categorical (${baseTypeOfValues(substantive, acc)})`);

  const scalarTypes = [...acc.jsonTypes].filter((t) => t !== "object" || !acc.hasObjectShape);
  const types = scalarTypes.length ? scalarTypes : substantive.length ? [baseTypeOfValues(substantive, acc)] : [];
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
  if (refName && SENTINEL_WORDS.test(refName)) return true;
  const text = `${v.label ?? ""} ${v.description ?? ""}`;
  if (text.trim() && SENTINEL_WORDS.test(text)) return true;
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
