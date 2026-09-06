// Variable names of nested fields, and JSON-pointer provenance for nested schemas.
//
// A nested field is named by its path: `visits[].date` (a field of every element of the
// `visits` array), `address.city`, `genotype[0]` (a tuple position), `biomarkers.*` (an open
// map's values), `biomarkers./^il_[0-9]+$/` (a `patternProperties` entry). This is the ONLY
// place a path becomes a name, so the syntax can be changed in one function.

import type { PathStep, SourceInfo } from "./types";
import { encodePointer, type ResolutionBase } from "./registry";

/**
 * Property names that can follow a `.` unquoted; anything else is written `["like this"]`. A
 * name starting with `/` is quoted so that it cannot read as a `patternProperties` entry.
 */
const PLAIN_NAME = /^(?!\/)[^.[\]"*\s]+$/;

export function formatVariablePath(steps: readonly PathStep[]): string {
  let out = "";
  steps.forEach((step, i) => {
    if (i === 0) {
      out = firstSegment(step);
      return;
    }
    switch (step.kind) {
      case "property":
        out += PLAIN_NAME.test(step.name) ? `.${step.name}` : `[${JSON.stringify(step.name)}]`;
        break;
      case "items":
        out += "[]";
        break;
      case "index":
        out += `[${step.index}]`;
        break;
      case "pattern":
        out += `./${step.pattern}/`;
        break;
      case "additional":
        out += ".*";
        break;
    }
  });
  return out;
}

/** The names top-level rows have always had: the property key, `/regex/`, `(additional properties)`. */
function firstSegment(step: PathStep): string {
  switch (step.kind) {
    case "property":
      return step.name;
    case "items":
      return "[]";
    case "index":
      return `[${step.index}]`;
    case "pattern":
      return `/${step.pattern}/`;
    case "additional":
      return step.keyword === "additionalProperties" ? "(additional properties)" : "(unevaluated properties)";
  }
}

/**
 * Provenance of the schema `segments` below `parent` -- e.g. `["properties", "date"]` or
 * `["items"]` -- as a JSON pointer into the same document. Without a parent the document is
 * the resolution base's; when neither names a document there is nothing to point into.
 */
export function sourceAt(parent: SourceInfo | undefined, base: ResolutionBase, segments: readonly string[]): SourceInfo | undefined {
  const uri = parent?.uri ?? base.idBase ?? base.retrievalUri;
  if (!uri) return undefined;
  return {
    uri,
    pointer: `${parent?.pointer ?? ""}${encodePointer([...segments])}`,
    ...(parent?.name ? { name: parent.name } : {})
  };
}
