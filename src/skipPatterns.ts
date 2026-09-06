// Parse the row-object-level conditional logic that encodes structural missingness and
// questionnaire skip patterns: `if`/`then` blocks (commonly inside the items object's
// `allOf`), plus `dependentRequired` and `dependentSchemas`.
//
// Output is (1) dataset-level ConditionalRule[] for a "skip patterns" panel, and
// (2) a per-variable map the extractor uses to annotate the affected rows' valid values
// and constraints with the triggering condition.
//
// The same logic can live inside a nested object (a rule between the fields of every visit).
// The extractor then scans that object with `qualify` mapping its property names to the
// nested rows' names (`fasting` -> `visits[].fasting`), and merges the result into the table's.

import type { ConditionalEffect, ConditionalRule, JsonSchema, JsonSchemaObject, JsonValue, SourceInfo } from "./types";
import type { ResolutionBase, SchemaRegistry } from "./registry";
import { refKeyword } from "./analyze";
import { asStringArray, formatJsonValue, isRecord, isSchemaObject } from "./utils";

/** A single conditional fact attached to one variable's row. */
export interface VariableConditional {
  /** Human trigger, e.g. "parous = 0". */
  condition: string;
  /** Authoring prose for the rule (block `$comment`). */
  description?: string | undefined;
  /** Forced value (`const`) or allowed set (`enum`) under the condition, if any. */
  value?: JsonValue | JsonValue[] | undefined;
  /** Best-effort human label for the forced value (parsed from the `$comment`). */
  label?: string | undefined;
  /** Ready-to-show constraint sentence. */
  constraintText: string;
  source?: SourceInfo | undefined;
}

export interface SkipPatternResult {
  rules: ConditionalRule[];
  byVariable: Map<string, VariableConditional[]>;
}

export interface SkipPatternContext {
  registry: SchemaRegistry;
  maxDepth: number;
  /**
   * Maps a property name of the object being scanned to the name of its row. Nested objects
   * pass the path prefix (`date` -> `visits[].date`); the row object needs nothing.
   */
  qualify?: ((name: string) => string) | undefined;
}

export function collectSkipPatterns(itemSchema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext): SkipPatternResult {
  const rules: ConditionalRule[] = [];
  const byVariable = new Map<string, VariableConditional[]>();
  const visited = new Set<string>();

  const attach = (variable: string, vc: VariableConditional): void => {
    const list = byVariable.get(variable) ?? [];
    list.push(vc);
    byVariable.set(variable, list);
  };

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

    if (schema.if !== undefined && (schema.then !== undefined || schema.else !== undefined)) {
      handleIfThen(schema, currentBase, ctx, attach, rules);
    }

    if (isRecord(schema.dependentRequired)) {
      handleDependentRequired(schema.dependentRequired, ctx, attach);
    }
    if (isRecord(schema.dependentSchemas)) {
      handleDependentSchemas(schema.dependentSchemas, currentBase, ctx, attach);
    }
  };

  visit(itemSchema, base, 0);
  return { rules, byVariable };
}

/**
 * Append the rules and per-variable facts of `from` to `into`, skipping any already there. The
 * same nested object can be scanned twice (a parent declared by two `allOf` branches), and a
 * repeated rule would badge a value with the same condition twice.
 */
