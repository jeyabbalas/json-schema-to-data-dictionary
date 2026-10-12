// Parse the row-object-level conditional logic that encodes structural missingness and
// questionnaire skip patterns: `if`/`then`/`else` blocks (commonly inside the items object's
// `allOf`), plus `dependentRequired` and `dependentSchemas`.
//
// Output is (1) dataset-level ConditionalRule[] for a "skip patterns" panel, and
// (2) a per-variable map the extractor uses to annotate the affected rows' valid values
// and constraints with the triggering condition.
//
// The same logic can live inside a nested object (a rule between the fields of every visit).
// The extractor then scans that object with its `path`, which names its property `fasting` by
// the nested row `visits[].fasting`, and merges the result into the table's. A rule can also
// reach into a value from outside: `"point": { "properties": { "tier": … } }` in an `if` tests
// the row `point.tier`, `"people": { "contains": … }` asks for an item of `people`, and `items`
// says what every item must be. Each of those tests holds, too, of a value that is not there
// to test -- a field of a null `point`, an item of a null list -- and the sentences say so.
//
// Reading happens in two steps. `collectSkipPatterns` turns each block into a small tree --
// the condition (`x = 1 and (y ≤ 0 or y is absent)`) and what each clause requires of each
// variable (`= -666`, `≠ -666`, `1 ≤ value ≤ 12 or one of …`, `at least one of …`) -- without
// rendering anything, because the words depend on the whole dictionary: a code reads with its
// label (`partner_present = 0 (No)`), and the labels are only known once every row is built.
// `renderSkipPatterns` then writes the sentences, given a lookup of those labels.
//
// A rule a value makes of itself (`"if": { "minimum": 500 }, "then": { "multipleOf": 5 }` in a
// property's own schema) is no skip pattern; `readValueRule` and `valueRuleText` put it into
// words for the analyzer, which lists it among the variable's constraints.

import type { ConditionalEffect, ConditionalEffectKind, ConditionalRule, JsonSchema, JsonSchemaObject, JsonValue, PathStep, SourceInfo } from "./types";
import type { ResolutionBase, SchemaRegistry } from "./registry";
import { formatLabel } from "./formats";
import { formatVariablePath } from "./paths";
import { asStringArray, formatJsonValue, formatNumber, isJsonSchema, isRecord, isSchemaObject, joinNonEmpty, jsonTypeOf, normalizeTypeArray, refKeyword, valueKey } from "./utils";

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
  /**
   * Variables the sentence names besides its condition's, by row name: the rest of a group one of
   * which must satisfy a rule, the object a field is required of, a position in a list (`days[0]`).
   */
  references?: string[] | undefined;
  /** `condition` combines tests ("a = 1 and b = 2", "a = 1 or a is absent"): joined with another, it needs parentheses. */
  compound?: boolean | undefined;
  /** The variable may also be absent under the condition ("value = 999 or absent"). */
  orAbsent?: true | undefined;
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
  /**
   * The JSON types the variable's own schema allows ("integer", "string", "null" …); empty when
   * it does not say. The types of a list's items are those of `<name>[]` (`counts[]`).
   */
  types(variable: string): readonly string[];
  /**
   * The row that holds the variable: its own, or one a position in a list has none of
   * (`days` for `days[0]`). Without it, every variable is taken to have a row of its own.
   */
  row?(variable: string): string;
}

const NO_LOOKUP: VariableLookup = { label: () => undefined, types: () => [] };

export interface SkipPatternContext {
  registry: SchemaRegistry;
  maxDepth: number;
  /**
   * Where the scanned object is: no steps for the row object, the steps to a nested one
   * (`visits[]`, `contact.address`). Its property `date` is then the row `visits[].date`, and a
   * test of the object itself (its type, its size) is a test of `visits[]`.
   */
  path?: readonly PathStep[] | undefined;
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
  /**
   * `tacit`: the tests beside it already say it in words ("age ≥ 70" is about a number), so the
   * sentence leaves it out; it still rules out the variable's other types.
   */
  | { kind: "type"; types: string[]; tacit?: true }
  /** How many items (a list) or properties (an object) the value has. */
  | { kind: "count"; of: "items" | "properties"; min?: number; max?: number }
  /** No two items are equal (`uniqueItems`). */
  | { kind: "unique" }
  /** An item satisfies `part` (`contains`); `min`/`max`: how many items must (`minContains`/`maxContains`). */
  | { kind: "contains"; part: Predicate; min?: number; max?: number }
  /** Every item satisfies `part` (`items`) -- from position `from` on, beside `prefixItems`. */
  | { kind: "every"; part: Predicate; from?: number }
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
  /**
   * An item of the list `variable` satisfies `element`, a condition on the item (named `item`,
   * `people[]`) and its fields (`people[].age`): `contains`, with `minContains`/`maxContains`.
   * `listOnly`: the condition requires a list, so a value that is not one (which passes
   * `contains`) is not a case of it.
   */
  | { kind: "some"; variable: string; item: string; element: Condition; min?: number; max?: number; listOnly?: true }
  /** Every item of the list `variable` satisfies `element` (`items`) -- from position `from` on, beside `prefixItems`. */
  | { kind: "every"; variable: string; item: string; element: Condition; listOnly?: true; from?: number }
  | { kind: "always" }
  | { kind: "never" }
  /** Keywords on the record this reader does not put into words (`minProperties`), as written. */
  | { kind: "unread"; schema: JsonValue };

/** What a clause requires of one variable. */
type ValueEffect = {
  kind: "value";
  variable: string;
  test: Predicate;
  required: boolean;
  always?: true;
  /** The object the variable is a field of, when it is nested: it is required there, of an object ("if point is an object"). */
  within?: string | undefined;
  comment?: string | undefined;
};

/** What one clause of a rule requires. */
export type RuleEffect =
  /**
   * Of one variable: its value satisfies `test`. `required`: the clause requires it present;
   * `always`: every record has it anyway. Otherwise it may also be absent.
   */
  | ValueEffect
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
  /**
   * The rule sits in a list's `items`: it holds of each item on its own, so its condition and
   * its effects are about the same item ("people[].name = null in the same item").
   */
  perItem?: true | undefined;
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
// Scope: which rows the scanned object's names stand for
// ---------------------------------------------------------------------------

const NO_PATH: readonly PathStep[] = [];
const NONE: ReadonlySet<string> = new Set();

/** The row name of `step` in the scanned object (`date` -> `visits[].date`; the record's fields keep their names). */
function nameIn(ctx: SkipPatternContext, step: PathStep): string {
  return formatVariablePath([...(ctx.path ?? NO_PATH), step]);
}

function field(ctx: SkipPatternContext, name: string): string {
  return nameIn(ctx, { kind: "property", name });
}

/** The scanned object's own name; undefined for the row object, which is the record itself. */
function selfOf(ctx: SkipPatternContext): string | undefined {
  return ctx.path && ctx.path.length > 0 ? formatVariablePath(ctx.path) : undefined;
}

/** The scope of what is inside a value: its fields are named under it, and none is known to be always there. */
function inside(ctx: SkipPatternContext, step: PathStep): SkipPatternContext {
  return { registry: ctx.registry, maxDepth: ctx.maxDepth, path: [...(ctx.path ?? NO_PATH), step], required: NONE };
}

/** The scanned object is an item of a list (`visits[]`, `a[].b`): what it says holds of each item on its own. */
function perItem(ctx: SkipPatternContext): boolean {
  return (ctx.path ?? NO_PATH).some((step) => step.kind === "items");
}

/** Said after a condition on the fields of one list item: the fields it sets are that item's. */
const SAME_ITEM = " in the same item";

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
    // bound inside a rule is its own. In a nested object, a rule about the object itself (its
    // size, its type) is one of its constraints, which the analyzer states; only a rule that
    // reaches its fields is a skip pattern.
    if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
      const fields = [schema.if, schema.then, schema.else].some((part) => isSchemaObject(part) && needsDescent(part, currentBase, ctx, 0));
      if (selfOf(ctx) === undefined || fields) rules.push(...readIfThen(schema, currentBase, ctx, undefined, 0));
    }

    if (isRecord(schema.dependentRequired)) dependencies.push(...readDependentRequired(schema.dependentRequired, ctx));
    if (isRecord(schema.dependentSchemas)) rules.push(...readDependentSchemas(schema.dependentSchemas, currentBase, ctx));
  };

  visit(itemSchema, base, 0);
  if (perItem(ctx)) for (const rule of rules) rule.perItem = true;
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
  const comment = joinComments([outerComment, commentOf(block)]);
  // The `if`'s comment says when it holds: it explains the `then`, not the `else`.
  const ifComment = conditionComment(block.if, base, ctx);
  const own = readCondition(block.if as JsonSchema, base, ctx, 0);
  const out: ParsedRule[] = [];
  const clause = (schema: JsonSchema | undefined, holds: boolean): void => {
    if (schema === undefined) return;
    const effects = readEffects(schema, base, ctx, 0);
    const relevant = withoutVacuous(own, effects);
    const condition = holds ? relevant : negate(relevant);
    const scoped = outer ? conjunction([outer, condition]) : condition;
    const clauseComment = joinComments([comment, holds ? ifComment : undefined, commentOf(schema)]);
    if (effects.length > 0) out.push({ condition: scoped, ...(clauseComment ? { comment: clauseComment } : {}), effects });
    out.push(...clauseRules(schema, base, ctx, scoped, nesting, clauseComment));
  };
  clause(block.then as JsonSchema | undefined, true);
  clause(block.else as JsonSchema | undefined, false);
  return out;
}

