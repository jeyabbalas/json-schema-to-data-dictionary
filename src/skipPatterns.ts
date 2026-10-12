// Parse the row-object-level conditional logic that encodes structural missingness and
// questionnaire skip patterns: `if`/`then`/`else` blocks (commonly inside the items object's
// `allOf`), plus `dependentRequired` and `dependentSchemas`.
//
// Output is (1) dataset-level ConditionalRule[] for a "skip patterns" panel, and
// (2) a per-variable map the extractor uses to annotate the affected rows' valid values
// and constraints with the triggering condition.
//
// The same logic can live inside a nested object (a rule between the fields of every visit).
// The extractor then scans that object with `qualify` mapping its property names to the
// nested rows' names (`fasting` -> `visits[].fasting`), and merges the result into the table's.
//
// Reading happens in two steps. `collectSkipPatterns` turns each block into a small tree --
// the condition (`x = 1 and (y ≤ 0 or y is absent)`) and what each clause requires of each
// variable (`= -666`, `≠ -666`, `1 ≤ value ≤ 12 or one of …`, `at least one of …`) -- without
// rendering anything, because the words depend on the whole dictionary: a code reads with its
// label (`partner_present = 0 (No)`), and the labels are only known once every row is built.
// `renderSkipPatterns` then writes the sentences, given a lookup of those labels.

import type { ConditionalEffect, ConditionalEffectKind, ConditionalRule, JsonSchema, JsonSchemaObject, JsonValue, SourceInfo } from "./types";
import type { ResolutionBase, SchemaRegistry } from "./registry";
import { refKeyword } from "./analyze";
import { formatLabel } from "./formats";
import { asStringArray, formatJsonValue, formatNumber, isRecord, isSchemaObject, joinNonEmpty, normalizeTypeArray } from "./utils";

/** A single conditional fact attached to one variable's row. */
export interface VariableConditional {
  /** Human trigger, e.g. "parous = 0 (Nulliparous)". */
  condition: string;
  /** Variables `condition` reads, by row name. */
  triggers: string[];
  /** Authoring prose for the rule (the block's `$comment`s) and for this variable's part of it. */
  description?: string | undefined;
  /** Forced value (`const`) or allowed set (`enum`) under the condition, if any. */
  value?: JsonValue | JsonValue[] | undefined;
  /** Human label for the forced value: the variable's own label for it, else one the rule's `$comment` gives. */
  label?: string | undefined;
  /** Ready-to-show constraint sentence. */
  constraintText: string;
  /** Other variables the sentence names (a rule that one of several variables must satisfy). */
  references?: string[] | undefined;
  /** `condition` combines tests ("a = 1 and b = 2", "a = 1 or a is absent"): joined with another, it needs parentheses. */
  compound?: boolean | undefined;
  source?: SourceInfo | undefined;
}

export interface SkipPatternResult {
  rules: ConditionalRule[];
  byVariable: Map<string, VariableConditional[]>;
  /** What the dictionary could not put into words (keywords it shows as JSON instead). */
  warnings: string[];
}

/** What the sentences need to know about each variable, once every row is built. */
export interface VariableLookup {
  /** The label a variable gives one of its values ("No" for `partner_present` = 0), if any. */
  label(variable: string, value: JsonValue): string | undefined;
  /** The JSON types the variable's own schema allows ("integer", "string", "null" …); empty when it does not say. */
  types(variable: string): readonly string[];
}

const NO_LOOKUP: VariableLookup = { label: () => undefined, types: () => [] };

export interface SkipPatternContext {
  registry: SchemaRegistry;
  maxDepth: number;
  /**
   * Maps a property name of the object being scanned to the name of its row. Nested objects
   * pass the path prefix (`date` -> `visits[].date`); the row object needs nothing.
   */
  qualify?: ((name: string) => string) | undefined;
  /**
   * Property names the scanned object itself requires. A condition on a property that may be
   * absent also holds when it is absent (`properties` only tests what is there), so a test on
   * one that is neither listed here nor in the `if`'s own `required` says so.
   */
  required?: ReadonlySet<string> | undefined;
}

// ---------------------------------------------------------------------------
// The parsed form
// ---------------------------------------------------------------------------

/** A test on one value. */
export type Predicate =
  | { kind: "eq"; value: JsonValue }
  | { kind: "ne"; value: JsonValue }
  | { kind: "in"; values: JsonValue[] }
  | { kind: "notIn"; values: JsonValue[] }
  | { kind: "range"; min?: number; max?: number; exclusiveMin?: boolean; exclusiveMax?: boolean }
  | { kind: "length"; min?: number; max?: number }
  | { kind: "pattern"; pattern: string }
  | { kind: "format"; format: string }
  | { kind: "multipleOf"; value: number }
  | { kind: "type"; types: string[] }
  | { kind: "absent" }
  | { kind: "all"; parts: Predicate[] }
  | { kind: "any"; parts: Predicate[]; exclusive?: boolean }
  | { kind: "not"; part: Predicate }
  /** No constraint at all (`true`, `{}`). */
  | { kind: "anything" }
  /** A constraint this reader cannot put into words: its keywords as written, when there are any. */
  | { kind: "opaque"; schema?: JsonValue };

/** A condition over the variables of a record. */
export type Condition =
  /**
   * `variable` satisfies `test`. `optional`: the test also holds when the variable is absent;
   * otherwise it needs the variable present. `always`: every record has the variable.
   */
  | { kind: "test"; variable: string; test: Predicate; optional: boolean; always?: true }
  | { kind: "present"; variable: string }
  | { kind: "all"; parts: Condition[] }
  | { kind: "any"; parts: Condition[]; exclusive?: boolean }
  | { kind: "not"; part: Condition }
  | { kind: "always" }
  | { kind: "never" }
  /** Keywords on the record this reader does not put into words (`minProperties`), as written. */
  | { kind: "unread"; schema: JsonValue };

