import test from "node:test";
import assert from "node:assert/strict";
import { loadDir } from "./_helpers.mjs";
import { createFakeEmbedder, syntheticTable } from "./_fakeEmbedder.mjs";

let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}

const { schemaDocumentsToTable, renderDataDictionary, tableToHtml, createMemoryVectorCache } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await tick(5);
  }
}

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
const visibleRows = (root) => [...root.querySelectorAll("[data-dd-row]")].filter((r) => !r.hidden);
const resultRows = (root) => [...root.querySelectorAll("[data-dd-results-body] [data-dd-row]")];
const layout = (root) => [...root.querySelectorAll("[data-dd-category] tbody")].map((tb) => [...tb.children].map((r) => r.dataset.ddRowIndex));

test("semantic mode: ranked results with exact + related rows, then restore", { skip }, async () => {
  const embedder = createFakeEmbedder();
  const statuses = [];
  const { el, root } = mount(syntheticTable(), {
    semanticSearch: { embedder, cache: false, debounceMs: 0, minQueryLength: 2, onStatus: (s) => statuses.push(s.state) }
  });
  assert.ok(el.semanticIndex, "exposes the index");
  await el.semanticIndex.ready;
  await tick();
  assert.equal(statuses.at(-1), "ready");
  assert.equal(root.querySelector("[data-dd-semantic-status]").textContent, "Semantic search on");
  const original = layout(root);
  assert.deepEqual(original, [["0", "1"], ["2", "3"]]);

  // No keyword hit for "climacteric": the synonym reaches meno_status semantically.
  type(root, "climacteric");
  await until(() => resultRows(root).length > 0);
  let rows = resultRows(root);
  assert.deepEqual(rows.map((r) => [r.dataset.ddRowIndex, r.dataset.ddMatch]), [["0", "related"]]);
  assert.ok([...root.querySelectorAll("[data-dd-category]")].every((c) => c.hidden), "categories are hidden while searching");
  assert.equal(root.querySelector("[data-dd-results]").hidden, false);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, true);
  assert.equal(root.querySelector("[data-dd-count]").textContent, "1 / 4 variables · 1 related");
  assert.match(rows[0].querySelector(".dd-col-name").title, /similarity/);
  assert.equal(rows[0].querySelector(".dd-row-cat").textContent, "Reproductive");

  // Keyword hit: exact rows come first and are highlighted.
  type(root, "status");
  await until(() => resultRows(root).length > 0 && resultRows(root)[0].dataset.ddMatch === "exact");
  rows = resultRows(root);
  assert.equal(rows[0].dataset.ddRowIndex, "0");
  assert.ok(rows[0].querySelector("mark.dd-hit"), "keyword hits are highlighted");
  assert.equal(rows[0].querySelector(".dd-col-name").getAttribute("title"), null);

  // Gibberish: nothing exact, nothing related -> empty state.
  type(root, "qzxv");
  await tick(20);
  assert.equal(resultRows(root).length, 0);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, false);
  assert.equal(root.querySelector("[data-dd-results]").hidden, true);

  // Clearing restores the categories, order and counters.
  type(root, "");
  assert.equal(resultRows(root).length, 0);
  assert.equal(root.querySelector("[data-dd-results]").hidden, true);
  assert.deepEqual(layout(root), original, "rows return to their categories in the original order");
  assert.ok([...root.querySelectorAll("[data-dd-category]")].every((c) => !c.hidden));
  assert.equal(visibleRows(root).length, 4);
  assert.equal(root.querySelector("[data-dd-count]").textContent, "4 variables");
  assert.equal(root.querySelector("[data-dd-match]"), null);
  assert.equal(root.querySelector("[data-dd-empty]").hidden, true);
});

test("semantic mode: the latest query wins over a slow earlier one", { skip }, async () => {
  const embedder = createFakeEmbedder({ delayMs: 30 });
  const { el, root } = mount(syntheticTable(), { semanticSearch: { embedder, cache: false, debounceMs: 0, minQueryLength: 2 } });
  await el.semanticIndex.ready;
  type(root, "cigarette"); // -> tobacco_use (row 1) related, 30 ms later
  await tick(5);
  type(root, "climacteric"); // -> meno_status (row 0)
  await until(() => resultRows(root).length > 0);
  await tick(100); // let any stale reply land
  assert.deepEqual(resultRows(root).map((r) => r.dataset.ddRowIndex), ["0"]);
});

