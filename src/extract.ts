// Orchestration: array root -> items object -> category sections -> variable rows,
// then overlay the row-object skip patterns. Produces the DataDictionaryTable.

import type {
  ConstraintItem,
  DataDictionaryCategory,
  DataDictionaryRow,
  DataDictionaryTable,
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
  SchemaDocumentInput,
  SchemaToTableOptions,
  SourceInfo,
  ValidValue
} from "./types";
import { SchemaRegistry, type IndexedSchemaLocation, type ResolutionBase } from "./registry";
import { analyzeProperty, collectRequired, refKeyword } from "./analyze";
import { collectSkipPatterns, type SkipPatternResult, type VariableConditional } from "./skipPatterns";
import { cloneJson, compactObject, isRecord, isSchemaObject, joinNonEmpty, uniqueSlug, valueKey } from "./utils";

interface Options {
  includePatternProperties: boolean;
  includeOpenContentRows: boolean;
  includeSource: boolean;
  splitAllOfObjectCategories: boolean;
  maxDepth: number;
}

const DEFAULTS: Options = {
  includePatternProperties: true,
  includeOpenContentRows: true,
  includeSource: true,
  splitAllOfObjectCategories: true,
  maxDepth: 6
};

interface ExtractCtx {
  registry: SchemaRegistry;
  options: Options;
  warnings: string[];
  skip: SkipPatternResult;
  required: Set<string>;
  usedIds: Set<string>;
}

interface Deref {
  schema: JsonSchema;
  base: ResolutionBase;
  source?: SourceInfo | undefined;
}

export function schemaDocumentsToTable(
  input: Array<JsonSchema | SchemaDocumentInput>,
  options: SchemaToTableOptions = {}
): DataDictionaryTable {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("schemaDocumentsToTable requires a non-empty array of JSON Schema documents.");
  }
  const opts = normalizeOptions(options);
  const registry = new SchemaRegistry(input);
  const warnings: string[] = [];

  const root = chooseRoot(registry, options, warnings);
  const meta = tableMeta(root.schema);

  const itemsLoc = findItems(root.schema, registry.baseOf(root), registry, opts.maxDepth) ?? {
    schema: root.schema,
    base: registry.baseOf(root),
    source: registry.sourceFor(root)
  };
  if (itemsLoc === undefined) warnings.push("No `items` schema found; treating the root schema as the row object.");

  const itemDeref = deref(itemsLoc.schema, itemsLoc.base, registry, opts.maxDepth, warnings);
  const itemObject = isSchemaObject(itemDeref.schema) ? itemDeref.schema : {};
  const itemSource = itemDeref.source ?? itemsLoc.source;

  const skip = collectSkipPatterns(itemObject, itemDeref.base, { registry, maxDepth: opts.maxDepth });
  const required = collectRequired(itemObject, registry, itemDeref.base, opts.maxDepth);

  const ctx: ExtractCtx = { registry, options: opts, warnings, skip, required, usedIds: new Set() };
  const categories = collectCategories(itemObject, itemDeref.base, itemSource, ctx);

  if (categories.length === 0) warnings.push("No object properties were found; the table has no variable rows.");

  const rows = categories.flatMap((c) => c.rows);
  for (const w of registry.warnings) if (!warnings.includes(w)) warnings.push(w);

  const additionalInformation = compactObject({
    ...(schemaExtra(root.schema) ?? {}),
    ...(isSchemaObject(itemDeref.schema) && itemDeref.schema !== root.schema ? wrapItemExtra(itemDeref.schema) : {})
  }) as Record<string, JsonValue>;

  return {
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.comment ? { comment: meta.comment } : {}),
    rows,
    categories,
    conditionalRules: skip.rules,
    additionalInformation: Object.keys(additionalInformation).length > 0 ? additionalInformation : null,
    warnings,
    ...(opts.includeSource ? { source: registry.sourceFor(root) } : {})
  };
}