/** What one clause of a rule requires. */
export type RuleEffect =
  /**
   * Of one variable: its value satisfies `test`. `required`: the clause requires it present;
   * `always`: every record has it anyway. Otherwise it may also be absent.
   */
  | { kind: "value"; variable: string; test: Predicate; required: boolean; always?: true; comment?: string | undefined }
  /** Of several variables together: `condition` holds (an `anyOf` of `properties` in a `then`). */
  | { kind: "combination"; condition: Condition; comment?: string | undefined }
  /** No record may satisfy the condition (`then: false`). */
  | { kind: "forbidden" }
  /** Keywords of the clause this reader does not put into words (`minProperties`), as written. */
  | { kind: "unread"; schema: JsonValue; comment?: string | undefined };

/** A rule before it is put into words. */
export interface ParsedRule {
  condition: Condition;
  comment?: string | undefined;
  effects: RuleEffect[];
}

/** A dependentRequired fact (already in words: it has no codes to label). */
interface DependencyFact {
  variable: string;
  fact: VariableConditional;
}

export interface ParsedSkipPatterns {
  rules: ParsedRule[];
  dependencies: DependencyFact[];
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export function collectSkipPatterns(itemSchema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext): ParsedSkipPatterns {
  const rules: ParsedRule[] = [];
  const dependencies: DependencyFact[] = [];
  const visited = new Set<string>();

  const visit = (schema: JsonSchema, currentBase: ResolutionBase, depth: number): void => {
    if (depth > ctx.maxDepth || !isSchemaObject(schema)) return;

    const ref = refKeyword(schema);
    if (ref) {
      const loc = ctx.registry.resolve(ref, currentBase);
      if (loc) {
        const key = `${loc.retrievalUri}#${loc.pointer}`;
        if (!visited.has(key)) {
          visited.add(key);
          visit(loc.schema, ctx.registry.baseOf(loc), depth + 1);
        }
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const branch of schema.allOf) visit(branch, currentBase, depth + 1);
    }

    // Each rule is read from depth 0: `depth` above bounds the search for rules, and the
    // bound inside a rule is its own.
    if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
      rules.push(...readIfThen(schema, currentBase, ctx, undefined, 0));
    }

    if (isRecord(schema.dependentRequired)) dependencies.push(...readDependentRequired(schema.dependentRequired, ctx));
    if (isRecord(schema.dependentSchemas)) rules.push(...readDependentSchemas(schema.dependentSchemas, currentBase, ctx));
  };

  visit(itemSchema, base, 0);
  return { rules, dependencies };
}

/**
 * Append the rules and facts of `from` to `into`, skipping any already there. The same nested
 * object can be scanned twice (a parent declared by two `allOf` branches), and a repeated rule
 * would badge a value with the same condition twice.
 */
export function mergeSkipPatterns(into: ParsedSkipPatterns, from: ParsedSkipPatterns): void {
  const ruleKey = (r: ParsedRule): string => JSON.stringify([r.condition, r.comment ?? null, r.effects]);
  const seenRules = new Set(into.rules.map(ruleKey));
  for (const rule of from.rules) {
    const key = ruleKey(rule);
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    into.rules.push(rule);
  }
  const factKey = (d: DependencyFact): string => JSON.stringify([d.variable, d.fact.condition, d.fact.constraintText]);
  const seenFacts = new Set(into.dependencies.map(factKey));
  for (const dep of from.dependencies) {
    const key = factKey(dep);
    if (seenFacts.has(key)) continue;
    seenFacts.add(key);
    into.dependencies.push(dep);
  }
}

const identity = (name: string): string => name;

/**
 * The rules of one `if`/`then`/`else` block; a block nested in a clause adds its own, under both
 * conditions (`nesting` counts those levels) and with the outer block's comment before its own.
 */
function readIfThen(
  block: JsonSchemaObject,
  base: ResolutionBase,
  ctx: SkipPatternContext,
  outer: Condition | undefined,
  nesting: number,
  outerComment?: string
): ParsedRule[] {
  if (nesting > ctx.maxDepth) return [];
  const comment = joinComments([outerComment, commentOf(block), commentOf(block.if)]);
  const own = readCondition(block.if as JsonSchema, base, ctx, 0);
  const out: ParsedRule[] = [];
  const clause = (schema: JsonSchema | undefined, condition: Condition): void => {
    if (schema === undefined) return;
    const scoped = outer ? conjunction([outer, condition]) : condition;
    const effects = readEffects(schema, base, ctx, 0);
    const clauseComment = joinComments([comment, commentOf(schema)]);
    if (effects.length > 0) out.push({ condition: scoped, ...(clauseComment ? { comment: clauseComment } : {}), effects });
    out.push(...clauseRules(schema, base, ctx, scoped, nesting, clauseComment));
  };
  clause(block.then as JsonSchema | undefined, own);
  clause(block.else as JsonSchema | undefined, negate(own));
  return out;
}

/**
 * The conditional rules inside a clause, which hold when the clause's condition does too: an
 * `if`/`then` block, `dependentRequired` ("when x is present, y is required") and `dependentSchemas`.
 */
function clauseRules(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, scoped: Condition, nesting: number, comment: string | undefined): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const nested of nestedBlocks(schema, base, ctx, 0)) out.push(...readIfThen(nested.schema, nested.base, ctx, scoped, nesting + 1, comment));
  if (!isSchemaObject(schema)) return out;
  const q = ctx.qualify ?? identity;
  if (isRecord(schema.dependentRequired)) {
    for (const [trigger, deps] of Object.entries(schema.dependentRequired)) {
      const effects: RuleEffect[] = asStringArray(deps).map((dep) => ({ kind: "value", variable: q(dep), test: { kind: "anything" }, required: true }));
      const condition = conjunction([scoped, { kind: "present", variable: q(trigger) }]);
      if (effects.length > 0) out.push({ condition, ...(comment ? { comment } : {}), effects });
    }
  }
  if (isRecord(schema.dependentSchemas)) out.push(...readDependentSchemas(schema.dependentSchemas, base, ctx, scoped, nesting + 1));
  return out;
}

