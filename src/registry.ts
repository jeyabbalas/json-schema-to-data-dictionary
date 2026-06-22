// Schema registry: indexes every (sub)schema in every input document and resolves
// `$ref`/`$dynamicRef` across documents.
//
// Real-world bundles (see the BCRPP fixture) declare `$id`s that are inconsistent with
// where the files actually live — e.g. the root is on raw.githubusercontent.com while the
// category schemas use a different host. A strict `$id`-only resolver cannot link them.
// So we index each node under BOTH a *retrieval URI* (its position, like a bundler would
// treat local files) AND its `$id` URI, and resolve a `$ref` by trying the retrieval base
// first, then the `$id` base. Unresolved refs degrade gracefully into `warnings`.

import type { JsonSchema, SchemaDocumentInput, SourceInfo } from "./types";
import { isRecord, isSchemaObject } from "./utils";

export interface IndexedSchemaLocation {
  schema: JsonSchema;
  /** Document retrieval URI (base for resolving relative `$ref`s), without fragment. */
  retrievalUri: string;
  /** Nearest enclosing `$id` (base for `$id`-relative refs), without fragment. */
  idBase: string;
  /** JSON Pointer from the document root. */
  pointer: string;
  name?: string;
}

/** The two bases needed to resolve a relative `$ref` from a given location. */
export interface ResolutionBase {
  retrievalUri: string;
  idBase: string;
}

interface NormalizedDocument {
  schema: JsonSchema;
  retrievalUri: string;
  idBase: string;
  name?: string;
}

const DEFAULT_BASE = "https://schema.local/";

const SCHEMA_CHILD_KEYWORDS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "contains",
  "unevaluatedItems",
  "if",
  "then",
  "else",
  "not",
  "contentSchema"
]);
const SCHEMA_MAP_KEYWORDS = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

export class SchemaRegistry {
  private readonly byUri = new Map<string, IndexedSchemaLocation>();
  private readonly documentRoots: IndexedSchemaLocation[] = [];
  readonly warnings: string[] = [];

  constructor(inputs: Array<JsonSchema | SchemaDocumentInput>) {
    for (const doc of normalizeDocuments(inputs)) this.indexDocument(doc);
  }

  get roots(): IndexedSchemaLocation[] {
    return [...this.documentRoots];
  }

  baseOf(loc: IndexedSchemaLocation): ResolutionBase {
    return { retrievalUri: loc.retrievalUri, idBase: loc.idBase };
  }

  get(uri: string): IndexedSchemaLocation | undefined {
    return this.byUri.get(canonicalizeUri(uri)) ?? this.byUri.get(canonicalizeUri(stripFragment(uri)));
  }

  /** Resolve a `$ref` against the retrieval base first, then the `$id` base. */
  resolve(ref: string, from: ResolutionBase): IndexedSchemaLocation | undefined {
    const candidates = new Set<string>();
    for (const base of [from.retrievalUri, from.idBase]) {
      if (!base) continue;
      const resolved = canonicalizeUri(resolveUri(ref, base));
      candidates.add(resolved);
      candidates.add(decodeUriFragment(resolved));
    }
    for (const candidate of candidates) {
      const hit = this.byUri.get(candidate);
      if (hit) return hit;
    }
    this.warnings.push(`Could not resolve $ref ${JSON.stringify(ref)} from ${from.retrievalUri}.`);
    return undefined;
  }

  sourceFor(loc: IndexedSchemaLocation, ref?: string): SourceInfo {
    const source: SourceInfo = { uri: loc.idBase || loc.retrievalUri };
    if (loc.pointer) source.pointer = loc.pointer;
    if (loc.name) source.name = loc.name;
    if (ref) source.ref = ref;
    return source;
  }

  private indexDocument(doc: NormalizedDocument): void {
    const root: IndexedSchemaLocation = {
      schema: doc.schema,
      retrievalUri: doc.retrievalUri,
      idBase: doc.idBase,
      pointer: "",
      ...(doc.name ? { name: doc.name } : {})
    };
    this.documentRoots.push(root);
    this.indexSchema(doc.schema, doc.retrievalUri, doc.idBase, [], [], doc.name);
  }

