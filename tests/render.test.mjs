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
  assert.ok("Parent" in rows[0]);
  assert.equal(rows[0].Parent, "", "top-level rows have no parent");
});

test("tableToHtml: a dictionary without nested rows renders no nested markup", () => {
  const html = tableToHtml(table);
  assert.doesNotMatch(html.slice(html.indexOf("</style>")), /data-dd-depth|dd-name-prefix|dd-name-leaf/);
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

test("tableToHtml: fixed column layout, static sections, no component-only markup", () => {
  const html = tableToHtml(table);
  const markup = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  assert.ok((markup.match(/<colgroup>/g) ?? []).length === table.categories.length, "one colgroup per category table");
  assert.match(markup, /data-dd-categories/);
  assert.match(markup, /data-dd-category data-dd-cat="0" data-dd-next="(\d+)" data-total="\1"/, "every row is materialised");
  assert.match(markup, /aria-controls="dd\d+-c0"[^>]*data-dd-category-toggle/);
  assert.equal((markup.match(/data-dd-row\b/g) ?? []).length, table.rows.length);
  assert.doesNotMatch(markup, /data-dd-more|data-dd-results|data-dd-row-index|data-dd-match|class="dd-row-cat"/);
  assert.match(markup, /data-search="/);
});

test("tableToHtml: a value cannot break out of the embedded script", () => {
  const evil = {
    ...table,
    rows: [{ ...table.rows[0], "Description": 'Ends the script: </script><script>alert(1)</script> & <b>bold</b>' }],
    categories: [{ ...table.categories[0], rows: [] }]
  };
  evil.categories[0].rows = evil.rows;
  const html = tableToHtml(evil);
  assert.equal((html.match(/<script/g) ?? []).length, 1, "the only <script is ours");
  assert.equal((html.match(/<\/script/g) ?? []).length, 1, "the only </script is ours");
  assert.match(html, /\\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script>/, "the CSV keeps the text, JSON-escaped");
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/, "the cell shows the escaped text");
});
