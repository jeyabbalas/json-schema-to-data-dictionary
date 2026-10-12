// The data dictionary as a formatted Excel workbook -- what the download button saves.
//
// A CSV flattens every cell to one line of text: codes, their labels, the special codes and the
// skip patterns that set them run together, and the schema author's comments have nowhere to go.
// The workbook keeps the table's structure instead. The "Data dictionary" sheet has one row per
// variable, laid out like the rendered table: one code per line with the code bold, the special
// codes (missing / not applicable / refused …) apart and in amber, under a code the skip
// patterns that set it -- each with the rule's comment, why it does -- and the author's
// `$comment`s as notes. A "Skip logic" sheet lists every rule, and an "About" sheet holds the
// dataset's description and notes, its categories, its special codes and what each means, and a
// key to the formatting.
//
// The sheets are built from the same view model as the HTML, so the two say the same thing; the
// file is written by the dependency-free writer in xlsx.ts.

import type { DataDictionaryTable, JsonValue, XlsxExportOptions } from "./types";
import { buildViewModel } from "./render/viewModel";
import type { CategoryVM, ConstraintVM, RowVM, RuleGroupVM, ValueVM, ViewModel } from "./render/viewModel";
import { buildXlsx, columnLetter, XLSX_MEDIA_TYPE } from "./xlsx";
import type { XlsxCell, XlsxColumn, XlsxFont, XlsxRow, XlsxRun, XlsxSheet, XlsxStyle } from "./xlsx";

const MONO = "Consolas";
const COLOR = {
  header: "1F2937",
  headerText: "FFFFFF",
  muted: "6B7280",
  faint: "9CA3AF",
  line: "E5E7EB",
  section: "9CA3AF",
  sentinel: "B45309",
  accent: "4338CA",
  title: "111827"
} as const;

const HEADER_STYLE: XlsxStyle = {
  font: { bold: true, color: COLOR.headerText },
  fill: COLOR.header,
  alignment: { vertical: "center", wrapText: true }
};
const CELL_STYLE: XlsxStyle = {
  alignment: { vertical: "top", wrapText: true },
  border: { bottom: { style: "thin", color: COLOR.line } }
};

/** The dictionary sheet's columns, in order, with their widths in characters. */
const DICTIONARY_COLUMNS: ReadonlyArray<{ header: string; width: number }> = [
  { header: "Variable name", width: 30 },
  { header: "Category", width: 20 },
  { header: "Description", width: 50 },
  { header: "Data type", width: 18 },
  { header: "Format", width: 24 },
  { header: "Valid values", width: 52 },
  { header: "Constraints", width: 56 },
  { header: "Additional information", width: 36 }
];

/**
 * Build the workbook (an .xlsx file's bytes). Save it with the
 * `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` media type.
 */
export function tableToXlsx(table: DataDictionaryTable, options: XlsxExportOptions = {}): Uint8Array {
  const vm = buildViewModel(table, options.title ? { title: options.title } : {});
  const sheets: XlsxSheet[] = [dictionarySheet(vm)];
  if ((options.includeSkipLogic ?? true) && vm.rules.length > 0) sheets.push(skipLogicSheet(vm));
  if (options.includeAbout ?? true) sheets.push(aboutSheet(vm, table));
  return buildXlsx(
    {
      sheets,
      properties: {
        title: vm.title,
        ...(table.description ? { description: table.description } : {}),
        subject: "Data dictionary"
      }
    },
    { compress: options.compress ?? true }
  );
}

/** The media type of an .xlsx file, for a download Blob. */
export { XLSX_MEDIA_TYPE };

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/** Rich text built line by line. */
class Lines {
  readonly runs: XlsxRun[] = [];

  /** Start a new line (nothing before the first). */
  line(): this {
    if (this.runs.length > 0) this.runs.push({ text: "\n" });
    return this;
  }

  add(text: string, font?: XlsxFont): this {
    if (text) this.runs.push(font ? { text, font } : { text });
    return this;
  }

  /** A `$comment` explaining the line above: its own line, italic and muted. */
  why(text: string | undefined, indent = ""): this {
    if (text) this.line().add(`${indent}${text}`, { italic: true, color: COLOR.muted });
    return this;
  }

  /** The schema author's note on a variable, section or the dataset. */
  note(text: string | undefined): this {
    if (!text) return this;
    this.line().add("Note: ", { bold: true, color: COLOR.muted }).add(text, { italic: true, color: COLOR.muted });
    return this;
  }

