// Rendering, search and export of nested rows: the view model splits a path into a muted
// prefix and a bold leaf, category tables indent by depth, the ranked results list shows the
// full path unindented, and every nested row is an ordinary row for the filter and the CSV.

import test from "node:test";
import assert from "node:assert/strict";
import { nestedTable, nestedBigTable } from "./_helpers.mjs";

let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}

const { buildViewModel, splitVariableName, renderDataDictionary, tableToHtml, tableToCsv, toPlainRows } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";

function mount(table, options) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, table, options);
  return { container, el, root: el.shadowRoot ?? el };
}
function type(root, value) {
  const input = root.querySelector("[data-dd-search]");
  input.value = value;
  input.dispatchEvent(new Event("input"));
}
const categoryRows = (root) => [...root.querySelectorAll("[data-dd-categories] [data-dd-row]")];
const resultRows = (root) => [...root.querySelectorAll("[data-dd-results-body] [data-dd-row]")];
const names = (rows) => rows.map((r) => r.querySelector("code").textContent);
const rowNamed = (rows, name) => rows.find((r) => r.querySelector("code").textContent === name);

test("splitVariableName: the parent's length fixes the split, whatever the syntax", () => {
  assert.deepEqual(splitVariableName("visits[].date", "visits"), ["visits[].", "date"]);
  assert.deepEqual(splitVariableName("visits[*].date", "visits"), ["visits[*].", "date"]);
  assert.deepEqual(splitVariableName("visits.date", "visits"), ["visits.", "date"]);
  assert.deepEqual(splitVariableName("address.city", "address"), ["address.", "city"]);
  assert.deepEqual(splitVariableName("contact.address.zip", "contact.address"), ["contact.address.", "zip"]);
  assert.deepEqual(splitVariableName("visits[].labs[].value", "visits[].labs"), ["visits[].labs[].", "value"]);
  assert.deepEqual(splitVariableName("genotype[0]", "genotype"), ["genotype", "[0]"]);
  assert.deepEqual(splitVariableName("bp_readings[][0]", "bp_readings[]"), ["bp_readings[]", "[0]"]);
  assert.deepEqual(splitVariableName("matrix[]", "matrix"), ["matrix", "[]"]);
  assert.deepEqual(splitVariableName('odd["a.b"]', "odd"), ["odd", '["a.b"]']);
  assert.deepEqual(splitVariableName('odd["x]y"]', "odd"), ["odd", '["x]y"]'], "a `]` inside the quotes does not close the group");
  assert.deepEqual(splitVariableName('odd["x]y"].z', 'odd["x]y"]'), ['odd["x]y"].', "z"]);
  assert.deepEqual(splitVariableName('odd["a\\"b"].z', "odd"), ['odd["a\\"b"].', "z"], "an escaped quote is part of the name");
  assert.deepEqual(splitVariableName('odd["a.b"][0]', 'odd["a.b"]'), ['odd["a.b"]', "[0]"]);
  assert.deepEqual(splitVariableName('odd["unterminated', "odd"), ["", 'odd["unterminated']);
  assert.deepEqual(splitVariableName("biomarkers.*", "biomarkers"), ["biomarkers.", "*"]);
  assert.deepEqual(splitVariableName("biomarkers./^il_[0-9]+$/", "biomarkers"), ["biomarkers.", "/^il_[0-9]+$/"]);
  // Nothing to split: no parent, a parent that is not a prefix, an empty leaf, an unclosed bracket.
  assert.deepEqual(splitVariableName("age", undefined), ["", "age"]);
  assert.deepEqual(splitVariableName("visits[].date", "nope"), ["", "visits[].date"]);
  assert.deepEqual(splitVariableName("visits.", "visits"), ["", "visits."]);
  assert.deepEqual(splitVariableName("visits[", "visits"), ["", "visits["]);
  assert.deepEqual(splitVariableName("visits", "visits"), ["", "visits"]);
});