/** `if`/`then` blocks inside a clause (directly, or in its `allOf`/`$ref`). */
function nestedBlocks(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Array<{ schema: JsonSchemaObject; base: ResolutionBase }> {
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return [];
  const out: Array<{ schema: JsonSchemaObject; base: ResolutionBase }> = [];
  if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) out.push({ schema, base });
  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) out.push(...nestedBlocks(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1));
  }
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) out.push(...nestedBlocks(branch, base, ctx, depth + 1));
  return out;
}

function readDependentRequired(dependentRequired: Record<string, unknown>, ctx: SkipPatternContext): DependencyFact[] {
  const q = ctx.qualify ?? identity;
  const out: DependencyFact[] = [];
  for (const [trigger, deps] of Object.entries(dependentRequired)) {
    const names = asStringArray(deps).map(q);
    if (names.length === 0) continue;
    const verb = names.length === 1 ? "is" : "are";
    const condition = `${q(trigger)} is present`;
    const triggers = [q(trigger)];
    out.push({
      variable: q(trigger),
      fact: { condition, triggers, constraintText: `When ${q(trigger)} is present, ${names.join(", ")} ${verb} also required.` }
    });
    for (const dep of names) out.push({ variable: dep, fact: { condition, triggers, constraintText: `Required when ${q(trigger)} is present.` } });
  }
  return out;
}

/**
 * `dependentSchemas`: what each schema requires once its property is present, read like a `then`
 * (inside a clause, also under the clause's condition, `outer`).
 */
function readDependentSchemas(dependentSchemas: Record<string, unknown>, base: ResolutionBase, ctx: SkipPatternContext, outer?: Condition, nesting = 0): ParsedRule[] {
  if (nesting > ctx.maxDepth) return [];
  const q = ctx.qualify ?? identity;
  const out: ParsedRule[] = [];
  for (const [trigger, sub] of Object.entries(dependentSchemas)) {
    if (!isSchemaObject(sub) && sub !== true && sub !== false) continue;
    const present: Condition = { kind: "present", variable: q(trigger) };
    const condition = outer ? conjunction([outer, present]) : present;
    const effects = readEffects(sub as JsonSchema, base, ctx, 0);
    const comment = commentOf(sub);
    if (effects.length > 0) out.push({ condition, ...(comment ? { comment } : {}), effects });
    out.push(...clauseRules(sub as JsonSchema, base, ctx, condition, nesting + 1, comment));
  }
  return out;
}

/** Comments joined, each once: a clause that is itself an `if`/`then` block passes its comment on and has it too. */
function joinComments(parts: Array<string | undefined>): string | undefined {
  const out: string[] = [];
  for (const part of parts) if (part && !out.some((o) => o.includes(part))) out.push(part);
  return out.length > 0 ? out.join(" ") : undefined;
}

function commentOf(schema: unknown): string | undefined {
  return isSchemaObject(schema) && typeof schema.$comment === "string" && schema.$comment.trim() ? schema.$comment.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Conditions (`if`)
// ---------------------------------------------------------------------------

/** The condition an `if` schema states, over the variables of the scanned object. */
function readCondition(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Condition {
  if (schema === true) return { kind: "always" };
  if (schema === false) return { kind: "never" };
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return { kind: "always" };
  const q = ctx.qualify ?? identity;
  const parts: Condition[] = [];

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) parts.push(readCondition(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1));
  }

  const required = new Set(asStringArray(schema.required));
  // A property every record has is never absent: a test on it needs nothing more.
  const always = (name: string): boolean => ctx.required?.has(name) ?? false;
  const present = (name: string): Condition => (always(name) ? { kind: "always" } : { kind: "present", variable: q(name) });
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!isSchemaObject(sub) && typeof sub !== "boolean") continue;
      const test = readPredicate(sub as JsonSchema, base, ctx, depth + 1);
      const variable = q(name);
      if (test.kind === "anything") {
        if (required.has(name)) parts.push(present(name));
        continue;
      }
      if (test.kind === "absent") {
        // `x: false` holds exactly when x is absent; were x required, the `if` could never hold.
        parts.push(required.has(name) || always(name) ? { kind: "never" } : { kind: "test", variable, test, optional: false });
        continue;
      }
      // `properties` only tests what is there: unless something requires the property, the
      // test also holds when it is absent.
      parts.push({ kind: "test", variable, test, optional: !required.has(name) && !always(name), ...(always(name) ? { always: true as const } : {}) });
    }
  }
  const tested = new Set(isRecord(schema.properties) ? Object.keys(schema.properties) : []);
  for (const name of required) if (!tested.has(name)) parts.push(present(name));
  const unread = unreadKeywords(schema, CONDITION_KEYS);
  if (unread !== undefined) parts.push({ kind: "unread", schema: unread });

  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) parts.push(readCondition(branch, base, ctx, depth + 1));
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const list = schema[keyword];
    if (Array.isArray(list) && list.length > 0) {
      const branches = list.map((b) => readCondition(b, base, ctx, depth + 1));
      parts.push(branches.length === 1 ? (branches[0] as Condition) : { kind: "any", parts: branches, ...(keyword === "oneOf" ? { exclusive: true } : {}) });
    }
  }
  if (schema.not !== undefined) parts.push(negate(readCondition(schema.not, base, ctx, depth + 1)));
  if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
    // An `if` inside an `if`: "(a and b) or (not a and c)".
    const inner = readCondition(schema.if, base, ctx, depth + 1);
    const then = schema.then !== undefined ? readCondition(schema.then, base, ctx, depth + 1) : ({ kind: "always" } as Condition);
    const otherwise = schema.else !== undefined ? readCondition(schema.else, base, ctx, depth + 1) : ({ kind: "always" } as Condition);
    parts.push(disjunction([conjunction([inner, then]), conjunction([negate(inner), otherwise])]));
  }
  return conjunction(parts);
}