  get value(): XlsxRun[] | string {
    return this.runs.length > 0 ? this.runs : "";
  }
}

// ---------------------------------------------------------------------------
// Data dictionary sheet
// ---------------------------------------------------------------------------

function dictionarySheet(vm: ViewModel): XlsxSheet {
  const rows: XlsxRow[] = [{ cells: DICTIONARY_COLUMNS.map((c) => c.header), style: HEADER_STYLE }];
  for (const category of vm.categories) {
    category.rows.forEach((row, i) => {
      // A heavier rule above the first variable of each category: the sections stay visible
      // without rows of their own, which would get in the way of sorting and filtering.
      const style: XlsxStyle = i === 0 && rows.length > 1 ? { ...CELL_STYLE, border: { ...CELL_STYLE.border, top: { style: "medium", color: COLOR.section } } } : CELL_STYLE;
      rows.push({ cells: dictionaryCells(row, category), style });
    });
  }
  const columns: XlsxColumn[] = DICTIONARY_COLUMNS.map((c) => ({ width: c.width }));
  return {
    name: "Data dictionary",
    columns,
    rows,
    freeze: { rows: 1, columns: 1 },
    autoFilter: `A1:${columnLetter(DICTIONARY_COLUMNS.length)}${rows.length}`,
    printTitleRows: "1:1",
    page: { orientation: "landscape", fitToWidth: true }
  };
}

function dictionaryCells(row: RowVM, category: CategoryVM): XlsxCell[] {
  const name = row.namePrefix
    ? [
        { text: row.namePrefix, font: { name: MONO, color: COLOR.muted } },
        { text: row.nameLeaf, font: { name: MONO, bold: true } }
      ]
    : [{ text: row.name, font: { name: MONO, bold: true } }];
  const mixed = /coded values/.test(row.dataType);
  return [
    { value: name, ...(row.depth > 0 ? { style: { alignment: { indent: Math.min(row.depth, 15) } } } : {}) },
    { value: category.title, style: { font: { color: COLOR.muted } } },
    { value: new Lines().add(row.description).note(row.comment).value },
    { value: row.dataType, ...(mixed ? { style: { font: { color: COLOR.sentinel } } } : {}) },
    { value: row.format },
    { value: validValues(row) },
    { value: constraints(row) },
    { value: additionalInformation(row.additionalInformation) }
  ];
}

function validValues(row: RowVM): XlsxRun[] | string {
  const out = new Lines();
  for (const m of row.measurements) {
    out.line().add(m.display, { name: MONO, bold: true }).add(`  ${m.description ?? "measured value"}`, { color: COLOR.muted });
    out.why(m.comment, "  ");
  }
  for (const v of row.values) value(out, v, false);
  if (row.sentinels.length > 0) {
    // As in the table: the heading divides real values from special codes, so it only appears
    // when there is something above it.
    if (row.measurements.length > 0 || row.values.length > 0) out.line().add("Special codes", { bold: true, color: COLOR.sentinel });
    for (const v of row.sentinels) value(out, v, true);
  }
  return out.value;
}

/** A code and its label; under it, the skip patterns that set the variable to it and why. */
function value(out: Lines, v: ValueVM, sentinel: boolean): void {
  out.line().add(v.display, { name: MONO, bold: true, ...(sentinel ? { color: COLOR.sentinel } : {}) });
  const text = v.label ?? v.description;
  if (text) out.add(`  ${text}`);
  out.why(v.comment, "  ");
  for (const c of v.conditions) {
    out.line().add("    if ", { color: COLOR.muted }).add(c.text, { color: COLOR.accent });
    out.why(c.comment, "      ");
  }
}

function constraints(row: RowVM): XlsxRun[] | string {
  const out = new Lines();
  // A skip pattern that sets the variable to one of its listed values is shown on that value.
  for (const c of row.constraints.filter((item: ConstraintVM) => !item.onValues)) {
    out.line().add("• ", { color: c.conditional ? COLOR.accent : COLOR.faint }).add(c.text);
    out.why(c.comment, "   ");
  }
  return out.value;
}

/** One keyword per line: `x-unit: years`; structured values as compact JSON. */
function additionalInformation(info: JsonValue | null): XlsxRun[] | string {
  if (info === null) return "";
  const out = new Lines();
  if (typeof info !== "object" || Array.isArray(info)) return JSON.stringify(info);
  for (const [key, val] of Object.entries(info)) {
    out.line().add(`${key}: `, { color: COLOR.muted }).add(typeof val === "string" ? val : JSON.stringify(val));
  }
  return out.value;
}

