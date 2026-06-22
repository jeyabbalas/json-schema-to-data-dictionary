// Pure transform from the data model to a render-ready view model. Both the static HTML
// string and the interactive web component consume this, so layout stays identical.

import type {
  ConditionalRule,
  DataDictionaryTable,
  JsonValue,
  RenderHtmlOptions,
  ValidValue
} from "../types";
import { additionalInfoText, constraintsText, validValuesText } from "../serialize";
import { displayValue } from "../utils";

export interface ResolvedOptions {
  title: string;
  emptyCell: string;
  searchPlaceholder: string;
  includeExport: boolean;
  expandCategories: boolean;
  expandAdditionalInfo: boolean;
  theme: "light" | "dark" | "auto";
}

export interface ValueVM {
  display: string;
  label?: string | undefined;
  description?: string | undefined;
  condition?: string | undefined;
}

export interface ConstraintVM {
  text: string;
  conditional: boolean;
}

export interface RowVM {
  name: string;
  description: string;
  dataType: string;
  format: string;
  measurements: ValueVM[];
  values: ValueVM[];
  sentinels: ValueVM[];
  constraints: ConstraintVM[];
  additionalInformation: JsonValue | null;
  searchText: string;
}

export interface CategoryVM {
  id: string;
  title: string;
  description?: string | undefined;
  rows: RowVM[];
}

export interface RuleVM {
  condition: string;
  description?: string | undefined;
  effects: string[];
}

export interface ViewModel {
  title: string;
  description?: string | undefined;
  comment?: string | undefined;
  variableCount: number;
  categories: CategoryVM[];
  rules: RuleVM[];
  additionalInformation: JsonValue | null;
  warnings: string[];
  options: ResolvedOptions;
}

export function resolveOptions(options: RenderHtmlOptions, table: DataDictionaryTable): ResolvedOptions {
  return {
    title: options.title ?? table.title ?? "Data dictionary",
    emptyCell: options.emptyCell ?? "—",
    searchPlaceholder: options.searchPlaceholder ?? "Search variables, descriptions, values…",
    includeExport: options.includeExport ?? true,
    expandCategories: options.expandCategories ?? true,
    expandAdditionalInfo: options.expandAdditionalInfo ?? false,
    theme: options.theme ?? "auto"
  };
}

export function buildViewModel(table: DataDictionaryTable, options: RenderHtmlOptions = {}): ViewModel {
  const resolved = resolveOptions(options, table);

  const categories: CategoryVM[] = table.categories.map((category) => ({
    id: category.id,
    title: category.title,
    ...(category.description ? { description: category.description } : {}),
    rows: category.rows.map(buildRowVM)
  }));

  const rules: RuleVM[] = table.conditionalRules.map(buildRuleVM);

  return {
    title: resolved.title,
    ...(table.description ? { description: table.description } : {}),
    ...(table.comment ? { comment: table.comment } : {}),
    variableCount: table.rows.length,
    categories,
    rules,
    additionalInformation: table.additionalInformation ?? null,
    warnings: table.warnings,
    options: resolved
  };
}

function buildRowVM(row: DataDictionaryTable["rows"][number]): RowVM {
  const measurements: ValueVM[] = [];
  const values: ValueVM[] = [];
  const sentinels: ValueVM[] = [];

  for (const v of row["Valid values"]) {
    const vm = toValueVM(v);
    if (v.kind === "measurement") measurements.push(vm);
    else if (v.kind === "sentinel") sentinels.push(vm);
    else values.push(vm);
  }

  const constraints: ConstraintVM[] = row["Constraints"].map((c) => ({
    text: c.text,
    conditional: c.keyword === "conditional" || c.keyword === "if/then" || c.keyword === "dependentRequired" || !!c.condition
  }));

  return {
    name: row["Variable name"],
    description: row["Description"],
    dataType: row["Data type"],
    format: row["Format"],
    measurements,
    values,
    sentinels,
    constraints,
    additionalInformation: row["Additional information"],
    searchText: rowSearchText(row)
  };
}

function toValueVM(v: ValidValue): ValueVM {
  return {
    display: v.kind === "measurement" ? v.label ?? "measured value" : displayValue(v.value),
    ...(v.kind !== "measurement" && v.label ? { label: v.label } : {}),
    ...(v.description ? { description: v.description } : {}),
    ...(v.condition ? { condition: v.condition } : {})
  };
}

function buildRuleVM(rule: ConditionalRule): RuleVM {
  const effects = rule.effects.map((e) => {
    const value = Array.isArray(e.value)
      ? e.value.length
        ? `∈ {${e.value.map(displayValue).join(", ")}}`
        : "(constrained)"
      : `= ${displayValue(e.value)}`;
    const label = e.label ? ` (${e.label})` : "";
    return `${e.variable} ${value}${label}`;
  });
  return {
    condition: rule.condition,
    ...(rule.description ? { description: rule.description } : {}),
    effects
  };
}

function rowSearchText(row: DataDictionaryTable["rows"][number]): string {
  return [
    row["Variable name"],
    row["Description"],
    row["Data type"],
    row["Format"],
    validValuesText(row["Valid values"]),
    constraintsText(row["Constraints"]),
    additionalInfoText(row["Additional information"])
  ]
    .join("  ")
    .toLowerCase();
}
