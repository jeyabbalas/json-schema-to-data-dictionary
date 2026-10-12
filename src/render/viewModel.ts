// Pure transform from the data model to a render-ready view model. Both the static HTML
// string and the interactive web component consume this, so layout stays identical.

import type {
  ConditionalEffect,
  ConditionalEffectKind,
  ConditionalRule,
  ConstraintItem,
  DataDictionaryRow,
  DataDictionaryTable,
  JsonValue,
  RenderHtmlOptions,
  SemanticSearchOptions,
  ValidValue
} from "../types";
import type { SearchFields } from "../search/ranking";
import { additionalInfoText, constraintsText, validValuesText } from "../serialize";
import { displayValue, formatJsonValue, valueKey } from "../utils";
import { widthsByKey } from "./columns";
import type { WidthsByKey } from "./columns";

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
  /** What the download button saves. */
  exportFormat: "xlsx" | "csv";
  expandCategories: boolean;
  expandAdditionalInfo: boolean;
  theme: "light" | "dark" | "auto";
  /** True when the interactive component was given `semanticSearch` (status chip shown). */
  semanticSearch: boolean;
  /** Rows materialised per category page in the component (`Infinity` = every row up front). */
  pageSize: number;
  /** Result rows per page in the component's ranked results list. */
  resultsPageSize: number;
  /** Starting column widths by column key (`{ description: 420 }`). */
  columnWidths: WidthsByKey;
}

/** A skip-pattern condition, with the variables it reads (each a row the reader can jump to). */
export interface ConditionVM {
  text: string;
  triggers: string[];
  /** The rule's `$comment`: why the pattern sets the value. */
  comment?: string | undefined;
}

export interface ValueVM {
  display: string;
  label?: string | undefined;
  description?: string | undefined;
  /** Every condition the value is used under, joined by "; " (as on the `ValidValue`). */
  condition?: string | undefined;
  /** The same conditions one by one: the skip patterns that set the variable to this value. */
  conditions: ConditionVM[];
  /** The schema author's `$comment` on the value. */
  comment?: string | undefined;
}

export interface ConstraintVM {
  text: string;
  conditional: boolean;
  /** Variables a conditional constraint's condition reads. */
  triggers: string[];
  /** Other variables the text names (the rest of an "at least one of these" group). */
  references: string[];
  /** The `$comment` of the rule the constraint comes from. */
  comment?: string | undefined;
  /**
   * A skip pattern that sets the variable to one listed value: the renderer shows its condition
   * on that value (Valid values) instead of repeating it as a constraint. A pattern that allows a
   * set of values stays a constraint -- it does not make any one of them *the* value.
   */
  onValues: boolean;
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
  /** The `title` / `description` text (the row's `Description` without its comment lines). */
  description: string;
  /** The schema author's `$comment`s on the variable, shown apart as a note. */
  comment?: string | undefined;
  dataType: string;
  format: string;
  measurements: ValueVM[];
  values: ValueVM[];
  sentinels: ValueVM[];
  constraints: ConstraintVM[];
  additionalInformation: JsonValue | null;
  /** Positions in `ViewModel.rules` of the skip patterns whose condition reads this variable. */
  skipRules: number[];
  searchText: string;
  /** Lower-cased per-field text used by the ranked search. */
  searchFields: SearchFields;
}

export interface CategoryVM {
  id: string;
  title: string;
  description?: string | undefined;
  comment?: string | undefined;
  rows: RowVM[];
}

/** The variables one skip pattern affects the same way. */
export interface RuleGroupVM {
  /**
   * How they are affected: set to a value (`equals`), one of a set (`oneOf`), anything but a
   * value or set (`notEquals`, `notOneOf`), or a requirement in words (`text`). Absent on rules
   * built before 0.8, which only pinned values.
   */
  kind?: ConditionalEffectKind | undefined;
  /** The values it sets, allows or rules out, displayed; empty when the effect is stated in `text`. */
  values: string[];
  /** The same values as JSON, a string in quotes (`"gold"`, `4`, `null`): text that must tell "4" from 4. */
  literals: string[];
  label?: string | undefined;
  /**
   * What the values leave unsaid: "or absent" (the rule allows the variable to be missing) or
   * "(required)" / "(required if point is an object)" (the rule also requires it).
   */
  qualifier?: string | undefined;
  /** The requirement in words, for effects that are not about listed values (a range, "at least one of …"). */
  text?: string | undefined;
  /** The object a field is required of ("point"), which `qualifier` or `text` names. */
  within?: string | undefined;
  /** The variables, by their names in the rule: a position in a list (`days[0]`) is its list's row's. */
  variables: string[];
}

