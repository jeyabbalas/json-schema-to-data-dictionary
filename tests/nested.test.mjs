// Variables of any JSON type: arrays of scalars hoist their item rules into the row; objects,
// arrays of objects, arrays of arrays and tuples get one row per nested field, named by path.

import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, findSchemaRoots, formatVariablePath, sourceAt, toPlainRows, tableToCsv } from "../dist/index.js";
import { loadFile, findRow, noUnresolved } from "./_helpers.mjs";

const DOCS = loadFile("single_schema/longitudinal-cohort-dataset.json");
const T = schemaDocumentsToTable(DOCS);
const names = (table) => table.rows.map((r) => r["Variable name"]);
const texts = (row) => row["Constraints"].map((c) => c.text);
const value = (row, v) => row["Valid values"].find((x) => JSON.stringify(x.value) === JSON.stringify(v));
const obj = (properties, extra = {}) => ({ type: "object", properties, ...extra });

/** A one-document table whose row object holds `properties` (plus `$defs` and row-level keywords). */
function single(properties, defs = {}, rowExtra = {}) {
  return [
    {
      uri: "https://demo.local/probe.json",
      name: "probe.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.org/probe.json",
        title: "Probe",
        type: "array",
        items: { type: "object", properties, ...rowExtra },
        $defs: defs
      }
    }
  ];
}
const build = (properties, defs, rowExtra, options) => schemaDocumentsToTable(single(properties, defs, rowExtra), options);

test("the fixture resolves cleanly: one category, nested rows counted, top-level variables ranked", () => {
  assert.equal(T.title, "Longitudinal Cohort Dataset");
  assert.ok(noUnresolved(T), T.warnings.join(" | "));
  assert.deepEqual(T.warnings, []);
  assert.equal(T.categories.length, 1);
  assert.equal(T.categories[0].rows.length, T.rows.length);
  assert.equal(T.rows.length, 58);
  assert.equal(findSchemaRoots(DOCS)[0].variableCount, 21, "variableCount counts top-level properties only");
  assert.equal(T.rows.filter((r) => !r.__parent).length, 21);
});

// --- Arrays of scalars: hoisted into the row ---------------------------------------------------

test("an array of coded values lists the codes, sentinels included, as the variable's values", () => {
  const row = findRow(T, "comorbidities");
  assert.equal(row["Data type"], "array of categorical (string)");
  const diabetes = value(row, "diabetes");
  assert.equal(diabetes.kind, "value");
  assert.equal(diabetes.description, "Diabetes mellitus (type 1 or 2)");
  assert.equal(value(row, "not_collected").kind, "sentinel");
  assert.deepEqual(texts(row), ["Items must be unique"]);
  assert.ok(!T.rows.some((r) => r.__parent === "comorbidities"), "no child rows for scalar items");
});

test("an array of a measurement plus codes is a mixed type with the range per item", () => {
  const row = findRow(T, "pain_scores");
  assert.equal(row["Data type"], "array of integer + coded values");
  assert.equal(row["Valid values"].find((v) => v.kind === "measurement").label, "0–10");
  assert.equal(value(row, 999).kind, "sentinel");
  assert.deepEqual(texts(row), ["1–12 items", "Each item: Measured value: 0 ≤ value ≤ 10"]);
});

test("the item format and pattern become the row's Format", () => {
  assert.equal(findRow(T, "visits[].visit_date")["Data type"], "date");
  assert.match(findRow(T, "visits[].visit_date")["Format"], /ISO 8601/);
  const showcase = schemaDocumentsToTable(loadFile("single_schema/format-showcase-dataset.json"));
  assert.equal(findRow(showcase, "tags")["Data type"], "array of string");
  assert.equal(findRow(showcase, "tags")["Format"], "Matches pattern ^[a-z0-9-]+$");
  assert.equal(build({ dates: { type: "array", items: { type: "string", format: "date" } } }).rows[0]["Data type"], "array of date");
});

