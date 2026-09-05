import test from "node:test";
import assert from "node:assert/strict";
import { loadDir, cloneTable } from "./_helpers.mjs";

// happy-dom gives us a DOM (incl. custom elements + Shadow DOM) under Node. If it is not
// installed, the interactive tests are skipped rather than failing the suite. Note that
// happy-dom's IntersectionObserver never fires, so lazy paging is driven by the buttons here.
let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}

const { schemaDocumentsToTable, renderDataDictionary } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";

const base = schemaDocumentsToTable(loadDir("multiple_schema_2"));

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
const sections = (root) => [...root.querySelectorAll("[data-dd-category]")];
const names = (rows) => rows.map((r) => r.querySelector("code").textContent);

/** A table of `n` rows in `perCategory`-sized categories whose descriptions all mention "synthetic". */
function syntheticRows(n, perCategory = 50) {
  const row = (i) => ({
    "Variable name": `var_${String(i).padStart(3, "0")}`,
    "Description": `Synthetic variable number ${i}`,
    "Data type": "integer",
    "Format": "",
    "Valid values": [],
    "Constraints": [],
    "Additional information": null
  });
  const rows = Array.from({ length: n }, (_, i) => row(i));
  const categories = [];
  for (let start = 0; start < n; start += perCategory) {
    categories.push({ id: `c${start}`, title: `Block ${start / perCategory}`, rows: rows.slice(start, start + perCategory) });
  }
  return { title: "Synthetic", rows, categories, conditionalRules: [], warnings: [] };
}

test("renderDataDictionary mounts a shadow-DOM component", { skip }, () => {
  const { el, root } = mount(base);
  assert.ok(el.shadowRoot, "uses a shadow root by default");
  const rows = root.querySelectorAll("[data-dd-row]");
  assert.equal(rows.length, base.rows.length, "a small dictionary is fully materialised");
  assert.match(root.textContent, /BCRPP - CORE table/);
  assert.ok(root.querySelector("[data-dd-results]").hidden, "the results section exists but is hidden");
  assert.equal(root.querySelector("[data-dd-count]").getAttribute("role"), "status");
  assert.equal(root.querySelector("[data-dd-more]"), null, "no lazy sentinels for a small dictionary");
  for (const toggle of root.querySelectorAll("[data-dd-category-toggle]")) {
    const id = toggle.getAttribute("aria-controls");
    assert.ok(id && root.getElementById?.(id) !== null, "toggles control their table wrap");
  }
});

test("search shows the ranked list, clearing restores the categories", { skip }, () => {
  const { root } = mount(base);
  const total = base.rows.length;
  const layout = () => sections(root).map((s) => names([...s.querySelectorAll("[data-dd-row]")]));
  const before = layout();

  type(root, "meno_age");
  const rows = resultRows(root);
  assert.ok(rows.length >= 1 && rows.length < total, `results ${rows.length} of ${total}`);
  assert.equal(root.querySelector("[data-dd-results]").hidden, false);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, true, "categories are hidden as a whole");
  assert.equal(names(rows)[0], "meno_age", "the exact name comes first");
  assert.ok(rows[0].querySelector(".dd-col-name mark.dd-hit"), "the name is highlighted");
  assert.ok(rows.every((r) => r.dataset.ddMatch === "exact"));
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${rows.length} / ${total} variables`);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, true);
  assert.deepEqual(layout(), before, "category rows never move");

  type(root, "zzzzzz");
  assert.equal(resultRows(root).length, 0);
  assert.equal(root.querySelector("[data-dd-results]").hidden, true);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, false);
  assert.equal(root.querySelector("[data-dd-empty-q]").textContent, "zzzzzz");
  assert.equal(root.querySelector("[data-dd-count]").textContent, `0 / ${total} variables`);

  type(root, "");
  assert.equal(resultRows(root).length, 0);
  assert.equal(root.querySelector("[data-dd-results]").hidden, true);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, false);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, true);
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${total} variables`);
  assert.equal(root.querySelector("mark.dd-hit"), null);
  assert.deepEqual(layout(), before);
});

test("schema text is escaped everywhere, highlights included", { skip }, () => {
  const table = syntheticRows(3);
  table.rows[1]["Description"] = 'Uses <b>bold</b> & "quotes" </script><img src=x onerror=alert(1)>';
  table.rows[1]["Valid values"] = [{ value: 1, label: "<i>one</i>", kind: "value" }];
  const { root } = mount(table);
  assert.equal(root.querySelector("b, i, img"), null, "markup in the schema never becomes elements");

  type(root, "bold");
  const rows = resultRows(root);
  assert.equal(rows.length, 1);
  assert.equal(root.querySelector("b, i, img"), null);
  const desc = rows[0].querySelector(".dd-desc");
  assert.equal(desc.querySelector("mark.dd-hit").textContent, "bold");
  assert.match(desc.textContent, /<b>bold<\/b> & "quotes" <\/script>/);

  type(root, "<i>one");
  assert.equal(resultRows(root).length, 1);
  assert.equal(root.querySelector("i"), null);
  // The engine tokenises the query ("i", "one"); every mark is one of those tokens and the
  // label text survives verbatim around them.
  const values = resultRows(root)[0].querySelector(".dd-values");
  const marks = [...values.querySelectorAll("mark.dd-hit")].map((m) => m.textContent.toLowerCase());
  assert.ok(marks.length >= 2 && marks.every((m) => m === "i" || m === "one"), `marks: ${marks.join(",")}`);
  assert.match(values.textContent, /<i>one<\/i>/);
});

