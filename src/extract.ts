// Orchestration: array root -> items object -> category sections -> variable rows -- and,
// for every object-shaped variable, array of objects or array of arrays, the rows of the
// fields inside it, named by path (`visits[].date`) and placed right after their parent --
// then overlay the skip patterns of the row object and of the nested objects. Produces the
// DataDictionaryTable.

import type {
  ConstraintItem,
  DataDictionaryCategory,
  DataDictionaryRow,
  DataDictionaryTable,
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
  PathStep,
  SchemaDocumentInput,
  SchemaRootCandidate,
  SchemaToTableOptions,
  SourceInfo,
  ValidValue
} from "./types";
import { SchemaRegistry, type IndexedSchemaLocation, type ResolutionBase } from "./registry";
import { analyzeProperty, collectRequired, refKeyword, type PropertyShape, type SchemaRef } from "./analyze";
import { collectSkipPatterns, mergeSkipPatterns, type SkipPatternResult, type VariableConditional } from "./skipPatterns";
import { formatVariablePath, sourceAt } from "./paths";
import { cloneJson, compactObject, isRecord, isSchemaObject, joinNonEmpty, uniqueSlug, valueKey } from "./utils";

interface Options {
  includePatternProperties: boolean;
  includeOpenContentRows: boolean;
  includeSource: boolean;
  splitAllOfObjectCategories: boolean;
  maxDepth: number;
  expandNested: boolean;
  maxNestingDepth: number;
}

const DEFAULTS: Options = {
  includePatternProperties: true,
  includeOpenContentRows: true,
  includeSource: true,
  splitAllOfObjectCategories: true,
  maxDepth: 6,
  expandNested: true,
  maxNestingDepth: 6
};

/** A container being expanded: the schema objects that define its fields, for the recursion guard. */
interface Frame {
  name: string;
  identities: ReadonlySet<JsonSchemaObject>;
}

/** What a row inherits from the object it is a field of. */
interface Enclosing {
  /** Property names the enclosing object requires. */
  required: ReadonlySet<string>;
  /** Names the `oneOf`/`anyOf` branch a field came from requires (mandatory in that variant only). */
  variantRequired?: ReadonlySet<string> | undefined;
  /** Variable name of the enclosing row (absent at the top level). */
  parent?: string | undefined;
  depth: number;
  ancestors: readonly Frame[];
}

interface ExtractCtx {
  registry: SchemaRegistry;
  options: Options;
  warnings: string[];
  skip: SkipPatternResult;
  /** The row object's own `required` names. */
  required: Set<string>;
  usedIds: Set<string>;
  /** The row object and its category schemas: a `$ref` back into them is recursion. */
  root: Frame;
}

interface Deref {
  schema: JsonSchema;
  base: ResolutionBase;
  source?: SourceInfo | undefined;
}

const NO_REQUIRED: ReadonlySet<string> = new Set();

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

  const ctx: ExtractCtx = {
    registry,
    options: opts,
    warnings,
    skip,
    required,
    usedIds: new Set(),
    root: { name: "the record", identities: new Set([itemObject]) }
  };
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
    maxDepth: o.maxDepth ?? DEFAULTS.maxDepth,
    expandNested: o.expandNested ?? DEFAULTS.expandNested,
    maxNestingDepth: nonNegativeInt(o.maxNestingDepth) ?? DEFAULTS.maxNestingDepth
  };
}

function nonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * Rank the input documents by how likely each is to be the table's root.
 *
 * People routinely hand over a whole project folder, so the input mixes the table schema with
 * the component schemas it `$ref`s, example data files, and occasionally several tables. The
 * ranking prefers, in order: an array of records (a table), one that no other document `$ref`s
 * into (a referenced document is a component), the one describing the most variables, and
 * finally input order. Documents that do not read like a JSON Schema at all (a bare data array,
 * a ledger of `{ violations: [...] }`) are left out entirely.
 */
export function findSchemaRoots(input: Array<JsonSchema | SchemaDocumentInput>): SchemaRootCandidate[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  return rankRoots(new SchemaRegistry(input));
}