test("a nullable array and nullable items read differently", () => {
  const days = findRow(T, "hospital_days");
  assert.equal(days["Data type"], "array of integer (nullable)");
  assert.ok(texts(days).includes("Each item: value ≥ 0"));
  assert.equal(findRow(T, "daily_steps")["Data type"], "array of integer or null");
});

test("`contains` is rendered, with its counts", () => {
  const steps = texts(findRow(T, "daily_steps"));
  assert.ok(steps.includes("Must contain an item matching: integer ≥ 10000"), steps.join(" | "));
  assert.ok(steps.includes("At least 1 matching item(s)"));
});

test("x-value-kind on the items, and the items' extras, reach the row", () => {
  const row = findRow(T, "diet_flags");
  assert.equal(row["Data type"], "array of integer");
  assert.ok(row["Valid values"].length === 3 && row["Valid values"].every((v) => v.kind === "sentinel"));
  assert.deepEqual(row["Additional information"], { items: { examples: [7] } });
});

test("array edge cases: enum of arrays, items true, bare, closed, empty object", () => {
  const pairs = findRow(T, "allele_pairs");
  assert.equal(pairs["Data type"], "array");
  assert.equal(pairs["Valid values"].length, 3);
  assert.equal(value(pairs, ["A", "G"]).description, "Heterozygous");
  assert.equal(findRow(T, "tags")["Data type"], "array of any");
  assert.equal(findRow(T, "notes")["Data type"], "object");
  assert.deepEqual(texts(findRow(T, "notes")), []);
  assert.ok(!T.rows.some((r) => r.__parent === "allele_pairs" || r.__parent === "tags" || r.__parent === "notes"));

  const t = build({ bare: { type: "array" }, closed: { type: "array", items: false } });
  assert.equal(findRow(t, "bare")["Data type"], "array");
  assert.deepEqual(texts(findRow(t, "closed")), ["Must be empty (no items allowed)"]);
});

// --- Arrays of objects and objects: nested rows ------------------------------------------------

test("an array of objects keeps its row and is followed by one row per field, in schema order", () => {
  const all = names(T);
  const from = all.indexOf("visits");
  assert.deepEqual(all.slice(from, all.indexOf("baseline")), [
    "visits",
    "visits[].visit_date",
    "visits[].fasting",
    "visits[].weight_kg",
    "visits[].glucose_mmol",
    "visits[].labs",
    "visits[].labs.hba1c_pct",
    "visits[].labs.panel",
    "visits[].labs.panel.ldl",
    "visits[].labs.panel.hdl",
    "visits[].medications"
  ]);
});

test("the parent row describes the container", () => {
  const visits = findRow(T, "visits");
  assert.equal(visits["Data type"], "array of object");
  assert.deepEqual(visits["Valid values"], []);
  const t = texts(visits);
  for (const expected of ["Required", "At least 1 item(s)", "Fields: visit_date, fasting, weight_kg, glucose_mmol, labs, medications"]) {
    assert.ok(t.includes(expected), `${expected} in ${t.join(" | ")}`);
  }
  assert.match(visits["Description"], /Clinic visit/);
  assert.equal(findRow(T, "visits").__depth, 0);
  assert.equal(findRow(T, "visits").__parent, undefined);
});

test("nested rows carry their parent, depth, structured path and category", () => {
  const ldl = findRow(T, "visits[].labs.panel.ldl");
  assert.equal(ldl.__parent, "visits[].labs.panel");
  assert.equal(ldl.__depth, 3);
  assert.equal(ldl.__category, findRow(T, "visits").__category);
  assert.deepEqual(ldl.__path, [
    { kind: "property", name: "visits" },
    { kind: "items" },
    { kind: "property", name: "labs" },
    { kind: "property", name: "panel" },
    { kind: "property", name: "ldl" }
  ]);
  assert.equal(findRow(T, "visits[].labs").__depth, 1);
  assert.equal(findRow(T, "visits[].labs").__parent, "visits");
  assert.equal(findRow(T, "visits[].labs.panel").__depth, 2);
  assert.deepEqual(findRow(T, "visits").__path, [{ kind: "property", name: "visits" }]);
  assert.equal(formatVariablePath(ldl.__path), "visits[].labs.panel.ldl");
});