export function mergeSkipPatterns(into: SkipPatternResult, from: SkipPatternResult): void {
  const ruleKey = (r: ConditionalRule): string => JSON.stringify([r.condition, r.description ?? null, r.effects]);
  const seenRules = new Set(into.rules.map(ruleKey));
  for (const rule of from.rules) {
    const key = ruleKey(rule);
    if (seenRules.has(key)) continue;
    seenRules.add(key);
    into.rules.push(rule);
  }
  const factKey = (vc: VariableConditional): string => JSON.stringify([vc.condition, vc.constraintText, vc.value ?? null]);
  for (const [variable, facts] of from.byVariable) {
    const list = into.byVariable.get(variable) ?? [];
    const seen = new Set(list.map(factKey));
    for (const fact of facts) {
      const key = factKey(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(fact);
    }
    into.byVariable.set(variable, list);
  }
}

const identity = (name: string): string => name;

function handleIfThen(
  block: JsonSchemaObject,
  base: ResolutionBase,
  ctx: SkipPatternContext,
  attach: (variable: string, vc: VariableConditional) => void,
  rules: ConditionalRule[]
): void {
  const q = ctx.qualify ?? identity;
  const comment = typeof block.$comment === "string" ? block.$comment : undefined;
  const codeLabels = comment ? parseCodeLabels(comment) : new Map<string, string>();

  const apply = (clause: JsonSchema | undefined, condition: string): ConditionalEffect[] => {
    if (clause === undefined || !isSchemaObject(clause)) return [];
    const effects: ConditionalEffect[] = [];
    for (const [property, sub] of thenProperties(clause, base, ctx)) {
      const variable = q(property);
      const forced = forcedValue(sub);
      const label = labelForForced(forced, codeLabels);
      const constraintText = constraintTextFor(condition, forced, label);
      attach(variable, {
        condition,
        ...(comment ? { description: comment } : {}),
        ...(forced !== undefined ? { value: forced } : {}),
        ...(label ? { label } : {}),
        constraintText
      });
      if (forced !== undefined) effects.push({ variable, value: forced, ...(label ? { label } : {}) });
      else effects.push({ variable, value: [] });
    }
    return effects;
  };

  const condition = describeCondition(block.if as JsonSchema, base, ctx);
  const effects: ConditionalEffect[] = [];
  if (block.then !== undefined) effects.push(...apply(block.then as JsonSchema, condition));
  if (block.else !== undefined) effects.push(...apply(block.else as JsonSchema, `not (${condition})`));

  if (effects.length > 0) {
    rules.push({
      condition,
      ...(comment ? { description: comment } : {}),
      effects
    });
  }
}

function handleDependentRequired(
  dependentRequired: Record<string, unknown>,
  ctx: SkipPatternContext,
  attach: (variable: string, vc: VariableConditional) => void
): void {
  const q = ctx.qualify ?? identity;
  for (const [trigger, deps] of Object.entries(dependentRequired)) {
    const names = asStringArray(deps).map(q);
    if (names.length === 0) continue;
    const verb = names.length === 1 ? "is" : "are";
    const condition = `${q(trigger)} is present`;
    attach(q(trigger), {
      condition,
      constraintText: `When ${q(trigger)} is present, ${names.join(", ")} ${verb} also required.`
    });
    for (const dep of names) {
      attach(dep, { condition, constraintText: `Required when ${q(trigger)} is present.` });
    }
  }
}

function handleDependentSchemas(
  dependentSchemas: Record<string, unknown>,
  base: ResolutionBase,
  ctx: SkipPatternContext,
  attach: (variable: string, vc: VariableConditional) => void
): void {
  const q = ctx.qualify ?? identity;
  for (const [trigger, sub] of Object.entries(dependentSchemas)) {
    if (!isSchemaObject(sub) && sub !== true && sub !== false) continue;
    const condition = `${q(trigger)} is present`;
    attach(q(trigger), {
      condition,
      constraintText: `When ${q(trigger)} is present, additional schema constraints apply.`
    });
    for (const [property] of thenProperties(sub as JsonSchema, base, ctx)) {
      attach(q(property), {
        condition,
        constraintText: `Constrained when ${q(trigger)} is present.`
      });
    }
  }
}

/** Property name/schema pairs declared by a `then`/dependent clause (through `$ref`/`allOf`). */
function thenProperties(schema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth = 0): Array<[string, JsonSchemaObject]> {
  if (depth > ctx.maxDepth || !isSchemaObject(schema)) return [];
  const out: Array<[string, JsonSchemaObject]> = [];
  const ref = refKeyword(schema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) out.push(...thenProperties(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1));
  }
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (isSchemaObject(sub)) out.push([name, sub]);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) out.push(...thenProperties(branch, base, ctx, depth + 1));
  }
  return out;
}