/**
 * The condition without the cases the effects say nothing of. `properties` passes a value that
 * is not an object, so a condition on a null `point`'s fields holds ("… or point is null"); but
 * when every effect is on a field inside `point`, a record whose point is not an object has none
 * of those fields to constrain (and "required if point is an object" asks nothing of it).
 */
function withoutVacuous(condition: Condition, effects: readonly RuleEffect[]): Condition {
  const targets: string[] = [];
  for (const effect of effects) {
    if (effect.kind !== "value") return condition;
    targets.push(effect.variable);
  }
  const holdsInside = (variable: string): boolean => targets.length > 0 && targets.every((t) => t.startsWith(`${variable}.`) || t.startsWith(`${variable}[`));
  const strip = (c: Condition): Condition => {
    if (c.kind === "all") return conjunction(c.parts.map(strip));
    if (c.kind !== "any" || c.exclusive) return c;
    return disjunction(c.parts.filter((p) => !(p.kind === "test" && isNotObject(p.test) && holdsInside(p.variable))).map(strip));
  };
  return strip(condition);
}

function isNotObject(test: Predicate): boolean {
  return test.kind === "not" && test.part.kind === "type" && test.part.types.length === 1 && test.part.types[0] === "object";
}

/**
 * The conditional rules inside a clause, which hold when the clause's condition does too: an
 * `if`/`then` block, `dependentRequired` ("when x is present, y is required") and `dependentSchemas`.
 */