test("multi-token queries highlight every token", { skip }, () => {
  const table = syntheticRows(3);
  table.rows[0]["Description"] = "Menopausal status at baseline";
  const { root } = mount(table);
  type(root, "menopausal status");
  const rows = resultRows(root);
  assert.equal(rows.length, 1);
  const marks = [...rows[0].querySelectorAll("mark.dd-hit")].map((m) => m.textContent);
  assert.deepEqual(marks, ["Menopausal", "status"]);
});

test("queries with regex metacharacters and 0.2 substring semantics still work", { skip }, () => {
  const { root } = mount(base);
  for (const q of ["a-b", "[x]", "\\", "(", "{", "^$", "kg/m2", ".*", "a|b", "?", "+"]) {
    assert.doesNotThrow(() => type(root, q), `query ${JSON.stringify(q)}`);
  }
  type(root, "kg/m2");
  assert.ok(resultRows(root).length >= 1, "punctuation inside a substring still matches");
  const kgMarks = new Set([...resultRows(root)[0].querySelectorAll("mark.dd-hit")].map((m) => m.textContent.toLowerCase()));
  assert.ok(kgMarks.has("kg") && kgMarks.has("m2"), `both tokens are highlighted: ${[...kgMarks].join(",")}`);
  type(root, "meno_");
  const rows = resultRows(root);
  assert.deepEqual(names(rows).slice(0, 3).sort(), ["meno_age", "meno_reason", "meno_status"], "name matches rank first");
  assert.ok(rows.length > 3, "rows mentioning meno_status in a skip pattern follow");
  type(root, "  Meno_Age  ");
  assert.equal(names(resultRows(root))[0], "meno_age", "queries are trimmed and case-insensitive");
});

test("light-DOM mode renders without a shadow root", { skip }, () => {
  const { el, root } = mount(base, { shadow: false });
  assert.equal(el.shadowRoot, null);
  assert.ok(root.querySelectorAll("[data-dd-row]").length > 10);
  type(root, "meno_age");
  assert.ok(resultRows(root).length >= 1, "search works in light DOM too");
});

test("toolbar: collapse all / expand all, and single toggles", { skip }, () => {
  const { root } = mount(base);
  root.querySelector('[data-dd-action="collapse-all"]').click();
  assert.ok(sections(root).every((s) => s.dataset.collapsed === "true"));
  assert.ok([...root.querySelectorAll("[data-dd-category-toggle]")].every((t) => t.getAttribute("aria-expanded") === "false"));
  root.querySelector('[data-dd-action="expand-all"]').click();
  assert.ok(sections(root).every((s) => s.dataset.collapsed === "false"));
  const first = sections(root)[0];
  first.querySelector("[data-dd-category-toggle]").click();
  assert.equal(first.dataset.collapsed, "true");
  first.querySelector("[data-dd-category-toggle]").click();
  assert.equal(first.dataset.collapsed, "false");
});

test("keyboard: '/' focuses the search box and Escape clears it from inside the shadow tree", { skip }, () => {
  const { root } = mount(base);
  const search = root.querySelector("[data-dd-search]");
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
  assert.equal(root.activeElement, search);

  type(root, "meno");
  assert.ok(resultRows(root).length > 0);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
  assert.equal(search.value, "");
  assert.equal(resultRows(root).length, 0);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, false);
});

// --- Lazy rows -------------------------------------------------------------------------------

const big = cloneTable(base, 10);