  private indexSchema(
    schema: JsonSchema,
    retrievalUri: string,
    idBaseIn: string,
    pointerFromRoot: string[],
    pointerFromId: string[],
    name: string | undefined
  ): void {
    let idBase = idBaseIn;
    let idPath = pointerFromId;

    // A nested `$id` starts a new resource: its `$id`-relative pointer resets to root.
    if (isSchemaObject(schema) && typeof schema.$id === "string" && schema.$id.trim()) {
      idBase = stripFragment(resolveUri(schema.$id, idBaseIn || retrievalUri));
      idPath = [];
    }

    const rootPtr = encodePointer(pointerFromRoot);
    const idPtr = encodePointer(idPath);

    // Positional alias (how a bundler would find this node by file position).
    this.addLocation(fragmentUri(retrievalUri, rootPtr), schema, retrievalUri, idBase, rootPtr, name);
    // `$id` alias (canonical JSON Schema identity).
    if (idBase && idBase !== retrievalUri) {
      this.addLocation(fragmentUri(idBase, idPtr), schema, retrievalUri, idBase, rootPtr, name);
    }

    if (!isSchemaObject(schema)) return;

    if (typeof schema.$anchor === "string" && schema.$anchor.trim()) {
      this.addLocation(`${idBase}#${schema.$anchor}`, schema, retrievalUri, idBase, rootPtr, name);
    }
    if (typeof schema.$dynamicAnchor === "string" && schema.$dynamicAnchor.trim()) {
      this.addLocation(`${idBase}#${schema.$dynamicAnchor}`, schema, retrievalUri, idBase, rootPtr, name);
    }

    for (const key of Object.keys(schema)) {
      const value = schema[key];
      if (SCHEMA_CHILD_KEYWORDS.has(key)) {
        if (isSchema(value)) this.indexSchema(value, retrievalUri, idBase, [...pointerFromRoot, key], [...idPath, key], name);
      } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
        if (isRecord(value)) {
          for (const [childKey, childSchema] of Object.entries(value)) {
            if (isSchema(childSchema)) {
              this.indexSchema(childSchema, retrievalUri, idBase, [...pointerFromRoot, key, childKey], [...idPath, key, childKey], name);
            }
          }
        }
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
        if (Array.isArray(value)) {
          value.forEach((childSchema, index) => {
            if (isSchema(childSchema)) {
              const seg = String(index);
              this.indexSchema(childSchema, retrievalUri, idBase, [...pointerFromRoot, key, seg], [...idPath, key, seg], name);
            }
          });
        }
      }
    }
  }

  private addLocation(
    uri: string,
    schema: JsonSchema,
    retrievalUri: string,
    idBase: string,
    pointer: string,
    name: string | undefined
  ): void {
    const canonical = canonicalizeUri(uri);
    if (this.byUri.has(canonical)) return;
    const loc: IndexedSchemaLocation = { schema, retrievalUri, idBase, pointer, ...(name ? { name } : {}) };
    this.byUri.set(canonical, loc);
  }
}

export function normalizeDocuments(inputs: Array<JsonSchema | SchemaDocumentInput>): NormalizedDocument[] {
  const collectionBase = inferCollectionBase(inputs);
  return inputs.map((input, index) => {
    const isDoc = isSchemaDocumentInput(input);
    const schema = isDoc ? input.schema : input;
    const explicitUri = isDoc ? input.uri : undefined;
    const name = isDoc ? input.name : undefined;

    const retrievalUri = stripFragment(
      explicitUri ? resolveUri(explicitUri, collectionBase) : `${collectionBase}document-${index + 1}.schema.json`
    );
    const id = rootId(schema);
    const idBase = id ? stripFragment(resolveUri(id, retrievalUri)) : retrievalUri;
    return { schema, retrievalUri, idBase, ...(name ? { name } : {}) };
  });
}

function inferCollectionBase(inputs: Array<JsonSchema | SchemaDocumentInput>): string {
  for (const input of inputs) {
    const schema = isSchemaDocumentInput(input) ? input.schema : input;
    const explicit = isSchemaDocumentInput(input) ? input.uri : undefined;
    const candidate = explicit ?? rootId(schema);
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      return new URL("./", new URL(candidate)).href;
    } catch {
      // Relative id — keep looking for an absolute base.
    }
  }
  return DEFAULT_BASE;
}

function isSchemaDocumentInput(value: JsonSchema | SchemaDocumentInput): value is SchemaDocumentInput {
  return isRecord(value) && "schema" in value && (typeof value.schema === "boolean" || isRecord(value.schema));
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isRecord(value);
}

function rootId(schema: JsonSchema): string | undefined {
  return isSchemaObject(schema) && typeof schema.$id === "string" && schema.$id.trim() ? schema.$id : undefined;
}

function fragmentUri(base: string, pointer: string): string {
  return pointer ? `${base}#${pointer}` : base;
}

export function resolveUri(ref: string, baseUri: string): string {
  try {
    return new URL(ref, ensureUsableBase(baseUri)).href;
  } catch {
    if (ref.startsWith("#")) return `${stripFragment(baseUri)}${ref}`;
    return ref;
  }
}

function ensureUsableBase(baseUri: string): string {
  try {
    new URL(baseUri);
    return baseUri;
  } catch {
    return new URL(baseUri.replace(/^\/+/, ""), DEFAULT_BASE).href;
  }
}

export function stripFragment(uri: string): string {
  const index = uri.indexOf("#");
  return index >= 0 ? uri.slice(0, index) : uri;
}

export function canonicalizeUri(uri: string): string {
  try {
    return new URL(uri, DEFAULT_BASE).href;
  } catch {
    return uri;
  }
}

export function encodePointer(segments: string[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map((s) => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function decodePointer(pointer: string): string[] {
  if (!pointer) return [];
  const withoutHash = pointer.startsWith("#") ? pointer.slice(1) : pointer;
  if (!withoutHash.startsWith("/")) return withoutHash ? [withoutHash] : [];
  return withoutHash
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function decodeUriFragment(uri: string): string {
  const hashIndex = uri.indexOf("#");
  if (hashIndex < 0) return uri;
  const base = uri.slice(0, hashIndex);
  const fragment = uri.slice(hashIndex + 1);
  try {
    return `${base}#${decodeURIComponent(fragment)}`;
  } catch {
    return uri;
  }
}
