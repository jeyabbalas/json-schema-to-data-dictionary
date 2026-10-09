import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadDir } from "./_helpers.mjs";

// happy-dom provides the DOM; it has no layout, so widths the tests read back are the ones set
// (a column without one measures 0 and clamps to the 56 px minimum).
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
const table = schemaDocumentsToTable(loadDir("multiple_schema_2"));

function mount(options) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, table, options);
  const events = [];
  el.addEventListener("dd-column-resize", (e) => events.push(e.detail));
  return { container, el, root: el.shadowRoot ?? el, events };
}
const ddRoot = (root) => root.querySelector("[data-dd-root]");
const handle = (root, key) => root.querySelector(`[data-dd-head] [data-dd-resize="${key}"]`);
const key = (target, k, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));

test("markup: one resize handle per column, announced as a separator", () => {
  const html = tableToHtml(table);
  const handles = [...html.matchAll(/<span class="dd-resize" data-dd-resize="(\w+)" role="separator" aria-orientation="vertical" aria-label="([^"]+)"/g)];
  assert.deepEqual(handles.map((m) => m[1]), ["name", "description", "type", "format", "values", "constraints", "additional"]);
  assert.equal(handles[1][2], "Resize the Description column");
});

test("columnWidths: declared on the root as --dd-col-* properties, invalid entries dropped", () => {
  const html = tableToHtml(table, { columnWidths: { "Description": 420.4, "Valid values": 0, "Constraints": Number.NaN, "Nope": 3 } });
  assert.match(html, /<div class="dd-root" data-theme="auto" data-dd-root style="--dd-col-description:420px">/);
  assert.match(tableToHtml(table), /<div class="dd-root" data-theme="auto" data-dd-root>/, "no style attribute without widths");
});

test("component: arrow keys resize a column, report it, and Reset clears every width", { skip }, () => {
  const { root, events } = mount({ columnWidths: { "Description": 300 } });
  const dd = ddRoot(root);
  const reset = root.querySelector('[data-dd-action="reset-widths"]');
  assert.equal(dd.style.getPropertyValue("--dd-col-description"), "300px");
  assert.equal(reset.hidden, false, "Reset is offered once a width is set");

  key(handle(root, "description"), "ArrowRight");
  assert.equal(dd.style.getPropertyValue("--dd-col-description"), "316px");
  key(handle(root, "description"), "ArrowLeft", true);
  assert.equal(dd.style.getPropertyValue("--dd-col-description"), "252px", "Shift moves four steps");
  assert.equal(handle(root, "description").getAttribute("aria-valuenow"), "252");
  assert.deepEqual(events.at(-1), { column: "Description", widths: { "Description": 252 } });

  key(handle(root, "description"), "Delete");
  assert.equal(dd.style.getPropertyValue("--dd-col-description"), "", "Delete returns one column to its default");
  key(handle(root, "type"), "ArrowRight");
  assert.equal(dd.style.getPropertyValue("--dd-col-type"), "72px", "an unmeasured column grows from the minimum");

  reset.click();
  assert.equal(dd.style.getPropertyValue("--dd-col-type"), "");
  assert.equal(reset.hidden, true);
  assert.deepEqual(events.at(-1), { column: null, widths: {} });
});

test("component: dragging a header edge resizes the column by the pointer's travel", { skip }, () => {
  const { root, events } = mount({ columnWidths: { "Variable name": 200 } });
  const h = handle(root, "name");
  const pointer = (type, clientX) => h.dispatchEvent(new PointerEvent(type, { clientX, button: 0, pointerId: 7, bubbles: true }));
  pointer("pointerdown", 100);
  assert.ok(ddRoot(root).hasAttribute("data-dd-resizing"));
  pointer("pointermove", 180);
  pointer("pointerup", 180);
  assert.ok(!ddRoot(root).hasAttribute("data-dd-resizing"));
  assert.equal(ddRoot(root).style.getPropertyValue("--dd-col-name"), "280px");
  assert.deepEqual(events.at(-1), { column: "Variable name", widths: { "Variable name": 280 } });

  pointer("pointerdown", 100);
  pointer("pointermove", -900);
  pointer("pointerup", -900);
  assert.equal(ddRoot(root).style.getPropertyValue("--dd-col-name"), "56px", "never narrower than the minimum");
});

test("component: double-click fits a column to its content (and says so)", { skip }, () => {
  const { root, events } = mount();
  handle(root, "type").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  assert.match(ddRoot(root).style.getPropertyValue("--dd-col-type"), /^\d+px$/);
  assert.equal(events.at(-1).column, "Data type");
  assert.equal(root.querySelector(".dd-probe"), null, "the measuring table is removed");
});

test("component: widths the reader set survive re-renders until options are replaced", { skip }, () => {
  const { el, root } = mount({ columnWidths: { "Description": 300 } });
  key(handle(root, "description"), "ArrowRight");
  el.table = table; // re-render with the same options
  assert.equal(ddRoot(el.shadowRoot).style.getPropertyValue("--dd-col-description"), "316px");
  el.options = { columnWidths: { "Format": 90 } };
  const dd = ddRoot(el.shadowRoot);
  assert.equal(dd.style.getPropertyValue("--dd-col-description"), "", "new options are the new starting point");
  assert.equal(dd.style.getPropertyValue("--dd-col-format"), "90px");
});

test("static HTML: the inline script resizes with the component's own runtime", { skip }, () => {
  const html = tableToHtml(table, { columnWidths: { "Constraints": 200 } });
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.match(script, /\(function attachColumnResize\(/, "the runtime is inlined as source");
  new vm.Script(script); // parses on its own

  const host = document.createElement("div");
  host.innerHTML = html.slice(0, html.indexOf("<script>"));
  document.body.appendChild(host);
  window.eval(script);
  const dd = host.querySelector("[data-dd-root]");
  const h = host.querySelector('[data-dd-resize="constraints"]');
  key(h, "ArrowRight");
  assert.equal(dd.style.getPropertyValue("--dd-col-constraints"), "216px");
  assert.equal(host.querySelector('[data-dd-action="reset-widths"]').hidden, false);

  host.querySelector('[data-dd-panel-toggle="rules"]').click();
  assert.equal(host.querySelector('[data-dd-panel="rules"]').hidden, false, "panels open in the static page too");
  const parous = [...host.querySelectorAll("[data-dd-row]")].find((r) => r.querySelector("code").textContent === "parous");
  parous.querySelector("[data-dd-skips]").click();
  assert.equal(parous.nextElementSibling.hidden, false, "and so do skip-pattern rows");
});