function rankRoots(registry: SchemaRegistry): SchemaRootCandidate[] {
  const roots = registry.roots;
  const referenced = referencedDocuments(registry);
  const candidates: SchemaRootCandidate[] = [];
  roots.forEach((root, index) => {
    if (!looksLikeSchemaDocument(root.schema)) return;
    const title = isSchemaObject(root.schema) && typeof root.schema.title === "string" ? root.schema.title.trim() : "";
    candidates.push({
      index,
      uri: root.retrievalUri,
      ...(root.name ? { name: root.name } : {}),
      ...(title ? { title } : {}),
      arrayLike: looksLikeArray(root.schema, registry.baseOf(root), registry, 4),
      referenced: referenced.has(root.retrievalUri),
      variableCount: countRowProperties(root, registry)
    });
  });
  return candidates.sort(
    (a, b) =>
      Number(b.arrayLike) - Number(a.arrayLike) ||
      Number(a.referenced) - Number(b.referenced) ||
      b.variableCount - a.variableCount ||
      a.index - b.index
  );
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

  const ranked = rankRoots(registry);
  const best = ranked[0];
  if (best) {
    const tables = ranked.filter((c) => c.arrayLike && !c.referenced);
    if (tables.length > 1) {
      const label = candidateLabeller(tables);
      warnings.push(
        `${tables.length} documents look like a table root; using ${label(best)}. ` +
          `Pick another with rootUri or rootIndex: ${tables.slice(0, 8).map(label).join(", ")}${tables.length > 8 ? ", …" : ""}.`
      );
    }
    return registry.roots[best.index] as IndexedSchemaLocation;
  }

  const first = registry.roots[0];
  if (!first) throw new Error("At least one JSON Schema document is required.");
  return first;
}

/** Name candidates by their `name`, falling back to the URI when two share one. */
function candidateLabeller(candidates: readonly SchemaRootCandidate[]): (candidate: SchemaRootCandidate) => string {
  const seen = new Map<string, number>();
  for (const c of candidates) if (c.name) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
  return (candidate) => (candidate.name && seen.get(candidate.name) === 1 ? candidate.name : candidate.uri);
}

/** Keywords that mark a document as a schema rather than data that happens to be JSON. */
const SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "type",
  "properties",
  "patternProperties",
  "items",
  "prefixItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "enum",
  "const",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "contains",
  "$anchor"
]);

function looksLikeSchemaDocument(schema: JsonSchema): boolean {
  if (!isSchemaObject(schema)) return false; // booleans and bare data arrays are never a table root
  return Object.keys(schema).some((key) => SCHEMA_KEYWORDS.has(key));
}

/** Retrieval URIs that some OTHER document `$ref`s into — those are components, not roots. */
function referencedDocuments(registry: SchemaRegistry): Set<string> {
  const referenced = new Set<string>();
  for (const root of registry.roots) {
    const base = registry.baseOf(root);
    for (const ref of collectRefs(root.schema)) {
      const target = registry.tryResolve(ref, base);
      if (target && target.retrievalUri !== root.retrievalUri) referenced.add(target.retrievalUri);
    }
  }
  return referenced;
}

/** Every `$ref`/`$dynamicRef` string anywhere in a document (over-collecting is harmless here). */
function collectRefs(schema: JsonSchema, out: Set<string> = new Set(), depth = 12): Set<string> {
  if (depth < 0 || typeof schema !== "object" || schema === null) return out;
  for (const value of Array.isArray(schema) ? schema : Object.values(schema)) {
    if (typeof value === "object" && value !== null) collectRefs(value as JsonSchema, out, depth - 1);
  }
  if (!Array.isArray(schema)) {
    for (const key of ["$ref", "$dynamicRef"]) {
      const value = (schema as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) out.add(value);
    }
  }
  return out;
}

/** How many variables a document would contribute as the root (its row object's properties). */
function countRowProperties(root: IndexedSchemaLocation, registry: SchemaRegistry): number {
  const base = registry.baseOf(root);
  const items = findItems(root.schema, base, registry, 6) ?? { schema: root.schema, base };
  const row = deref(items.schema, items.base, registry, 6, []);
  const names = new Set<string>();
  const visit = (schema: JsonSchema, schemaBase: ResolutionBase, depth: number, seen: Set<string>): void => {
    if (depth < 0 || !isSchemaObject(schema)) return;
    if (isRecord(schema.properties)) for (const name of Object.keys(schema.properties)) names.add(name);
    const ref = refKeyword(schema);
    if (ref) {
      const loc = registry.tryResolve(ref, schemaBase);
      const key = loc ? `${loc.retrievalUri}#${loc.pointer}` : "";
      if (loc && !seen.has(key)) {
        seen.add(key);
        visit(loc.schema, registry.baseOf(loc), depth - 1, seen);
      }
    }
    for (const list of [schema.allOf, schema.anyOf, schema.oneOf]) {
      if (Array.isArray(list)) for (const branch of list) visit(branch, schemaBase, depth - 1, seen);
    }
  };
  visit(row.schema, row.base, 6, new Set());
  return names.size;
}

