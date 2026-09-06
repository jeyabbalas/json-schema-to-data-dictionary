import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");

/** Load a single fixture file as a one-document input array. */
export function loadFile(rel) {
  const p = join(FIXTURES, rel);
  return [{ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) }];
}

/** Load every .json file under a fixture directory (recursively) as document inputs. */
export function loadDir(rel) {
  const dir = join(FIXTURES, rel);
  const out = [];
  (function walk(d) {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".json")) out.push({ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) });
    }
  })(dir);
  return out;
}

export function findRow(table, name) {
  return table.rows.find((r) => r["Variable name"] === name);
}

export function noUnresolved(table) {
  return !table.warnings.some((w) => /could not resolve/i.test(w));
}

/**
 * A table `times` larger than `table`: every copy suffixes the variable names and the
 * category ids/titles (copy 0 keeps the originals). Each cloned row object is shared between
 * `rows` and its category, as buildViewModel identifies rows by object identity.
 */
export function cloneTable(table, times) {
  const rows = [];
  const categories = [];
  for (let t = 0; t < times; t += 1) {
    const suffix = t === 0 ? "" : `_${t}`;
    const clones = new Map(table.rows.map((row) => [row, { ...row, "Variable name": row["Variable name"] + suffix }]));
    const clone = (row) => clones.get(row) ?? { ...row, "Variable name": row["Variable name"] + suffix };
    rows.push(...clones.values());
    for (const cat of table.categories) {
      categories.push({ ...cat, id: cat.id + suffix, title: suffix ? `${cat.title} ${t}` : cat.title, rows: cat.rows.map(clone) });
    }
  }
  return { ...table, rows, categories };
}

/**
 * A compact, JSON-stable projection of everything a consumer sees in a table: row names,
 * categories, columns, value kinds/labels/conditions, constraint texts, provenance pointers and
 * the conditional rules. The golden files under fixtures/golden/ hold this projection for the
 * scalar-only fixtures, so a change to the extractor that alters their output fails loudly.
 */
export function projectTable(table) {
  return {
    title: table.title ?? null,
    categories: table.categories.map((c) => ({ id: c.id, title: c.title, rows: c.rows.map((r) => r["Variable name"]) })),
    rows: table.rows.map((r) => ({
      name: r["Variable name"],
      category: r.__category ?? null,
      description: r["Description"],
      type: r["Data type"],
      format: r["Format"],
      values: r["Valid values"].map((v) => [v.value, v.kind ?? null, v.label ?? null, v.description ?? null, v.condition ?? null]),
      constraints: r["Constraints"].map((c) => [c.keyword, c.text, c.condition ?? null]),
      additional: r["Additional information"],
      source: r.__source ? { uri: r.__source.uri, pointer: r.__source.pointer ?? null } : null
    })),
    conditionalRules: table.conditionalRules,
    warnings: table.warnings
  };
}

/**
 * A hand-built table with nested rows (no schema parsing): a `visits` array of objects two
 * levels deep, a hoisted array of numbers, a tuple, a nested object chain and an open map. The
 * `<b>note</b>` leaf checks escaping; "zip" occurs in exactly one row.
 */
export function nestedTable() {
  const row = (name, extra = {}) => ({
    "Variable name": name,
    "Description": "",
    "Data type": "string",
    "Format": "",
    "Valid values": [],
    "Constraints": [],
    "Additional information": null,
    __depth: 0,
    ...extra
  });
  const nested = (name, parent, depth, extra = {}) => row(name, { __parent: parent, __depth: depth, ...extra });
  const visits = [
    row("visits", { "Data type": "array of object", "Description": "Clinic visits attended", "Constraints": [{ keyword: "properties", text: "Fields: date, weight, labs, <b>note</b>" }] }),
    nested("visits[].date", "visits", 1, { "Data type": "date", "Description": "Visit date" }),
    nested("visits[].weight", "visits", 1, { "Data type": "number", "Description": "Weight in kilograms" }),
    nested("visits[].labs", "visits", 1, { "Data type": "array of object" }),
    nested("visits[].labs[].name", "visits[].labs", 2, { "Description": "Assay name" }),
    nested("visits[].<b>note</b>", "visits", 1, { "Description": "Free-text note" }),
    row("weights", {
      "Data type": "array of number + coded values",
      "Description": "Self-reported weight at each visit",
      "Valid values": [{ value: null, kind: "measurement", label: "20–300" }, { value: 888, kind: "sentinel", label: "Missing" }],
      "Constraints": [{ keyword: "items", text: "1–12 items" }, { keyword: "range", text: "Each item: 20 ≤ value ≤ 300" }]
    }),
    row("genotype", { "Data type": "array", "Constraints": [{ keyword: "prefixItems", text: "Exactly 2 item(s)" }] }),
    nested("genotype[0]", "genotype", 1, { "Data type": "categorical (string)", "Description": "First allele" })
  ];
  const contact = [
    row("contact", { "Data type": "object" }),
    nested("contact.address", "contact", 1, { "Data type": "object" }),
    nested("contact.address.zip", "contact.address", 2, { "Description": "Postal code" }),
    row("biomarkers", { "Data type": "object", "Description": "Assay concentrations" }),
    nested("biomarkers.*", "biomarkers", 1, { "Data type": "number" }),
    nested("biomarkers./^il_[0-9]+$/", "biomarkers", 1, { "Data type": "number", "Description": "Interleukin level" })
  ];
  const rows = [...visits, ...contact];
  return {
    title: "Nested",
    rows,
    categories: [
      { id: "visits", title: "Visits", rows: visits },
      { id: "contact", title: "Contact", rows: contact }
    ],
    conditionalRules: [],
    warnings: []
  };
}

/** One 130-row category whose `visits` group of 20 nested rows straddles a 20-row page boundary. */
export function nestedBigTable() {
  const row = (name, extra = {}) => ({
    "Variable name": name,
    "Description": `Synthetic ${name}`,
    "Data type": "integer",
    "Format": "",
    "Valid values": [],
    "Constraints": [],
    "Additional information": null,
    __depth: 0,
    ...extra
  });
  const pad = (i) => String(i).padStart(3, "0");
  const rows = [
    ...Array.from({ length: 90 }, (_, i) => row(`var_${pad(i)}`)),
    row("visits", { "Data type": "array of object" }),
    ...Array.from({ length: 20 }, (_, i) => row(`visits[].f${String(i).padStart(2, "0")}`, { __parent: "visits", __depth: 1 })),
    ...Array.from({ length: 19 }, (_, i) => row(`var_${pad(90 + i)}`))
  ];
  return { title: "Big nested", rows, categories: [{ id: "all", title: "All", rows }], conditionalRules: [], warnings: [] };
}