test("lazy rows: a large dictionary renders one page and a sentinel per incomplete section", { skip }, () => {
  const { root } = mount(big, { pageSize: 20 });
  assert.equal(big.rows.length, base.rows.length * 10);
  assert.equal(sections(root).length, base.categories.length * 10);
  assert.equal(categoryRows(root).length, 20, "only the first page is materialised");
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${big.rows.length} variables`);

  let rowsSeen = 0;
  for (const section of sections(root)) {
    const next = Number(section.dataset.ddNext);
    const total = Number(section.dataset.total);
    const materialised = section.querySelectorAll("[data-dd-row]").length;
    assert.equal(materialised, next);
    assert.equal(total, big.categories[Number(section.dataset.ddCat)].rows.length);
    const sentinel = section.querySelector("[data-dd-more]");
    if (next < total) {
      assert.ok(sentinel && sentinel.querySelector("[data-dd-more-btn]"), "incomplete sections end with a sentinel");
      assert.equal(sentinel, section.querySelector("[data-dd-rows]").lastElementChild);
      assert.match(sentinel.textContent, new RegExp(`Show ${Math.min(20, total - next)} more · ${total - next} remaining`));
    } else {
      assert.equal(sentinel, null);
    }
    rowsSeen += materialised;
  }
  assert.equal(rowsSeen, 20);
});

test("lazy rows: the sentinel button appends at most one page, in order, until the section is complete", { skip }, () => {
  const { root } = mount(big, { pageSize: 20 });
  const section = sections(root).find((s) => Number(s.dataset.total) > 40 && Number(s.dataset.ddNext) === 0);
  assert.ok(section, "a large untouched section exists");
  const expected = big.categories[Number(section.dataset.ddCat)].rows.map((r) => r["Variable name"]);
  const button = () => section.querySelector("[data-dd-more-btn]");

  button().click();
  assert.equal(section.dataset.ddNext, "20");
  assert.deepEqual(names([...section.querySelectorAll("[data-dd-row]")]), expected.slice(0, 20));
  assert.ok(button(), "still incomplete");
  assert.match(button().textContent, new RegExp(`${expected.length - 20} remaining`));

  let guard = 0;
  while (button() && guard < 100) {
    button().click();
    guard += 1;
  }
  assert.equal(section.querySelector("[data-dd-more]"), null, "the sentinel goes once every row is in");
  assert.equal(section.dataset.ddNext, String(expected.length));
  assert.deepEqual(names([...section.querySelectorAll("[data-dd-row]")]), expected);
  assert.equal(categoryRows(root).length, 20 + expected.length);
});

test("lazy rows: pageSize Infinity materialises everything up front", { skip }, () => {
  const { root } = mount(big, { pageSize: Infinity });
  assert.equal(categoryRows(root).length, big.rows.length);
  assert.equal(root.querySelector("[data-dd-more]"), null);
  assert.ok(sections(root).every((s) => s.dataset.ddNext === s.dataset.total));
});

test("lazy rows: expanding a collapsed, empty section materialises its first page", { skip }, () => {
  const { root } = mount(big, { pageSize: 20, expandCategories: false });
  const last = sections(root).at(-1);
  assert.equal(last.dataset.collapsed, "true");
  assert.equal(last.querySelectorAll("[data-dd-row]").length, 0);
  last.querySelector("[data-dd-category-toggle]").click();
  assert.equal(last.dataset.collapsed, "false");
  assert.equal(last.querySelector("[data-dd-category-toggle]").getAttribute("aria-expanded"), "true");
  const total = Number(last.dataset.total);
  assert.equal(last.querySelectorAll("[data-dd-row]").length, Math.min(20, total));
  assert.equal(last.dataset.ddNext, String(Math.min(20, total)));
});

test("lazy rows: searching and clearing keeps the counts and the materialised rows", { skip }, () => {
  const { root } = mount(big, { pageSize: 20 });
  const total = big.rows.length;
  type(root, "meno_age");
  const rows = resultRows(root);
  assert.ok(rows.length >= 10, "at least one name match per copy");
  assert.deepEqual(names(rows).slice(0, 1), ["meno_age"], "the bare name outranks the suffixed copies");
  assert.ok(names(rows).slice(0, 10).every((n) => n.startsWith("meno_age")), "the name matches rank before description matches");
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${rows.length} / ${total} variables`);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, true);
  type(root, "");
  assert.equal(root.querySelector("[data-dd-count]").textContent, `${total} variables`);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, false);
  assert.equal(categoryRows(root).length, 20, "lazy state is untouched by searching");
});

// --- Results paging ---------------------------------------------------------------------------

test("results paging: 'Show more' appends pages of resultsPageSize rows", { skip }, () => {
  const table = syntheticRows(300);
  const { root } = mount(table, { resultsPageSize: 50 });
  type(root, "synthetic");
  assert.equal(resultRows(root).length, 50);
  assert.equal(root.querySelector("[data-dd-count]").textContent, "300 / 300 variables");
  const foot = root.querySelector("[data-dd-results-foot]");
  const more = root.querySelector("[data-dd-results-more]");
  assert.equal(foot.hidden, false);
  assert.equal(root.querySelector("[data-dd-results-status]").textContent, "Showing 50 of 300 matches");
  assert.equal(more.textContent, "Show 50 more");

  more.click();
  assert.equal(resultRows(root).length, 100);
  assert.equal(root.querySelector("[data-dd-results-status]").textContent, "Showing 100 of 300 matches");
  assert.deepEqual(names(resultRows(root)).slice(48, 52), ["var_048", "var_049", "var_050", "var_051"], "pages continue in rank order");

  for (let i = 0; i < 10 && !foot.hidden; i += 1) more.click();
  assert.equal(resultRows(root).length, 300);
  assert.equal(foot.hidden, true);

  // A new query starts from the first page again; clearing empties the list.
  type(root, "var_29");
  assert.ok(resultRows(root).length >= 10 && resultRows(root).length < 50, "a new query starts from the first page");
  assert.ok(names(resultRows(root)).slice(0, 10).every((n) => n.startsWith("var_29")), "name-prefix matches rank first");
  assert.equal(foot.hidden, true);
  type(root, "");
  assert.equal(resultRows(root).length, 0);
});