function clauseRules(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, scoped: Condition, nesting: number, comment: string | undefined): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const nested of nestedBlocks(schema, base, ctx, 0)) out.push(...readIfThen(nested.schema, nested.base, ctx, scoped, nesting + 1, comment));
  if (!isSchemaObject(schema)) return out;
  if (isRecord(schema.dependentRequired)) {
    for (const [trigger, deps] of Object.entries(schema.dependentRequired)) {
      const effects: RuleEffect[] = asStringArray(deps).map((dep) => ({ kind: "value", variable: field(ctx, dep), test: { kind: "anything" }, required: true, ...withinOf(ctx) }));
      const condition = conjunction([scoped, { kind: "present", variable: field(ctx, trigger) }]);
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
  const out: DependencyFact[] = [];
  // In a list's items, the fields are the same item's.
  const scope = perItem(ctx) ? SAME_ITEM : "";
  for (const [trigger, deps] of Object.entries(dependentRequired)) {
    const names = asStringArray(deps).map((dep) => field(ctx, dep));
    if (names.length === 0) continue;
    const verb = names.length === 1 ? "is" : "are";
    const name = field(ctx, trigger);
    const condition = `${name} is present${scope}`;
    const triggers = [name];
    out.push({
      variable: name,
      fact: { condition, triggers, references: names, constraintText: `When ${name} is present, ${listText(names)} ${verb} also required${scope}.` }
    });
    for (const dep of names) out.push({ variable: dep, fact: { condition, triggers, constraintText: `Required when ${condition}.` } });
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] as string}` : items.join("");
}

/**
 * `dependentSchemas`: what each schema requires once its property is present, read like a `then`
 * (inside a clause, also under the clause's condition, `outer`).
 */
function readDependentSchemas(dependentSchemas: Record<string, unknown>, base: ResolutionBase, ctx: SkipPatternContext, outer?: Condition, nesting = 0): ParsedRule[] {
  if (nesting > ctx.maxDepth) return [];
  const out: ParsedRule[] = [];
  for (const [trigger, sub] of Object.entries(dependentSchemas)) {
    if (!isSchemaObject(sub) && sub !== true && sub !== false) continue;
    const present: Condition = { kind: "present", variable: field(ctx, trigger) };
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

/** An `if`'s `$comment`; for an `if` that only names a definition (`$ref`), the definition's. */
function conditionComment(schema: unknown, base: ResolutionBase, ctx: SkipPatternContext): string | undefined {
  const own = commentOf(schema);
  if (own !== undefined || !isSchemaObject(schema)) return own;
  const ref = refKeyword(schema);
  const loc = ref ? ctx.registry.resolve(ref, base) : undefined;
  return loc ? commentOf(loc.schema) : undefined;
}

/** A field the scanned object requires is required there: "within visits[]", not in the record. */
function withinOf(ctx: SkipPatternContext): { within?: string } {
  const self = selfOf(ctx);
  return self !== undefined ? { within: self } : {};
}

// ---------------------------------------------------------------------------
// Conditions (`if`)
// ---------------------------------------------------------------------------

/** The condition an `if` schema states, over the variables of the scanned object. */
function readCondition(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Condition {
  if (schema === true) return { kind: "always" };
  if (schema === false) return { kind: "never" };
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return { kind: "always" };
  const self = selfOf(ctx);
  const parts: Condition[] = [];

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) parts.push(readCondition(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1));
  }

  // A value inside the record is tested by its own keywords too: its type, a code, its size.
  const own = self !== undefined ? leafPredicate(schema, base, ctx, depth) : ({ kind: "anything" } as Predicate);
  if (self !== undefined && own.kind !== "anything") parts.push({ kind: "test", variable: self, test: own, optional: false });
  const forced = forcedTypes(own);

  // Its fields. `properties` and `required` test only an object: a value that is not one (a
  // null `point`) passes them -- which matters unless every field test passes absence anyway,
  // or the value must be an object.
  const fields = readFields(schema, base, ctx, depth);
  const object = forced !== undefined && forced.every((t) => t === "object");
  if (fields.kind !== "always") parts.push(self !== undefined && !object && !holdsWhenAbsent(fields) ? disjunction([fields, notType(self, "object")]) : fields);

  // Its items, when they have fields of their own, and its positions.
  if (self !== undefined) parts.push(...readItems(schema, base, ctx, depth, forced !== undefined && forced.every((t) => t === "array")));

  const unread = unreadKeywords(schema, self !== undefined ? NESTED_CONDITION_KEYS : CONDITION_KEYS);
  if (unread !== undefined) {
    parts.push(self !== undefined ? { kind: "test", variable: self, test: { kind: "opaque", schema: unread }, optional: false } : { kind: "unread", schema: unread });
  }

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

/** What `properties` and `required` say of the scanned object's fields. */
function readFields(schema: JsonSchemaObject, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Condition {
  const required = new Set(asStringArray(schema.required));
  // A property every record has is never absent: a test on it needs nothing more.
  const always = (name: string): boolean => ctx.required?.has(name) ?? false;
  const present = (name: string): Condition => (always(name) ? { kind: "always" } : { kind: "present", variable: field(ctx, name) });
  const parts: Condition[] = [];
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!isSchemaObject(sub) && typeof sub !== "boolean") continue;
      const variable = field(ctx, name);
      if (isSchemaObject(sub) && needsDescent(sub, base, ctx, depth + 1)) {
        // What is inside the value: tests of its own rows (`point.tier`). `properties` skips an
        // absent property, so they hold then too -- unless the `if` requires it.
        const inner = readCondition(sub, base, inside(ctx, { kind: "property", name }), depth + 1);
        if (required.has(name)) {
          if (!impliesPresent(inner, variable)) parts.push(present(name));
          parts.push(inner);
        } else parts.push(always(name) || holdsWhenAbsent(inner) ? inner : orAbsent(inner, variable));
        continue;
      }
      const test = readPredicate(sub as JsonSchema, base, ctx, depth + 1);
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
  return conjunction(parts);
}

/**
 * A list's items with fields of their own (`items`, `contains`), and its positions
 * (`prefixItems`). `list`: the value must be a list, so a value that is not one is no case.
 */
function readItems(schema: JsonSchemaObject, base: ResolutionBase, ctx: SkipPatternContext, depth: number, list: boolean): Condition[] {
  const self = selfOf(ctx) as string;
  const item = nameIn(ctx, { kind: "items" });
  const element = (sub: JsonSchema): Condition => readCondition(sub, base, inside(ctx, { kind: "items" }), depth + 1);
  const listOnly = list ? { listOnly: true as const } : {};
  const out: Condition[] = [];
  if (isSchemaObject(schema.items) && needsDescent(schema.items, base, ctx, depth + 1)) {
    out.push({ kind: "every", variable: self, item, element: element(schema.items), ...listOnly, ...positionsBefore(schema) });
  }
  if (isSchemaObject(schema.contains) && needsDescent(schema.contains, base, ctx, depth + 1)) {
    out.push({ kind: "some", variable: self, item, element: element(schema.contains), ...containsBounds(schema), ...listOnly });
  }
  if (Array.isArray(schema.prefixItems)) {
    const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
    schema.prefixItems.forEach((sub, index) => {
      if (!isJsonSchema(sub)) return;
      const variable = nameIn(ctx, { kind: "index", index });
      const inner = isSchemaObject(sub) && needsDescent(sub, base, ctx, depth + 1) ? readCondition(sub, base, inside(ctx, { kind: "index", index }), depth + 1) : testOf(variable, readPredicate(sub, base, ctx, depth + 1));
      // A list too short to have the position is not tested there -- unless it must be a list that long.
      const there = list && minItems > index;
      if (inner.kind !== "always") out.push(there || holdsWhenAbsent(inner) ? inner : orAbsent(inner, variable));
    });
  }
  return out;
}

/** Where `items` starts: after the positions `prefixItems` names, when it names any. */
function positionsBefore(schema: JsonSchemaObject): { from?: number } {
  return Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0 ? { from: schema.prefixItems.length } : {};
}

function containsBounds(schema: JsonSchemaObject): { min?: number; max?: number } {
  const min = typeof schema.minContains === "number" ? schema.minContains : undefined;
  const max = typeof schema.maxContains === "number" ? schema.maxContains : undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function testOf(variable: string, test: Predicate): Condition {
  return test.kind === "anything" ? { kind: "always" } : { kind: "test", variable, test, optional: false };
}

function notType(variable: string, type: string): Condition {
  return { kind: "test", variable, test: { kind: "not", part: { kind: "type", types: [type] } }, optional: false };
}

/** `inner`, or `variable` absent: a test of the variable itself reads "… or x is absent". */
function orAbsent(inner: Condition, variable: string): Condition {
  if (inner.kind === "test" && inner.variable === variable) return { ...inner, optional: true };
  return disjunction([inner, { kind: "test", variable, test: { kind: "absent" }, optional: false }]);
}

/**
 * Whether the condition holds of a record that lacks every variable it tests -- as one whose
 * object is absent or null lacks the object's fields.
 */
function holdsWhenAbsent(condition: Condition): boolean {
  switch (condition.kind) {
    case "always":
      return true;
    case "test":
      return condition.optional || condition.test.kind === "absent";
    case "all":
      return condition.parts.every(holdsWhenAbsent);
    case "any":
      return condition.parts.some(holdsWhenAbsent);
    default:
      return false;
  }
}

/**
 * The condition needs `variable` there: it tests the variable, or a field inside it, in a way an
 * absent value fails ("point.tier = 1" needs a point; "point is null" has one too).
 */
function impliesPresent(condition: Condition, variable: string): boolean {
  switch (condition.kind) {
    case "test":
    case "present": {
      const named = condition.variable === variable || condition.variable.startsWith(`${variable}.`) || condition.variable.startsWith(`${variable}[`);
      return named && (condition.kind === "present" || (!condition.optional && condition.test.kind !== "absent"));
    }
    case "all":
      return condition.parts.some((p) => impliesPresent(p, variable));
    case "any":
      return condition.parts.every((p) => impliesPresent(p, variable));
    case "some":
    case "every":
      return condition.variable === variable;
    default:
      return false;
  }
}

/** What a value must be for a row inside it to be there. */
type Shape = { type: "object" } | { type: "array"; length: number };

/**
 * What `variable` must be for `named`, a row inside it, to be there: an object for a field
 * (`point.tier`, `odd_keys["a.b"]`), a list at least `length` items long for a position (`days[0]`).
 */
function containerOf(variable: string, named: string): Shape | undefined {
  if (named.length <= variable.length || !named.startsWith(variable)) return undefined;
  const rest = named.slice(variable.length);
  if (rest.startsWith(".") || rest.startsWith('["')) return { type: "object" };
  const position = /^\[(\d+)\]/.exec(rest);
  return position ? { type: "array", length: Number(position[1]) + 1 } : undefined;
}

/** What the condition needs `variable` to be, by a test of a row inside it that an absent row fails. */
function shapeFrom(condition: Condition, variable: string): Shape | undefined {
  switch (condition.kind) {
    case "test":
      return !condition.optional && condition.test.kind !== "absent" ? containerOf(variable, condition.variable) : undefined;
    case "present":
      return containerOf(variable, condition.variable);
    case "some":
      return condition.variable === variable && condition.listOnly ? { type: "array", length: condition.min ?? 1 } : undefined;
    case "every":
      return condition.variable === variable && condition.listOnly ? { type: "array", length: 0 } : undefined;
    default:
      return undefined;
  }
}

/** The condition needs `variable` to be an object ("point.tier = 1" needs a point that is one). */
function impliesObject(condition: Condition, variable: string): boolean {
  switch (condition.kind) {
    case "test":
      if (condition.variable === variable) return !condition.optional && (forcedTypes(condition.test)?.every((t) => t === "object") ?? false);
      return shapeFrom(condition, variable)?.type === "object";
    case "present":
      return shapeFrom(condition, variable)?.type === "object";
    case "all":
      return condition.parts.some((p) => impliesObject(p, variable));
    case "any":
      return condition.parts.every((p) => impliesObject(p, variable));
    default:
      return false;
  }
}

/**
 * The condition without the tests that the tests beside them already imply: "point.tier = 1"
 * needs a point that is an object, "days[0] = 1" a list with a first item, and "people has an
 * item where …" a list -- so "point is an object and", "days is an array and days has at least 1
 * item and" and "people is an array and" say nothing more.
 */
function prune(condition: Condition): Condition {
  switch (condition.kind) {
    case "all": {
      const parts = condition.parts.map(prune);
      return conjunction(parts.filter((part, i) => !(part.kind === "test" && impliedShape(part, parts.filter((_, j) => j !== i)))));
    }
    case "any":
      return { ...condition, parts: condition.parts.map(prune) };
    case "not":
      return { kind: "not", part: prune(condition.part) };
    case "some":
    case "every":
      return { ...condition, element: prune(condition.element) };
    default:
      return condition;
  }
}

/** A test of a value's type and length only, which the other tests settle by needing a row inside it. */
function impliedShape(part: Extract<Condition, { kind: "test" }>, others: readonly Condition[]): boolean {
  if (part.optional) return false;
  const shapes: Shape[] = [];
  for (const other of others) {
    const shape = shapeFrom(other, part.variable);
    if (shape) shapes.push(shape);
  }
  if (shapes.length === 0) return false;
  const tests = part.test.kind === "all" ? part.test.parts : [part.test];
  return tests.every((t) => {
    if (t.kind === "type") return shapes.some((s) => t.types.includes(s.type));
    if (t.kind === "count" && t.of === "items" && t.min !== undefined && t.max === undefined) return shapes.some((s) => s.type === "array" && s.length >= (t.min as number));
    return false;
  });
}

/**
 * Two tests that cannot both hold: of the same variable, there, and of types or values that do
 * not meet ("shifty is an integer", "shifty is true or false").
 */
function exclusive(a: Condition, b: Condition): boolean {
  if (a.kind !== "test" || b.kind !== "test" || a.variable !== b.variable || a.optional || b.optional) return false;
  const ta = forcedTypes(a.test);
  const tb = forcedTypes(b.test);
  if (ta && tb && !ta.some((t) => tb.some((u) => t === u || (t === "integer" && u === "number") || (t === "number" && u === "integer")))) return true;
  const va = a.test.kind === "eq" ? [a.test.value] : a.test.kind === "in" ? a.test.values : undefined;
  const vb = b.test.kind === "eq" ? [b.test.value] : b.test.kind === "in" ? b.test.values : undefined;
  return va !== undefined && vb !== undefined && !va.some((v) => vb.some((w) => valueKey(v) === valueKey(w)));
}

/** The types a value that passes `test` can have, when the test settles them (`type`, a code). */
function forcedTypes(test: Predicate): string[] | undefined {
  switch (test.kind) {
    case "type":
      return test.types;
    case "eq":
      return [jsonTypeOf(test.value)];
    case "in":
      return [...new Set(test.values.map(jsonTypeOf))];
    case "all": {
      let out: string[] | undefined;
      for (const part of test.parts) {
        const types = forcedTypes(part);
        if (types) out = out ? out.filter((t) => types.includes(t) || (t === "integer" && types.includes("number"))) : types;
      }
      return out;
    }
    default:
      return undefined;
  }
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

/**
 * Whether a subschema says what is inside the value -- its fields (`properties`, `required`), its
 * positions (`prefixItems`), a rule of its own (`if`), or items with fields -- which a test of the
 * value alone cannot hold: it is read as tests of the rows inside it.
 */
function needsDescent(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): boolean {
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return false;
  if (isRecord(schema.properties) || Array.isArray(schema.required) || Array.isArray(schema.prefixItems) || schema.if !== undefined) return true;
  for (const key of ["items", "contains"] as const) {
    const sub = schema[key];
    if (isSchemaObject(sub) && needsDescent(sub, base, ctx, depth + 1)) return true;
  }
  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc && needsDescent(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1)) return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const list = schema[key];
    if (Array.isArray(list) && list.some((b) => needsDescent(b, base, ctx, depth + 1))) return true;
  }
  return schema.not !== undefined && needsDescent(schema.not, base, ctx, depth + 1);
}

function readPredicate(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Predicate {
  if (schema === true) return { kind: "anything" };
  if (schema === false) return { kind: "absent" };
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return { kind: "opaque" };
  const parts: Predicate[] = [];

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    parts.push(loc ? readPredicate(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1) : { kind: "opaque" });
  }
  const leaf = leafParts(schema, base, ctx, depth);
  parts.push(...leaf.parts);
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
  return combine(parts, leaf.typeOnly);
}

/** What a schema says of the value itself, without its combinators or what is inside it. */
function leafPredicate(schema: JsonSchemaObject, base: ResolutionBase, ctx: SkipPatternContext, depth: number): Predicate {
  const leaf = leafParts(schema, base, ctx, depth);
  return combine(leaf.parts, leaf.typeOnly);
}

function combine(parts: Predicate[], typeOnly: Predicate | undefined): Predicate {
  const meaningful: Predicate[] = parts.filter((p) => p.kind !== "anything");
  if (meaningful.length === 0) return typeOnly ?? { kind: "anything" };
  // A `type` beside a value or a set adds nothing ("an integer, one of 1, 2"). Beside a range it
  // may (an integer ≤ 50, of a number variable); the sentence drops it when the variable's own
  // type already says so.
  if (typeOnly && !meaningful.some((p) => p.kind === "eq" || p.kind === "in")) meaningful.unshift(typeOnly);
  return meaningful.length === 1 ? (meaningful[0] as Predicate) : { kind: "all", parts: meaningful };
}

/** The value's own keywords: a code or a set, a range, a length, a pattern, a format, a size, and items without fields. */
function leafParts(schema: JsonSchemaObject, base: ResolutionBase, ctx: SkipPatternContext, depth: number): { parts: Predicate[]; typeOnly?: Predicate } {
  const parts: Predicate[] = [];
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
  // A list's or an object's size, distinct items, and what the items are (when they have no fields to name).
  for (const [of, low, high] of [
    ["items", num(schema.minItems), num(schema.maxItems)],
    ["properties", num(schema.minProperties), num(schema.maxProperties)]
  ] as const) {
    if (low !== undefined || high !== undefined) parts.push({ kind: "count", of, ...(low !== undefined ? { min: low } : {}), ...(high !== undefined ? { max: high } : {}) });
  }
  if (schema.uniqueItems === true) parts.push({ kind: "unique" });
  if (isJsonSchema(schema.contains) && !needsDescent(schema.contains, base, ctx, depth + 1)) {
    parts.push({ kind: "contains", part: readPredicate(schema.contains, base, ctx, depth + 1), ...containsBounds(schema) });
  }
  if (Array.isArray(schema.items)) parts.push({ kind: "opaque", schema: { items: schema.items as JsonValue } });
  else if (isJsonSchema(schema.items) && !needsDescent(schema.items, base, ctx, depth + 1)) {
    const part = readPredicate(schema.items, base, ctx, depth + 1);
    // `items: false` allows no items beyond the positions `prefixItems` names.
    if (part.kind === "absent") parts.push({ kind: "count", of: "items", max: positionsBefore(schema).from ?? 0 });
    else if (part.kind !== "anything") parts.push({ kind: "every", part, ...positionsBefore(schema) });
  }
  const types = normalizeTypeArray(schema.type);
  return { parts, ...(types.length > 0 ? { typeOnly: { kind: "type", types } } : {}) };
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

/** What a schema says of the value itself (`leafParts`). */
const LEAF_KEYS = [
  "const",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "multipleOf",
  "type",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "items",
  "minProperties",
  "maxProperties",
  "enumDescriptions",
  "x-enumDescriptions"
];

/** What an `if` can say in words about a value inside the record: the value itself, its fields, items and positions. */
const NESTED_CONDITION_KEYS = new Set([...CONDITION_KEYS, ...LEAF_KEYS, "prefixItems"]);

/** What a clause can require in words; its `if`/`then` blocks and dependencies are rules of their own. */
const EFFECT_KEYS = new Set([...CONDITION_KEYS, "dependentRequired", "dependentSchemas"]);

/** What a clause of a rule inside a nested object can require of that object: also the object itself. */
const SCAN_EFFECT_KEYS = new Set([...EFFECT_KEYS, ...LEAF_KEYS, "prefixItems"]);

/**
 * What a clause can require of a value inside the record (`"point": { "required": ["x"] }` in a
 * `then`). A rule of its own there (`if`, `dependentRequired` …) is shown as written.
 */
const NESTED_EFFECT_KEYS = new Set([...[...CONDITION_KEYS].filter((k) => k !== "if" && k !== "then" && k !== "else"), ...LEAF_KEYS, "prefixItems"]);

const PREDICATE_KEYS = new Set(["$ref", "$dynamicRef", "not", "allOf", "anyOf", "oneOf", ...LEAF_KEYS]);

// ---------------------------------------------------------------------------
// Effects (`then` / `else` / a dependent schema)
// ---------------------------------------------------------------------------

/**
 * What a clause requires, variable by variable. `comment` is the `$comment` of the subschema
 * being read when it is not the clause itself (whose comment is the rule's): an `allOf` branch
 * explains the effects it contributes. `clause`: the schema is the clause or an `allOf`/`$ref` of
 * it, not a value inside the record that the clause reaches into.
 */
function readEffects(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth: number, comment?: string, clause = true): RuleEffect[] {
  if (schema === false) return [{ kind: "forbidden" }];
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return [];
  const self = selfOf(ctx);
  const out: RuleEffect[] = [];
  const byVariable = new Map<string, ValueEffect>();
  const effectFor = (variable: string, always: boolean): ValueEffect => {
    let effect = byVariable.get(variable);
    if (!effect) {
      effect = { kind: "value", variable, test: { kind: "anything" }, required: false, ...(always ? { always: true as const } : {}), ...(comment ? { comment } : {}) };
      byVariable.set(variable, effect);
      out.push(effect);
    }
    return effect;
  };
  const constrain = (effect: ValueEffect, test: Predicate, note?: string): void => {
    if (test.kind !== "anything") effect.test = effect.test.kind === "anything" ? test : { kind: "all", parts: [effect.test, test] };
    if (note && note !== effect.comment) effect.comment = effect.comment && note.includes(effect.comment) ? note : joinNonEmpty([effect.comment, note], " ");
  };
  // Effects read inside a value: what they require of the value itself joins this clause's
  // effect on it; what they require of the rows inside it is added as it is.
  const absorb = (effects: RuleEffect[], variable: string, always: boolean): void => {
    for (const effect of effects) {
      if (effect.kind !== "value" || effect.variable !== variable) {
        out.push(effect);
        continue;
      }
      const target = effectFor(variable, always);
      constrain(target, effect.test, effect.comment);
      if (effect.required) target.required = true;
    }
  };
  const withComment = comment ? { comment } : {};
  const noteOf = (sub: unknown): string | undefined => joinNonEmpty([comment, commentOf(sub)], " ") || undefined;

  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) out.push(...readEffects(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1, noteOf(loc.schema), clause));
  }
  // A value inside the record: what the clause says of the value itself (it is there to be tested).
  if (self !== undefined) constrain(effectFor(self, true), leafPredicate(schema, base, ctx, depth));
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (!isSchemaObject(sub) && typeof sub !== "boolean") continue;
      const variable = field(ctx, name);
      const always = ctx.required?.has(name) ?? false;
      if (isSchemaObject(sub) && needsDescent(sub, base, ctx, depth + 1)) {
        absorb(readEffects(sub, base, inside(ctx, { kind: "property", name }), depth + 1, noteOf(sub), false), variable, always);
        continue;
      }
      const test = readPredicate(sub as JsonSchema, base, ctx, depth + 1);
      if (test.kind === "anything") continue;
      constrain(effectFor(variable, always), test, commentOf(sub));
    }
  }
  for (const name of asStringArray(schema.required)) {
    const effect = effectFor(field(ctx, name), ctx.required?.has(name) ?? false);
    effect.required = true;
    if (self !== undefined) effect.within = self;
  }
  if (self !== undefined) {
    // Items with fields of their own: what each item's fields must be, and the item itself.
    const item = nameIn(ctx, { kind: "items" });
    const element = inside(ctx, { kind: "items" });
    if (isSchemaObject(schema.items) && needsDescent(schema.items, base, ctx, depth + 1)) {
      const after = positionsBefore(schema);
      if (after.from !== undefined) {
        // Beside `prefixItems`, `items` is about the items after those positions, not every item.
        const condition: Condition = { kind: "every", variable: self, item, element: readCondition(schema.items, base, element, depth + 1), ...after };
        out.push({ kind: "combination", condition, ...withComment });
      } else {
        for (const effect of readEffects(schema.items, base, element, depth + 1, comment, false)) {
          if (effect.kind === "value" && effect.variable === item) constrain(effectFor(self, true), { kind: "every", part: effect.test });
          else out.push(effect);
        }
      }
    }
    if (isSchemaObject(schema.contains) && needsDescent(schema.contains, base, ctx, depth + 1)) {
      const condition: Condition = { kind: "some", variable: self, item, element: readCondition(schema.contains, base, element, depth + 1), ...containsBounds(schema) };
      out.push({ kind: "combination", condition, ...withComment });
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((sub, index) => {
        if (!isJsonSchema(sub)) return;
        const variable = nameIn(ctx, { kind: "index", index });
        if (isSchemaObject(sub) && needsDescent(sub, base, ctx, depth + 1)) absorb(readEffects(sub, base, inside(ctx, { kind: "index", index }), depth + 1, comment, false), variable, false);
        else {
          const test = readPredicate(sub, base, ctx, depth + 1);
          if (test.kind !== "anything") constrain(effectFor(variable, false), test);
        }
      });
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) out.push(...readEffects(branch, base, ctx, depth + 1, noteOf(branch), clause));
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
  const unread = unreadKeywords(schema, !clause ? NESTED_EFFECT_KEYS : self !== undefined ? SCAN_EFFECT_KEYS : EFFECT_KEYS);
  if (unread !== undefined) {
    if (self !== undefined) constrain(effectFor(self, true), { kind: "opaque", schema: unread });
    else out.push({ kind: "unread", schema: unread, ...withComment });
  }
  return out.filter((e) => e.kind !== "value" || e.required || e.test.kind !== "anything");
}

/** The condition includes keywords this reader shows as written. */
function hasUnread(condition: Condition): boolean {
  switch (condition.kind) {
    case "unread":
      return true;
    case "test":
      return isOpaque(condition.test);
    case "all":
    case "any":
      return condition.parts.some(hasUnread);
    case "not":
      return hasUnread(condition.part);
    case "some":
    case "every":
      return hasUnread(condition.element);
    default:
      return false;
  }
}

function isOpaque(test: Predicate): boolean {
  switch (test.kind) {
    case "opaque":
      return true;
    case "all":
    case "any":
      return test.parts.some(isOpaque);
    case "not":
    case "contains":
    case "every":
      return isOpaque(test.part);
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
  const rowOf = (variable: string): string => lookup.row?.(variable) ?? variable;

  for (const rule of parsed.rules) {
    const resolved = prune(resolve(rule.condition, lookup));
    const ruleLookup = narrowed(resolved, rule.effects, lookup);
    // A rule in a list's items is about one item at a time.
    const scoped = rule.perItem === true && resolved.kind !== "always" && resolved.kind !== "never";
    const condition = scoped ? `${conditionText(resolved, ruleLookup, 2)}${SAME_ITEM}` : conditionText(resolved, ruleLookup);
    const triggers = [...new Set(variablesOf(resolved).map(rowOf))];
    const compound = isCompound(resolved) || scoped ? { compound: true } : {};
    noteUnread(resolved, unread);
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
        const together = prune(resolve(effect.condition, lookup));
        noteUnread(together, unread);
        const variables = variablesOf(together);
        const rows = [...new Set(variables.map(rowOf))];
        const requirement = combinationText(together, lookup);
        const comment = joinNonEmpty([rule.comment, effect.comment], " ") || undefined;
        for (const row of rows) {
          attach(row, {
            condition,
            triggers,
            ...compound,
            ...describe(comment),
            constraintText: sentence(condition, requirement),
            references: rows.filter((r) => r !== row)
          });
        }
        for (const variable of variables) effects.push({ variable, value: [], kind: "combination", text: requirement });
        continue;
      }
      const { variable, required } = effect;
      // A position in a list (`days[0]`) has no row of its own: its list's row names it.
      const row = rowOf(variable);
      const subject = row === variable ? "value" : variable;
      // `"type": "null"` sets the value as surely as `"const": null`, and reads the same.
      const test: Predicate = effect.test.kind === "type" && effect.test.types.length === 1 && effect.test.types[0] === "null" ? { kind: "eq", value: null } : effect.test;
      // "Required if point is an object" goes without saying when the condition needs a point.
      const within = effect.within !== undefined && !impliesObject(resolved, effect.within) ? effect.within : undefined;
      notePredicate(test, unread);
      // A code a rule sets reads with the variable's own label, as in its Valid values. A "Label
      // (code)" in the rule's comment names only a code the variable does not label itself: one
      // comment often covers several variables, which may give the same code different meanings.
      const own = (v: JsonValue): string | undefined => lookup.label(variable, v);
      const pinned = test.kind === "eq" ? test.value : test.kind === "in" ? test.values : undefined;
      const pinLabel = test.kind === "eq" ? own(test.value) ?? codeLabels.get(String(test.value)) : undefined;
      const presence = { required, ...(effect.always ? { always: true as const } : {}), within };
      // What the condition rules out goes without saying: "or value is null" of a list it needs.
      const types = typesAllowed(ruleLookup.types(variable), typesWhen(resolved, variable));
      const labelOf = (v: JsonValue): string | undefined => (test.kind === "eq" ? pinLabel : own(v));
      const requirement = effectText(test, presence, types, labelOf, ruleLookup.types(`${variable}[]`));
      const comment = joinNonEmpty([rule.comment, effect.comment], " ") || undefined;
      const orAbsent = mayBeAbsent(test, effect) ? { orAbsent: true as const } : {};
      // A value the rule sets is one of the row's own values -- not of a list it is one item of.
      const pin = row === variable ? { ...(pinned !== undefined ? { value: pinned } : {}), ...(pinLabel ? { label: pinLabel } : {}), ...orAbsent } : {};
      const references = [...(row !== variable ? [row] : []), ...(required && within !== undefined ? [rowOf(within)] : [])];
      attach(row, {
        condition,
        triggers,
        ...compound,
        ...describe(comment),
        ...pin,
        ...(references.length > 0 ? { references } : {}),
        constraintText: sentence(condition, subject === "value" ? requirement : effectText(test, presence, types, labelOf, ruleLookup.types(`${variable}[]`), subject))
      });
      const excludedLabel = test.kind === "ne" ? own(test.value) : undefined;
      effects.push({
        variable,
        // A rule can set a value to null: that is its value, not "no value".
        value: pinned !== undefined ? pinned : [],
        ...(pinLabel ? { label: pinLabel } : excludedLabel ? { label: excludedLabel } : {}),
        kind: effectKind(test, required),
        ...(test.kind === "ne" ? { excluded: [test.value] } : test.kind === "notIn" ? { excluded: test.values } : {}),
        ...(required ? { required: true as const, ...(within !== undefined ? { within } : {}) } : {}),
        ...orAbsent,
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
    case "some":
    case "every":
      noteUnread(condition.element, into);
      break;
    default:
      break;
  }
}

function notePredicate(test: Predicate, into: Set<string>): void {
  if (test.kind === "opaque" && isRecord(test.schema)) for (const key of Object.keys(test.schema)) into.add(key);
  else if (test.kind === "all" || test.kind === "any") for (const part of test.parts) notePredicate(part, into);
  else if (test.kind === "not" || test.kind === "contains" || test.kind === "every") notePredicate(test.part, into);
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

/** The effect constrains a variable some records may lack, and says so ("… or absent"). */
function mayBeAbsent(test: Predicate, effect: { required: boolean; always?: true }): boolean {
  return !effect.required && !effect.always && !SILENT_ON_ABSENCE.has(test.kind);
}

/**
 * What an effect requires, about "value" (or `subject`, a position in a list its list's row
 * names): "value = -666 (Not applicable)", "1 ≤ value ≤ 12 or value is one of …". A variable some
 * records lack may still be absent ("value = 999 (Missing) or absent"): `properties` constrains
 * only a value that is there. A requirement that it be there says whether null will do ("value
 * must be present (may be null)"); a field a nested object requires is required there, of an
 * object: "(required if point is an object)".
 */
function effectText(
  test: Predicate,
  effect: { required: boolean; always?: true; within?: string | undefined },
  own: readonly string[],
  labelOf: (value: JsonValue) => string | undefined,
  itemOwn: readonly string[] = [],
  subject = "value"
): string {
  const within = effect.within ? ` if ${effect.within} is an object` : "";
  if (test.kind === "anything") {
    if (!effect.required) return "no constraint";
    return `${subject} must be present${within}${own.includes("null") ? " (may be null)" : ""}`;
  }
  const simple = simplify(test, own);
  const others = untestedTypes(simple, own);
  const alternatives = [...(others.length > 0 ? [`${subject} is ${typeText(others)}`] : []), ...(mayBeAbsent(test, effect) ? ["absent"] : [])];
  const text = predicateText(simple, subject, labelOf, "effect", alternatives.length > 0 ? 2 : 0, itemOwn);
  if (effect.required) return test.kind === "absent" ? text : `${text} (required${within})`;
  return [text, ...alternatives].join(" or ");
}

/**
 * The types of `variable` a value can have while the condition holds: "people has at least 2
 * items where …" needs a list, "point.tier = 1" a point that is an object, "v is a number" a
 * number. Undefined when the condition does not settle them.
 */
function typesWhen(condition: Condition, variable: string): readonly string[] | undefined {
  switch (condition.kind) {
    case "test":
      if (condition.variable === variable) return forcedTypes(condition.test);
      return shapeTypes(shapeFrom(condition, variable));
    case "present":
    case "some":
    case "every":
      return shapeTypes(shapeFrom(condition, variable));
    case "all": {
      let out: readonly string[] | undefined;
      for (const part of condition.parts) {
        const types = typesWhen(part, variable);
        if (types) out = out ? typesAllowed(out, types) : types;
      }
      return out;
    }
    case "any": {
      const out: string[] = [];
      for (const part of condition.parts) {
        const types = typesWhen(part, variable);
        if (!types) return undefined;
        for (const t of types) if (!out.includes(t)) out.push(t);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function shapeTypes(shape: Shape | undefined): readonly string[] | undefined {
  return shape ? [shape.type] : undefined;
}

/** The `own` types among those `allowed` (an integer is a number), or all of them when nothing says. */
function typesAllowed(own: readonly string[], allowed: readonly string[] | undefined): readonly string[] {
  if (!allowed) return own;
  return own.filter((t) => allowed.includes(t) || (t === "integer" && allowed.includes("number")) || (t === "number" && allowed.includes("integer")));
}

/**
 * The lookup a rule about one variable alone is put into words with. A value of a type both its
 * condition and every effect let through untested ("at least 2 items" and "no repeated items"
 * pass a null list) is free either way: the sentence leaves that type out of both sides, as the
 * rule a value makes of itself does.
 */
function narrowed(condition: Condition, effects: readonly RuleEffect[], lookup: VariableLookup): VariableLookup {
  if (condition.kind !== "test" || effects.length === 0) return lookup;
  const { variable } = condition;
  const own = lookup.types(variable);
  let free = untestedTypes(simplify(condition.test, own), own);
  for (const effect of effects) {
    if (effect.kind !== "value" || effect.variable !== variable) return lookup;
    const passes = untestedTypes(simplify(effect.test, own), own);
    free = free.filter((t) => passes.includes(t));
  }
  if (free.length === 0) return lookup;
  const rest = own.filter((t) => !free.includes(t));
  return { label: (v, value) => lookup.label(v, value), types: (v) => (v === variable ? rest : lookup.types(v)) };
}

/** A combination: "at least one of these holds: checking_owned = 1 (Yes), savings_owned = 1 (Yes)". */
function combinationText(condition: Condition, lookup: VariableLookup): string {
  if (condition.kind === "any") {
    const items = condition.parts.map((p) => conditionText(p, lookup, 1));
    return `${condition.exclusive ? "exactly one of these holds" : "at least one of these holds"}: ${items.join("; ")}`;
  }
  return conditionText(condition, lookup);
}

/** Inside a plain "or", where another "or" needs no parentheses: "a or b or c". */
const IN_OR = 3;

/**
 * Operator precedence for parenthesising: 0 = top level, 1 = inside "and", 2 = inside "not", a
 * "where" clause or an "exactly one of" list, `IN_OR` = inside "or". `alias` renames a variable
 * in the text: the item a "where" clause is about reads "item".
 */
export function conditionText(condition: Condition, lookup: VariableLookup = NO_LOOKUP, level = 0, alias?: ReadonlyMap<string, string>): string {
  const display = (variable: string): string => alias?.get(variable) ?? variable;
  // "a or b" needs parentheses inside "and" or "not", not at the top or inside another "or".
  const group = (text: string): string => (level === 1 || level === 2 ? `(${text})` : text);
  switch (condition.kind) {
    case "always":
      return "always";
    case "never":
      return "never";
    case "present":
      return `${display(condition.variable)} is present`;
    case "unread":
      return `the record matches ${schemaText(condition.schema)}`;
    case "test": {
      const { variable } = condition;
      const subject = display(variable);
      const own = lookup.types(variable);
      const test = simplify(condition.test, own);
      // A range tests only numbers and a pattern only strings: values of the variable's other
      // types pass. So does an absent value, when the test is optional.
      const others = untestedTypes(test, own);
      const alternatives = [...(others.length > 0 ? [`${subject} is ${typeText(others)}`] : []), ...(condition.optional ? [`${subject} is absent`] : [])];
      const text = predicateText(test, subject, (v) => lookup.label(variable, v), "condition", alternatives.length > 0 ? 2 : level, lookup.types(`${variable}[]`));
      if (alternatives.length === 0) return text;
      return group([text, ...alternatives].join(" or "));
    }
    case "all": {
      const text = condition.parts.map((p) => conditionText(p, lookup, 1, alias)).join(" and ");
      return level > 1 ? `(${text})` : text;
    }
    case "any": {
      if (condition.exclusive) {
        const text = `exactly one of: ${condition.parts.map((p) => conditionText(p, lookup, 2, alias)).join("; ")}`;
        return level > 0 ? `(${text})` : text;
      }
      return group(condition.parts.map((p) => conditionText(p, lookup, IN_OR, alias)).join(" or "));
    }
    case "not": {
      // Level 2 parenthesises every compound condition; a single test is wrapped here.
      const inner = conditionText(condition.part, lookup, 2, alias);
      return `not ${inner.startsWith("(") ? inner : `(${inner})`}`;
    }
    case "some":
    case "every": {
      // "people has an item where (people[].age ≥ 65 or people[].age is null)". `contains` and
      // `items` test only a list: a null `people` passes them.
      const subject = display(condition.variable);
      const inner = conditionText(condition.element, lookup, 2, new Map([...(alias ?? []), [condition.item, "item"]]));
      const phrase = condition.kind === "every" ? `${subject} has only items where ${inner}${fromText(subject, condition.from)}` : `${subject} has ${quantity(condition.min, condition.max)} where ${inner}`;
      const others = condition.listOnly ? [] : lookup.types(condition.variable).filter((t) => t !== "array");
      return others.length === 0 ? phrase : group(`${phrase} or ${subject} is ${typeText(others)}`);
    }
  }
}

/**
 * The condition as far as the variables' own types settle it: "point is not an object" is
 * "point is null" of a point that is an object or null, and cannot happen of one that is
 * always an object.
 */
function resolve(condition: Condition, lookup: VariableLookup): Condition {
  switch (condition.kind) {
    case "test": {
      const { test } = condition;
      if (test.kind !== "not" || test.part.kind !== "type") return condition;
      const own = lookup.types(condition.variable);
      if (own.length === 0) return condition;
      const ruled = test.part.types;
      const rest = own.filter((t) => !ruled.includes(t) && !(t === "integer" && ruled.includes("number")));
      return rest.length === 0 ? { kind: "never" } : { ...condition, test: { kind: "type", types: rest } };
    }
    case "all":
      return conjunction(condition.parts.map((p) => resolve(p, lookup)));
    case "any": {
      const parts = condition.parts.map((p) => resolve(p, lookup));
      if (!condition.exclusive) return disjunction(parts);
      const kept = parts.filter((p) => p.kind !== "never");
      if (kept.length === 0) return { kind: "never" };
      if (kept.length === 1) return kept[0] as Condition;
      // Of tests that cannot hold together, one holds when any does: "or" says as much.
      if (!kept.every((p, i) => kept.every((q, j) => i === j || exclusive(p, q)))) return { kind: "any", parts: kept, exclusive: true };
      return sameTypeTest(kept) ?? disjunction(kept);
    }
    case "not": {
      const part = resolve(condition.part, lookup);
      return part.kind === "always" ? { kind: "never" } : part.kind === "never" ? { kind: "always" } : { kind: "not", part };
    }
    case "some":
    case "every":
      return { ...condition, element: resolve(condition.element, lookup) };
    default:
      return condition;
  }
}

/** Type tests of one variable, as one: "shifty is an integer or true or false". */
function sameTypeTest(parts: readonly Condition[]): Condition | undefined {
  const first = parts[0];
  if (first?.kind !== "test") return undefined;
  const types: string[] = [];
  for (const part of parts) {
    if (part.kind !== "test" || part.variable !== first.variable || part.optional || part.test.kind !== "type") return undefined;
    for (const t of part.test.types) if (!types.includes(t)) types.push(t);
  }
  return { kind: "test", variable: first.variable, test: { kind: "type", types }, optional: false, ...(first.always ? { always: true as const } : {}) };
}

/**
 * `test` without the `type` parts the variable's own type already implies ("an integer" of an
 * integer variable); the opposite of a range, of a variable that is only ever a number, as the
 * range it leaves ("id < 12" for "not (id ≥ 12)"). A `type` part the tests beside it say in
 * words ("age ≥ 70" is about a number) is kept, unsaid: it still rules out a null age.
 */
function simplify(test: Predicate, own: readonly string[]): Predicate {
  switch (test.kind) {
    case "all": {
      const parts = test.parts.map((p) => simplify(p, own)).filter((p) => !(p.kind === "type" && impliedType(p.types, own)));
      if (parts.length === 0) return test;
      if (parts.length === 1) return parts[0] as Predicate;
      return { kind: "all", parts: parts.map((p) => (p.kind === "type" && saidBy(p.types, parts, own) ? { ...p, tacit: true as const } : p)) };
    }
    case "any":
      return { ...test, parts: test.parts.map((p) => simplify(p, own)) };
    case "not": {
      const part = simplify(test.part, own);
      if (part.kind === "range" && own.length > 0 && own.every((t) => t === "integer" || t === "number")) return complement(part);
      return { kind: "not", part };
    }
    default:
      return test;
  }
}

/** The numbers outside a range: "x < 12" for "x ≥ 12", "x < 1 or x > 5" for "1 ≤ x ≤ 5". */
function complement(test: Extract<Predicate, { kind: "range" }>): Predicate {
  const below: Predicate | undefined = test.min !== undefined ? { kind: "range", max: test.min, ...(test.exclusiveMin ? {} : { exclusiveMax: true }) } : undefined;
  const above: Predicate | undefined = test.max !== undefined ? { kind: "range", min: test.max, ...(test.exclusiveMax ? {} : { exclusiveMin: true }) } : undefined;
  if (below && above) return { kind: "any", parts: [below, above] };
  return below ?? above ?? test;
}

/** What a test that is about one kind of value tests: numbers for a range, strings for a pattern, lists for a size. */
function familyOf(test: Predicate): readonly string[] | undefined {
  switch (test.kind) {
    case "range":
    case "multipleOf":
      return ["number", "integer"];
    case "length":
    case "pattern":
    case "format":
      return ["string"];
    case "count":
      return [test.of === "items" ? "array" : "object"];
    case "unique":
    case "contains":
    case "every":
      return ["array"];
    default:
      return undefined;
  }
}

/**
 * A `type` among `parts` that another part says in words: "≥ 70" is about a number, so "is an
 * integer" adds nothing of a variable whose numbers are integers -- but it does of one whose
 * numbers need not be.
 */
function saidBy(types: readonly string[], parts: readonly Predicate[], own: readonly string[]): boolean {
  if (own.length === 0) return false;
  return parts.some((p) => {
    const family = familyOf(p);
    if (!family || !types.every((t) => family.includes(t))) return false;
    return own.filter((t) => family.includes(t)).every((t) => types.includes(t) || (t === "integer" && types.includes("number")));
  });
}

/** Every type the variable allows is one of `types` (an integer is a number). */
function impliedType(types: readonly string[], own: readonly string[]): boolean {
  return own.length > 0 && own.every((t) => types.includes(t) || (t === "integer" && types.includes("number")));
}

/**
 * The variable's own types whose every value passes a test: a range tests only numbers, a
 * length, pattern or format only strings, a list's size and items only a list, an object's
 * size only an object -- so the values of its other types pass. A value passes "and" when it
 * passes each part, "or" when it passes one. None when the variable's types are not known; a
 * test that pins the value or its type lets no type through untested.
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
    case "count":
      return own.filter((t) => t !== (test.of === "items" ? "array" : "object"));
    case "unique":
    case "contains":
    case "every":
      return own.filter((t) => t !== "array");
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
 * which are about the row's own value, read as sentences (`value is one of 4, 5`). `itemOwn`:
 * the types of the list's items, which say what passes a test of each item.
 */
function predicateText(
  test: Predicate,
  subject: string,
  labelOf: (value: JsonValue) => string | undefined,
  mode: "condition" | "effect",
  level: number,
  itemOwn: readonly string[] = []
): string {
  const one = (v: JsonValue, labelled = true): string => {
    const label = labelled ? labelOf(v) : undefined;
    // A count coded "0" = "0" gains nothing from its label.
    return label && label !== String(v) ? `${formatJsonValue(v)} (${label})` : formatJsonValue(v);
  };
  const many = (values: JsonValue[]): string => values.map((v) => one(v, values.length <= MAX_LABELLED_MEMBERS)).join(", ");
  // What each item must be: "item ≤ 999", or "(item ≤ 999 or item is null)" of nullable items.
  const itemText = (part: Predicate): string => {
    const simple = simplify(part, itemOwn);
    const others = untestedTypes(simple, itemOwn);
    const text = predicateText(simple, "item", labelOf, mode, 2);
    return others.length > 0 ? `(${text} or item is ${typeText(others)})` : text;
  };
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
      const chars = (n: number): string => (n === 1 ? "1 character" : `${n} characters`);
      if (min !== undefined && max !== undefined) return min === max ? `${subject} has exactly ${chars(min)}` : `${subject} has ${min}–${max} characters`;
      return min !== undefined ? `${subject} has at least ${chars(min)}` : `${subject} has at most ${chars(max as number)}`;
    }
    case "pattern":
      return `${subject} matches ${test.pattern}`;
    case "format":
      return `${subject} has the format ${formatLabel(test.format)}`;
    case "multipleOf":
      return `${subject} is a multiple of ${formatNumber(test.value)}`;
    case "type":
      return `${subject} is ${typeText(test.types)}`;
    case "count":
      return `${subject} has ${countText(test)}`;
    case "unique":
      return `${subject} has no repeated items`;
    case "contains":
      if (test.min === undefined && test.max === undefined && (test.part.kind === "eq" || test.part.kind === "in")) {
        return test.part.kind === "eq" ? `${subject} includes ${one(test.part.value)}` : `${subject} includes one of ${many(test.part.values)}`;
      }
      return `${subject} has ${quantity(test.min, test.max)} where ${itemText(test.part)}`;
    case "every":
      return `${subject} has only items where ${itemText(test.part)}${fromText(subject, test.from)}`;
    case "absent":
      return `${subject} is absent`;
    case "anything":
      return `${subject} is present`;
    case "opaque":
      return test.schema === undefined ? `${subject} is constrained` : `${subject} matches ${schemaText(test.schema)}`;
    case "not":
      if (test.part.kind === "type") return `${subject} is not ${typeText(test.part.types)}`;
      return `not (${predicateText(test.part, subject, labelOf, mode, 0, itemOwn)})`;
    case "all": {
      const shown = test.parts.filter((p) => !(p.kind === "type" && p.tacit));
      if (shown.length === 1) return predicateText(shown[0] as Predicate, subject, labelOf, mode, level, itemOwn);
      const text = shown.map((p) => predicateText(p, subject, labelOf, mode, 1, itemOwn)).join(" and ");
      return level > 1 ? `(${text})` : text;
    }
    case "any": {
      const items = test.parts.map((p) => predicateText(p, subject, labelOf, mode, 2, itemOwn));
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

/** "at least 2 items", "no properties", "1–3 items", "exactly 2 items". */
function countText(test: Extract<Predicate, { kind: "count" }>): string {
  const unit = (n: number): string => (test.of === "items" ? (n === 1 ? "item" : "items") : n === 1 ? "property" : "properties");
  const { min, max } = test;
  if (min !== undefined && max !== undefined) return min === max ? `exactly ${min} ${unit(min)}` : `${min}–${max} ${unit(max)}`;
  if (min !== undefined) return `at least ${min} ${unit(min)}`;
  return max === 0 ? `no ${unit(0)}` : `at most ${max} ${unit(max as number)}`;
}

/** Where an `items` beside `prefixItems` starts: " from days[2] on". */
function fromText(subject: string, from: number | undefined): string {
  return from ? ` from ${subject}[${from}] on` : "";
}

/** How many items a `contains` asks for: "an item", "at least 2 items", "no item". */
function quantity(min: number | undefined, max: number | undefined): string {
  const items = (n: number): string => (n === 1 ? "1 item" : `${n} items`);
  if (min !== undefined && max !== undefined) return min === max ? `exactly ${items(min)}` : `${min}–${max} items`;
  if (max !== undefined) return max === 0 ? "no item" : `at most ${items(max)}`;
  if (min !== undefined && min !== 1) return min === 0 ? "any number of items" : `at least ${items(min)}`;
  return "an item";
}

function typeText(types: string[]): string {
  const words = types.map((t) => (t === "null" ? "null" : t === "integer" ? "an integer" : t === "array" || t === "object" ? `an ${t}` : t === "boolean" ? "true or false" : `a ${t}`));
  return words.join(" or ");
}

/** Every variable a condition reads, in the order it names them, each once (an item a "where" clause is about is its list's). */
export function variablesOf(condition: Condition): string[] {
  const out: string[] = [];
  const visit = (c: Condition, skip: ReadonlySet<string>): void => {
    switch (c.kind) {
      case "test":
      case "present":
        if (!skip.has(c.variable) && !out.includes(c.variable)) out.push(c.variable);
        break;
      case "all":
      case "any":
        for (const part of c.parts) visit(part, skip);
        break;
      case "not":
        visit(c.part, skip);
        break;
      case "some":
      case "every":
        if (!skip.has(c.variable) && !out.includes(c.variable)) out.push(c.variable);
        visit(c.element, new Set([...skip, c.item]));
        break;
      default:
        break;
    }
  };
  visit(condition, new Set());
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

// ---------------------------------------------------------------------------
// Rules a value makes of itself
// ---------------------------------------------------------------------------

/** An `if`/`then`/`else` in a property's own schema: "When value ≥ 500, value is a multiple of 5." */
export interface ValueRule {
  condition: Predicate;
  then?: Predicate | undefined;
  otherwise?: Predicate | undefined;
  comment?: string | undefined;
  /** The types of the union branch the rule came from: it holds only for a value of those types. */
  branch?: string[] | undefined;
}

/**
 * The rule of an `if`/`then`/`else` block about the value itself; undefined when it reaches
 * inside the value (the fields of an object), which the extractor reads as a skip pattern.
 */
export function readValueRule(block: JsonSchemaObject, base: ResolutionBase, registry: SchemaRegistry, maxDepth: number, comment?: string): ValueRule | undefined {
  const ctx: SkipPatternContext = { registry, maxDepth };
  if ([block.if, block.then, block.else].some((part) => isSchemaObject(part) && needsDescent(part, base, ctx, 0))) return undefined;
  const read = (schema: unknown): Predicate | undefined => (isJsonSchema(schema) ? readPredicate(schema, base, ctx, 0) : undefined);
  const condition = read(block.if) ?? { kind: "anything" };
  const then = read(block.then);
  const otherwise = read(block.else);
  const note = joinComments([comment, commentOf(block.if), commentOf(block.then), commentOf(block.else)]);
  return { condition, ...(then ? { then } : {}), ...(otherwise ? { otherwise } : {}), ...(note ? { comment: note } : {}) };
}

/**
 * A value rule in words, about "value" (an item's rule is hoisted with "Each item: " before it).
 * A rule from one branch of a union says which values it is about ("value is an integer and …").
 */
export function valueRuleText(rule: ValueRule, own: readonly string[], itemOwn: readonly string[], labelOf: (value: JsonValue) => string | undefined): string {
  const branch = rule.branch && rule.branch.length > 0 && !(rule.branch.length === own.length && rule.branch.every((t) => own.includes(t))) ? rule.branch : undefined;
  const test: Predicate = branch ? { kind: "all", parts: [{ kind: "type", types: branch }, rule.condition] } : rule.condition;
  const simple = simplify(test, own);
  // The `then` is about the values that pass the condition ("when value is a string": strings
  // only). A value of a type neither side tests (a null, of "≥ 500 → a multiple of 5") passes
  // both: the rule says nothing of it, so neither side mentions it.
  const reach = admittedTypes(simple, own);
  const silent = new Set(untestedTypes(simple, own).filter((t) => rule.then !== undefined && untestedTypes(simplify(rule.then, reach), reach).includes(t)));
  const others = untestedTypes(simple, own).filter((t) => !silent.has(t));
  const condition = [predicateText(simple, "value", labelOf, "condition", others.length > 0 ? 2 : 0, itemOwn), ...(others.length > 0 ? [`value is ${typeText(others)}`] : [])].join(" or ");
  const clause = (effect: Predicate | undefined, types: readonly string[]): string | undefined => {
    if (effect === undefined || effect.kind === "anything") return undefined;
    if (effect.kind === "absent") return "the value is not allowed";
    return effectText(effect, { required: false, always: true }, types, labelOf, itemOwn);
  };
  const then = clause(rule.then, reach.filter((t) => !silent.has(t)));
  // The `else` is about the values that fail the condition: not those of a type it lets through
  // untested, nor -- when it only asks for a type -- those of that type.
  const passes = new Set([...untestedTypes(simple, own), ...(simple.kind === "type" ? reach : [])]);
  const otherwise = clause(rule.otherwise, (branch ?? own).filter((t) => !passes.has(t)));
  if (rule.condition.kind === "anything") return then ? `${capitalize(then)}.` : "";
  if (then && otherwise) return `When ${condition}, ${then}; otherwise, ${otherwise}.`;
  if (then) return `When ${condition}, ${then}.`;
  return otherwise ? `Unless ${condition}, ${otherwise}.` : "";
}

/** The types of `own` a value that passes `test` can have. */
function admittedTypes(test: Predicate, own: readonly string[]): string[] {
  const forced = forcedTypes(test);
  if (!forced) return [...own];
  return own.filter((t) => forced.includes(t) || (t === "integer" && forced.includes("number")) || (t === "number" && forced.includes("integer")));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