test("provenance points at the nested schema, through $defs and across documents", () => {
  const pointer = (name) => findRow(T, name).__source.pointer;
  assert.equal(pointer("visits[].visit_date"), "/$defs/visit/properties/visit_date");
  assert.equal(pointer("address.city"), "/properties/address/properties/city");
  assert.equal(pointer("genotype[0]"), "/properties/genotype/prefixItems/0");
  assert.equal(pointer("biomarkers.*"), "/properties/biomarkers/additionalProperties");
  assert.equal(pointer("biomarkers./^il_[0-9]+$/"), "/properties/biomarkers/patternProperties/^il_[0-9]+$");
  assert.equal(pointer("bp_readings[]"), "/properties/bp_readings/items");
  assert.equal(pointer("contact.email"), "/properties/contact/oneOf/1/properties/email");
  assert.equal(findRow(T, "visits[].visit_date").__source.uri, "https://example.org/schemas/longitudinal-cohort-dataset.json");

  const cross = schemaDocumentsToTable([
    {
      uri: "https://demo.local/t/table.json",
      name: "table.json",
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", items: obj({ visits: { type: "array", items: { $ref: "common/visit.json" } } }) }
    },
    {
      uri: "https://demo.local/t/common/visit.json",
      name: "visit.json",
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://schemas.example/common/visit.json", ...obj({ date: { type: "string", format: "date" } }, { required: ["date"] }) }
    }
  ]);
  assert.ok(noUnresolved(cross));
  assert.deepEqual(names(cross), ["visits", "visits[].date"]);
  assert.deepEqual(findRow(cross, "visits[].date").__source, { uri: "https://schemas.example/common/visit.json", pointer: "/properties/date", name: "visit.json" });
  assert.deepEqual(sourceAt({ uri: "u", pointer: "/a" }, { retrievalUri: "r", idBase: "i" }, ["properties", "x/y"]), { uri: "u", pointer: "/a/properties/x~1y" });
});

test("a field the enclosing object requires says so, and within what", () => {
  const required = (name) => findRow(T, name)["Constraints"].find((c) => c.keyword === "required");
  assert.deepEqual(required("visits[].visit_date"), { keyword: "required", value: true, text: "Required within visits[]" });
  assert.equal(required("visits[].weight_kg"), undefined);
  assert.equal(required("address.city").text, "Required within address");
  assert.equal(required("visits[].labs.hba1c_pct").text, "Required within visits[].labs");
  assert.equal(required("consent.signed").text, "Required within consent");
  assert.equal(required("participant_id").text, "Required");
  assert.ok(!T.rows.some((r) => r["Variable name"] === "consent.witness"), "a required name without a schema is not a row");
});

test("skip patterns inside a nested object are qualified by the path, once per use of the definition", () => {
  const rule = (condition) => T.conditionalRules.find((r) => r.condition === condition);
  assert.equal(T.conditionalRules[0].condition, "vital_status = 0", "row-level rules come first");
  assert.deepEqual(rule("visits[].fasting = 0").effects, [{ variable: "visits[].glucose_mmol", value: 999, label: "Missing" }]);
  assert.match(rule("visits[].fasting = 0").description, /non-fasting visit/);
  assert.ok(rule("baseline.fasting = 0"), "the same def used as an object gets its own rule");
  assert.equal(rule("fasting = 0"), undefined, "no unqualified rule");
  assert.equal(T.conditionalRules.length, 3);

  const glucose = findRow(T, "visits[].glucose_mmol");
  const code = value(glucose, 999);
  assert.equal(code.kind, "sentinel");
  assert.equal(code.condition, "visits[].fasting = 0");
  assert.ok(texts(glucose).includes("When visits[].fasting = 0, value = 999 (Missing)."));
  assert.equal(value(findRow(T, "death_year"), 777).condition, "vital_status = 0", "row-level rules still annotate top-level rows");
});

