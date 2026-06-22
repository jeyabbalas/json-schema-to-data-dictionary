import test from "node:test";
import assert from "node:assert/strict";
import { loadDir, findRow } from "./_helpers.mjs";

// happy-dom gives us a DOM (incl. custom elements + Shadow DOM) under Node. If it is not
// installed, the interactive tests are skipped rather than failing the suite.
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

test("renderDataDictionary mounts a shadow-DOM component", { skip }, () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const container = document.createElement("div");
  document.body.appendChild(container);

  const el = renderDataDictionary(container, table);
  assert.ok(el.shadowRoot, "uses a shadow root by default");
  const rows = el.shadowRoot.querySelectorAll("[data-dd-row]");
  assert.ok(rows.length > 10, `rendered rows: ${rows.length}`);
  assert.match(el.shadowRoot.textContent, /BCRPP - CORE table/);
});

test("search filters rows", { skip }, () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, table);
  const root = el.shadowRoot;

  const total = root.querySelectorAll("[data-dd-row]").length;
  const input = root.querySelector("[data-dd-search]");
  input.value = "meno_age";
  input.dispatchEvent(new Event("input"));

  const visible = [...root.querySelectorAll("[data-dd-row]")].filter((r) => !r.hidden);
  assert.ok(visible.length >= 1 && visible.length < total, `visible ${visible.length} of ${total}`);
  assert.ok(visible.some((r) => /meno_age/.test(r.textContent)));
});

test("light-DOM mode renders without a shadow root", { skip }, () => {
  const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, table, { shadow: false });
  assert.equal(el.shadowRoot, null);
  assert.ok(el.querySelectorAll("[data-dd-row]").length > 10);
});