test("semantic mode: index survives option re-renders, follows the table, and is disposed on unmount", { skip }, async () => {
  const embedder = createFakeEmbedder();
  const table = syntheticTable();
  const { container, el } = mount(table, { semanticSearch: { embedder, cache: false } });
  const first = el.semanticIndex;
  await first.ready;

  el.options = { ...el.options, theme: "dark" };
  assert.equal(el.semanticIndex, first, "same table + embedder reuses the index");

  el.table = syntheticTable();
  assert.notEqual(el.semanticIndex, first, "a new table gets a new index");
  await assert.rejects(first.search("meno"), /disposed/);

  const second = el.semanticIndex;
  await second.ready;
  el.options = {};
  assert.equal(el.semanticIndex, undefined, "removing the option drops the index");
  await assert.rejects(second.search("meno"), /disposed/);
  assert.equal((el.shadowRoot ?? el).querySelector("[data-dd-results]"), null, "back to the plain markup");

  el.options = { semanticSearch: { embedder, cache: false } };
  const third = el.semanticIndex;
  await third.ready;
  container.replaceChildren();
  await assert.rejects(third.search("meno"), /disposed/);
});

test("semantic mode: a load failure shows the error chip while keyword search keeps working", { skip }, async () => {
  const statuses = [];
  const { el, root } = mount(syntheticTable(), {
    semanticSearch: { embedder: createFakeEmbedder({ failLoad: "offline" }), cache: false, onStatus: (s) => statuses.push(s) }
  });
  await el.semanticIndex.ready.catch(() => {});
  await tick();
  const chip = root.querySelector("[data-dd-semantic-status]");
  assert.equal(chip.dataset.state, "error");
  assert.equal(chip.title, "offline");
  assert.equal(statuses.at(-1).state, "error");

  type(root, "tobacco");
  const rows = resultRows(root);
  assert.deepEqual(rows.map((r) => [r.dataset.ddRowIndex, r.dataset.ddMatch]), [["1", "exact"]]);
});

test("semantic mode on the BCRPP fixture: related rows carry their category", { skip }, async () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const { el, root } = mount(table, { semanticSearch: { embedder: createFakeEmbedder(), cache: createMemoryVectorCache(), debounceMs: 0 } });
  await el.semanticIndex.ready;
  type(root, "climacteric");
  await until(() => resultRows(root).length > 0);
  const rows = resultRows(root);
  assert.ok(rows.every((r) => r.dataset.ddMatch === "related"));
  assert.ok(rows.length <= 10);
  assert.ok(rows.some((r) => /meno/.test(r.querySelector("code").textContent)), "menopause rows relate to 'climacteric'");
  assert.ok(rows.every((r) => r.querySelector(".dd-row-cat").textContent.length > 0));
  type(root, "");
  assert.equal(visibleRows(root).length, table.rows.length);
});

test("without semanticSearch the markup and behavior are unchanged", { skip }, () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const { root } = mount(table);
  assert.equal(root.querySelector("[data-dd-results]"), null);
  assert.equal(root.querySelector("[data-dd-semantic-status]"), null);
  assert.equal(root.querySelector("[data-dd-row-index]"), null);
  assert.equal(root.querySelector(".dd-row-cat"), null);
  type(root, "meno_age");
  assert.ok(visibleRows(root).length >= 1 && visibleRows(root).length < table.rows.length);
  assert.ok(root.querySelector("[data-dd-category]:not([hidden])"), "in-place filtering keeps categories");

  const html = tableToHtml(table);
  const markup = html.slice(html.indexOf("</style>")); // the shared stylesheet may mention the selectors
  assert.doesNotMatch(markup, /data-dd-results|data-dd-semantic-status|data-dd-row-index|class="dd-row-cat"/);
});