export interface RuleVM {
  condition: string;
  description?: string | undefined;
  /** One line per effect: "age_preg1 = 777 (Nonparous)". */
  effects: string[];
  /** Variables the condition reads. */
  triggers: string[];
  /** The effects grouped by the value they set, in order of first appearance. */
  groups: RuleGroupVM[];
}

export interface ViewModel {
  title: string;
  description?: string | undefined;
  comment?: string | undefined;
  variableCount: number;
  categories: CategoryVM[];
  rules: RuleVM[];
  /** Every variable name that has a row (what a skip-pattern reference can jump to). */
  names: ReadonlySet<string>;
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
    exportFormat: options.exportFormat === "csv" ? "csv" : "xlsx",
    expandCategories: options.expandCategories ?? true,
    expandAdditionalInfo: options.expandAdditionalInfo ?? false,
    theme: options.theme ?? "auto",
    semanticSearch: Boolean(options.semanticSearch),
    pageSize: positiveOrDefault(options.pageSize, 100),
    resultsPageSize: positiveOrDefault(options.resultsPageSize, 50),
    columnWidths: widthsByKey(options.columnWidths)
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

  const rules: RuleVM[] = table.conditionalRules.map(buildRuleVM);
  // Which rules each variable triggers, and the variables a bare condition string reads (for
  // values of a table built without `triggers` on its constraints).
  const rulesByTrigger = new Map<string, number[]>();
  const triggersByCondition = new Map<string, string[]>();
  rules.forEach((rule, i) => {
    if (!triggersByCondition.has(rule.condition)) triggersByCondition.set(rule.condition, rule.triggers);
    for (const name of rule.triggers) {
      const list = rulesByTrigger.get(name) ?? [];
      list.push(i);
      rulesByTrigger.set(name, list);
    }
  });

  const categories: CategoryVM[] = table.categories.map((category) => ({
    id: category.id,
    title: category.title,
    ...(category.description ? { description: category.description } : {}),
    ...(category.comment ? { comment: category.comment } : {}),
    rows: category.rows.map((row) =>
      buildRowVM(row, rowIndex.get(row) ?? -1, category.title, rulesByTrigger.get(row["Variable name"]) ?? [], triggersByCondition)
    )
  }));