// ---------------------------------------------------------------------------
// Skip logic sheet
// ---------------------------------------------------------------------------

function skipLogicSheet(vm: ViewModel): XlsxSheet {
  const headers = ["Rule", "When", "Then", "Variables", "Note"];
  const rows: XlsxRow[] = [{ cells: headers, style: HEADER_STYLE }];
  vm.rules.forEach((rule, i) => {
    rule.groups.forEach((group, g) => {
      // A rule's further effects repeat its number and condition, muted, so a filtered or
      // sorted sheet still says what each line belongs to.
      const continued = g > 0;
      const style: XlsxStyle = continued ? CELL_STYLE : { ...CELL_STYLE, border: { ...CELL_STYLE.border, top: { style: "thin", color: COLOR.section } } };
      const muted = continued ? { font: { color: COLOR.faint } } : {};
      rows.push({
        style,
        cells: [
          { value: i + 1, style: { ...muted, alignment: { horizontal: "left" } } },
          { value: rule.condition, style: muted },
          { value: requirement(group) },
          { value: group.variables.join(", "), style: { font: { name: MONO } } },
          { value: rule.description ?? "", style: { font: { italic: true, color: COLOR.muted } } }
        ]
      });
    });
  });
  return {
    name: "Skip logic",
    columns: [{ width: 7 }, { width: 50 }, { width: 46 }, { width: 46 }, { width: 60 }],
    rows,
    freeze: { rows: 1 },
    autoFilter: `A1:E${rows.length}`,
    printTitleRows: "1:1",
    page: { orientation: "landscape", fitToWidth: true }
  };
}

/**
 * What a rule requires of a group of variables, about "value" as the dictionary's sentences are:
 * "value = "gold" or absent". The values are written as JSON, so a code "4" reads apart from 4.
 */
function requirement(g: RuleGroupVM): XlsxRun[] {
  const codes = (values: string[]): XlsxRun => ({ text: values.join(", "), font: { name: MONO, bold: true } });
  const label = g.label ? [{ text: ` (${g.label})` }] : [];
  const qualifier: XlsxRun[] = g.qualifier ? [{ text: ` ${g.qualifier}`, font: { italic: true, color: COLOR.muted } }] : [];
  switch (g.kind) {
    case undefined:
    case "equals":
      return g.literals.length > 0 ? [{ text: "value = " }, codes(g.literals), ...label, ...qualifier] : [{ text: "constrained" }];
    case "oneOf":
      return [{ text: "value is one of " }, codes(g.literals), ...qualifier];
    case "notEquals":
      return [{ text: "value ≠ " }, codes(g.literals), ...label, ...qualifier];
    case "notOneOf":
      return [{ text: "value is not one of " }, codes(g.literals), ...qualifier];
    default:
      return [{ text: g.text ?? "constrained" }];
  }
}

// ---------------------------------------------------------------------------
// About sheet
// ---------------------------------------------------------------------------

const LEGEND: ReadonlyArray<[string, string]> = [
  ["Valid values", "One code per line, the code in bold and its label after it. A range such as 0–120 is the measured value; special codes (missing, not applicable, refused, don't know …) follow under “Special codes”, in amber."],
  ["if …", "Under a code: a skip pattern that sets the variable to that code, and — in italics — the schema author's explanation of the rule."],
  ["Constraints", "Ranges and other rules. A line with a condition — “When …”, “Required when … is present”, “Each item: When …” — applies only where the condition holds (skip patterns that allow, rule out or require values), with the author's explanation, where there is one, in italics."],
  ["Required", "The variable is present in every record — possibly as null, where its type allows null. It may still hold a special code, such as “not applicable”, where a skip pattern says so."],
  ["Note", "A comment the schema's author wrote about a variable, a section or the dataset."],
  ["Additional information", "Further schema keywords, such as units, the universe a question is asked of, or how a value is derived."],
  ["Skip logic", "Every if/then skip pattern, one line per group of variables it affects. “value =” sets them, “value ≠” and “is not one of” rule values out, “is one of” allows only the listed values; “or absent”: the variable may also be left out; “(required)”: the rule also requires it, and “value must be present”: it requires the variable whatever its value (“may be null”: null will do). “If x is an object”: a field of x is required only where x is an object. “In the same item”: the condition and the variables are fields of one item of a list; “x[0]” is the first item of the list x, and “from x[1] on” its items after the first. A test of a variable that may be null says what null does (“or value is null”), unless the rule's other side settles it. A “when x is present, y is also required” rule (dependentRequired) is stated on the rows of x and y instead."]
];