test("dependentRequired inside a nested object is qualified too", () => {
  assert.ok(texts(findRow(T, "visits[].fasting")).includes("Required when visits[].glucose_mmol is present."));
  assert.ok(texts(findRow(T, "visits[].glucose_mmol")).includes("When visits[].glucose_mmol is present, visits[].fasting is also required."));
  assert.ok(texts(findRow(T, "hospital_days")).includes("When hospital_days is present, visits is also required."));
  assert.ok(texts(findRow(T, "visits")).includes("Required when hospital_days is present."));
});

test("an object-shaped variable: fields, closedness, formats of the children", () => {
  const address = findRow(T, "address");
  assert.equal(address["Data type"], "object");
  assert.ok(texts(address).includes("Fields: street, city, postcode"));
  assert.ok(texts(address).includes("No other properties allowed"));
  assert.equal(findRow(T, "address.postcode")["Format"], "Matches pattern ^[0-9]{5}$");
  const all = names(T);
  assert.deepEqual(all.slice(all.indexOf("address"), all.indexOf("address") + 4), ["address", "address.street", "address.city", "address.postcode"]);
});

test("open maps, pattern properties and propertyNames", () => {
  const map = findRow(T, "biomarkers");
  assert.ok(texts(map).includes("Property names match pattern ^[a-z][a-z0-9_]*$"));
  assert.ok(texts(map).includes("At least 1 property"));
  const star = findRow(T, "biomarkers.*");
  assert.equal(star["Data type"], "number");
  assert.deepEqual(star["Constraints"][0], { keyword: "additionalProperties", text: "Any property name not listed above." });
  assert.ok(texts(star).includes("value ≥ 0"));
  const pattern = findRow(T, "biomarkers./^il_[0-9]+$/");
  assert.equal(pattern["Constraints"][0].keyword, "patternProperties");
  assert.equal(pattern.__parent, "biomarkers");

  const off = schemaDocumentsToTable(DOCS, { includeOpenContentRows: false, includePatternProperties: false });
  assert.ok(!names(off).some((n) => n.startsWith("biomarkers.")), "both kinds of open-content rows are optional");
  assert.ok(findRow(off, "biomarkers"));
});

test("tuples: one row per position", () => {
  const genotype = findRow(T, "genotype");
  assert.equal(genotype["Data type"], "array");
  assert.deepEqual(texts(genotype), ["Exactly 2 item(s)"]);
  for (const name of ["genotype[0]", "genotype[1]"]) {
    const slot = findRow(T, name);
    assert.equal(slot["Data type"], "categorical (string)");
    assert.equal(slot["Valid values"].length, 4);
    assert.equal(slot.__parent, "genotype");
    assert.equal(slot.__depth, 1);
  }
  assert.equal(findRow(T, "genotype[]"), undefined);

  const t = build({
    open: { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
    d7: { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false },
    partial: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false, minItems: 1 }
  });
  assert.equal(findRow(t, "open")["Data type"], "array of number");
  assert.deepEqual(texts(findRow(t, "open")), ["First 1 item(s) are positional"]);
  assert.ok(findRow(t, "open[0]"));
  assert.deepEqual(texts(findRow(t, "d7")), ["Up to 2 item(s)"], "without minItems a shorter array is valid");
  assert.equal(findRow(t, "d7")["Additional information"], null, "additionalItems is consumed, not passed through");
  assert.equal(findRow(t, "d7[1]")["Data type"], "integer");
  assert.equal(findRow(t, "d7[1]").__source.pointer, "/properties/d7/items/1");
  assert.deepEqual(texts(findRow(t, "partial")), ["1–2 items"]);
  const exact = build({ pair: { type: "array", prefixItems: [{ type: "string" }, { type: "string" }], items: false, minItems: 2, maxItems: 2 } });
  assert.deepEqual(texts(findRow(exact, "pair")), ["Exactly 2 item(s)"]);
});

