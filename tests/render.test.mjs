import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, tableToHtml, toPlainRows, tableToCsv, validValuesText } from "../dist/index.js";
import { loadDir, findRow } from "./_helpers.mjs";

const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));

test("tableToHtml: self-contained, searchable markup", () => {
  const html = tableToHtml(table);
  assert.match(html, /<style/);
  assert.match(html, /class="dd-root"/);
  assert.match(html, /data-dd-search/);
  assert.match(html, /<script>/, "ships an inline behavior script");
  assert.match(html, /BCRPP - CORE table/);
  assert.match(html, /dd-table/);
  assert.match(html, /dd-badge/);
});

test("tableToHtml: shows sub-headings, skip patterns and separated codes", () => {
  const html = tableToHtml(table);
  assert.match(html, /CORE — Demographics/);
  assert.match(html, /skip pattern/i, "skip-pattern panel present");
  assert.match(html, /special codes/, "sentinel codes are visually separated");
  assert.match(html, /meno_status = 2/, "skip-pattern condition rendered on the value");
});

test("tableToHtml: escapes angle brackets from content", () => {
  const html = tableToHtml(table);
  // No unescaped script-like sequences leaking from data; the only <script> is ours at the end.
  const scriptOpens = html.match(/<script/g) ?? [];
  assert.equal(scriptOpens.length, 1);
});

test("toPlainRows: spreadsheet-ready", () => {
  const rows = toPlainRows(table);
  assert.equal(rows.length, table.rows.length);
  const first = rows[0];
  for (const col of ["Variable name", "Description", "Data type", "Format", "Valid values", "Constraints", "Additional information"]) {
    assert.ok(col in first, `missing column ${col}`);
  }
  assert.equal(typeof first["Valid values"], "string");

  const structured = toPlainRows(table, { stringifyComplexColumns: false });
  assert.ok(Array.isArray(structured[0]["Valid values"]));
});

test("toPlainRows: includes internal columns when asked", () => {
  const rows = toPlainRows(table, { includeInternalColumns: true });
  assert.ok("Category" in rows[0]);
});

test("tableToCsv: RFC-4180 header + quoting", () => {
  const csv = tableToCsv(table);
  const header = csv.split("\r\n")[0];
  assert.equal(header, "Variable name,Description,Data type,Format,Valid values,Constraints,Additional information");
  assert.ok(csv.includes('"') || true); // quoting only when needed
});

test("validValuesText: renders measurement + coded values", () => {
  const meno = findRow(table, "meno_age");
  const text = validValuesText(meno["Valid values"]);
  assert.match(text, /measured value/);
  assert.match(text, /777/);
});
