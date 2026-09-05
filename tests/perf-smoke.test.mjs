import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { loadDir, cloneTable } from "./_helpers.mjs";

// Rendering budget smoke test at 10,000 variables (the BCRPP fixture cloned 95 times) under
// happy-dom. The budgets are generous for CI machines and scale with DD_PERF_SCALE.
let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}

const { schemaDocumentsToTable, renderDataDictionary, tableToHtml } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";
const scale = Number(process.env.DD_PERF_SCALE ?? 1);
const budget = (ms) => ms * scale;

const base = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const big = cloneTable(base, 95);

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

test("perf smoke: 10,070 rows render one page, search and clear within budget", { skip }, () => {
  assert.equal(big.rows.length, 10070);
  assert.equal(big.categories.length, 1045);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const { value: el, ms: renderMs } = timed(() => renderDataDictionary(container, big));
  const root = el.shadowRoot;

  assert.equal(root.querySelectorAll("[data-dd-category]").length, 1045);
  assert.equal(root.querySelectorAll("[data-dd-categories] [data-dd-row]").length, 100, "first page only");
  const elements = root.querySelectorAll("*").length;
  assert.ok(elements < 60000, `initial DOM has ${elements} elements`);
  assert.equal(root.querySelector("[data-dd-count]").textContent, "10070 variables");
  assert.ok(renderMs < budget(1500), `render took ${renderMs.toFixed(0)} ms`);

  const input = root.querySelector("[data-dd-search]");
  const keystroke = timed(() => {
    input.value = "meno";
    input.dispatchEvent(new Event("input"));
  });
  const results = root.querySelectorAll("[data-dd-results-body] [data-dd-row]");
  assert.ok(results.length > 0 && results.length <= 100, `results page holds ${results.length} rows`);
  assert.match(root.querySelector("[data-dd-count]").textContent, /^\d+ \/ 10070 variables$/);
  assert.equal(root.querySelector("[data-dd-categories]").hidden, true);
  assert.ok(keystroke.ms < budget(250), `keystroke took ${keystroke.ms.toFixed(0)} ms`);

  const clear = timed(() => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
  });
  assert.equal(root.querySelector("[data-dd-categories]").hidden, false);
  assert.equal(root.querySelector("[data-dd-count]").textContent, "10070 variables");
  assert.ok(clear.ms < budget(60), `clear took ${clear.ms.toFixed(0)} ms`);

  console.log(
    `perf-smoke: render ${renderMs.toFixed(0)} ms, ${elements} elements, keystroke ${keystroke.ms.toFixed(0)} ms, clear ${clear.ms.toFixed(0)} ms`
  );
});

test("perf smoke: the static HTML still materialises every row", { skip }, () => {
  const { value: html, ms } = timed(() => tableToHtml(big));
  assert.ok(html.length > 20_000_000, `static HTML is ${(html.length / 1e6).toFixed(1)} MB`);
  assert.equal((html.match(/<tr class="dd-row"/g) ?? []).length, 10070);
  assert.doesNotMatch(html, /data-dd-more|data-dd-results/);
  console.log(`perf-smoke: tableToHtml ${(html.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms`);
});