/** Each distinct special code (code, label and description), with the number of variables using it, most used first. */
function specialCodes(table: DataDictionaryTable): Array<{ display: string; label: string; description: string; count: number }> {
  const byKey = new Map<string, { display: string; label: string; description: string; count: number }>();
  for (const row of table.rows) {
    for (const v of row["Valid values"]) {
      if (v.kind !== "sentinel") continue;
      const display = typeof v.value === "string" ? v.value : JSON.stringify(v.value);
      const label = v.label ?? "";
      const description = v.description && v.description !== label ? v.description : "";
      const key = JSON.stringify([display, label, description]);
      const entry = byKey.get(key) ?? { display, label, description, count: 0 };
      entry.count += 1;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

function aboutSheet(vm: ViewModel, table: DataDictionaryTable): XlsxSheet {
  const rows: XlsxRow[] = [];
  const merges: string[] = [];
  const wide = (cells: Array<XlsxCell | string>, style?: XlsxStyle): void => {
    rows.push({ cells, ...(style ? { style } : {}) });
    merges.push(`A${rows.length}:D${rows.length}`);
  };
  const blank = (): void => {
    rows.push({ cells: [] });
  };
  const heading = (text: string): void => {
    blank();
    wide([{ value: text, style: { font: { bold: true, size: 12, color: COLOR.title } } }]);
  };
  const wrap: XlsxStyle = { alignment: { vertical: "top", wrapText: true } };

  rows.push({ cells: [{ value: vm.title, style: { font: { bold: true, size: 16, color: COLOR.title } } }] });
  if (vm.description) wide([vm.description], wrap);
  if (vm.comment) wide([{ value: new Lines().note(vm.comment).value }], wrap);
  blank();
  const counts: Array<[string, number]> = [
    ["Variables", vm.variableCount],
    ["Categories", vm.categories.length],
    ["Skip-logic rules", vm.rules.length]
  ];
  for (const [label, count] of counts) rows.push({ cells: [{ value: label, style: { font: { color: COLOR.muted } } }, count] });
  if (table.source?.uri) rows.push({ cells: [{ value: "Schema", style: { font: { color: COLOR.muted } } }, table.source.uri] });

  heading("Categories");
  rows.push({ cells: ["Category", "Variables", "Description", "Note"], style: HEADER_STYLE });
  for (const category of vm.categories) {
    rows.push({
      style: CELL_STYLE,
      cells: [
        { value: category.title, style: { font: { bold: true } } },
        { value: category.rows.length, style: { alignment: { horizontal: "left" } } },
        category.description ?? "",
        { value: category.comment ?? "", style: { font: { italic: true, color: COLOR.muted } } }
      ]
    });
  }

  // The special codes once, with what each means: a cell shows a code's label only.
  const codes = specialCodes(table);
  if (codes.length > 0) {
    heading("Special codes");
    rows.push({ cells: ["Code", "Variables", "Label", "Description"], style: HEADER_STYLE });
    for (const code of codes) {
      rows.push({
        style: CELL_STYLE,
        cells: [
          { value: code.display, style: { font: { name: MONO, bold: true, color: COLOR.sentinel } } },
          { value: code.count, style: { alignment: { horizontal: "left" } } },
          code.label,
          code.description
        ]
      });
    }
  }

  heading("How to read this workbook");
  for (const [term, meaning] of LEGEND) {
    rows.push({ cells: [{ value: term, style: { font: { bold: true } } }, meaning], style: wrap });
    merges.push(`B${rows.length}:D${rows.length}`);
  }

  if (vm.additionalInformation !== null && typeof vm.additionalInformation === "object" && !Array.isArray(vm.additionalInformation)) {
    heading("Dataset metadata");
    for (const [key, val] of Object.entries(vm.additionalInformation)) {
      rows.push({ cells: [{ value: key, style: { font: { color: COLOR.muted } } }, typeof val === "string" ? val : JSON.stringify(val)], style: wrap });
      merges.push(`B${rows.length}:D${rows.length}`);
    }
  }
  if (vm.warnings.length > 0) {
    heading("Extraction warnings");
    for (const warning of vm.warnings) wide([warning], wrap);
  }
  return { name: "About", columns: [{ width: 28 }, { width: 14 }, { width: 70 }, { width: 50 }], rows, merges, showGridLines: false };
}
