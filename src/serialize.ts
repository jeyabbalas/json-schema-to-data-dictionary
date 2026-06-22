// Flatten the rich row model into plain rows / CSV for spreadsheet export.

import type { ConstraintItem, DataDictionaryRow, DataDictionaryTable, PlainRowsOptions, ValidValue } from "./types";
import { cloneJson, displayValue, stableStringify } from "./utils";

const COLUMNS = [
  "Variable name",
  "Description",
  "Data type",
  "Format",
  "Valid values",
  "Constraints",
  "Additional information"
] as const;

/** One valid value rendered as a single human-readable line. */
export function validValueLine(v: ValidValue): string {
  if (v.kind === "measurement") return v.label ? `${v.label} (measured value)` : "measured value";
  const head = displayValue(v.value);
  const label = v.label ?? v.description;
  const cond = v.condition ? ` [when ${v.condition}]` : "";
  return label ? `${head} = ${label}${cond}` : `${head}${cond}`;
}

export function validValuesText(values: ValidValue[]): string {
  return values.map(validValueLine).join("; ");
}

export function constraintsText(constraints: ConstraintItem[]): string {
  return constraints.map((c) => c.text).join(" ");
}

export function additionalInfoText(info: DataDictionaryRow["Additional information"]): string {
  if (info === null || info === undefined) return "";
  return stableStringify(info);
}

/**
 * Convert the table to plain rows. By default complex columns are stringified so the
 * result can be written straight to CSV/XLSX; pass `stringifyComplexColumns: false` to keep
 * the structured values.
 */
export function toPlainRows(table: DataDictionaryTable, options: PlainRowsOptions = {}): Array<Record<string, unknown>> {
  const stringify = options.stringifyComplexColumns ?? true;
  const empty = options.emptyCell ?? "";

  return table.rows.map((row) => {
    const plain: Record<string, unknown> = {
      "Variable name": row["Variable name"],
      Description: row["Description"] || empty,
      "Data type": row["Data type"] || empty,
      Format: row["Format"] || empty,
      "Valid values": stringify ? validValuesText(row["Valid values"]) || empty : cloneJson(row["Valid values"]),
      Constraints: stringify ? constraintsText(row["Constraints"]) || empty : cloneJson(row["Constraints"]),
      "Additional information": stringify ? additionalInfoText(row["Additional information"]) || empty : cloneJson(row["Additional information"])
    };
    if (options.includeInternalColumns) {
      plain.Category = row.__category ?? empty;
      plain.Source = row.__source ? stableStringify(row.__source) : empty;
    }
    return plain;
  });
}

/** Render the table as a CSV string (RFC 4180 quoting). */
export function tableToCsv(table: DataDictionaryTable, options: PlainRowsOptions = {}): string {
  const includeCategory = options.includeInternalColumns ?? false;
  const headers = includeCategory ? ["Category", ...COLUMNS] : [...COLUMNS];
  const lines = [headers.map(csvCell).join(",")];

  for (const row of table.rows) {
    const cells = [
      row["Variable name"],
      row["Description"],
      row["Data type"],
      row["Format"],
      validValuesText(row["Valid values"]),
      constraintsText(row["Constraints"]),
      additionalInfoText(row["Additional information"])
    ];
    if (includeCategory) cells.unshift(row.__category ?? "");
    lines.push(cells.map(csvCell).join(","));
  }

  return lines.join("\r\n");
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
