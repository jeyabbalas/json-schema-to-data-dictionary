// The Excel workbook (`tableToXlsx`), read back with ExcelJS (a devDependency): the sheets, the
// dictionary laid out like the table -- codes bold, special codes apart, the skip patterns that
// set a code under it with the rule's comment, notes -- and the download button that saves it.

import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { loadDir, loadFile } from "./_helpers.mjs";

// happy-dom provides the DOM for the component checks; without it they are skipped.
let registered = false;
try {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  registered = true;
} catch {
  registered = false;
}
const { schemaDocumentsToTable, tableToXlsx, tableToHtml, renderDataDictionary, XLSX_MEDIA_TYPE } = await import("../dist/index.js");
const skip = registered ? false : "happy-dom not installed";

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const hesp = schemaDocumentsToTable(loadDir("hesp"));
const longitudinal = schemaDocumentsToTable(loadFile("single_schema/longitudinal-cohort-dataset.json"));

async function read(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

/** A cell's text, rich or plain. */
function text(cell) {
  const v = cell.value;
  if (v && typeof v === "object" && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  return v === null || v === undefined ? "" : String(v);
}

/** The run of a rich-text cell that contains `fragment`. */
function run(cell, fragment) {
  return cell.value.richText.find((r) => r.text.includes(fragment));
}

/** The dictionary row of a variable (column A holds the name). */
function rowOf(sheet, name) {
  for (let r = 2; r <= sheet.rowCount; r += 1) if (text(sheet.getRow(r).getCell(1)) === name) return sheet.getRow(r);
  return undefined;
}

const COLUMNS = ["Variable name", "Category", "Description", "Data type", "Format", "Valid values", "Constraints", "Additional information"];

test("xlsx: three sheets, a frozen and filterable header, one row per variable", async () => {
  const bytes = tableToXlsx(bcrpp);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK", "a zip");
  assert.equal(XLSX_MEDIA_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  const workbook = await read(bytes);
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ["Data dictionary", "Skip logic", "About"]);
  const sheet = workbook.getWorksheet("Data dictionary");
  assert.deepEqual(COLUMNS.map((_, i) => text(sheet.getRow(1).getCell(i + 1))), COLUMNS);
  assert.equal(sheet.rowCount, bcrpp.rows.length + 1);
  assert.equal(sheet.getRow(1).getCell(1).font?.bold, true);
  const view = sheet.views[0];
  assert.equal(view.state, "frozen");
  assert.equal(view.ySplit, 1);
  assert.equal(view.xSplit, 1, "the variable names stay in view");
  assert.ok(sheet.autoFilter, "the header filters");
  assert.equal(workbook.title, bcrpp.title);
});

test("xlsx: a code set by a skip pattern says when, with the rule's comment; the measurement and special codes apart", async () => {
  const sheet = (await read(tableToXlsx(bcrpp))).getWorksheet("Data dictionary");
  const row = rowOf(sheet, "meno_age");
  const values = row.getCell(6);
  const lines = text(values).split("\n");
  assert.match(lines[0], /^20–65  /, "the measured range first");
  assert.ok(lines.includes("Special codes"), "the special codes under a heading of their own");
  const at = lines.findIndex((l) => l.startsWith("777  "));
  assert.ok(at > lines.indexOf("Special codes"));
  assert.equal(lines[at + 1], "    if meno_status = 2 (Premenopausal)");
  assert.match(lines[at + 2], /^      Skip pattern: premenopausal/, "the rule's comment under its condition");
  assert.equal(run(values, "777").font.bold, true);
  assert.equal(run(values, "777").font.color?.argb?.slice(-6), "B45309", "special codes in amber");
  assert.equal(run(values, "Skip pattern: premenopausal").font.italic, true);
  assert.equal(run(values, "Skip pattern: premenopausal").font.size, 11, "a run's font is complete, not just its own facets");

  const constraints = text(row.getCell(7));
  assert.match(constraints, /^• Required\n• Measured value: 20 ≤ value ≤ 65/);
  assert.doesNotMatch(constraints, /When meno_status = 2/, "a pin shown on its code is not repeated");
});

test("xlsx: a rule that allows a set of codes is a constraint, with its comment", async () => {
  const sheet = (await read(tableToXlsx(bcrpp))).getWorksheet("Data dictionary");
  const row = rowOf(sheet, "hrt_dur");
  const constraints = text(row.getCell(7)).split("\n");
  const at = constraints.findIndex((l) => l.startsWith("• When meno_status = 2 (Premenopausal), value is one of 666"));
  assert.ok(at >= 0, constraints.join("\n"));
  assert.match(constraints[at + 1], /^   Skip pattern: premenopausal/);
  assert.doesNotMatch(text(row.getCell(6)), /if meno_status = 2/, "no code is badged by it");
});

test("xlsx: notes, nested rows, data types and additional information", async () => {
  const sheet = (await read(tableToXlsx(bcrpp))).getWorksheet("Data dictionary");
  const bbd = rowOf(sheet, "BBD_type1");
  const description = bbd.getCell(3);
  assert.match(text(description), /^Type of benign breast disease for first BBD diagnosis\nNote: Source coding: 1 - non-proliferative disease/);
  assert.equal(run(description, "Note: ").font.bold, true);
  assert.equal(run(description, "Source coding").font.italic, true);
  assert.equal(text(bbd.getCell(2)), "CORE — Personal Health History");

  const nested = (await read(tableToXlsx(longitudinal))).getWorksheet("Data dictionary");
  const glucose = rowOf(nested, "visits[].glucose_mmol");
  assert.ok(glucose, "nested rows are listed by path");
  assert.equal(glucose.getCell(1).alignment?.indent, 1);
  assert.ok(!run(glucose.getCell(1), "visits[].").font?.bold, "the parent path muted, the field bold");
  assert.equal(run(glucose.getCell(1), "glucose_mmol").font.bold, true);

  const hespSheet = (await read(tableToXlsx(hesp))).getWorksheet("Data dictionary");
  const months = rowOf(hespSheet, "months_housing_arrears");
  assert.equal(text(months.getCell(4)), "integer + coded values");
  assert.equal(text(months.getCell(8)), "x-universe: Households with a cash rent or mortgage payment.\nx-unit: months", "one keyword per line, no JSON");
  const move = text(rowOf(hespSheet, "move_reason").getCell(7));
  assert.match(move, /• When moved_since_last_wave = 1 \(Yes\), value ≠ -666 \(Not applicable \/ structural skip\)\.\n   Applicability: households that moved/);
});

test("xlsx: the Skip logic sheet lists every rule, one line per group of variables it affects", async () => {
  const sheet = (await read(tableToXlsx(hesp))).getWorksheet("Skip logic");
  assert.deepEqual([1, 2, 3, 4, 5].map((c) => text(sheet.getRow(1).getCell(c))), ["Rule", "When", "Then", "Variables", "Note"]);
  const groups = hesp.conditionalRules.reduce((n, r) => n + new Set(r.effects.map((e) => JSON.stringify([e.kind, e.value, e.excluded, e.text, e.label]))).size, 0);
  assert.ok(sheet.rowCount - 1 <= groups && sheet.rowCount - 1 >= hesp.conditionalRules.length);
  const rules = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) rules.push(sheet.getRow(r).getCell(1).value);
  assert.equal(Math.max(...rules), 171);

  const lines = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) lines.push([2, 3, 4, 5].map((c) => text(sheet.getRow(r).getCell(c))));
  const applicability = lines.find((l) => l[0] === "moved_since_last_wave = 1 (Yes)");
  assert.deepEqual(applicability.slice(1, 3), ["≠ -666 (Not applicable / structural skip)", "move_reason"]);
  assert.match(applicability[3], /^Applicability:/);
  const banked = lines.find((l) => l[0] === "banked_status = 1 (Banked and not underbanked)" && l[1].startsWith("at least one"));
  assert.equal(banked[2], "checking_owned, savings_owned, prepaid_account_owned, money_market_cd_owned");
});