function normalizeOptions(o: SchemaToTableOptions): Options {
  return {
    includePatternProperties: o.includePatternProperties ?? DEFAULTS.includePatternProperties,
    includeOpenContentRows: o.includeOpenContentRows ?? DEFAULTS.includeOpenContentRows,
    includeSource: o.includeSource ?? DEFAULTS.includeSource,
    splitAllOfObjectCategories: o.splitAllOfObjectCategories ?? DEFAULTS.splitAllOfObjectCategories,
    maxDepth: o.maxDepth ?? DEFAULTS.maxDepth
  };
}

function chooseRoot(registry: SchemaRegistry, options: SchemaToTableOptions, warnings: string[]): IndexedSchemaLocation {
  if (options.rootUri) {
    const loc = registry.get(options.rootUri);
    if (loc) return loc;
    warnings.push(`rootUri ${JSON.stringify(options.rootUri)} not found; auto-detecting the root.`);
  }
  if (typeof options.rootIndex === "number") {
    const indexed = registry.roots[options.rootIndex];
    if (indexed) return indexed;
  }
  for (const r of registry.roots) {
    if (looksLikeArray(r.schema, registry.baseOf(r), registry, 4)) return r;
  }
  const first = registry.roots[0];
  if (!first) throw new Error("At least one JSON Schema document is required.");
  return first;
}