function conjunction(parts: Condition[]): Condition {
  const flat: Condition[] = [];
  for (const part of parts) {
    if (part.kind === "always") continue;
    if (part.kind === "never") return part;
    if (part.kind === "all") flat.push(...part.parts);
    else flat.push(part);
  }
  if (flat.length === 0) return { kind: "always" };
  return flat.length === 1 ? (flat[0] as Condition) : { kind: "all", parts: flat };
}

function disjunction(parts: Condition[]): Condition {
  const flat = parts.filter((p) => p.kind !== "never");
  if (flat.some((p) => p.kind === "always")) return { kind: "always" };
  if (flat.length === 0) return { kind: "never" };
  return flat.length === 1 ? (flat[0] as Condition) : { kind: "any", parts: flat };
}

/** The opposite condition, stated directly where that is exact (`x ≠ 1` for `x = 1` on a variable that is always there). */
function negate(condition: Condition): Condition {
  switch (condition.kind) {
    case "always":
      return { kind: "never" };
    case "never":
      return { kind: "always" };
    case "not":
      return condition.part;
    case "present":
      return { kind: "test", variable: condition.variable, test: { kind: "absent" }, optional: false };
    case "test": {
      const { variable } = condition;
      if (condition.test.kind === "absent") return { kind: "present", variable };
      const opposite = negatePredicate(condition.test);
      // Absent satisfies an optional test, so its opposite needs the variable to be there. A test
      // that needs it there fails when it is absent, so its opposite holds then too -- unless
      // every record has the variable: then `x ≠ 1` is the whole opposite of `x = 1`.
      if (condition.optional) return conjunction([{ kind: "present", variable }, { kind: "test", variable, test: opposite, optional: false }]);
      return condition.always ? { kind: "test", variable, test: opposite, optional: false, always: true } : { kind: "test", variable, test: opposite, optional: true };
    }
    default:
      return { kind: "not", part: condition };
  }
}

function negatePredicate(test: Predicate): Predicate {
  switch (test.kind) {
    case "eq":
      return { kind: "ne", value: test.value };
    case "ne":
      return { kind: "eq", value: test.value };
    case "in":
      return { kind: "notIn", values: test.values };
    case "notIn":
      return { kind: "in", values: test.values };
    case "not":
      return test.part;
    default:
      return { kind: "not", part: test };
  }
}

// ---------------------------------------------------------------------------
// Predicates (a property's subschema in an `if` or a `then`)
// ---------------------------------------------------------------------------

/** Keywords that say nothing about the value. */
const ANNOTATIONS = new Set(["$comment", "title", "description", "$id", "$anchor", "$schema", "$defs", "definitions", "examples", "default", "deprecated", "readOnly", "writeOnly"]);

function readPredicate(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Predicate {
  if (schema === true) return { kind: "anything" };
  if (schema === false) return { kind: "absent" };
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return { kind: "opaque" };
  const parts: Predicate[] = [];
  let typeOnly: Predicate | undefined;

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    parts.push(loc ? readPredicate(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1) : { kind: "opaque" });
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) parts.push({ kind: "eq", value: schema.const as JsonValue });
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as JsonValue[];
    parts.push(values.length === 1 ? { kind: "eq", value: values[0] as JsonValue } : { kind: "in", values });
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // Of `minimum` and `exclusiveMinimum` (both may be given) the stricter bound applies; likewise above.
  const inMin = num(schema.minimum);
  const inMax = num(schema.maximum);
  const exMin = num(schema.exclusiveMinimum);
  const exMax = num(schema.exclusiveMaximum);
  const exclusiveMin = exMin !== undefined && (inMin === undefined || exMin >= inMin);
  const exclusiveMax = exMax !== undefined && (inMax === undefined || exMax <= inMax);
  const min = exclusiveMin ? exMin : inMin;
  const max = exclusiveMax ? exMax : inMax;
  if (min !== undefined || max !== undefined) {
    parts.push({
      kind: "range",
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(exclusiveMin ? { exclusiveMin: true } : {}),
      ...(exclusiveMax ? { exclusiveMax: true } : {})
    });
  }
  const minLength = num(schema.minLength);
  const maxLength = num(schema.maxLength);
  if (minLength !== undefined || maxLength !== undefined) {
    parts.push({ kind: "length", ...(minLength !== undefined ? { min: minLength } : {}), ...(maxLength !== undefined ? { max: maxLength } : {}) });
  }
  if (typeof schema.pattern === "string") parts.push({ kind: "pattern", pattern: schema.pattern });
  if (typeof schema.format === "string" && schema.format.trim()) parts.push({ kind: "format", format: schema.format.trim() });
  const multipleOf = num(schema.multipleOf);
  if (multipleOf !== undefined) parts.push({ kind: "multipleOf", value: multipleOf });
  const types = normalizeTypeArray(schema.type);
  if (types.length > 0) typeOnly = { kind: "type", types };
  if (schema.not !== undefined) parts.push(negatePredicate(readPredicate(schema.not, base, ctx, depth + 1)));
  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) parts.push(readPredicate(branch, base, ctx, depth + 1));
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const list = schema[keyword];
    if (Array.isArray(list) && list.length > 0) {
      const branches = list.map((b) => readPredicate(b, base, ctx, depth + 1));
      parts.push(branches.length === 1 ? (branches[0] as Predicate) : { kind: "any", parts: branches, ...(keyword === "oneOf" ? { exclusive: true } : {}) });
    }
  }
  const unread = unreadKeywords(schema, PREDICATE_KEYS);
  if (unread !== undefined) parts.push({ kind: "opaque", schema: unread });

  const meaningful: Predicate[] = parts.filter((p) => p.kind !== "anything");
  if (meaningful.length === 0) return typeOnly ?? { kind: "anything" };
  // A `type` beside a value or a set adds nothing ("an integer, one of 1, 2"). Beside a range it
  // may (an integer ≤ 50, of a number variable); the sentence drops it when the variable's own
  // type already says so.
  if (typeOnly && !meaningful.some((p) => p.kind === "eq" || p.kind === "in")) meaningful.unshift(typeOnly);
  return meaningful.length === 1 ? (meaningful[0] as Predicate) : { kind: "all", parts: meaningful };
}