function looksLikeArray(schema: JsonSchema, base: ResolutionBase, registry: SchemaRegistry, depth: number): boolean {
  if (depth < 0 || !isSchemaObject(schema)) return false;
  if (schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"))) return true;
  if (schema.items !== undefined) return true;
  const ref = refKeyword(schema);
  if (ref) {
    const loc = registry.tryResolve(ref, base);
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

  // Resolve every branch first: the category schemas are part of "the record", and a
  // property that `$ref`s back into one of them must be recognised as recursion.
  const derefs = branches.map((b) => deref(b.schema, b.base, ctx.registry, ctx.options.maxDepth, ctx.warnings));
  const rootIdentities = ctx.root.identities as Set<JsonSchemaObject>;
  for (const d of derefs) if (isSchemaObject(d.schema)) rootIdentities.add(d.schema);

  if (!ctx.options.splitAllOfObjectCategories) {
    // One merged category: own properties + every object branch.
    const merged = newCategoryBuilder("Variables", itemObject, itemBase, itemSource, ctx);
    addObjectProperties(itemObject, itemBase, itemSource, merged, ctx);
    for (const d of derefs) {
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
  for (const d of derefs) {
    if (!isSchemaObject(d.schema) || !hasProperties(d.schema)) continue; // skip if/then-only branches
    sectionN += 1;
    const title = categoryTitle(d.schema, `Section ${sectionN}`);
    const builder = newCategoryBuilder(title, d.schema, d.base, d.source, ctx);
    addObjectProperties(d.schema, d.base, d.source, builder, ctx);
    // Merge nested allOf object branches within this category (constraints-style composition).
    if (Array.isArray(d.schema.allOf)) {
      for (const inner of d.schema.allOf) {
        const di = deref(inner, d.base, ctx.registry, ctx.options.maxDepth, ctx.warnings);
        if (isSchemaObject(di.schema) && hasProperties(di.schema)) {
          rootIdentities.add(di.schema);
          addObjectProperties(di.schema, di.base, di.source, builder, ctx);
        }
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
  /** Parent variable name -> its child rows' names, in the order they were added. */
  children: Map<string, Set<string>>;
  additionalInformation: Record<string, JsonValue> | null;
  source?: SourceInfo | undefined;
}

function newCategoryBuilder(title: string, schema: JsonSchemaObject, _base: ResolutionBase, source: SourceInfo | undefined, ctx: ExtractCtx): CategoryBuilder {
  return {
    id: uniqueSlug(title, ctx.usedIds),
    title,
    ...(categoryDescription(schema) ? { description: categoryDescription(schema) } : {}),
    rows: new Map(),
    children: new Map(),
    additionalInformation: (schemaExtra(schema) as Record<string, JsonValue>) ?? null,
    ...(ctx.options.includeSource && source ? { source } : {})
  };
}

function addObjectProperties(schema: JsonSchemaObject, base: ResolutionBase, source: SourceInfo | undefined, builder: CategoryBuilder, ctx: ExtractCtx): void {
  const enclosing: Enclosing = { required: ctx.required, depth: 0, ancestors: [ctx.root] };

  if (isRecord(schema.properties)) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      const ref: SchemaRef = { schema: propSchema as JsonSchema, base, source: sourceAt(source, base, ["properties", name]) };
      emitVariable([{ kind: "property", name }], ref, enclosing, builder, ctx);
    }
  }

  if (ctx.options.includePatternProperties && isRecord(schema.patternProperties)) {
    for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
      const ref: SchemaRef = { schema: propSchema as JsonSchema, base, source: sourceAt(source, base, ["patternProperties", pattern]) };
      const row = emitVariable([{ kind: "pattern", pattern }], ref, enclosing, builder, ctx);
      row.Constraints.unshift({ keyword: "patternProperties", text: `Property name matches /${pattern}/.` });
    }
  }

  if (ctx.options.includeOpenContentRows) {
    for (const [key, note] of [
      ["additionalProperties", "Schema for properties not named above."],
      ["unevaluatedProperties", "Schema for properties not evaluated by adjacent applicators."]
    ] as const) {
      const sub = schema[key];
      if (sub !== undefined && sub !== false && sub !== true) {
        const ref: SchemaRef = { schema: sub as JsonSchema, base, source: sourceAt(source, base, [key]) };
        const row = emitVariable([{ kind: "additional", keyword: key }], ref, enclosing, builder, ctx);
        row.Constraints.unshift({ keyword: key, text: note });
      }
    }
  }
}

/**
 * Store a row (merging a repeated declaration into the existing one) and return the stored row.
 * Declarations from `allOf` branches describe one value and normally agree on its type; those
 * from `oneOf`/`anyOf` branches (`variant`) are alternatives, so their types are listed side by side.
 */
function addRow(row: DataDictionaryRow, builder: CategoryBuilder, variant = false): DataDictionaryRow {
  const key = row["Variable name"];
  if (row.__parent !== undefined) {
    const siblings = builder.children.get(row.__parent) ?? new Set<string>();
    siblings.add(key);
    builder.children.set(row.__parent, siblings);
  }
  const existing = builder.rows.get(key);
  if (!existing) {
    builder.rows.set(key, row);
    return row;
  }
  // Same property declared in more than one merged branch: union the information.
  existing["Description"] = joinNonEmpty([existing["Description"], row["Description"]]);
  existing["Data type"] = variant ? unionTypes(existing["Data type"], row["Data type"]) : existing["Data type"] || row["Data type"];
  existing["Format"] = joinNonEmpty([existing["Format"], row["Format"]], " ");
  existing["Valid values"] = dedupeValidValues([...existing["Valid values"], ...row["Valid values"]]);
  existing["Constraints"] = dedupeConstraints([...existing["Constraints"], ...row["Constraints"]]);
  existing["Additional information"] = mergeInfo(existing["Additional information"], row["Additional information"]);
  return existing;
}

/**
 * One variable: analyse its schema, build its row, and -- when it is an object, an array of
 * objects, an array of arrays or a tuple -- the rows of the fields inside it.
 */
function emitVariable(path: readonly PathStep[], ref: SchemaRef, enclosing: Enclosing, builder: CategoryBuilder, ctx: ExtractCtx): DataDictionaryRow {
  const name = formatVariablePath(path);
  const analysis = analyzeProperty(ref.schema, {
    registry: ctx.registry,
    base: ref.base,
    ...(ref.source ? { source: ref.source } : {}),
    maxDepth: ctx.options.maxDepth
  });

  const validValues = analysis.validValues.slice();
  const constraints: ConstraintItem[] = [];
  const last = path[path.length - 1];
  const variant = ref.union !== undefined && ref.variant !== undefined && enclosing.parent !== undefined ? `variant ${ref.variant + 1} of ${enclosing.parent}` : undefined;
  if (last?.kind === "property" && enclosing.required.has(last.name)) {
    // "Required within visits[]" rather than a bare "Required": the field is mandatory in
    // every element, which says nothing about whether `visits` itself is present.
    const within = path.length > 1 ? ` within ${formatVariablePath(path.slice(0, -1))}` : "";
    constraints.push({ keyword: "required", value: true, text: `Required${within}` });
  } else if (last?.kind === "property" && variant !== undefined && enclosing.variantRequired?.has(last.name)) {
    constraints.push({ keyword: "required", value: true, text: `Required in ${variant}` });
  }
  if (variant !== undefined) constraints.push({ keyword: ref.union as "oneOf" | "anyOf", value: ref.variant, text: `In ${variant}` });
  constraints.push(...analysis.constraints);

  applySkipPatterns(name, validValues, constraints, ctx);

  const row = addRow(
    {
      "Variable name": name,
      "Description": analysis.description,
      "Data type": analysis.dataType,
      "Format": analysis.format,
      "Valid values": validValues,
      "Constraints": constraints,
      "Additional information": analysis.additionalInformation,
      __category: builder.title,
      ...(ctx.options.includeSource && ref.source ? { __source: ref.source } : {}),
      ...(enclosing.parent !== undefined ? { __parent: enclosing.parent } : {}),
      __depth: enclosing.depth,
      __path: path.slice()
    },
    builder,
    variant !== undefined
  );

  if (ctx.options.expandNested) expandChildren(path, analysis.shape, row, enclosing, builder, ctx);
  return row;
}

/**
 * The rows inside a container. Object fields become `path.field`; every element of an array
 * of objects is the virtual node `path[]` whose fields become `path[].field`; an array of
 * arrays gets a real `path[]` row; tuple positions become `path[0]`, `path[1]`, …
 */
function expandChildren(
  path: readonly PathStep[],
  shape: PropertyShape,
  owner: DataDictionaryRow,
  enclosing: Enclosing,
  builder: CategoryBuilder,
  ctx: ExtractCtx
): void {
  const { registry } = ctx;
  const { maxDepth, includePatternProperties, includeOpenContentRows } = ctx.options;
  const containerName = formatVariablePath(path);
  const frame: Frame = { name: containerName, identities: shape.identities };
  const child: Enclosing = { required: NO_REQUIRED, parent: owner["Variable name"], depth: enclosing.depth + 1, ancestors: [...enclosing.ancestors, frame] };

  const hasFields =
    shape.properties.size > 0 ||
    shape.patternProperties.size > 0 ||
    describesOpenContent(shape.additionalProperties) ||
    describesOpenContent(shape.unevaluatedProperties);
  if (hasFields && guard(shape, owner, enclosing, ctx)) {
    // What the object requires: its own `required` (through `$ref`/`allOf`) applies to every
    // field; a `oneOf`/`anyOf` branch's `required` only to the fields of that branch, and only
    // while it is the variant in effect -- the rows say so ("Required in variant 2 of contact").
    const required = collectRequired(shape.self.schema, registry, shape.self.base, maxDepth);
    const variantRequired = new Map<string, Set<string>>();
    for (const variant of shape.variants) {
      const key = variantKey(variant);
      if (key === undefined) continue;
      const names = variantRequired.get(key) ?? new Set<string>();
      for (const name of collectRequired(variant.schema, registry, variant.base, maxDepth)) names.add(name);
      variantRequired.set(key, names);
    }
    const fieldsOf = (ref: SchemaRef): Enclosing => {
      const key = variantKey(ref);
      const own = key !== undefined ? variantRequired.get(key) : undefined;
      return { ...child, required, ...(own ? { variantRequired: own } : {}) };
    };
    // Rules between the fields of this object, named by their rows, before the rows are built
    // so that each row picks up its conditions.
    const qualify = (property: string): string => formatVariablePath([...path, { kind: "property", name: property }]);
    mergeSkipPatterns(ctx.skip, collectSkipPatterns(shape.self.schema, shape.self.base, { registry, maxDepth, qualify }));
    for (const variant of shape.variants) mergeSkipPatterns(ctx.skip, collectSkipPatterns(variant.schema, variant.base, { registry, maxDepth, qualify }));

    for (const [name, refs] of shape.properties) {
      for (const ref of refs) emitVariable([...path, { kind: "property", name }], ref, fieldsOf(ref), builder, ctx);
    }
    if (includePatternProperties) {
      for (const [pattern, refs] of shape.patternProperties) {
        for (const ref of refs) {
          const row = emitVariable([...path, { kind: "pattern", pattern }], ref, fieldsOf(ref), builder, ctx);
          row.Constraints.unshift({ keyword: "patternProperties", text: `Property name matches /${pattern}/.` });
        }
      }
    }
    if (includeOpenContentRows) {
      for (const [keyword, note] of [
        ["additionalProperties", "Any property name not listed above."],
        ["unevaluatedProperties", "Any property name not evaluated by adjacent applicators."]
      ] as const) {
        const ref = shape[keyword];
        if (!describesOpenContent(ref)) continue;
        const row = emitVariable([...path, { kind: "additional", keyword }], ref, fieldsOf(ref), builder, ctx);
        row.Constraints.unshift({ keyword, text: note });
      }
    }
  }

  if (shape.prefixItems.length > 0 && guard(shape, owner, enclosing, ctx)) {
    shape.prefixItems.forEach((refs, index) => {
      for (const ref of refs) emitVariable([...path, { kind: "index", index }], ref, child, builder, ctx);
    });
  }

  if (shape.items) {
    const itemShape = shape.items.analysis.shape;
    if (itemShape.kind === "object") {
      // Every element is an object: its fields are `path[].field`, no row for `path[]` itself.
      expandChildren([...path, { kind: "items" }], itemShape, owner, enclosing, builder, ctx);
    } else if (itemShape.kind !== "scalar" && guard(itemShape, owner, enclosing, ctx)) {
      emitVariable([...path, { kind: "items" }], shape.items.ref, child, builder, ctx);
    }
  }
}

/**
 * An open-content schema worth a row: `additionalProperties: true` (or a missing keyword)
 * says nothing about the values and gets none, as at the top level.
 */
function describesOpenContent(value: SchemaRef | false | undefined): value is SchemaRef {
  return value !== undefined && value !== false && value.schema !== true;
}

/** The `oneOf`/`anyOf` branch a schema came from, as a map key; `undefined` outside a union. */
function variantKey(ref: SchemaRef): string | undefined {
  return ref.union !== undefined && ref.variant !== undefined ? `${ref.union}:${ref.variant}` : undefined;
}

/**
 * Whether `owner`'s fields may be expanded: not when the shape is one of the containers
 * already being expanded above it (a recursive schema), and not below the nesting limit.
 * Either way the owner says so in its constraints, once.
 */
function guard(shape: PropertyShape, owner: DataDictionaryRow, enclosing: Enclosing, ctx: ExtractCtx): boolean {
  for (const frame of enclosing.ancestors) {
    for (const identity of shape.identities) {
      if (!frame.identities.has(identity)) continue;
      pushOnce(owner.Constraints, { keyword: "recursive", text: `Recursive structure: same shape as ${frame.name}` });
      return false;
    }
  }
  const limit = ctx.options.maxNestingDepth;
  if (enclosing.depth + 1 > limit) {
    pushOnce(owner.Constraints, { keyword: "maxNestingDepth", value: limit, text: "Nested fields not expanded (nesting depth limit reached)" });
    const warning = `Nested fields of "${owner["Variable name"]}" were not expanded: nesting depth limit reached (maxNestingDepth = ${limit}).`;
    if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
    return false;
  }
  return true;
}

function pushOnce(constraints: ConstraintItem[], item: ConstraintItem): void {
  if (!constraints.some((c) => c.keyword === item.keyword && c.text === item.text)) constraints.push(item);
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
  // `x-value-kind` is consumed by the analyzer, not surfaced: it steers classification and
  // would otherwise show up here as dataset metadata that does nothing.
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-") && key !== "x-value-kind") out[key] = cloneJson(value);
  }
  const compact = compactObject(out);
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function wrapItemExtra(schema: JsonSchemaObject): Record<string, unknown> {
  const extra = schemaExtra(schema);
  return extra ? { item: extra } : {};
}

/**
 * Rows in reading order: each top-level row followed by its descendants, depth first. A parent
 * declared again by a later `allOf` branch may add children long after its own row was added;
 * insertion order alone would strand them at the end of the section.
 */
function orderedRows(builder: CategoryBuilder): DataDictionaryRow[] {
  const out: DataDictionaryRow[] = [];
  const emitted = new Set<string>();
  const visit = (row: DataDictionaryRow): void => {
    const name = row["Variable name"];
    if (emitted.has(name)) return;
    emitted.add(name);
    out.push(row);
    for (const child of builder.children.get(name) ?? []) {
      const childRow = builder.rows.get(child);
      if (childRow) visit(childRow);
    }
  };
  for (const row of builder.rows.values()) if (row.__parent === undefined) visit(row);
  for (const row of builder.rows.values()) visit(row); // anything left over (an orphaned child) still gets listed
  return out;
}

function finalizeBuilders(builders: CategoryBuilder[]): DataDictionaryCategory[] {
  return builders
    .filter((b) => b.rows.size > 0)
    .map((b) => ({
      id: b.id,
      title: b.title,
      ...(b.description ? { description: b.description } : {}),
      rows: orderedRows(b),
      additionalInformation: b.additionalInformation,
      ...(b.source ? { source: b.source } : {})
    }));
}

/** "string" + "integer (nullable)" -> "string or integer (nullable)"; a repeated alternative is listed once. */
function unionTypes(a: string, b: string): string {
  return [...new Set([...a.split(" or "), ...b.split(" or ")].filter(Boolean))].join(" or ");
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
