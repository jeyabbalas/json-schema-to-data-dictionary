import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable } from "../dist/index.js";
import { loadDir, loadFile, findRow, noUnresolved } from "./_helpers.mjs";

test("BCRPP: resolves all cross-file refs, builds category subheadings", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  assert.ok(noUnresolved(table), `unexpected unresolved refs: ${table.warnings.join(" | ")}`);
  assert.equal(table.title, "BCRPP - CORE table");
  assert.ok(typeof table.description === "string" && table.description.length > 0);

  const titles = table.categories.map((c) => c.title);
  assert.ok(titles.includes("CORE — Demographics"), `categories: ${titles.join(", ")}`);
  assert.ok(titles.some((t) => /Identification/.test(t)));
  assert.ok(table.rows.length > 40, `rows: ${table.rows.length}`);
});

test("BCRPP: mixed measurement + sentinel codes (meno_age)", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const meno = findRow(table, "meno_age");
  assert.ok(meno, "meno_age row exists");
  assert.match(meno["Data type"], /number \+ coded values/);

  const kinds = meno["Valid values"].map((v) => v.kind);
  assert.ok(kinds.includes("measurement"), "has a measurement entry");
  assert.ok(kinds.includes("sentinel"), "has sentinel entries");

  const measurement = meno["Valid values"].find((v) => v.kind === "measurement");
  assert.match(measurement.label, /20.*65/);

  const v777 = meno["Valid values"].find((v) => v.value === 777);
  assert.ok(v777, "777 is present");
  assert.equal(v777.kind, "sentinel");
  assert.match(String(v777.label ?? ""), /Premenopausal/);
  assert.match(String(v777.condition ?? ""), /meno_status/, "777 carries its skip-pattern condition");

  assert.ok(meno["Valid values"].some((v) => v.value === 888), "888 missing code present");

  // The numeric range is communicated as a constraint, tagged as the measured value.
  assert.ok(meno["Constraints"].some((c) => /20/.test(c.text) && /65/.test(c.text)));
});

test("BCRPP: oneOf categoricals with a missing sentinel (race)", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const race = findRow(table, "race");
  assert.ok(race);
  assert.match(race["Data type"], /categorical/);
  assert.ok(race["Valid values"].some((v) => v.value === 1 && /White/.test(v.label ?? "")));
  const missing = race["Valid values"].find((v) => v.value === 888);
  assert.ok(missing, "888 present");
  assert.equal(missing.kind, "sentinel");
  assert.match(String(missing.label ?? missing.description ?? ""), /missing/i);
  // race is required in the demographics category.
  assert.ok(race["Constraints"].some((c) => c.keyword === "required"));
});

test("BCRPP: 4-digit sentinel and bare-$ref property", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const birthYear = findRow(table, "birth_year");
  assert.match(birthYear["Data type"], /integer \+ coded values/);
  assert.ok(birthYear["Valid values"].some((v) => v.value === 8888));

  const subjectId = findRow(table, "subject_id"); // property is just {$ref: .../subject_id}
  assert.ok(subjectId);
  assert.match(subjectId["Data type"], /string/);
  assert.ok(subjectId["Format"].length > 0, "pattern surfaces in Format");
  assert.match(subjectId["Description"], /Subject ID/);
});

test("BCRPP: plain measurement has no valid-value codes", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const age = findRow(table, "age");
  assert.equal(age["Data type"], "integer");
  assert.equal(age["Valid values"].length, 0);
  assert.ok(age["Constraints"].some((c) => /120/.test(c.text)));
});

test("BCRPP: skip patterns become conditional rules", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  assert.ok(table.conditionalRules.length > 5, `conditionalRules: ${table.conditionalRules.length}`);
  const menoRule = table.conditionalRules.find((r) => /meno_status/.test(r.condition));
  assert.ok(menoRule, "found a meno_status rule");
  assert.ok(menoRule.effects.some((e) => e.variable === "meno_age"));
});

test("multiple_schema_1: allOf categories from external refs", () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_1"));
  assert.ok(noUnresolved(table), table.warnings.join(" | "));
  assert.equal(table.title, "Clinical Trial Dataset");
  const titles = table.categories.map((c) => c.title);
  assert.ok(titles.includes("Patient Demographics"), `categories: ${titles.join(", ")}`);
  assert.ok(titles.includes("Laboratory Results"));
  assert.ok(titles.includes("Adverse Events"));
  assert.ok(table.rows.length > 0);
});

test("single covid dataset: enum descriptions and dependentRequired", () => {
  const table = schemaDocumentsToTable(loadFile("single_schema/covid-patient-dataset.json"));
  assert.equal(table.title, "COVID-19 Patient Surveillance Dataset");

  const ageGroup = findRow(table, "age_group");
  assert.ok(ageGroup);
  assert.match(ageGroup["Data type"], /categorical/);
  assert.ok(ageGroup["Valid values"].some((v) => /Young adults/.test(v.label ?? v.description ?? "")));

  const patientId = findRow(table, "patient_id");
  assert.ok(patientId && patientId["Format"].length > 0, "pattern -> Format");

  // dependentRequired produces conditional constraints somewhere in the table.
  assert.ok(table.rows.some((r) => r["Constraints"].some((c) => c.keyword === "conditional" || /when .*present/i.test(c.text))));
});

test("single format showcase: built-in string formats map to data types", () => {
  const table = schemaDocumentsToTable(loadFile("single_schema/format-showcase-dataset.json"));
  assert.match(findRow(table, "created_datetime")["Data type"], /timestamp/);
  assert.match(findRow(table, "created_date")["Data type"], /date/);
  assert.match(findRow(table, "session_uuid")["Data type"], /UUID/);
  assert.match(findRow(table, "session_uuid")["Format"], /RFC 4122|123e4567/);
  assert.match(findRow(table, "contact_email")["Data type"], /email/);
  assert.match(findRow(table, "server_ipv4")["Data type"], /IPv4/);
});