test("an array of arrays gets a `name[]` row for the inner array", () => {
  const readings = findRow(T, "bp_readings");
  assert.equal(readings["Data type"], "array of array");
  assert.deepEqual(texts(readings), ["Each item: Exactly 2 item(s)"], "the pair's item count is the item's, not the array's");
  const inner = findRow(T, "bp_readings[]");
  assert.equal(inner.__parent, "bp_readings");
  assert.equal(inner.__depth, 1);
  assert.deepEqual(texts(inner), ["Exactly 2 item(s)"]);
  const systolic = findRow(T, "bp_readings[][0]");
  assert.equal(systolic.__parent, "bp_readings[]");
  assert.equal(systolic.__depth, 2);
  assert.deepEqual(texts(systolic), ["50 ≤ value ≤ 300"], "a tuple position is not an 'Each item' rule");

  const t = build({ matrix: { type: "array", items: { type: "array", items: { type: "number", minimum: 0 } } } });
  assert.equal(findRow(t, "matrix")["Data type"], "array of array of number");
  assert.deepEqual(texts(findRow(t, "matrix")), ["Each inner item: value ≥ 0"], "the inner element rule is kept on the parent, one level further in");
  assert.deepEqual(texts(findRow(t, "matrix[]")), ["Each item: value ≥ 0"]);
  assert.equal(findRow(t, "matrix[]")["Data type"], "array of number");
  const flat = build({ matrix: { type: "array", items: { type: "array", items: { type: "number", minimum: 0 }, minItems: 2 } } }, {}, {}, { expandNested: false });
  assert.deepEqual(texts(findRow(flat, "matrix")), ["Each item: At least 2 item(s)", "Each inner item: value ≥ 0"], "nothing is lost without the matrix[] row");
  assert.equal(findRow(flat, "matrix[]"), undefined);
});

test("a union of shapes lists every type and the fields of its object branch", () => {
  const contact = findRow(T, "contact");
  assert.equal(contact["Data type"], "email address or object");
  assert.match(contact["Format"], /Email address/);
  assert.ok(texts(contact).includes("Fields: email, phone"));
  for (const name of ["contact.email", "contact.phone"]) {
    const row = findRow(T, name);
    assert.deepEqual(row["Constraints"].find((c) => c.keyword === "oneOf"), { keyword: "oneOf", value: 1, text: "In variant 2 of contact" });
    assert.equal(row.__parent, "contact");
  }
  assert.deepEqual(
    findRow(T, "contact.email")["Constraints"].find((c) => c.keyword === "required"),
    { keyword: "required", value: true, text: "Required in variant 2 of contact" },
    "a branch's required holds in that variant only, and says so"
  );
  assert.equal(findRow(T, "contact.phone")["Constraints"].find((c) => c.keyword === "required"), undefined);

  // The object's own `required` applies to every field, whichever branch declares it.
  const t = build({
    c: { type: "object", required: ["id"], oneOf: [{ properties: { id: { type: "string" }, a: { type: "string" } } }, { properties: { id: { type: "integer" }, b: { type: "string" } }, required: ["b"] }] }
  });
  assert.deepEqual(names(t), ["c", "c.id", "c.a", "c.b"]);
  assert.deepEqual(texts(findRow(t, "c.id")), ["Required within c", "In variant 1 of c", "In variant 2 of c"]);
  assert.equal(findRow(t, "c.id")["Data type"], "string or integer", "a field declared by two branches is one row");
  assert.deepEqual(texts(findRow(t, "c.a")), ["In variant 1 of c"]);
  assert.deepEqual(texts(findRow(t, "c.b")), ["Required in variant 2 of c", "In variant 2 of c"]);
});

test("open content that says nothing gets no row: `additionalProperties: true` inside an object, as at the top level", () => {
  const t = build({
    m: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
    u: { type: "object", properties: { a: { type: "string" } }, unevaluatedProperties: true },
    open: { type: "object", additionalProperties: true },
    typed: { type: "object", additionalProperties: { type: "number" } }
  });
  assert.deepEqual(names(t), ["m", "m.a", "u", "u.a", "open", "typed", "typed.*"]);
  assert.equal(findRow(t, "typed.*")["Data type"], "number");
});

