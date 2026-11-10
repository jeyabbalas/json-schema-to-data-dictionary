// A `null` the schema names -- `{ "const": null, "title": "Missing (Unknown; Passthru)" }` -- is a
// special code like a titled `{ "const": 9 }`, listed as `null = Missing (Unknown; Passthru)` in
// the table, the CSV and the workbook (issue #3). An untitled null only makes the variable
// "(nullable)".

import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { schemaDocumentsToTable, tableToCsv, tableToHtml, tableToXlsx } from "../dist/index.js";
import { findRow } from "./_helpers.mjs";

const passthru = { const: null, title: "Missing (Unknown; Passthru)", "x-value-kind": "sentinel" };

function dictionary(properties) {
  return schemaDocumentsToTable([
    { uri: "https://example.org/study.json", schema: { type: "array", items: { type: "object", properties } } }
  ]);
}

test("a titled null branch is listed among the special codes (issue #3)", () => {
  const table = dictionary({ diabp: { title: "Diastolic blood pressure", oneOf: [{ const: "<65" }, { const: "65-74" }, passthru] } });
  const row = findRow(table, "diabp");
  assert.equal(row["Data type"], "categorical (string) (nullable)");
  assert.deepEqual(
    row["Valid values"].map((v) => [v.value, v.label, v.kind]),
    [
      ["<65", undefined, "value"],
      ["65-74", undefined, "value"],
      [null, "Missing (Unknown; Passthru)", "sentinel"]
    ]
  );
  assert.deepEqual(table.warnings, []);
});

test("it reads as null = label in the CSV, the HTML and the workbook", async () => {
  const table = dictionary({ diabp: { title: "Diastolic blood pressure", oneOf: [{ const: "<65" }, { const: "65-74" }, passthru] } });
  assert.match(tableToCsv(table), /Special codes:\nnull = Missing \(Unknown; Passthru\)/);
  assert.match(tableToHtml(table), /special codes[\s\S]*null[\s\S]*Missing \(Unknown; Passthru\)/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await tableToXlsx(table));
  const cells = [];
  workbook.getWorksheet("Data dictionary").eachRow((r) => r.eachCell((c) => cells.push(c.value?.richText ? c.value.richText.map((t) => t.text).join("") : String(c.value ?? ""))));
  assert.ok(cells.includes("<65\n65-74\nSpecial codes\nnull  Missing (Unknown; Passthru)"));
});

test("a skip pattern conditioned on the null code names it by its label", () => {
  const table = schemaDocumentsToTable([
    {
      uri: "https://example.org/study.json",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: { diabp: { oneOf: [{ const: "<65" }, { const: "65-74" }, passthru] }, med: { enum: ["0", "1"] } },
          allOf: [{ if: { properties: { diabp: { const: null } }, required: ["diabp"] }, then: { properties: { med: { const: "0" } } } }]
        }
      }
    }
  ]);
  assert.equal(findRow(table, "med")["Valid values"][0].condition, "diabp = null (Missing (Unknown; Passthru))");
});

test("an untitled null branch only makes the variable nullable", () => {
  const table = dictionary({
    a: { oneOf: [{ const: "<65" }, { const: "65-74" }, { const: null }] },
    b: { enum: ["<65", "65-74", null] },
    c: { oneOf: [{ const: "<65" }, { const: "65-74" }, { type: "null" }] },
    d: { oneOf: [{ const: "<65" }, { const: "65-74" }, { const: null, title: "  " }] }
  });
  for (const name of ["a", "b", "c", "d"]) {
    const row = findRow(table, name);
    assert.equal(row["Data type"], "categorical (string) (nullable)", name);
    assert.deepEqual(row["Valid values"].map((v) => v.value), ["<65", "65-74"], name);
  }
});

test("a titled null is a special code whatever its wording, unless x-value-kind says it is an answer", () => {
  const table = dictionary({
    guessed: { oneOf: [{ const: 1, title: "Yes" }, { const: 2, title: "No" }, { const: null, title: "Passthru" }] },
    described: { oneOf: [{ const: 1, title: "Yes" }, { const: 2, title: "No" }, { const: null, description: "Skipped by the interviewer" }] },
    answer: { oneOf: [{ const: 1, title: "Yes" }, { const: 2, title: "No" }, { const: null, title: "No preference", "x-value-kind": "value" }] }
  });
  assert.deepEqual(findRow(table, "guessed")["Valid values"].at(-1), {
    value: null,
    label: "Passthru",
    kind: "sentinel",
    source: findRow(table, "guessed")["Valid values"].at(-1).source
  });
  assert.equal(findRow(table, "described")["Valid values"].at(-1).description, "Skipped by the interviewer");
  assert.equal(findRow(table, "described")["Valid values"].at(-1).kind, "sentinel");
  assert.equal(findRow(table, "answer")["Valid values"].at(-1).kind, "value");
  assert.equal(findRow(table, "answer")["Data type"], "categorical (integer) (nullable)");
});

test("a shared null definition, an enum description and a measured value all keep the label", () => {
  const table = schemaDocumentsToTable([
    { uri: "https://example.org/common/defs.json", schema: { $defs: { passthru } } },
    {
      uri: "https://example.org/study.json",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            shared: { oneOf: [{ const: "<65" }, { const: "65-74" }, { $ref: "common/defs.json#/$defs/passthru" }] },
            listed: { enum: [1, 2, null], "x-enumDescriptions": { 1: "Yes", 2: "No", null: "Not asked" } },
            measured: { oneOf: [{ type: "integer", minimum: 40, maximum: 140 }, { const: 999, title: "Unknown" }, passthru] },
            single: { oneOf: [{ const: "<65" }, passthru] }
          }
        }
      }
    }
  ]);
  const last = (name) => findRow(table, name)["Valid values"].at(-1);
  assert.deepEqual([last("shared").value, last("shared").label, last("shared").kind], [null, "Missing (Unknown; Passthru)", "sentinel"]);
  assert.deepEqual([last("listed").value, last("listed").description, last("listed").kind], [null, "Not asked", "sentinel"]);
  assert.equal(findRow(table, "listed")["Data type"], "categorical (integer) (nullable)");
  assert.equal(findRow(table, "measured")["Data type"], "integer + coded values (nullable)");
  assert.deepEqual(findRow(table, "measured")["Valid values"].map((v) => [v.value, v.kind]), [[null, "measurement"], [999, "sentinel"], [null, "sentinel"]]);
  // One code and a labelled null is not a categorical: the null is what "(nullable)" already says.
  assert.equal(findRow(table, "single")["Data type"], "string (nullable)");
  assert.deepEqual(table.warnings, []);
});

test("a nullable item's titled null is listed with the item's codes", () => {
  const table = dictionary({ readings: { type: "array", items: { oneOf: [{ const: "<65" }, { const: "65-74" }, passthru] } } });
  const row = findRow(table, "readings");
  assert.equal(row["Data type"], "array of nullable categorical (string)");
  assert.deepEqual(row["Valid values"].map((v) => [v.value, v.kind]), [["<65", "value"], ["65-74", "value"], [null, "sentinel"]]);
});
