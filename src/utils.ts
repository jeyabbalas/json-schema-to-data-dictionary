import type { JsonSchema, JsonSchemaObject, JsonValue } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSchemaObject(schema: JsonSchema | unknown): schema is JsonSchemaObject {
  return isRecord(schema);
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isRecord(value);
}

/** Deterministic stringify with sorted keys — used as a stable identity key for values. */
export function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, sortKeys) ?? String(value);
}

function sortKeys(_key: string, value: unknown): unknown {
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = value[key];
    return out;
  }
  return value;
}

/** Stable identity key for a JSON value (so enum members / sentinels dedupe correctly). */
export function valueKey(value: unknown): string {
  if (typeof value === "string") return `s:${value}`;
  return `j:${JSON.stringify(value, sortKeys)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = slugify(base);
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${slugify(base)}-${i}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

export function joinNonEmpty(parts: Array<string | undefined | null>, sep = "\n\n"): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(sep);
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Normalise `type` (string | string[]) into a deduped array. */
export function normalizeTypeArray(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return [...new Set(type.filter((x): x is string => typeof x === "string"))];
  return [];
}

/** The JSON Schema instance type of a concrete value (numbers split into integer/number). */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  if (t === "string" || t === "boolean" || t === "object") return t;
  return "string";
}

/** Compact rendering of a JSON value for constraint sentences (strings keep quotes). */
export function formatJsonValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/** Bare rendering of a value for value chips/labels (strings without surrounding quotes). */
export function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/** Drop undefined/null/empty entries from an object (used to keep "Additional information" tidy). */
export function compactObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A readable number (avoids "1e-7"-style output for typical schema bounds). */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}
