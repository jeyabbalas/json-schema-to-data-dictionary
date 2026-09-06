// Pure transform from the data model to a render-ready view model. Both the static HTML
// string and the interactive web component consume this, so layout stays identical.

import type {
  ConditionalRule,
  DataDictionaryRow,
  DataDictionaryTable,
  JsonValue,
  RenderHtmlOptions,
  SemanticSearchOptions,
  ValidValue
} from "../types";
import type { SearchFields } from "../search/ranking";
import { additionalInfoText, constraintsText, validValuesText } from "../serialize";
import { displayValue } from "../utils";

/** Render options plus the component-only settings (the static HTML never sets them). */
export type ViewModelOptions = RenderHtmlOptions & {
  semanticSearch?: SemanticSearchOptions | undefined;
  pageSize?: number | undefined;
  resultsPageSize?: number | undefined;
};

export interface ResolvedOptions {
  title: string;
  emptyCell: string;
  searchPlaceholder: string;
  includeExport: boolean;
  expandCategories: boolean;
  expandAdditionalInfo: boolean;
  theme: "light" | "dark" | "auto";
  /** True when the interactive component was given `semanticSearch` (status chip shown). */
  semanticSearch: boolean;
  /** Rows materialised per category page in the component (`Infinity` = every row up front). */
  pageSize: number;
  /** Result rows per page in the component's ranked results list. */
  resultsPageSize: number;
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
  /** Index into `table.rows` (-1 if the row is not part of `table.rows`). */
  index: number;
  /** Title of the category the row belongs to. */
  category: string;
  /** The property key, or the full path of a nested field (`visits[].date`). */
  name: string;
  /** Nesting level: 0 for a top-level variable, 1 for a field of one, … */
  depth: number;
  /** Full path of the variable this row is a field of (nested rows only). */
  parent?: string | undefined;
  /**
   * Display split of `name`: the parent path with its separator, then the field's own name
   * (`visits[].` + `date`); `namePrefix + nameLeaf === name`. Empty prefix for top-level rows.
   */
  namePrefix: string;
  nameLeaf: string;
  description: string;
  dataType: string;
  format: string;
  measurements: ValueVM[];
  values: ValueVM[];
  sentinels: ValueVM[];
  constraints: ConstraintVM[];
  additionalInformation: JsonValue | null;
  searchText: string;
  /** Lower-cased per-field text used by the ranked search. */
  searchFields: SearchFields;
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

export function resolveOptions(options: ViewModelOptions, table: DataDictionaryTable): ResolvedOptions {
  return {
    title: options.title ?? table.title ?? "Data dictionary",
    emptyCell: options.emptyCell ?? "—",
    searchPlaceholder: options.searchPlaceholder ?? "Search variables, descriptions, values…",
    includeExport: options.includeExport ?? true,
    expandCategories: options.expandCategories ?? true,
    expandAdditionalInfo: options.expandAdditionalInfo ?? false,
    theme: options.theme ?? "auto",
    semanticSearch: Boolean(options.semanticSearch),
    pageSize: positiveOrDefault(options.pageSize, 100),
    resultsPageSize: positiveOrDefault(options.resultsPageSize, 50)
  };
}

/** `Infinity` passes through; anything else must be a positive number (floored), else the default. */
function positiveOrDefault(value: number | undefined, fallback: number): number {
  if (value === Infinity) return Infinity;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

const EMPTY_FIELDS: SearchFields = { name: "", description: "", values: "", all: "" };

/** Per-row search fields positioned by `table.rows` index (empty fields for rows outside any category). */
export function rowsByTableIndex(vm: ViewModel): SearchFields[] {
  const rows: SearchFields[] = Array.from({ length: vm.variableCount }, () => EMPTY_FIELDS);
  for (const category of vm.categories) {
    for (const row of category.rows) if (row.index >= 0 && row.index < rows.length) rows[row.index] = row.searchFields;
  }
  return rows;
}

/** Row view models positioned by `table.rows` index (undefined for rows outside any category). */
export function rowVMsByTableIndex(vm: ViewModel): Array<RowVM | undefined> {
  const rows: Array<RowVM | undefined> = new Array<RowVM | undefined>(vm.variableCount).fill(undefined);
  for (const category of vm.categories) {
    for (const row of category.rows) if (row.index >= 0 && row.index < rows.length) rows[row.index] = row;
  }
  return rows;
}

export function buildViewModel(table: DataDictionaryTable, options: ViewModelOptions = {}): ViewModel {
  const resolved = resolveOptions(options, table);

  // Rows are identified by object identity: categories hold the same row objects as table.rows.
  const rowIndex = new Map<DataDictionaryRow, number>(table.rows.map((row, i) => [row, i]));

  const categories: CategoryVM[] = table.categories.map((category) => ({
    id: category.id,
    title: category.title,
    ...(category.description ? { description: category.description } : {}),
    rows: category.rows.map((row) => buildRowVM(row, rowIndex.get(row) ?? -1, category.title))
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

/**
 * Split a nested row's path into the parent path (with its separator) and the leaf. The split
 * point is fixed by the parent's length -- never by scanning for dots, which a pattern-property
 * leaf (`./^il_[0-9]+$/`) can contain. Only the character(s) right after the parent are read:
 * `.` gives `parent.`; a bracket group (`[]`, `[0]`, `["odd name"]`) plus an optional `.` gives
 * `parent[].`, and when the group is the whole remainder the leaf IS the group (`genotype` +
 * `[0]`). Anything that does not fit (a parent that is not a prefix, an empty leaf) falls back
 * to no prefix at all; the row still indents by depth.
 */
export function splitVariableName(name: string, parent: string | undefined): [prefix: string, leaf: string] {
  if (!parent || name.length <= parent.length || !name.startsWith(parent)) return ["", name];
  const rest = name.slice(parent.length);
  if (rest.startsWith(".")) return rest.length > 1 ? [`${parent}.`, rest.slice(1)] : ["", name];
  if (rest.startsWith("[")) {
    const close = bracketGroupEnd(rest);
    if (close < 0) return ["", name];
    if (close === rest.length - 1) return [parent, rest];
    const after = close + (rest.charAt(close + 1) === "." ? 2 : 1);
    return after < rest.length ? [name.slice(0, parent.length + after), rest.slice(after)] : ["", name];
  }
  return ["", name];
}

/** Index of the `]` closing the bracket group `rest` starts with, reading a quoted name (`["x]y"]`) as one token. */
function bracketGroupEnd(rest: string): number {
  if (rest.charAt(1) !== '"') return rest.indexOf("]");
  let i = 2;
  while (i < rest.length && rest.charAt(i) !== '"') i += rest.charAt(i) === "\\" ? 2 : 1;
  return rest.charAt(i) === '"' && rest.charAt(i + 1) === "]" ? i + 1 : -1;
}

function buildRowVM(row: DataDictionaryTable["rows"][number], index: number, category: string): RowVM {
  const depth = typeof row.__depth === "number" && Number.isInteger(row.__depth) && row.__depth > 0 ? row.__depth : 0;
  const parent = typeof row.__parent === "string" && row.__parent ? row.__parent : undefined;
  const [namePrefix, nameLeaf] = splitVariableName(row["Variable name"], parent);
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

  const searchText = rowSearchText(row);
  return {
    index,
    category,
    name: row["Variable name"],
    depth,
    ...(parent !== undefined ? { parent } : {}),
    namePrefix,
    nameLeaf,
    description: row["Description"],
    dataType: row["Data type"],
    format: row["Format"],
    measurements,
    values,
    sentinels,
    constraints,
    additionalInformation: row["Additional information"],
    searchText,
    searchFields: {
      name: row["Variable name"].toLowerCase(),
      description: row["Description"].toLowerCase(),
      values: validValuesText(row["Valid values"]).toLowerCase(),
      all: searchText
    }
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