/** The keywords of `schema` this reader does not put into words, as written; undefined when there are none. */
function unreadKeywords(schema: JsonSchemaObject, handled: ReadonlySet<string>): JsonValue | undefined {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key) || key.startsWith("x-") || handled.has(key)) continue;
    out[key] = value as JsonValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What an `if` can say about the record in words (`type` is "object" for any record). */
const CONDITION_KEYS = new Set(["$ref", "$dynamicRef", "required", "properties", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "type"]);

/** What a clause can require in words; its `if`/`then` blocks and dependencies are rules of their own. */
const EFFECT_KEYS = new Set([...CONDITION_KEYS, "dependentRequired", "dependentSchemas"]);

const PREDICATE_KEYS = new Set([
  "$ref",
  "$dynamicRef",
  "const",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "type",
  "not",
  "allOf",
  "anyOf",
  "oneOf",
  "format",
  "multipleOf",
  "enumDescriptions",
  "x-enumDescriptions"
]);

// ---------------------------------------------------------------------------
// Effects (`then` / `else` / a dependent schema)
// ---------------------------------------------------------------------------

/**
 * What a clause requires, variable by variable. `comment` is the `$comment` of the subschema
 * being read when it is not the clause itself (whose comment is the rule's): an `allOf` branch
 * explains the effects it contributes.
 */
function readEffects(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number, comment?: string): RuleEffect[] {
  if (schema === false) return [{ kind: "forbidden" }];
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return [];
  const q = ctx.qualify ?? identity;
  const out: RuleEffect[] = [];
  const byVariable = new Map<string, Extract<RuleEffect, { kind: "value" }>>();
  const effectFor = (name: string): Extract<RuleEffect, { kind: "value" }> => {
    const variable = q(name);
    let effect = byVariable.get(variable);
    if (!effect) {
      const always = ctx.required?.has(name) ?? false;
      effect = { kind: "value", variable, test: { kind: "anything" }, required: false, ...(always ? { always: true as const } : {}), ...(comment ? { comment } : {}) };
      byVariable.set(variable, effect);
      out.push(effect);
    }
    return effect;
  };
  const withComment = comment ? { comment } : {};

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) out.push(...readEffects(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1, joinNonEmpty([comment, commentOf(loc.schema)], " ") || undefined));
  }
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!isSchemaObject(sub) && typeof sub !== "boolean") continue;
      const test = readPredicate(sub as JsonSchema, base, ctx, depth + 1);
      if (test.kind === "anything") continue;
      const effect = effectFor(name);
      effect.test = effect.test.kind === "anything" ? test : { kind: "all", parts: [effect.test, test] };
      const own = commentOf(sub);
      if (own) effect.comment = joinNonEmpty([effect.comment, own], " ");
    }
  }
  for (const name of asStringArray(schema.required)) effectFor(name).required = true;
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) out.push(...readEffects(branch, base, ctx, depth + 1, joinNonEmpty([comment, commentOf(branch)], " ") || undefined));
  }
  // An `anyOf`/`oneOf`/`not` over properties constrains the variables together: "at least one
  // of these accounts is owned". Read it as a condition, which is what each branch states.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const list = schema[keyword];
    if (!Array.isArray(list) || list.length === 0) continue;
    const branches = list.map((b) => readCondition(b, base, ctx, depth + 1));
    const condition = branches.length === 1 ? (branches[0] as Condition) : ({ kind: "any", parts: branches, ...(keyword === "oneOf" ? { exclusive: true } : {}) } as Condition);
    if (variablesOf(condition).length > 0) out.push({ kind: "combination", condition, ...withComment });
    else if (hasUnread(condition)) out.push({ kind: "unread", schema: { [keyword]: list as JsonValue }, ...withComment });
  }
  if (schema.not !== undefined) {
    const condition = negate(readCondition(schema.not, base, ctx, depth + 1));
    if (variablesOf(condition).length > 0) out.push({ kind: "combination", condition, ...withComment });
    else if (hasUnread(condition)) out.push({ kind: "unread", schema: { not: schema.not as JsonValue }, ...withComment });
  }
  const unread = unreadKeywords(schema, EFFECT_KEYS);
  if (unread !== undefined) out.push({ kind: "unread", schema: unread, ...withComment });
  return out.filter((e) => e.kind !== "value" || e.required || e.test.kind !== "anything");
}