test("buildViewModel: nested rows get depth, parent and the prefix/leaf split; top-level rows do not", () => {
  const vm = buildViewModel(nestedTable());
  const rows = new Map(vm.categories.flatMap((c) => c.rows).map((r) => [r.name, r]));
  const date = rows.get("visits[].date");
  assert.equal(date.depth, 1);
  assert.equal(date.parent, "visits");
  assert.equal(date.namePrefix, "visits[].");
  assert.equal(date.nameLeaf, "date");
  assert.equal(date.searchFields.name, "visits[].date");
  const labName = rows.get("visits[].labs[].name");
  assert.equal(labName.depth, 2);
  assert.equal(labName.namePrefix + labName.nameLeaf, labName.name);
  const visits = rows.get("visits");
  assert.equal(visits.depth, 0);
  assert.equal(visits.parent, undefined);
  assert.equal(visits.namePrefix, "");
  assert.equal(visits.nameLeaf, "visits");

  const odd = nestedTable();
  odd.rows[1].__parent = "nope";
  odd.rows[2].__depth = -1;
  odd.rows[3].__depth = NaN;
  const oddVm = buildViewModel(odd);
  const oddRows = new Map(oddVm.categories.flatMap((c) => c.rows).map((r) => [r.name, r]));
  assert.deepEqual([oddRows.get("visits[].date").namePrefix, oddRows.get("visits[].date").nameLeaf], ["", "visits[].date"]);
  assert.equal(oddRows.get("visits[].weight").depth, 0);
  assert.equal(oddRows.get("visits[].labs").depth, 0);
});

test("component: nested rows render indented with the prefix/leaf markup, in category order", { skip }, () => {
  const table = nestedTable();
  const { root } = mount(table);
  const rows = categoryRows(root);
  assert.deepEqual(names(rows), table.rows.map((r) => r["Variable name"]));
  assert.equal(rows.filter((r) => r.dataset.ddDepth === "1").length, table.rows.filter((r) => r.__depth === 1).length);
  assert.equal(rows.filter((r) => r.dataset.ddDepth === "2").length, 2);

  const date = rowNamed(rows, "visits[].date");
  assert.equal(date.querySelector("code").textContent, "visits[].date");
  assert.equal(date.querySelector(".dd-name-prefix").textContent, "visits[].");
  assert.equal(date.querySelector(".dd-name-leaf").textContent, "date");
  const slot = rowNamed(rows, "genotype[0]");
  assert.equal(slot.querySelector(".dd-name-prefix").textContent, "genotype");
  assert.equal(slot.querySelector(".dd-name-leaf").textContent, "[0]");
  const visits = rowNamed(rows, "visits");
  assert.equal(visits.dataset.ddDepth, undefined);
  assert.equal(visits.querySelector(".dd-name-prefix"), null);
  assert.equal(visits.querySelector("code").textContent, "visits");
});

test("component: a leaf name is escaped, highlighted or not", { skip }, () => {
  const { root } = mount(nestedTable());
  assert.equal(root.querySelector("b"), null, "markup in a name never becomes an element");
  assert.equal(rowNamed(categoryRows(root), "visits[].<b>note</b>").querySelector(".dd-name-leaf").textContent, "<b>note</b>");
  type(root, "note");
  const hit = rowNamed(resultRows(root), "visits[].<b>note</b>");
  assert.ok(hit, "the row is found by its leaf");
  assert.equal(root.querySelector("b"), null);
  assert.equal(hit.querySelector(".dd-name-leaf mark.dd-hit").textContent, "note");
});