test("property names that could read as syntax are quoted in the path", () => {
  const t = build({ o: { type: "object", properties: { "a.b": { type: "string" }, "x]y": { type: "string" }, "/re/": { type: "string" }, "with space": { type: "string" }, "a/b": { type: "string" }, plain_1: { type: "string" } } } });
  assert.deepEqual(names(t), ["o", 'o["a.b"]', 'o["x]y"]', 'o["/re/"]', 'o["with space"]', "o.a/b", "o.plain_1"]);
  assert.deepEqual(findRow(t, 'o["/re/"]').__path, [{ kind: "property", name: "o" }, { kind: "property", name: "/re/" }]);
  assert.equal(findRow(t, 'o["/re/"]').__source.pointer, "/properties/o/properties/~1re~1");
});

test("unions of plain typed branches are typed (no more `any`)", () => {
  const t = build({
    either: { oneOf: [{ type: "string" }, obj({ a: { type: "integer" } })] },
    numornull: { anyOf: [{ type: "number" }, { type: "null" }] },
    dateorcode: { oneOf: [{ type: "string", format: "date" }, { const: 999, title: "Missing" }] },
    intorarr: { oneOf: [{ type: "integer" }, { type: "array", items: { type: "integer" } }] },
    bools: { anyOf: [{ type: "boolean" }, { type: "string" }] }
  });
  assert.equal(findRow(t, "either")["Data type"], "string or object");
  assert.ok(findRow(t, "either.a"));
  assert.equal(findRow(t, "numornull")["Data type"], "number (nullable)");
  assert.equal(findRow(t, "dateorcode")["Data type"], "date");
  assert.equal(value(findRow(t, "dateorcode"), 999).kind, "sentinel");
  assert.equal(findRow(t, "intorarr")["Data type"], "integer or array of integer");
  assert.equal(findRow(t, "bools")["Data type"], "boolean or string");
});

test("a recursive definition is expanded once and then noted", () => {
  const follow = findRow(T, "events[].follow_ups");
  assert.equal(follow["Data type"], "array of object");
  assert.deepEqual(follow["Constraints"].find((c) => c.keyword === "recursive"), { keyword: "recursive", text: "Recursive structure: same shape as events[]" });
  assert.ok(texts(follow).includes("Fields: event_type, event_date, follow_ups"), "the fields are still named");
  assert.ok(!names(T).some((n) => n.startsWith("events[].follow_ups[")), "nothing below the recursion");

  const t = build(
    { node: { $ref: "#/$defs/node" }, self: { $ref: "#/items" } },
    { node: obj({ value: { type: "integer" }, next: { $ref: "#/$defs/node" } }) }
  );
  assert.deepEqual(names(t), ["node", "node.value", "node.next", "self"]);
  assert.equal(findRow(t, "node.next")["Constraints"].find((c) => c.keyword === "recursive").text, "Recursive structure: same shape as node");
  assert.equal(findRow(t, "self")["Constraints"].find((c) => c.keyword === "recursive").text, "Recursive structure: same shape as the record");
  assert.deepEqual(t.warnings, []);
});

test("maxNestingDepth caps the rows and says so", () => {
  const chain = obj({ b: obj({ c: obj({ d: obj({ e: obj({ f: obj({ g: obj({ h: { type: "string" } }) }) }) }) }) }) });
  const deep = build({ deep: chain });
  assert.ok(findRow(deep, "deep.b.c.d.e.f.g"), "depth 6 is emitted by default");
  assert.equal(findRow(deep, "deep.b.c.d.e.f.g.h"), undefined);
  assert.equal(findRow(deep, "deep.b.c.d.e.f.g")["Constraints"].find((c) => c.keyword === "maxNestingDepth").text, "Nested fields not expanded (nesting depth limit reached)");
  assert.deepEqual(deep.warnings, ['Nested fields of "deep.b.c.d.e.f.g" were not expanded: nesting depth limit reached (maxNestingDepth = 6).']);

  const two = build({ deep: chain }, {}, {}, { maxNestingDepth: 2 });
  assert.deepEqual(names(two), ["deep", "deep.b", "deep.b.c"]);
  const zero = build({ deep: chain, x: { type: "string" } }, {}, {}, { maxNestingDepth: 0 });
  assert.deepEqual(names(zero), ["deep", "x"]);
  assert.equal(zero.warnings.length, 1);
});

