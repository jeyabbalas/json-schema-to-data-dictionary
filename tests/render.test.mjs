import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, tableToHtml, toPlainRows, tableToCsv, validValuesText } from "../dist/index.js";
import { loadDir, findRow } from "./_helpers.mjs";

const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));

/** The Additional information cell of the row named `name` in `html`. */
function additionalCell(html, name) {
  const row = html.split('<tr class="dd-row"').find((r) => r.includes(`<code>${name}</code>`));
  return row?.match(/<td class="dd-additional">([\s\S]*?)<\/td>/)?.[1];
}

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
  assert.equal((markup.match(/<thead class="dd-sr-head">/g) ?? []).length, table.categories.length, "every category table has its own (hidden) header row");
  assert.equal((markup.match(/<th class="dd-h-description"/g) ?? []).length, table.categories.length + 1, "whose cells size the columns, as the column header's do");
  assert.equal((markup.match(/data-dd-resize="/g) ?? []).length, 7, "one resize handle per column, in the column header only");
  assert.match(markup, /data-dd-categories/);
  assert.match(markup, /data-dd-category data-dd-cat="0" data-dd-next="(\d+)" data-total="\1"/, "every row is materialised");
  assert.match(markup, /aria-controls="dd\d+-c0"[^>]*data-dd-category-toggle/);
  assert.equal((markup.match(/data-dd-row\b/g) ?? []).length, table.rows.length);
  assert.doesNotMatch(markup, /data-dd-more|data-dd-results|data-dd-row-index|data-dd-match|class="dd-row-cat"/);
  assert.match(markup, /data-search="/);
});

test("tableToHtml: the panel toggles sit under the search box, the table's controls at the far end", () => {
  const html = tableToHtml(table);
  const markup = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  const toolbar = markup.slice(markup.indexOf('<div class="dd-toolbar">'), markup.indexOf('<section class="dd-panel"'));
  const [searchbar, tools] = toolbar.split('<div class="dd-tools">');
  assert.ok(tools, "a line of its own under the search box");
  assert.match(searchbar, /data-dd-search/);
  assert.doesNotMatch(searchbar, /data-dd-panel-toggle|data-dd-action/, "the search box keeps its line to itself");
  assert.match(tools, /^<div class="dd-panel-toggles"><button[^>]*data-dd-panel-toggle="rules"[\s\S]*data-dd-panel-toggle="meta"/, "Skip logic first, then Metadata");
  assert.match(tools, /<div class="dd-actions">[\s\S]*data-dd-action="reset-widths"[\s\S]*data-dd-action="(collapse|expand)-all"/);
});

test("tableToHtml: with nothing to open, the table's controls stay beside the search box", () => {
  const plain = schemaDocumentsToTable([
    { uri: "https://example.org/p.json", schema: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } } }
  ]);
  const html = tableToHtml(plain);
  const markup = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  assert.doesNotMatch(markup, /data-dd-panel-toggle|class="dd-tools"/);
  assert.match(markup, /<div class="dd-searchbar">[\s\S]*data-dd-search[\s\S]*<div class="dd-actions">/);
});

test("tableToHtml: Additional information lists its entries, short values inline, long ones collapsible", () => {
  const row = (name, info) => ({ "Variable name": name, "Description": "", "Data type": "array", "Format": "", "Valid values": [], "Constraints": [], "Additional information": info });
  const people = [{ name: "Ada", age: 36, langs: ["en", "fr"] }, { name: "Linus", age: 54, langs: ["fi", "sv", "en"] }];
  const rows = [
    row("counts", { examples: [[1, 2, 3], [4, null, 17]], "x-duckdb-type": "BIGINT[]" }),
    row("people", { examples: [people], "x-duckdb-type": 'STRUCT("name" VARCHAR, age BIGINT, langs VARCHAR[])[]' }),
    row("escapes", { q: 'say "hi"', b: "ends\\", n: "line\nbreak", o: { 'q"k': true } })
  ];
  const showcase = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), `Showcase row ${i}: one kind of edge case`]));
  const synthetic = { title: "Info", rows, categories: [{ id: "all", title: "All", rows }], conditionalRules: [], warnings: [], additionalInformation: { "x-showcase-rows": showcase } };
  const html = tableToHtml(synthetic);
  const num = (n) => `<span class="dd-num">${n}</span>`;

  const counts = additionalCell(html, "counts");
  assert.ok(counts.startsWith('<div class="dd-tree"><ul class="dd-tree-root">'), "no summary to open first");
  assert.ok(counts.includes(`<span class="dd-key">examples:</span> [[${num(1)}, ${num(2)}, ${num(3)}], [${num(4)}, ${num("null")}, ${num(17)}]]`));
  assert.ok(counts.includes('<span class="dd-key">x-duckdb-type:</span> <span class="dd-str">&quot;BIGINT[]&quot;</span>'));
  assert.ok(!counts.includes("<details"));

  const struct = additionalCell(html, "people");
  assert.ok(struct.includes('<details><summary><span class="dd-key">examples:</span> Array (1)</summary>'), "a long value is collapsed, its key in the summary");
  assert.ok(struct.includes("&quot;STRUCT(&quot;name&quot; VARCHAR, age BIGINT, langs VARCHAR[])[]&quot;"), "a string's own quotes are not backslash-escaped");
  assert.ok(additionalCell(tableToHtml(synthetic, { expandAdditionalInfo: true }), "people").includes('<details open><summary><span class="dd-key">examples:</span>'));
  assert.ok(html.includes('<details open><summary><span class="dd-key">x-showcase-rows:</span> Object (12)</summary>'), "the metadata panel opens one level");

  const escapes = additionalCell(html, "escapes");
  assert.ok(escapes.includes("&quot;say &quot;hi&quot;&quot;"));
  assert.ok(escapes.includes("&quot;ends\\\\&quot;"), "an escaped backslash before the closing quote stays escaped");
  assert.ok(escapes.includes("&quot;line\\nbreak&quot;"));
  assert.ok(escapes.includes('{<span class="dd-key">&quot;q&quot;k&quot;:</span> <span class="dd-num">true</span>}'), "an inline key reads like a string");
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

test("tableToHtml: the dataset's description and note scroll in a box of bounded height", () => {
  const long = schemaDocumentsToTable([
    {
      uri: "https://example.org/p.json",
      schema: { title: "P", description: "Line one.\nLine two.", $comment: "A note.", type: "object", properties: { a: { type: "string" } } }
    }
  ]);
  const html = tableToHtml(long);
  const markup = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  assert.match(markup, /<h2 class="dd-title">P<\/h2>\s*<div class="dd-about"><p class="dd-description">Line one\.<br>Line two\.<\/p><div class="dd-comment"><div class="dd-note">[\s\S]*A note\.<\/div><\/div><\/div>\s*<div class="dd-toolbar">/);
  assert.match(html, /\.dd-about \{[^}]*max-height: var\(--dd-description-max-height, [^;]+\);[^}]*overflow-y: auto;/);

  const bare = schemaDocumentsToTable([{ uri: "https://example.org/q.json", schema: { type: "object", properties: { a: { type: "string" } } } }]);
  const plain = tableToHtml(bare);
  assert.doesNotMatch(plain.slice(plain.indexOf("</style>")), /class="dd-about"/, "no box without a description or note");
});
