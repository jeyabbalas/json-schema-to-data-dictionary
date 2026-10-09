import test from "node:test";
import assert from "node:assert/strict";
import { loadDir, loadFile, findRow } from "./_helpers.mjs";

// happy-dom provides the DOM for the component tests; without it they are skipped.
let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}

const { schemaDocumentsToTable, buildViewModel, tableToHtml, tableToCsv, renderDataDictionary } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const covid = schemaDocumentsToTable(loadFile("single_schema/covid-patient-dataset.json"));
const vm = buildViewModel(bcrpp);
const rowVM = (name, model = vm) => model.categories.flatMap((c) => c.rows).find((r) => r.name === name);

/** A one-file table whose row object carries `allOf: [rule]`. */
function tableWithRule(properties, rule) {
  return schemaDocumentsToTable([
    { uri: "https://example.org/t.json", schema: { type: "array", items: { type: "object", properties, allOf: [rule] } } }
  ]);
}

// --- The model ---------------------------------------------------------------

test("rules and conditional constraints name the variables their condition reads", () => {
  const rule = bcrpp.conditionalRules.find((r) => r.condition === "parous = 1 and parity = 1");
  assert.deepEqual(rule.triggers, ["parous", "parity"]);
  assert.deepEqual(bcrpp.conditionalRules.find((r) => r.condition === "meno_status = 2").triggers, ["meno_status"]);

  const pinned = findRow(bcrpp, "age_preg2")["Constraints"].find((c) => c.condition === "parous = 0");
  assert.equal(pinned.keyword, "conditional");
  assert.equal(pinned.value, 777, "a skip pattern that pins the variable records the value");
  assert.deepEqual(pinned.triggers, ["parous"]);
  assert.deepEqual(findRow(bcrpp, "hrt_dur")["Constraints"].find((c) => c.condition === "meno_status = 2").value, [666, 777, 888]);

  const required = findRow(covid, "days_hospitalized")["Constraints"].find((c) => c.condition === "hospitalized is present");
  assert.deepEqual(required.triggers, ["hospitalized"]);
  assert.equal(required.value, undefined, "dependentRequired pins nothing");
});

test("a range condition reads as an inequality, exclusive bounds included", () => {
  assert.ok(bcrpp.conditionalRules.some((r) => r.condition === "parous = 1 and 1 ≤ parity ≤ 2"));
  const props = { x: { type: "number" }, y: { type: "integer", enum: [1, 2, 777] } };
  const cases = [
    [{ exclusiveMinimum: 5 }, "x > 5"],
    [{ minimum: 1, exclusiveMaximum: 3 }, "1 ≤ x < 3"],
    [{ maximum: 9 }, "x ≤ 9"],
    [{ minimum: 4, maximum: 4 }, "x = 4"]
  ];
  for (const [range, text] of cases) {
    const table = tableWithRule(props, { if: { properties: { x: range }, required: ["x"] }, then: { properties: { y: { const: 777 } } } });
    assert.equal(table.conditionalRules[0]?.condition, text);
    assert.deepEqual(table.conditionalRules[0]?.triggers, ["x"]);
  }
});

// --- The view model ------------------------------------------------------------

test("view model: each special code lists the skip patterns that set it, with their variables", () => {
  const age = rowVM("age_preg2");
  const code = (v) => age.sentinels.find((s) => s.display === v);
  assert.deepEqual(code("666").conditions, [{ text: "parous = 1 and parity = 1", triggers: ["parous", "parity"] }]);
  assert.deepEqual(code("777").conditions, [{ text: "parous = 0", triggers: ["parous"] }]);
  assert.deepEqual(code("888").conditions, []);
  assert.equal(code("777").condition, "parous = 0", "the joined text is kept");

  const hrt = rowVM("hrt_dur");
  assert.deepEqual(
    hrt.sentinels.find((s) => s.display === "777").conditions.map((c) => c.text),
    ["meno_status = 2", "hrtuse = 0"],
    "one entry per pattern, not a '; '-joined string"
  );
});

test("view model: pinning constraints are shown on their values, the rest stay constraints", () => {
  const age = rowVM("age_preg2");
  const conditional = age.constraints.filter((c) => c.conditional);
  assert.ok(conditional.length >= 2);
  assert.ok(conditional.every((c) => c.onValues), "every if/then constraint of age_preg2 pins a value");
  assert.ok(age.constraints.filter((c) => !c.conditional).every((c) => !c.onValues));

  const covidVM = buildViewModel(covid);
  const days = rowVM("days_hospitalized", covidVM);
  const required = days.constraints.find((c) => c.text === "Required when hospitalized is present.");
  assert.deepEqual({ onValues: required.onValues, triggers: required.triggers }, { onValues: false, triggers: ["hospitalized"] });
});