test("xlsx: the About sheet carries the dataset's notes, its categories and a key to the formatting", async () => {
  const sheet = (await read(tableToXlsx(hesp))).getWorksheet("About");
  const all = [];
  sheet.eachRow((row) => all.push(row.values.slice(1).map((v) => text({ value: v })).join(" | ")));
  const joined = all.join("\n");
  assert.equal(text(sheet.getRow(1).getCell(1)), hesp.title);
  assert.match(joined, /Note: Standard JSON Schema cannot enforce uniqueness of record_id/);
  assert.match(joined, /Variables \| 265/);
  assert.match(joined, /HESP CORE - Household composition \| 28 \| .* \| Soft checks: adult_count \+ child_count/);
  assert.match(joined, /How to read this workbook/);
  assert.match(joined, /special codes \(missing, not applicable, refused/);
});

test("xlsx: options and a table without rules", async () => {
  const only = await read(tableToXlsx(bcrpp, { includeSkipLogic: false, includeAbout: false, title: "Renamed" }));
  assert.deepEqual(only.worksheets.map((s) => s.name), ["Data dictionary"]);
  assert.equal(only.title, "Renamed");
  const covid = schemaDocumentsToTable(loadFile("single_schema/covid-patient-dataset.json"));
  assert.deepEqual((await read(tableToXlsx(covid))).worksheets.map((s) => s.name), ["Data dictionary", "About"]);
  assert.ok(tableToXlsx(bcrpp, { compress: false }).length > tableToXlsx(bcrpp).length * 3, "compressed by default");
});

test("static HTML: the download button saves the embedded workbook; exportFormat csv embeds a CSV file", async () => {
  const html = tableToHtml(bcrpp);
  assert.match(html, /data-dd-action="download" title="Download the dictionary as an Excel workbook \(\.xlsx\)">.*Excel<\/button>/);
  const data = JSON.parse(/var D=(\{.*?\});var root=/.exec(html)[1]);
  assert.equal(data.file.type, XLSX_MEDIA_TYPE);
  assert.match(data.file.name, /\.xlsx$/);
  const bytes = Uint8Array.from(Buffer.from(data.file.base64, "base64"));
  assert.deepEqual((await read(bytes)).worksheets.map((s) => s.name), ["Data dictionary", "Skip logic", "About"]);
  assert.ok(data.csv.startsWith("Variable name,"), "Copy still copies CSV text");

  const csv = JSON.parse(/var D=(\{.*?\});var root=/.exec(tableToHtml(bcrpp, { exportFormat: "csv" }))[1]);
  assert.equal(csv.file.type, "text/csv;charset=utf-8");
  assert.ok(csv.file.text.startsWith("﻿Variable name,"), "a byte-order mark so Excel reads UTF-8");
  assert.doesNotMatch(tableToHtml(bcrpp, { includeExport: false }), /data-dd-action="download"|"base64"/);
});

test("component: the download button offers the Excel workbook", { skip }, () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const el = renderDataDictionary(container, bcrpp);
  const button = el.shadowRoot.querySelector('[data-dd-action="download"]');
  assert.match(button.textContent, /Excel/);
  assert.match(button.title, /Excel workbook/);
  const csv = renderDataDictionary(container, bcrpp, { exportFormat: "csv" });
  assert.match(csv.shadowRoot.querySelector('[data-dd-action="download"]').textContent, /CSV/);
});