test("expandNested: false keeps one row per property, with the hoisted item rules and the field list", () => {
  const flat = schemaDocumentsToTable(DOCS, { expandNested: false });
  assert.equal(flat.rows.length, 21);
  assert.ok(flat.rows.every((r) => r.__parent === undefined && r.__depth === 0));
  assert.ok(texts(findRow(flat, "visits")).includes("Fields: visit_date, fasting, weight_kg, glucose_mmol, labs, medications"));
  assert.equal(findRow(flat, "comorbidities")["Valid values"].length, 5);
  assert.equal(flat.conditionalRules.length, 1, "nested rules need the nested rows");
});

test("edge schemas: boolean property schemas, odd property names, empty required", () => {
  const t = build({
    bools: obj({ yes: true, no: false }),
    odd: obj({ "a.b": { type: "string" }, "sp ace": { type: "integer" }, "x[y]": { type: "boolean" } })
  });
  assert.equal(findRow(t, "bools.yes")["Data type"], "any");
  assert.deepEqual(texts(findRow(t, "bools.no")), ["No value is valid (schema is false)."]);
  assert.deepEqual(names(t).slice(3), ["odd", 'odd["a.b"]', 'odd["sp ace"]', 'odd["x[y]"]']);
  assert.ok(texts(findRow(t, "odd")).includes("Fields: a.b, sp ace, x[y]"));
  assert.equal(formatVariablePath([{ kind: "property", name: "a" }, { kind: "items" }, { kind: "property", name: "b" }, { kind: "index", index: 2 }, { kind: "additional", keyword: "additionalProperties" }, { kind: "pattern", pattern: "^x$" }]), "a[].b[2].*./^x$/");
  assert.equal(formatVariablePath([{ kind: "pattern", pattern: "^x$" }]), "/^x$/");
  assert.equal(formatVariablePath([{ kind: "additional", keyword: "unevaluatedProperties" }]), "(unevaluated properties)");
});

test("a parent declared by two branches of one category merges once, its children contiguous", () => {
  const docs = [
    {
      uri: "https://demo.local/t/categories/vars.json",
      name: "vars.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        title: "Vars",
        properties: { other: { type: "string" } },
        allOf: [
          { properties: { address: obj({ street: { type: "string" }, city: { type: "string" } }) } },
          { properties: { address: obj({ country: { type: "string" } }, { description: "Country added by a second branch" }) } }
        ]
      }
    },
    {
      uri: "https://demo.local/t/t.schema.json",
      name: "t.schema.json",
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", title: "T", type: "array", items: { type: "object", allOf: [{ $ref: "categories/vars.json" }] } }
    }
  ];
  const t = schemaDocumentsToTable(docs);
  assert.deepEqual(names(t), ["other", "address", "address.street", "address.city", "address.country"]);
  assert.equal(t.rows.filter((r) => r["Variable name"] === "address").length, 1);
  assert.deepEqual(texts(findRow(t, "address")), ["Fields: street, city", "Fields: country"]);
});

test("exports and determinism: every nested row is a plain row, in order", () => {
  const plain = toPlainRows(T);
  assert.equal(plain.length, T.rows.length);
  assert.equal(plain[3]["Variable name"], "visits[].visit_date");
  const lines = tableToCsv(T).split("\r\n");
  const visits = lines.findIndex((l) => l.startsWith("visits,"));
  assert.ok(lines[visits + 1].startsWith("visits[].visit_date,"), lines[visits + 1]);
  assert.deepEqual(names(schemaDocumentsToTable(DOCS)), names(T));
});