test("component: searching by leaf, parent, full path or words surfaces nested rows, unindented", { skip }, () => {
  const table = nestedTable();
  const { root } = mount(table);
  const total = table.rows.length;

  type(root, "date");
  let rows = resultRows(root);
  const date = rowNamed(rows, "visits[].date");
  assert.ok(date, `results: ${names(rows).join(", ")}`);
  assert.equal(date.dataset.ddDepth, undefined, "no indentation out of context");
  assert.equal(date.querySelector(".dd-name-prefix").textContent, "visits[].");
  assert.equal(date.querySelector(".dd-name-leaf mark.dd-hit").textContent, "date");
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${rows.length} / ${total} variables`);
  assert.ok(rows.every((r) => r.dataset.ddDepth === undefined));

  type(root, "visits");
  rows = resultRows(root);
  assert.equal(names(rows)[0], "visits", "the exact name first");
  for (const name of ["visits[].date", "visits[].weight", "visits[].labs", "visits[].labs[].name"]) {
    const row = rowNamed(rows, name);
    assert.ok(row, `${name} is a hit`);
    assert.equal(row.querySelector(".dd-name-prefix mark.dd-hit").textContent, "visits");
  }

  type(root, "visits[].date");
  assert.equal(names(resultRows(root))[0], "visits[].date", "a typed path is an exact match");
  type(root, "visits date");
  assert.equal(names(resultRows(root))[0], "visits[].date", "the path typed as words is an exact match");
  type(root, "zip");
  assert.deepEqual(names(resultRows(root)), ["contact.address.zip"]);

  type(root, "");
  assert.equal(resultRows(root).length, 0);
  assert.equal(rowNamed(categoryRows(root), "visits[].date").dataset.ddDepth, "1", "the category view keeps its indentation");
});

test("export: nested rows keep their full path and order; Parent only with the internal columns", () => {
  const table = nestedTable();
  const lines = tableToCsv(table).split("\r\n");
  assert.equal(lines[0], "Variable name,Description,Data type,Format,Valid values,Constraints,Additional information");
  const visits = lines.findIndex((l) => l.startsWith("visits,"));
  assert.ok(lines[visits + 1].startsWith("visits[].date,"));
  assert.ok(lines[visits + 2].startsWith("visits[].weight,"));
  assert.ok(lines.some((l) => l.startsWith("weights,") && l.includes("array of number + coded values")));

  const plain = toPlainRows(table, { includeInternalColumns: true });
  assert.deepEqual(Object.keys(plain[0]).slice(-3), ["Category", "Parent", "Source"]);
  assert.equal(plain.find((r) => r["Variable name"] === "visits[].date").Parent, "visits");
  assert.equal(plain.find((r) => r["Variable name"] === "visits").Parent, "");
  assert.ok(!("Parent" in toPlainRows(table)[0]));
});

test("tableToHtml: nested rows carry data-dd-depth and the prefix/leaf, and the inline filter still counts them", { skip }, () => {
  const table = nestedTable();
  const html = tableToHtml(table);
  const markup = html.slice(html.indexOf("</style>"), html.indexOf("<script>"));
  assert.equal((markup.match(/data-dd-depth="1"/g) ?? []).length, table.rows.filter((r) => r.__depth === 1).length);
  assert.equal((markup.match(/data-dd-depth="2"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-dd-row\b/g) ?? []).length, table.rows.length, "the depth attribute is not counted as a row");
  assert.match(markup, /class="dd-name-prefix"/);
  assert.match(markup, new RegExp(`data-total="${table.rows.length}"`));
  assert.doesNotMatch(markup, /<b>/, "the name is escaped");

  document.body.innerHTML = html;
  const script = [...document.querySelectorAll("script")].map((s) => s.textContent).join("\n");
  new Function(script)();
  const input = document.querySelector("[data-dd-search]");
  input.value = "zip";
  input.dispatchEvent(new Event("input"));
  assert.equal(document.querySelector("[data-dd-count]").textContent, `1 / ${table.rows.length} variables`);
  const rows = [...document.querySelectorAll("[data-dd-row]")];
  const zip = rows.find((r) => r.querySelector("code").textContent === "contact.address.zip");
  assert.equal(zip.hidden, false);
  assert.equal(zip.dataset.ddDepth, "2");
  assert.ok(rows.filter((r) => r !== zip).every((r) => r.hidden));
  input.value = "";
  input.dispatchEvent(new Event("input"));
  assert.equal(document.querySelector("[data-dd-count]").textContent, `${table.rows.length} variables`);
  assert.ok(rows.every((r) => !r.hidden));
  document.body.innerHTML = "";
});

test("lazy rows: a page boundary inside a nested group keeps the category order", { skip }, () => {
  const table = nestedBigTable();
  const expected = table.rows.map((r) => r["Variable name"]);
  const { root } = mount(table, { pageSize: 20 });
  const section = root.querySelector("[data-dd-category]");
  const button = () => section.querySelector("[data-dd-more-btn]");
  assert.equal(categoryRows(root).length, 20);
  for (let i = 0; i < 4; i += 1) button().click();
  let rows = categoryRows(root);
  assert.equal(rows.length, 100);
  assert.deepEqual(names(rows).slice(89), expected.slice(89, 100), "the page ends nine rows into the nested group");
  assert.equal(names(rows)[90], "visits");
  assert.deepEqual(names(rows).slice(91, 100).map((n) => n.startsWith("visits[].")), Array(9).fill(true));
  assert.ok(rows.slice(91).every((r) => r.dataset.ddDepth === "1" && r.querySelector(".dd-name-prefix").textContent === "visits[]."));
  button().click();
  rows = categoryRows(root);
  assert.deepEqual(names(rows), expected.slice(0, 120));
  let guard = 0;
  while (button() && guard < 10) {
    button().click();
    guard += 1;
  }
  assert.deepEqual(names(categoryRows(root)), expected);
  assert.equal(section.querySelector("[data-dd-more]"), null);
});