/** The condition includes keywords this reader shows as written. */
function hasUnread(condition: Condition): boolean {
  switch (condition.kind) {
    case "unread":
      return true;
    case "all":
    case "any":
      return condition.parts.some(hasUnread);
    case "not":
      return hasUnread(condition.part);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Sets with more members than this are listed without labels: the sentence would not end. */
const MAX_LABELLED_MEMBERS = 8;

/** A label parsed from a comment is a short phrase ("Never-user"), not a sentence. */
const MAX_LABEL_WORDS = 4;

/** Keywords shown as written are cut short after this many characters. */
const MAX_SCHEMA_TEXT = 120;

/** Put the parsed rules into words, labelling codes and qualifying tests through `lookup`. */
export function renderSkipPatterns(parsed: ParsedSkipPatterns, lookup: VariableLookup = NO_LOOKUP): SkipPatternResult {
  const rules: ConditionalRule[] = [];
  const byVariable = new Map<string, VariableConditional[]>();
  const unread = new Set<string>();
  const attach = (variable: string, fact: VariableConditional): void => {
    const list = byVariable.get(variable) ?? [];
    if (!list.some((f) => f.condition === fact.condition && f.constraintText === fact.constraintText)) list.push(fact);
    byVariable.set(variable, list);
  };

  for (const rule of parsed.rules) {
    const condition = conditionText(rule.condition, lookup);
    const triggers = variablesOf(rule.condition);
    const compound = isCompound(rule.condition) ? { compound: true } : {};
    noteUnread(rule.condition, unread);
    const codeLabels = rule.comment ? parseCodeLabels(rule.comment) : new Map<string, string>();
    const effects: ConditionalEffect[] = [];
    for (const effect of rule.effects) {
      if (effect.kind === "forbidden") {
        const text = `Not allowed: ${condition}.`;
        for (const variable of triggers) attach(variable, { condition, triggers, ...compound, ...describe(rule.comment), constraintText: text });
        for (const variable of triggers) effects.push({ variable, value: [], kind: "forbidden", text: "not allowed" });
        continue;
      }
      if (effect.kind === "unread") {
        // A requirement on the record as a whole, shown as written on the rows the condition reads.
        if (isRecord(effect.schema)) for (const key of Object.keys(effect.schema)) unread.add(key);
        const requirement = `the record must also match ${schemaText(effect.schema)}`;
        const comment = joinNonEmpty([rule.comment, effect.comment], " ") || undefined;
        for (const variable of triggers) {
          attach(variable, { condition, triggers, ...compound, ...describe(comment), constraintText: sentence(condition, requirement) });
          effects.push({ variable, value: [], kind: "constraint", text: requirement, ...(effect.comment ? { comment: effect.comment } : {}) });
        }
        continue;
      }
      if (effect.kind === "combination") {
        noteUnread(effect.condition, unread);
        const variables = variablesOf(effect.condition);
        const requirement = combinationText(effect.condition, lookup);
        const comment = joinNonEmpty([rule.comment, effect.comment], " ") || undefined;
        for (const variable of variables) {
          attach(variable, {
            condition,
            triggers,
            ...compound,
            ...describe(comment),
            constraintText: sentence(condition, requirement),
            references: variables.filter((v) => v !== variable)
          });
          effects.push({ variable, value: [], kind: "combination", text: requirement });
        }
        continue;
      }
      const { variable, test, required } = effect;
      notePredicate(test, unread);
      // A code a rule sets reads with the variable's own label, as in its Valid values. A "Label
      // (code)" in the rule's comment names only a code the variable does not label itself: one
      // comment often covers several variables, which may give the same code different meanings.
      const own = (v: JsonValue): string | undefined => lookup.label(variable, v);
      const pinned = test.kind === "eq" ? test.value : test.kind === "in" ? test.values : undefined;
      const pinLabel = test.kind === "eq" ? own(test.value) ?? codeLabels.get(String(test.value)) : undefined;
      const requirement = effectText(test, effect, lookup.types(variable), (v) => (test.kind === "eq" ? pinLabel : own(v)));
      const comment = joinNonEmpty([rule.comment, effect.comment], " ") || undefined;
      attach(variable, {
        condition,
        triggers,
        ...compound,
        ...describe(comment),
        ...(pinned !== undefined ? { value: pinned } : {}),
        ...(pinLabel ? { label: pinLabel } : {}),
        constraintText: sentence(condition, requirement)
      });
      const excludedLabel = test.kind === "ne" ? own(test.value) : undefined;
      effects.push({
        variable,
        value: pinned ?? [],
        ...(pinLabel ? { label: pinLabel } : excludedLabel ? { label: excludedLabel } : {}),
        kind: effectKind(test, required),
        ...(test.kind === "ne" ? { excluded: [test.value] } : test.kind === "notIn" ? { excluded: test.values } : {}),
        text: requirement,
        ...(effect.comment ? { comment: effect.comment } : {})
      });
    }
    if (effects.length > 0) rules.push({ condition, triggers, ...(rule.comment ? { description: rule.comment } : {}), effects });
  }
  for (const dep of parsed.dependencies) attach(dep.variable, dep.fact);
  const keys = [...unread].sort();
  const warnings = keys.length > 0 ? [`Skip patterns: ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} shown as written (JSON) rather than in words.`] : [];
  return { rules, byVariable, warnings };
}

function describe(comment: string | undefined): { description?: string } {
  return comment ? { description: comment } : {};
}

/** "When a = 1, value = 0 (No)." -- or, for a rule without a condition, "In every record, …". */
function sentence(condition: string, requirement: string): string {
  return condition === "always" ? `In every record, ${requirement}.` : `When ${condition}, ${requirement}.`;
}

/** The condition reads as tests joined by "and" (or "exactly one of"): beside another, it needs parentheses. */
function isCompound(condition: Condition): boolean {
  if (condition.kind === "all") return true;
  if (condition.kind === "any") return condition.exclusive === true;
  return condition.kind === "test" && (condition.test.kind === "all" || (condition.test.kind === "any" && condition.test.exclusive === true));
}

/** Collect the keywords a condition shows as written. */
function noteUnread(condition: Condition, into: Set<string>): void {
  switch (condition.kind) {
    case "unread":
      if (isRecord(condition.schema)) for (const key of Object.keys(condition.schema)) into.add(key);
      break;
    case "test":
      notePredicate(condition.test, into);
      break;
    case "all":
    case "any":
      for (const part of condition.parts) noteUnread(part, into);
      break;
    case "not":
      noteUnread(condition.part, into);
      break;
    default:
      break;
  }
}

function notePredicate(test: Predicate, into: Set<string>): void {
  if (test.kind === "opaque" && isRecord(test.schema)) for (const key of Object.keys(test.schema)) into.add(key);
  else if (test.kind === "all" || test.kind === "any") for (const part of test.parts) notePredicate(part, into);
  else if (test.kind === "not") notePredicate(test.part, into);
}

function effectKind(test: Predicate, required: boolean): ConditionalEffectKind {
  switch (test.kind) {
    case "eq":
      return "equals";
    case "in":
      return "oneOf";
    case "ne":
      return "notEquals";
    case "notIn":
      return "notOneOf";
    case "anything":
      return required ? "required" : "constraint";
    case "absent":
      return "absent";
    default:
      return "constraint";
  }
}

/** Tests an absent value passes without saying so: "value ≠ -666" plainly does, "value = 999" does not. */
const SILENT_ON_ABSENCE = new Set<Predicate["kind"]>(["ne", "notIn", "not", "absent", "anything"]);

/**
 * What an effect requires, about "value": "value = -666 (Not applicable)", "1 ≤ value ≤ 12 or
 * value is one of …". A variable some records lack may still be absent ("value = 999 (Missing)
 * or absent"): `properties` constrains only a value that is there.
 */
function effectText(test: Predicate, effect: { required: boolean; always?: true }, own: readonly string[], labelOf: (value: JsonValue) => string | undefined): string {
  if (test.kind === "anything") return effect.required ? "a value is required" : "no constraint";
  const simple = simplify(test, own);
  const others = untestedTypes(simple, own);
  const alternatives = [
    ...(others.length > 0 ? [`value is ${typeText(others)}`] : []),
    ...(!effect.required && !effect.always && !SILENT_ON_ABSENCE.has(test.kind) ? ["absent"] : [])
  ];
  const text = predicateText(simple, "value", labelOf, "effect", alternatives.length > 0 ? 2 : 0);
  if (effect.required) return test.kind === "absent" ? text : `${text} (required)`;
  return [text, ...alternatives].join(" or ");
}

/** A combination: "at least one of these holds: checking_owned = 1 (Yes), savings_owned = 1 (Yes)". */
function combinationText(condition: Condition, lookup: VariableLookup): string {
  if (condition.kind === "any") {
    const items = condition.parts.map((p) => conditionText(p, lookup, 1));
    return `${condition.exclusive ? "exactly one of these holds" : "at least one of these holds"}: ${items.join("; ")}`;
  }
  return conditionText(condition, lookup);
}

/** Operator precedence for parenthesising: 0 = top level, 1 = inside "and", 2 = inside "or"/"not". */
export function conditionText(condition: Condition, lookup: VariableLookup = NO_LOOKUP, level = 0): string {
  switch (condition.kind) {
    case "always":
      return "always";
    case "never":
      return "never";
    case "present":
      return `${condition.variable} is present`;
    case "unread":
      return `the record matches ${schemaText(condition.schema)}`;
    case "test": {
      const { variable } = condition;
      const own = lookup.types(variable);
      const test = simplify(condition.test, own);
      // A range tests only numbers and a pattern only strings: values of the variable's other
      // types pass. So does an absent value, when the test is optional.
      const others = untestedTypes(test, own);
      const alternatives = [...(others.length > 0 ? [`${variable} is ${typeText(others)}`] : []), ...(condition.optional ? [`${variable} is absent`] : [])];
      const text = predicateText(test, variable, (v) => lookup.label(variable, v), "condition", alternatives.length > 0 ? 2 : level);
      if (alternatives.length === 0) return text;
      const either = [text, ...alternatives].join(" or ");
      return level > 0 ? `(${either})` : either;
    }
    case "all": {
      const text = condition.parts.map((p) => conditionText(p, lookup, 1)).join(" and ");
      return level > 1 ? `(${text})` : text;
    }
    case "any": {
      const items = condition.parts.map((p) => conditionText(p, lookup, 2));
      const text = condition.exclusive ? `exactly one of: ${items.join("; ")}` : items.join(" or ");
      return level > 0 ? `(${text})` : text;
    }
    case "not": {
      // Level 2 parenthesises every compound condition; a single test is wrapped here.
      const inner = conditionText(condition.part, lookup, 2);
      return `not ${inner.startsWith("(") ? inner : `(${inner})`}`;
    }
  }
}

/** `test` without the `type` parts the variable's own type already implies ("an integer" of an integer variable). */
function simplify(test: Predicate, own: readonly string[]): Predicate {
  switch (test.kind) {
    case "all": {
      const parts = test.parts.map((p) => simplify(p, own)).filter((p) => !(p.kind === "type" && impliedType(p.types, own)));
      if (parts.length === 0) return test;
      return parts.length === 1 ? (parts[0] as Predicate) : { kind: "all", parts };
    }
    case "any":
      return { ...test, parts: test.parts.map((p) => simplify(p, own)) };
    case "not":
      return { kind: "not", part: simplify(test.part, own) };
    default:
      return test;
  }
}

/** Every type the variable allows is one of `types` (an integer is a number). */
function impliedType(types: readonly string[], own: readonly string[]): boolean {
  return own.length > 0 && own.every((t) => types.includes(t) || (t === "integer" && types.includes("number")));
}

/**
 * The variable's own types whose every value passes a test: a range tests only numbers, a
 * length, pattern or format only strings, so the values of its other types pass. A value passes
 * "and" when it passes each part, "or" when it passes one. None when the variable's types are
 * not known; a test that pins the value or its type lets no type through untested.
 */
function untestedTypes(test: Predicate, own: readonly string[]): string[] {
  switch (test.kind) {
    case "range":
    case "multipleOf":
      return own.filter((t) => t !== "number" && t !== "integer");
    case "length":
    case "pattern":
    case "format":
      return own.filter((t) => t !== "string");
    case "all": {
      const lists = test.parts.map((p) => untestedTypes(p, own));
      return own.filter((t) => lists.every((l) => l.includes(t)));
    }
    case "any": {
      const lists = test.parts.map((p) => untestedTypes(p, own));
      return own.filter((t) => lists.some((l) => l.includes(t)));
    }
    default:
      return [];
  }
}

/** Keywords as written, cut short: `{"minProperties":5}`. */
function schemaText(schema: JsonValue): string {
  const text = JSON.stringify(schema) ?? "";
  return text.length > MAX_SCHEMA_TEXT ? `${text.slice(0, MAX_SCHEMA_TEXT - 1)}…` : text;
}

/**
 * A predicate on `subject` in words. Conditions use set notation (`tenure ∈ {4, 5}`); effects,
 * which are about the row's own value, read as sentences (`value is one of 4, 5`).
 */
function predicateText(
  test: Predicate,
  subject: string,
  labelOf: (value: JsonValue) => string | undefined,
  mode: "condition" | "effect",
  level: number
): string {
  const one = (v: JsonValue, labelled = true): string => {
    const label = labelled ? labelOf(v) : undefined;
    // A count coded "0" = "0" gains nothing from its label.
    return label && label !== String(v) ? `${formatJsonValue(v)} (${label})` : formatJsonValue(v);
  };
  const many = (values: JsonValue[]): string => values.map((v) => one(v, values.length <= MAX_LABELLED_MEMBERS)).join(", ");
  switch (test.kind) {
    case "eq":
      return `${subject} = ${one(test.value)}`;
    case "ne":
      return `${subject} ≠ ${one(test.value)}`;
    case "in":
      return mode === "effect" ? `${subject} is one of ${many(test.values)}` : `${subject} ∈ {${many(test.values)}}`;
    case "notIn":
      return mode === "effect" ? `${subject} is not one of ${many(test.values)}` : `${subject} ∉ {${many(test.values)}}`;
    case "range":
      return rangeText(subject, test);
    case "length": {
      const { min, max } = test;
      if (min !== undefined && max !== undefined) return min === max ? `${subject} has exactly ${min} characters` : `${subject} has ${min}–${max} characters`;
      return min !== undefined ? `${subject} has at least ${min} characters` : `${subject} has at most ${max} characters`;
    }
    case "pattern":
      return `${subject} matches ${test.pattern}`;
    case "format":
      return `${subject} has the format ${formatLabel(test.format)}`;
    case "multipleOf":
      return `${subject} is a multiple of ${formatNumber(test.value)}`;
    case "type":
      return `${subject} is ${typeText(test.types)}`;
    case "absent":
      return `${subject} is absent`;
    case "anything":
      return `${subject} is present`;
    case "opaque":
      return test.schema === undefined ? `${subject} is constrained` : `${subject} matches ${schemaText(test.schema)}`;
    case "not":
      return `not (${predicateText(test.part, subject, labelOf, mode, 0)})`;
    case "all": {
      const text = test.parts.map((p) => predicateText(p, subject, labelOf, mode, 1)).join(" and ");
      return level > 1 ? `(${text})` : text;
    }
    case "any": {
      const items = test.parts.map((p) => predicateText(p, subject, labelOf, mode, 2));
      const text = test.exclusive && items.length > 1 ? `exactly one of: ${items.join("; ")}` : items.join(" or ");
      return level > 0 ? `(${text})` : text;
    }
  }
}

/** A numeric range on `subject`: "subject = 1", "1 ≤ subject ≤ 3", "subject ≥ 18", "subject < 5". */
function rangeText(subject: string, test: Extract<Predicate, { kind: "range" }>): string {
  const { min, max } = test;
  const lo = test.exclusiveMin ? "<" : "≤";
  const hi = test.exclusiveMax ? "<" : "≤";
  if (min !== undefined && max !== undefined) {
    return min === max && lo === "≤" && hi === "≤" ? `${subject} = ${formatNumber(min)}` : `${formatNumber(min)} ${lo} ${subject} ${hi} ${formatNumber(max)}`;
  }
  if (min !== undefined) return `${subject} ${lo === "<" ? ">" : "≥"} ${formatNumber(min)}`;
  return `${subject} ${hi} ${formatNumber(max as number)}`;
}

function typeText(types: string[]): string {
  const words = types.map((t) => (t === "null" ? "null" : t === "integer" ? "an integer" : t === "array" || t === "object" ? `an ${t}` : t === "boolean" ? "true or false" : `a ${t}`));
  return words.join(" or ");
}

/** Every variable a condition reads, in the order it names them, each once. */
export function variablesOf(condition: Condition): string[] {
  const out: string[] = [];
  const visit = (c: Condition): void => {
    switch (c.kind) {
      case "test":
      case "present":
        if (!out.includes(c.variable)) out.push(c.variable);
        break;
      case "all":
      case "any":
        c.parts.forEach(visit);
        break;
      case "not":
        visit(c.part);
        break;
      default:
        break;
    }
  };
  visit(condition);
  return out;
}

/** Render an `if` schema as a compact human condition, e.g. "parous = 1 and parity ≤ 2". */
export function describeCondition(ifSchema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext): string {
  return conditionText(readCondition(ifSchema, base, ctx, 0));
}

/**
 * Extract `Label (code)` pairs from a "Source coding"/skip-pattern `$comment`, e.g.
 * "... are Nonparous (777)" -> {"777": "Nonparous"}; "NA (777 / 7777)" maps both codes. The
 * label is the phrase after the last "is"/"are" ("OC duration/start/stop are NA never-user" ->
 * "NA never-user"), and a phrase of more than four words is no label.
 */
export function parseCodeLabels(comment: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /([A-Z][A-Za-z0-9/+\- ]*?)\s*\((\d{2,4}(?:\s*\/\s*\d{2,4})*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(comment)) !== null) {
    const label = match[1]?.split(/\s(?:is|are)\s/).pop()?.trim();
    const codes = match[2];
    if (!label || !codes || label.split(/\s+/).length > MAX_LABEL_WORDS) continue;
    for (const code of codes.split("/").map((c) => c.trim())) {
      if (code && !map.has(code)) map.set(code, label);
    }
  }
  return map;
}