/** The value a clause pins a property to: a single `const`, or an `enum` set. */
function forcedValue(sub: JsonSchemaObject): JsonValue | JsonValue[] | undefined {
  if (Object.prototype.hasOwnProperty.call(sub, "const")) return sub.const as JsonValue;
  if (Array.isArray(sub.enum)) return sub.enum as JsonValue[];
  return undefined;
}

function labelForForced(forced: JsonValue | JsonValue[] | undefined, codeLabels: Map<string, string>): string | undefined {
  if (forced === undefined || Array.isArray(forced)) return undefined;
  return codeLabels.get(String(forced));
}

function constraintTextFor(condition: string, forced: JsonValue | JsonValue[] | undefined, label: string | undefined): string {
  if (forced === undefined) return `Constrained when ${condition}.`;
  if (Array.isArray(forced)) {
    return `When ${condition}, value is one of ${forced.map(formatJsonValue).join(", ")}.`;
  }
  const labelText = label ? ` (${label})` : "";
  return `When ${condition}, value = ${formatJsonValue(forced)}${labelText}.`;
}

/** Render an `if` schema as a compact human condition, e.g. "parous = 1 and parity ≤ 2". */
export function describeCondition(ifSchema: JsonSchema, base: ResolutionBase, ctx: SkipPatternContext, depth = 0): string {
  if (depth > ctx.maxDepth || !isSchemaObject(ifSchema)) return "condition holds";
  const q = ctx.qualify ?? identity;

  const ref = refKeyword(ifSchema);
  if (ref) {
    const loc = ctx.registry.resolve(ref, base);
    if (loc) return describeCondition(loc.schema, ctx.registry.baseOf(loc), ctx, depth + 1);
  }

  const parts: string[] = [];
  if (isRecord(ifSchema.properties)) {
    for (const [name, sub] of Object.entries(ifSchema.properties)) {
      if (!isSchemaObject(sub)) continue;
      if (Object.prototype.hasOwnProperty.call(sub, "const")) {
        parts.push(`${q(name)} = ${formatJsonValue(sub.const)}`);
      } else if (Array.isArray(sub.enum)) {
        parts.push(`${q(name)} ∈ {${sub.enum.map(formatJsonValue).join(", ")}}`);
      } else {
        const range = conditionRange(sub);
        parts.push(range ? `${q(name)} ${range}` : `${q(name)} is constrained`);
      }
    }
  }

  if (parts.length === 0) {
    const required = asStringArray(ifSchema.required).map(q);
    if (required.length) return `${required.join(", ")} present`;
    return "condition holds";
  }
  return parts.join(" and ");
}

function conditionRange(sub: JsonSchemaObject): string {
  const min = typeof sub.minimum === "number" ? sub.minimum : undefined;
  const max = typeof sub.maximum === "number" ? sub.maximum : undefined;
  if (min !== undefined && max !== undefined) return min === max ? `= ${min}` : `${min}–${max}`;
  if (min !== undefined) return `≥ ${min}`;
  if (max !== undefined) return `≤ ${max}`;
  return "";
}

/**
 * Extract `Label (code)` pairs from a "Source coding"/skip-pattern `$comment`, e.g.
 * "... are Nonparous (777)" -> {"777": "Nonparous"}; "NA (777 / 7777)" maps both codes.
 */
export function parseCodeLabels(comment: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /([A-Z][A-Za-z0-9/+\- ]*?)\s*\((\d{2,4}(?:\s*\/\s*\d{2,4})*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(comment)) !== null) {
    const label = match[1]?.trim();
    const codes = match[2];
    if (!label || !codes) continue;
    for (const code of codes.split("/").map((c) => c.trim())) {
      if (code && !map.has(code)) map.set(code, label);
    }
  }
  return map;
}
