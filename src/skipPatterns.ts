// Parse the row-object-level conditional logic that encodes structural missingness and
// questionnaire skip patterns: `if`/`then` blocks (commonly inside the items object's
// `allOf`), plus `dependentRequired` and `dependentSchemas`.
//
// Output is (1) dataset-level ConditionalRule[] for a "skip patterns" panel, and
// (2) a per-variable map the extractor uses to annotate the affected rows' valid values
// and constraints with the triggering condition.

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

interface Ctx {
  registry: SchemaRegistry;
  maxDepth: number;
}

export function collectSkipPatterns(itemSchema: JsonSchema, base: ResolutionBase, ctx: Ctx): SkipPatternResult {
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
      handleDependentRequired(schema.dependentRequired, attach);
    }
    if (isRecord(schema.dependentSchemas)) {
      handleDependentSchemas(schema.dependentSchemas, currentBase, ctx, attach);
    }
  };

  visit(itemSchema, base, 0);
  return { rules, byVariable };
}

function handleIfThen(
  block: JsonSchemaObject,
  base: ResolutionBase,
  ctx: Ctx,
  attach: (variable: string, vc: VariableConditional) => void,
  rules: ConditionalRule[]
): void {
  const comment = typeof block.$comment === "string" ? block.$comment : undefined;
  const codeLabels = comment ? parseCodeLabels(comment) : new Map<string, string>();

  const apply = (clause: JsonSchema | undefined, condition: string): ConditionalEffect[] => {
    if (clause === undefined || !isSchemaObject(clause)) return [];
    const effects: ConditionalEffect[] = [];
    for (const [variable, sub] of thenProperties(clause, base, ctx)) {
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
  attach: (variable: string, vc: VariableConditional) => void
): void {
  for (const [trigger, deps] of Object.entries(dependentRequired)) {
    const names = asStringArray(deps);
    if (names.length === 0) continue;
    const verb = names.length === 1 ? "is" : "are";
    attach(trigger, {
      condition: `${trigger} is present`,
      constraintText: `When ${trigger} is present, ${names.join(", ")} ${verb} also required.`
    });
    for (const dep of names) {
      attach(dep, { condition: `${trigger} is present`, constraintText: `Required when ${trigger} is present.` });
    }
  }
}

function handleDependentSchemas(
  dependentSchemas: Record<string, unknown>,
  base: ResolutionBase,
  ctx: Ctx,
  attach: (variable: string, vc: VariableConditional) => void
): void {
  for (const [trigger, sub] of Object.entries(dependentSchemas)) {
    if (!isSchemaObject(sub) && sub !== true && sub !== false) continue;
    attach(trigger, {
      condition: `${trigger} is present`,
      constraintText: `When ${trigger} is present, additional schema constraints apply.`
    });
    for (const [variable] of thenProperties(sub as JsonSchema, base, ctx)) {
      attach(variable, {
        condition: `${trigger} is present`,
        constraintText: `Constrained when ${trigger} is present.`
      });
    }
  }
}

/** Property name/schema pairs declared by a `then`/dependent clause (through `$ref`/`allOf`). */
function thenProperties(schema: JsonSchema, base: ResolutionBase, ctx: Ctx, depth = 0): Array<[string, JsonSchemaObject]> {
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
export function describeCondition(ifSchema: JsonSchema, base: ResolutionBase, ctx: Ctx, depth = 0): string {
  if (depth > ctx.maxDepth || !isSchemaObject(ifSchema)) return "condition holds";

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
        parts.push(`${name} = ${formatJsonValue(sub.const)}`);
      } else if (Array.isArray(sub.enum)) {
        parts.push(`${name} ∈ {${sub.enum.map(formatJsonValue).join(", ")}}`);
      } else {
        const range = conditionRange(sub);
        parts.push(range ? `${name} ${range}` : `${name} is constrained`);
      }
    }
  }

  if (parts.length === 0) {
    const required = asStringArray(ifSchema.required);
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