function looksLikeArray(schema: JsonSchema, base: ResolutionBase, registry: SchemaRegistry, depth: number): boolean {
  if (depth < 0 || !isSchemaObject(schema)) return false;
  if (schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"))) return true;
  if (schema.items !== undefined) return true;
  const ref = refKeyword(schema);
  if (ref) {
    const loc = registry.resolve(ref, base);
    if (loc) return looksLikeArray(loc.schema, registry.baseOf(loc), registry, depth - 1);
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.some((b) => looksLikeArray(b, base, registry, depth - 1));
  return false;
}

function findItems(schema: JsonSchema, base: ResolutionBase, registry: SchemaRegistry, maxDepth: number): Deref | undefined {
  const seen = new Set<string>();
  function visit(current: JsonSchema, currentBase: ResolutionBase, depth: number): Deref | undefined {
    if (depth > maxDepth || !isSchemaObject(current)) return undefined;
    const ref = refKeyword(current);
    if (ref) {
      const loc = registry.resolve(ref, currentBase);
      if (loc) {
        const key = `${loc.retrievalUri}#${loc.pointer}`;
        if (!seen.has(key)) {
          seen.add(key);
          const found = visit(loc.schema, registry.baseOf(loc), depth + 1);
          if (found) return found;
        }
      }
    }
    if (current.items !== undefined && current.items !== false) {
      return { schema: current.items, base: currentBase };
    }
    if (Array.isArray(current.allOf)) {
      for (const branch of current.allOf) {
        const found = visit(branch, currentBase, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  return visit(schema, base, 0);
}

function collectCategories(itemObject: JsonSchemaObject, itemBase: ResolutionBase, itemSource: SourceInfo | undefined, ctx: ExtractCtx): DataDictionaryCategory[] {
  const branches: Array<{ schema: JsonSchema; base: ResolutionBase }> = [];
  const compositors = [itemObject.allOf, itemObject.anyOf, itemObject.oneOf].filter(Array.isArray) as JsonSchema[][];
  for (const list of compositors) for (const b of list) branches.push({ schema: b, base: itemBase });

  if (!ctx.options.splitAllOfObjectCategories) {
    // One merged category: own properties + every object branch.
    const merged = newCategoryBuilder("Variables", itemObject, itemBase, itemSource, ctx);
    addObjectProperties(itemObject, itemBase, itemSource, merged, ctx);
    for (const b of branches) {
      const d = deref(b.schema, b.base, ctx.registry, ctx.options.maxDepth, ctx.warnings);
      if (isSchemaObject(d.schema) && hasProperties(d.schema)) addObjectProperties(d.schema, d.base, d.source, merged, ctx);
    }
    return finalizeBuilders([merged]);
  }

  const categories: CategoryBuilder[] = [];

  // 1) Inline properties on the row object form a "General" section.
  if (hasOwnProperties(itemObject)) {
    const title = itemObject.title && !branches.length ? itemObject.title : "General";
    const builder = newCategoryBuilder(title, itemObject, itemBase, itemSource, ctx);
    addObjectProperties(itemObject, itemBase, itemSource, builder, ctx);
    categories.push(builder);
  }

  // 2) Each object-typed branch (resolved through $ref) becomes its own sub-section.
  let sectionN = 0;
  for (const b of branches) {
    const d = deref(b.schema, b.base, ctx.registry, ctx.options.maxDepth, ctx.warnings);
    if (!isSchemaObject(d.schema) || !hasProperties(d.schema)) continue; // skip if/then-only branches
    sectionN += 1;
    const title = categoryTitle(d.schema, `Section ${sectionN}`);
    const builder = newCategoryBuilder(title, d.schema, d.base, d.source, ctx);
    addObjectProperties(d.schema, d.base, d.source, builder, ctx);
    // Merge nested allOf object branches within this category (constraints-style composition).
    if (Array.isArray(d.schema.allOf)) {
      for (const inner of d.schema.allOf) {
        const di = deref(inner, d.base, ctx.registry, ctx.options.maxDepth, ctx.warnings);
        if (isSchemaObject(di.schema) && hasProperties(di.schema)) addObjectProperties(di.schema, di.base, di.source, builder, ctx);
      }
    }
    categories.push(builder);
  }

  return finalizeBuilders(categories);
}

// ---------------------------------------------------------------------------
// Category building
// ---------------------------------------------------------------------------

interface CategoryBuilder {
  id: string;
  title: string;
  description?: string | undefined;
  comment?: string | undefined;
  rows: Map<string, DataDictionaryRow>;
  additionalInformation: Record<string, JsonValue> | null;
  source?: SourceInfo | undefined;
}

function newCategoryBuilder(title: string, schema: JsonSchemaObject, _base: ResolutionBase, source: SourceInfo | undefined, ctx: ExtractCtx): CategoryBuilder {
  return {
    id: uniqueSlug(title, ctx.usedIds),
    title,
    ...(categoryDescription(schema) ? { description: categoryDescription(schema) } : {}),
    rows: new Map(),
    additionalInformation: (schemaExtra(schema) as Record<string, JsonValue>) ?? null,
    ...(ctx.options.includeSource && source ? { source } : {})
  };
}

function addObjectProperties(schema: JsonSchemaObject, base: ResolutionBase, source: SourceInfo | undefined, builder: CategoryBuilder, ctx: ExtractCtx): void {
  if (isRecord(schema.properties)) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      addRow(buildRow(name, propSchema as JsonSchema, base, source, builder.title, ctx), builder);
    }
  }

  if (ctx.options.includePatternProperties && isRecord(schema.patternProperties)) {
    for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
      const row = buildRow(`/${pattern}/`, propSchema as JsonSchema, base, source, builder.title, ctx);
      row.Constraints.unshift({ keyword: "patternProperties", text: `Property name matches /${pattern}/.` });
      addRow(row, builder);
    }
  }

  if (ctx.options.includeOpenContentRows) {
    for (const [key, label, note] of [
      ["additionalProperties", "(additional properties)", "Schema for properties not named above."],
      ["unevaluatedProperties", "(unevaluated properties)", "Schema for properties not evaluated by adjacent applicators."]
    ] as const) {
      const sub = schema[key];
      if (sub !== undefined && sub !== false && sub !== true) {
        const row = buildRow(label, sub as JsonSchema, base, source, builder.title, ctx);
        row.Constraints.unshift({ keyword: key, text: note });
        addRow(row, builder);
      }
    }
  }
}

function addRow(row: DataDictionaryRow, builder: CategoryBuilder): void {
  const key = row["Variable name"];
  const existing = builder.rows.get(key);
  if (!existing) {
    builder.rows.set(key, row);
    return;
  }
  // Same property declared in more than one merged branch: union the information.
  existing["Description"] = joinNonEmpty([existing["Description"], row["Description"]]);
  existing["Data type"] = existing["Data type"] || row["Data type"];
  existing["Format"] = joinNonEmpty([existing["Format"], row["Format"]], " ");
  existing["Valid values"] = dedupeValidValues([...existing["Valid values"], ...row["Valid values"]]);
  existing["Constraints"] = dedupeConstraints([...existing["Constraints"], ...row["Constraints"]]);
  existing["Additional information"] = mergeInfo(existing["Additional information"], row["Additional information"]);
}

function buildRow(
  name: string,
  propSchema: JsonSchema,
  base: ResolutionBase,
  categorySource: SourceInfo | undefined,
  categoryTitleText: string,
  ctx: ExtractCtx
): DataDictionaryRow {
  const source = propertySource(categorySource, base, name);
  const analysis = analyzeProperty(propSchema, {
    registry: ctx.registry,
    base,
    ...(source ? { source } : {}),
    maxDepth: ctx.options.maxDepth
  });

  const validValues = analysis.validValues.slice();
  const constraints: ConstraintItem[] = [];
  if (ctx.required.has(name)) constraints.push({ keyword: "required", value: true, text: "Required" });
  constraints.push(...analysis.constraints);

  applySkipPatterns(name, validValues, constraints, ctx);

  return {
    "Variable name": name,
    "Description": analysis.description,
    "Data type": analysis.dataType,
    "Format": analysis.format,
    "Valid values": validValues,
    "Constraints": constraints,
    "Additional information": analysis.additionalInformation,
    __category: categoryTitleText,
    ...(ctx.options.includeSource && source ? { __source: source } : {})
  };
}

function applySkipPatterns(name: string, validValues: ValidValue[], constraints: ConstraintItem[], ctx: ExtractCtx): void {
  const conds = ctx.skip.byVariable.get(name);
  if (!conds || conds.length === 0) return;
  for (const cond of conds) {
    constraints.push({
      keyword: "conditional",
      text: cond.constraintText,
      condition: cond.condition,
      ...(cond.source ? { source: cond.source } : {})
    });
    if (cond.value === undefined) continue;
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    for (const v of values) annotateOrAddCode(validValues, v, cond);
  }
}

function annotateOrAddCode(validValues: ValidValue[], value: JsonValue, cond: VariableConditional): void {
  const existing = validValues.find((vv) => valueKey(vv.value) === valueKey(value));
  if (existing) {
    if (existing.kind !== "value" && existing.kind !== "measurement") existing.kind = "sentinel";
    existing.condition = existing.condition ? `${existing.condition}; ${cond.condition}` : cond.condition;
    if (!existing.label && cond.label) existing.label = cond.label;
    return;
  }
  validValues.push({
    value,
    kind: "sentinel",
    condition: cond.condition,
    ...(cond.label ? { label: cond.label } : {})
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deref(schema: JsonSchema, base: ResolutionBase, registry: SchemaRegistry, maxDepth: number, warnings: string[]): Deref {
  let current = schema;
  let currentBase = base;
  let source: SourceInfo | undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (!isSchemaObject(current)) return { schema: current, base: currentBase, ...(source ? { source } : {}) };
    const ref = refKeyword(current);
    if (!ref) return { schema: current, base: currentBase, ...(source ? { source } : {}) };
    const loc = registry.resolve(ref, currentBase);
    if (!loc) return { schema: current, base: currentBase, ...(source ? { source } : {}) };
    const key = `${loc.retrievalUri}#${loc.pointer}`;
    if (seen.has(key)) {
      warnings.push(`Recursive $ref while traversing ${ref}; stopped dereferencing.`);
      return { schema: current, base: currentBase, ...(source ? { source } : {}) };
    }
    seen.add(key);
    current = loc.schema;
    currentBase = registry.baseOf(loc);
    source = registry.sourceFor(loc, ref);
  }
  return { schema: current, base: currentBase, ...(source ? { source } : {}) };
}

function hasProperties(schema: JsonSchemaObject): boolean {
  if (hasOwnProperties(schema)) return true;
  if (Array.isArray(schema.allOf)) return true; // may contribute properties after deref
  return schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
}

function hasOwnProperties(schema: JsonSchemaObject): boolean {
  return isRecord(schema.properties) && Object.keys(schema.properties).length > 0;
}

function categoryTitle(schema: JsonSchema, fallback: string): string {
  if (isSchemaObject(schema)) {
    if (typeof schema.title === "string" && schema.title.trim()) return schema.title.trim();
    if (typeof schema.$id === "string" && schema.$id.trim()) {
      const tail = schema.$id.split(/[/?#]/).filter(Boolean).pop();
      if (tail) return tail.replace(/\.(json|schema)$/i, "");
    }
  }
  return fallback;
}

function categoryDescription(schema: JsonSchema): string | undefined {
  if (!isSchemaObject(schema)) return undefined;
  return (
    joinNonEmpty([
      typeof schema.description === "string" ? schema.description : undefined,
      typeof schema.$comment === "string" ? schema.$comment : undefined
    ]) || undefined
  );
}

function tableMeta(schema: JsonSchema): { title?: string; description?: string; comment?: string } {
  if (!isSchemaObject(schema)) return {};
  return {
    ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(typeof schema.$comment === "string" ? { comment: schema.$comment } : {})
  };
}

function propertySource(categorySource: SourceInfo | undefined, base: ResolutionBase, name: string): SourceInfo | undefined {
  const uri = categorySource?.uri ?? base.idBase ?? base.retrievalUri;
  if (!uri) return undefined;
  const parentPointer = categorySource?.pointer ?? "";
  const pointer = `${parentPointer}/properties/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  return { uri, pointer, ...(categorySource?.name ? { name: categorySource.name } : {}) };
}

const EXTRA_KEYS = [
  "$id",
  "$schema",
  "$anchor",
  "$dynamicAnchor",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentSchema"
];

function schemaExtra(schema: JsonSchema): Record<string, unknown> | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of EXTRA_KEYS) if (Object.prototype.hasOwnProperty.call(schema, key)) out[key] = cloneJson(schema[key]);
  for (const [key, value] of Object.entries(schema)) if (key.startsWith("x-")) out[key] = cloneJson(value);
  const compact = compactObject(out);
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function wrapItemExtra(schema: JsonSchemaObject): Record<string, unknown> {
  const extra = schemaExtra(schema);
  return extra ? { item: extra } : {};
}

function finalizeBuilders(builders: CategoryBuilder[]): DataDictionaryCategory[] {
  return builders
    .filter((b) => b.rows.size > 0)
    .map((b) => ({
      id: b.id,
      title: b.title,
      ...(b.description ? { description: b.description } : {}),
      rows: [...b.rows.values()],
      additionalInformation: b.additionalInformation,
      ...(b.source ? { source: b.source } : {})
    }));
}

function dedupeValidValues(values: ValidValue[]): ValidValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = `${v.kind ?? ""}|${valueKey(v.value)}|${v.label ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeConstraints(items: ConstraintItem[]): ConstraintItem[] {
  const seen = new Set<string>();
  return items.filter((c) => {
    const key = `${c.keyword}|${c.text}|${c.condition ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeInfo(a: DataDictionaryRow["Additional information"], b: DataDictionaryRow["Additional information"]): DataDictionaryRow["Additional information"] {
  if (!a) return b;
  if (!b) return a;
  return compactObject({ ...a, ...b }) as Record<string, JsonValue>;
}