test("view model: variables know the rules they trigger; rules group their effects by value", () => {
  const index = (cond) => vm.rules.findIndex((r) => r.condition === cond);
  assert.ok(rowVM("parous").skipRules.includes(index("parous = 0")));
  assert.equal(rowVM("parous").skipRules.length, 10);
  assert.equal(rowVM("parity").skipRules.length, 9);
  assert.deepEqual(rowVM("age_preg1").skipRules, []);
  assert.ok(vm.names.has("age_preg10") && !vm.names.has("nope"));

  const meno = vm.rules[index("meno_status = 2")];
  assert.deepEqual(meno.groups, [
    { values: ["777"], label: "Premenopausal/NA", variables: ["meno_age", "meno_reason"] },
    { values: ["666", "777", "888"], variables: ["hrt_dur", "hrtep_dur", "hrteonly_dur"] }
  ]);
});

test("view model: a table built without the structured fields falls back to the condition text", () => {
  const row = {
    "Variable name": "stop_age",
    "Description": "",
    "Data type": "integer",
    "Format": "",
    "Valid values": [{ value: 777, kind: "sentinel", label: "N/A", condition: "status = 0; status = 9" }],
    "Constraints": [{ keyword: "conditional", text: "When status = 0, value = 777.", condition: "status = 0" }],
    "Additional information": null
  };
  const status = { ...row, "Variable name": "status", "Valid values": [], "Constraints": [] };
  const table = {
    rows: [status, row],
    categories: [{ id: "c", title: "C", rows: [status, row] }],
    conditionalRules: [{ condition: "status = 0", effects: [{ variable: "stop_age", value: 777 }] }],
    warnings: []
  };
  const model = buildViewModel(table);
  const value = rowVM("stop_age", model).sentinels[0];
  assert.deepEqual(value.conditions.map((c) => c.text), ["status = 0", "status = 9"]);
  assert.deepEqual(rowVM("stop_age", model).constraints[0].onValues, false, "without `value` nothing is known to be shown elsewhere");
  assert.deepEqual(rowVM("status", model).skipRules, [], "a rule without triggers is attached to no variable");
});

// --- Static output ------------------------------------------------------------

test("static HTML: a pinned code says when it applies, once, linking the variable it depends on", () => {
  const html = tableToHtml(bcrpp);
  const rowHtml = (name) => {
    const start = html.indexOf(`<code>${name}</code>`);
    return html.slice(start, html.indexOf("</tr>", start));
  };
  const age = rowHtml("age_preg1");
  assert.match(age, /<span class="dd-when"><span class="dd-kw">if<\/span> <span class="dd-cond"><button type="button" class="dd-ref" data-dd-goto="parous"[^>]*>parous<\/button> = 0<\/span><\/span>/);
  assert.doesNotMatch(age, /When parous = 0, value = 777/, "the pinning constraint is not repeated");
  assert.match(tableToCsv(bcrpp), /When parous = 0, value = 777 \(Nonparous\)\./, "exports keep the constraint text");
});

test("static HTML: a variable skip patterns read opens a detail row listing them", () => {
  const html = tableToHtml(bcrpp);
  const start = html.indexOf("<code>parous</code>");
  const row = html.slice(start, html.indexOf("</tr>", start));
  assert.match(row, /<button type="button" class="dd-skips-toggle" data-dd-skips aria-expanded="false" aria-controls="(dd-skips-\d+)"[^>]*>.*Skips 22<\/span><\/button>/);
  const id = /aria-controls="(dd-skips-\d+)"/.exec(row)[1];
  const detailStart = html.indexOf(`<tr class="dd-detail" id="${id}" data-dd-detail hidden>`);
  assert.ok(detailStart > start, "the detail row follows its variable");
  const detail = html.slice(detailStart, html.indexOf("</tr>", detailStart));
  assert.equal((detail.match(/class="dd-rule[ "]/g) ?? []).length, 10, "one entry per rule parous takes part in");
  assert.match(detail, /<code class="dd-ref-self">parous<\/code> = 0/, "the variable itself is named, not linked");
  assert.match(detail, /data-dd-goto="parity"/, "the other variable of a joint condition is linked");
});

test("static HTML: the toolbar's skip-logic panel lists every rule", () => {
  const html = tableToHtml(bcrpp);
  assert.match(html, /data-dd-panel-toggle="rules"[^>]*>.*Skip logic <span class="dd-btn-count">27<\/span>/);
  const panel = html.slice(html.indexOf('data-dd-panel="rules"'), html.indexOf('data-dd-panel="meta"'));
  assert.equal((panel.match(/class="dd-rule[ "]/g) ?? []).length, 27);
  assert.doesNotMatch(tableToHtml(covid), /data-dd-panel="rules"/, "no panel without rules");
});