  return {
    title: resolved.title,
    ...(table.description ? { description: table.description } : {}),
    ...(table.comment ? { comment: table.comment } : {}),
    variableCount: table.rows.length,
    categories,
    rules,
    names: new Set(table.rows.map((row) => row["Variable name"])),
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

function buildRowVM(
  row: DataDictionaryTable["rows"][number],
  index: number,
  category: string,
  skipRules: number[],
  triggersByCondition: ReadonlyMap<string, string[]>
): RowVM {
  const depth = typeof row.__depth === "number" && Number.isInteger(row.__depth) && row.__depth > 0 ? row.__depth : 0;
  const parent = typeof row.__parent === "string" && row.__parent ? row.__parent : undefined;
  const [namePrefix, nameLeaf] = splitVariableName(row["Variable name"], parent);
  const measurements: ValueVM[] = [];
  const values: ValueVM[] = [];
  const sentinels: ValueVM[] = [];

  // Skip patterns that set this variable to one value: the conditions each value is used under
  // come from them, with the variables each condition reads. A pin whose value is listed is then
  // shown there, and needs no repeating among the constraints -- unless it also lets the variable
  // be absent, which the value's badge does not say. A pattern that allows a set of values stays
  // a constraint: under it the variable may take any of them.
  const pins = row["Constraints"].filter((c) => c.keyword === "conditional" && c.value !== undefined && !Array.isArray(c.value) && c.condition);
  const shown = new Set<ConstraintItem>();
  const conditionsOf = (v: ValidValue): ConditionVM[] => {
    const key = valueKey(v.value);
    const out: ConditionVM[] = [];
    for (const pin of pins) {
      if (valueKey(pin.value) !== key) continue;
      shown.add(pin);
      if (!out.some((o) => o.text === pin.condition)) {
        out.push({ text: pin.condition as string, triggers: pin.triggers ?? [], ...(pin.comment ? { comment: pin.comment } : {}) });
      }
    }
    if (out.length > 0 || !v.condition) return out;
    // A table without the structured pins: fall back to the condition text. Tables from 0.7 and
    // earlier joined several with "; "; a condition of its own can contain one ("exactly one of: …").
    const texts = /exactly one of|at least one of/.test(v.condition) ? [v.condition] : v.condition.split("; ");
    return texts.map((text) => ({ text, triggers: triggersByCondition.get(text) ?? [] }));
  };

  for (const v of row["Valid values"]) {
    const vm = toValueVM(v, v.kind === "measurement" ? [] : conditionsOf(v));
    if (v.kind === "measurement") measurements.push(vm);
    else if (v.kind === "sentinel") sentinels.push(vm);
    else values.push(vm);
  }

  const constraints: ConstraintVM[] = row["Constraints"].map((c) => ({
    text: c.text,
    conditional: c.keyword === "conditional" || c.keyword === "if/then" || c.keyword === "dependentRequired" || !!c.condition,
    triggers: c.triggers ?? (c.condition ? triggersByCondition.get(c.condition) ?? [] : []),
    references: c.references ?? [],
    ...(c.comment ? { comment: c.comment } : {}),
    onValues: shown.has(c) && !c.orAbsent
  }));

  const searchText = rowSearchText(row);
  const { text: description, comment } = splitDescription(row);
  return {
    index,
    category,
    name: row["Variable name"],
    depth,
    ...(parent !== undefined ? { parent } : {}),
    namePrefix,
    nameLeaf,
    description,
    ...(comment ? { comment } : {}),
    dataType: row["Data type"],
    format: row["Format"],
    measurements,
    values,
    sentinels,
    constraints,
    additionalInformation: row["Additional information"],
    skipRules,
    searchText,
    searchFields: {
      name: row["Variable name"].toLowerCase(),
      description: row["Description"].toLowerCase(),
      values: validValuesText(row["Valid values"]).toLowerCase(),
      all: searchText
    }
  };
}

function toValueVM(v: ValidValue, conditions: ConditionVM[]): ValueVM {
  return {
    display: v.kind === "measurement" ? v.label ?? "measured value" : displayValue(v.value),
    ...(v.kind !== "measurement" && v.label ? { label: v.label } : {}),
    ...(v.description ? { description: v.description } : {}),
    ...(v.condition ? { condition: v.condition } : {}),
    conditions,
    ...(v.comment ? { comment: v.comment } : {})
  };
}

/**
 * A row's `Description` split into its text and the `$comment` lines it ends with (as the
 * extractor writes it). A description that does not end with them is shown whole.
 */
export function splitDescription(row: Pick<DataDictionaryRow, "Description" | "__comment">): { text: string; comment?: string } {
  const description = row["Description"];
  const comment = row.__comment?.trim();
  if (!comment) return { text: description };
  if (description.trim() === comment) return { text: "", comment };
  const at = description.lastIndexOf(comment);
  if (at > 0 && at + comment.length === description.length && /\n\s*$/.test(description.slice(0, at))) {
    return { text: description.slice(0, at).trim(), comment };
  }
  return { text: description, comment };
}

function buildRuleVM(rule: ConditionalRule): RuleVM {
  const effects = rule.effects.map((e) => {
    if (e.text && e.kind !== "equals" && e.kind !== "oneOf") return `${e.variable}: ${e.text}`;
    const value = Array.isArray(e.value)
      ? e.value.length
        ? `∈ {${e.value.map(displayValue).join(", ")}}`
        : "(constrained)"
      : `= ${displayValue(e.value)}`;
    const label = e.label ? ` (${e.label})` : "";
    return `${e.variable} ${value}${label}`;
  });
  const groups: RuleGroupVM[] = [];
  const byKey = new Map<string, RuleGroupVM>();
  for (const e of rule.effects) {
    const group = groupOf(e);
    const key = JSON.stringify([group.kind ?? null, group.literals, group.label ?? null, group.qualifier ?? null, group.text ?? null]);
    let existing = byKey.get(key);
    if (!existing) {
      existing = group;
      byKey.set(key, existing);
      groups.push(existing);
    }
    if (!existing.variables.includes(e.variable)) existing.variables.push(e.variable);
  }
  return {
    condition: rule.condition,
    ...(rule.description ? { description: rule.description } : {}),
    effects,
    triggers: rule.triggers ?? [],
    groups
  };
}

/** How one effect shows in a rule's list: the values it is about, or its requirement in words. */
function groupOf(e: ConditionalEffect): RuleGroupVM {
  const label = e.label ? { label: e.label } : {};
  const within = e.required && e.within ? { within: e.within } : {};
  const qualifier = e.required ? { qualifier: e.within ? `(required if ${e.within} is an object)` : "(required)" } : e.orAbsent ? { qualifier: "or absent" } : {};
  switch (e.kind) {
    case undefined:
    case "equals":
    case "oneOf": {
      const values = Array.isArray(e.value) ? e.value : [e.value];
      return { ...(e.kind ? { kind: e.kind } : {}), values: values.map(displayValue), literals: values.map(formatJsonValue), ...label, ...qualifier, ...within, variables: [] };
    }
    case "notEquals":
    case "notOneOf": {
      const values = e.excluded ?? [];
      return { kind: e.kind, values: values.map(displayValue), literals: values.map(formatJsonValue), ...label, ...qualifier, ...within, variables: [] };
    }
    default:
      return { kind: e.kind, values: [], literals: [], ...(e.text ? { text: e.text } : {}), ...within, variables: [] };
  }
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