// --- Component ------------------------------------------------------------------

function mount(table, options) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, table, options);
  return { el, root: el.shadowRoot ?? el };
}
const rowNamed = (root, name) => [...root.querySelectorAll("[data-dd-row]")].find((r) => r.querySelector("code").textContent === name);

test("component: the skips chip builds its detail row when first opened, then toggles it", { skip }, () => {
  const { root } = mount(bcrpp);
  const parous = rowNamed(root, "parous");
  const toggle = parous.querySelector("[data-dd-skips]");
  assert.equal(parous.nextElementSibling?.hasAttribute("data-dd-detail") ?? false, false, "not rendered up front");
  toggle.click();
  const detail = parous.nextElementSibling;
  assert.ok(detail.hasAttribute("data-dd-detail") && !detail.hidden);
  assert.equal(toggle.getAttribute("aria-controls"), detail.id);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(detail.querySelectorAll(".dd-rule").length, 10);
  toggle.click();
  assert.equal(detail.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(detail.hidden, false);
  assert.ok(!detail.nextElementSibling?.hasAttribute("data-dd-detail"), "built once");
});

test("component: a variable reference jumps to its row, opening its section and leaving the search", { skip }, () => {
  const { root } = mount(bcrpp, { expandCategories: false });
  const target = rowNamed(root, "parous");
  const section = target.closest("[data-dd-category]");
  assert.equal(section.dataset.collapsed, "true");

  const input = root.querySelector("[data-dd-search]");
  input.value = "smoking_stop";
  input.dispatchEvent(new Event("input"));
  assert.equal(root.querySelector("[data-dd-categories]").hidden, true);

  root.querySelector('[data-dd-goto="parous"]').click(); // in a panel: always present
  assert.equal(input.value, "", "parous is not among the results, so the search is cleared");
  assert.equal(root.querySelector("[data-dd-categories]").hidden, false);
  assert.equal(section.dataset.collapsed, "false");
  assert.ok(target.classList.contains("dd-flash"));
});

test("component: a reference to a row on a later page materialises it", { skip }, () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    "Variable name": `v${i}`,
    "Description": "",
    "Data type": "integer",
    "Format": "",
    "Valid values": i === 0 ? [{ value: 9, kind: "sentinel", label: "Skipped", condition: "v350 = 0" }] : [],
    "Constraints": i === 0 ? [{ keyword: "conditional", value: 9, text: "When v350 = 0, value = 9.", condition: "v350 = 0", triggers: ["v350"] }] : [],
    "Additional information": null
  }));
  const table = { rows, categories: [{ id: "c", title: "C", rows }], conditionalRules: [], warnings: [] };
  const { root } = mount(table, { pageSize: 50 });
  assert.equal(rowNamed(root, "v350"), undefined, "not materialised yet");
  root.querySelector('[data-dd-goto="v350"]').click();
  const target = rowNamed(root, "v350");
  assert.ok(target, "the jump pages it in");
  assert.ok(target.classList.contains("dd-flash"));
  assert.equal(root.querySelectorAll("[data-dd-row]").length, 400, "whole pages: 50 → 400 (350 is on the eighth)");
});

test("component: toolbar panels open one at a time and close", { skip }, () => {
  const { root } = mount(bcrpp);
  const rules = root.querySelector('[data-dd-panel="rules"]');
  const meta = root.querySelector('[data-dd-panel="meta"]');
  const toggle = (key) => root.querySelector(`[data-dd-panel-toggle="${key}"]`);
  assert.ok(rules.hidden && meta.hidden);
  toggle("rules").click();
  assert.equal(rules.hidden, false);
  assert.equal(toggle("rules").getAttribute("aria-expanded"), "true");
  toggle("meta").click();
  assert.ok(rules.hidden && !meta.hidden, "opening one closes the other");
  meta.querySelector("[data-dd-panel-close]").click();
  assert.ok(meta.hidden);
  assert.equal(toggle("meta").getAttribute("aria-expanded"), "false");
});

test("component: one button collapses every section, then expands them", { skip }, () => {
  const { root } = mount(bcrpp);
  const sections = [...root.querySelectorAll("[data-dd-category]")];
  root.querySelector('[data-dd-action="collapse-all"]').click();
  assert.ok(sections.every((s) => s.dataset.collapsed === "true"));
  const button = root.querySelector('[data-dd-action="expand-all"]');
  assert.ok(button, "the same button now expands");
  assert.equal(button.getAttribute("aria-label"), "Expand all");
  sections[0].querySelector("[data-dd-category-toggle]").click();
  assert.ok(root.querySelector('[data-dd-action="collapse-all"]'), "one open section is enough to offer collapsing again");
});
