// Markup for one data-dictionary row, plus the cell helpers (valid values, constraints,
// skip patterns, JSON tree). Shared by the initial page, lazily materialised pages and the
// ranked results list, so a row renders identically wherever it appears. Every value derived
// from the schema is HTML-escaped before interpolation — the highlighter escapes as it marks.

import type { JsonValue } from "../types";
import { escapeHtml, rowFor } from "../utils";
import { PLAIN } from "./highlight";
import type { Highlighter } from "./highlight";
import type { ConditionVM, ConstraintVM, RowVM, RuleGroupVM, RuleVM, ValueVM, ViewModel } from "./viewModel";

export interface RowMarkupOptions {
  /** Emit the `data-search` blob the static inline script filters on. */
  searchAttr: boolean;
  /** Emit `data-dd-row-index` (position in `table.rows`) on rows that have one. */
  rowIndex: boolean;
  /** Emit the category tag shown under the variable name in the results list. */
  categoryTag: boolean;
  /**
   * Emit `data-dd-depth` on nested rows (indentation and the tree glyph of the category
   * tables). The results list shows rows out of context and leaves it off.
   */
  indent: boolean;
  /** Wraps query hits in `<mark class="dd-hit">`. Default: plain escaping. */
  highlight?: Highlighter | undefined;
  /** Results list only: keyword ("exact") or semantic-only ("related") match. */
  match?: "exact" | "related" | undefined;
  /** Results list only: similarity shown in a related row's tooltip. */
  similarity?: number | undefined;
  /**
   * Render the skip-pattern detail row of a variable that patterns read up front (hidden), as
   * the static output must. The component leaves it out and builds it when first opened.
   */
  skipDetails?: boolean | undefined;
}

export function rowMarkup(row: RowVM, vm: ViewModel, opts: RowMarkupOptions): string {
  const hl = opts.highlight ?? PLAIN;
  const empty = `<span class="dd-muted">${escapeHtml(vm.options.emptyCell)}</span>`;
  const mixed = /coded values/.test(row.dataType);
  const indexAttr = opts.rowIndex && row.index >= 0 ? ` data-dd-row-index="${row.index}"` : "";
  const matchAttr = opts.match ? ` data-dd-match="${opts.match}"` : "";
  const searchAttr = opts.searchAttr ? ` data-search="${escapeHtml(row.searchText)}"` : "";
  const titleAttr = opts.match === "related" ? ` title="Related · similarity ${(opts.similarity ?? 0).toFixed(2)}"` : "";
  const categoryTag = opts.categoryTag ? `<span class="dd-row-cat">${escapeHtml(row.category)}</span>` : "";
  const depthAttr = opts.indent && row.depth > 0 ? ` data-dd-depth="${row.depth}"` : "";
  // A nested field shows its parent path muted and its own name bold; both halves live inside
  // the one <code>, so the cell still reads (and copies) as the full path. A narrow column
  // breaks the line between them, or after a `.` of the parent path, rather than inside a name.
  // (Escaped and highlighted text has no `.` but the path's own.)
  const name = row.namePrefix
    ? `<span class="dd-name-prefix">${hl(row.namePrefix).replaceAll(".", ".<wbr>")}</span><wbr><span class="dd-name-leaf">${hl(row.nameLeaf)}</span>`
    : hl(row.name);
  const skips = skipsToggle(row, vm, opts.skipDetails ?? false);
  return `
          <tr class="dd-row" data-dd-row${indexAttr}${depthAttr}${matchAttr}${searchAttr}>
            <th class="dd-col-name" scope="row"${titleAttr}><code>${name}</code>${categoryTag}${skips.toggle}</th>
            <td class="dd-desc">${row.description || row.comment ? `${multiline(row.description, hl)}${note(row.comment, hl)}` : empty}</td>
            <td class="dd-type">${row.dataType ? `<span class="dd-badge" data-mixed="${mixed}">${hl(row.dataType)}</span>` : empty}</td>
            <td class="dd-format">${row.format ? multiline(row.format, hl) : empty}</td>
            <td class="dd-values">${validValues(row, vm, hl) || empty}</td>
            <td class="dd-constraints">${constraintsCell(row, vm, hl) || empty}</td>
            <td class="dd-additional">${row.additionalInformation === null ? empty : `<div class="dd-tree">${jsonTree(row.additionalInformation, vm.options.expandAdditionalInfo)}</div>`}</td>
          </tr>${skips.detail}`;
}

/** A measured range up to this long ("1900–2030") lines up with the codes under it. */
const MEASURE_ALIGNED = 9;

function validValues(row: RowVM, vm: ViewModel, hl: Highlighter): string {
  if (row.measurements.length === 0 && row.values.length === 0 && row.sentinels.length === 0) return "";
  const parts: string[] = [`<dl class="dd-vv">`];

  for (const m of row.measurements) {
    parts.push(
      `<div class="dd-vv-row dd-measure${m.display.length > MEASURE_ALIGNED ? " dd-measure-wide" : ""}"><dt><span class="dd-measure-label">${hl(m.display)}</span></dt><dd>${hl(m.description ?? "measured value")}${why(m.comment, hl)}</dd></div>`
    );
  }
  for (const v of row.values) parts.push(valueRow(v, false, row, vm, hl));
  if (row.sentinels.length) {
    // The separator divides real values from special codes, so it only earns its place when
    // there is something above it -- a variable whose only declared values are sentinels
    // (a sparse coding table) would otherwise open with a heading and nothing before it.
    if (row.measurements.length || row.values.length) parts.push(`<div class="dd-vv-sep">special codes</div>`);
    for (const v of row.sentinels) parts.push(valueRow(v, true, row, vm, hl));
  }

  parts.push(`</dl>`);
  return parts.join("");
}

function valueRow(v: ValueVM, sentinel: boolean, row: RowVM, vm: ViewModel, hl: Highlighter): string {
  const text = v.label ?? v.description ?? "";
  // One line per skip pattern that sets the variable to this value: "if parous = 0", with the
  // rule's comment -- why it does -- under it.
  const when = v.conditions
    .map((c) => `<span class="dd-when"><span class="dd-kw">if</span> ${condition(c, vm, row.name, hl)}</span>${why(c.comment, hl)}`)
    .join("");
  // A value's description, when it has a label too, is there on hover ("-999 Not collected:
  // in universe, but not collected or unavailable after processing").
  const title = v.label && v.description && v.description !== v.label ? ` title="${escapeHtml(v.description)}"` : "";
  return `<div class="dd-vv-row${sentinel ? " dd-sentinel" : ""}"><dt><code class="dd-code">${hl(v.display)}</code></dt><dd><span${title}>${hl(text)}</span>${why(v.comment, hl)}${when}</dd></div>`;
}

/**
 * A `$comment` on the variable, its section or the dataset: the schema author's note, set apart
 * from the definition it annotates.
 */
export function note(text: string | undefined, hl: Highlighter = PLAIN): string {
  return text ? `<div class="dd-note"><span class="dd-note-tag">Note</span> ${multiline(text, hl)}</div>` : "";
}

/** A rule's or a value's `$comment`, under the line it explains. */
function why(text: string | undefined, hl: Highlighter): string {
  return text ? `<span class="dd-why">${multiline(text, hl)}</span>` : "";
}

function constraintsCell(row: RowVM, vm: ViewModel, hl: Highlighter): string {
  // A skip pattern that pins the value is already shown on that value (Valid values).
  const items = row.constraints.filter((c) => !c.onValues);
  return items.length ? `<ul class="dd-constraints-list">${items.map((c) => constraintItem(c, vm, row.name, hl)).join("")}</ul>` : "";
}

function constraintItem(c: ConstraintVM, vm: ViewModel, self: string, hl: Highlighter): string {
  if (!c.conditional) return `<li>${hl(c.text)}${why(c.comment, hl)}</li>`;
  return `<li class="dd-conditional">${linkNames(c.text, [...c.triggers, ...c.references], vm, self, hl)}${why(c.comment, hl)}</li>`;
}

let detailCounter = 0;

/**
 * On a variable that skip patterns read: a chip under its name ("Skips 22") that opens a
 * full-width row beneath it listing those patterns -- what each answer sets, and where. With
 * `withDetail` the row is rendered (hidden) right away; otherwise `skipsDetailMarkup` builds it
 * on demand.
 */
function skipsToggle(row: RowVM, vm: ViewModel, withDetail: boolean): { toggle: string; detail: string } {
  if (row.skipRules.length === 0) return { toggle: "", detail: "" };
  const rules = rulesOf(row, vm);
  // The variables its answers set: a rule that reads a list to bound the same list sets no other.
  const affected = new Set<string>();
  for (const rule of rules) for (const g of rule.groups) for (const name of g.variables) if (rowName(name, vm) !== row.name) affected.add(rowName(name, vm));
  const count = affected.size;
  const label = count > 0 ? `Skips ${count}` : `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
  const title =
    count > 0 ? `Answers to ${row.name} set ${count} other variable${count === 1 ? "" : "s"} (skip patterns)` : `Skip patterns that read ${row.name}`;
  const detail = withDetail ? skipsDetailMarkup(row, vm) : undefined;
  const controls = detail ? ` aria-controls="${detail.id}"` : "";
  return {
    toggle: `<button type="button" class="dd-skips-toggle" data-dd-skips aria-expanded="false"${controls} title="${escapeHtml(title)}">${ICON_SKIP}<span>${label}</span></button>`,
    detail: detail?.html ?? ""
  };
}

/** The (hidden) row listing the skip patterns that read `row`'s variable, and its id. */
export function skipsDetailMarkup(row: RowVM, vm: ViewModel): { id: string; html: string } {
  const id = `dd-skips-${(detailCounter += 1)}`;
  return {
    id,
    html: `<tr class="dd-detail" id="${id}" data-dd-detail hidden><td colspan="7"><div class="dd-pin">${rulesMarkup(rulesOf(row, vm), vm, row.name)}</div></td></tr>`
  };
}

function rulesOf(row: RowVM, vm: ViewModel): RuleVM[] {
  return row.skipRules.map((i) => vm.rules[i]).filter((r): r is RuleVM => r !== undefined);
}

/** A list of skip patterns: "if <condition>  →  <value> <label>  <variables>", with the rule's comment under it. */
export function rulesMarkup(rules: RuleVM[], vm: ViewModel, self: string | undefined): string {
  let lastTrigger: string | undefined;
  const items = rules.map((rule) => {
    const first = rule.triggers[0];
    const opens = first !== lastTrigger;
    lastTrigger = first;
    const groups = rule.groups
      .map((g) => {
        const variables = g.variables.map((name) => reference(name, vm, self, PLAIN)).join("");
        return `<div class="dd-rule-group"><div class="dd-rule-set"><span class="dd-kw" aria-hidden="true">→</span>${ruleSet(g, vm, self)}</div><div class="dd-rule-vars">${variables}</div></div>`;
      })
      .join("");
    const cond = condition({ text: rule.condition, triggers: rule.triggers }, vm, self, PLAIN);
    const comment = rule.description ? `<div class="dd-rule-note">${multiline(rule.description)}</div>` : "";
    return `<div class="dd-rule${opens ? " dd-rule-opens" : ""}"><div class="dd-rule-if"><span class="dd-kw">if</span> ${cond}</div><div class="dd-rule-then">${groups}</div>${comment}</div>`;
  });
  return `<div class="dd-rules">${items.join("")}</div>`;
}

/**
 * What a rule does to a group of variables: the value it sets (`→ 777 Nonparous`), allows or
 * rules out -- with what that leaves unsaid ("or absent", "required") -- or its requirement in words.
 */
function ruleSet(g: RuleGroupVM, vm: ViewModel, self: string | undefined): string {
  const codes = g.values.map((value) => `<code class="dd-code">${escapeHtml(value)}</code>`).join("");
  const label = g.label ? ` <span class="dd-rule-label">${escapeHtml(g.label)}</span>` : "";
  const within = g.within ? [g.within] : [];
  const qualifier = g.qualifier ? ` <span class="dd-rule-qual">${linkNames(g.qualifier, within, vm, self, PLAIN)}</span>` : "";
  const kw = (word: string): string => `<span class="dd-kw">${word}</span>`;
  switch (g.kind) {
    case undefined:
    case "equals":
      return g.values.length ? `${codes}${label}${qualifier}` : `<span class="dd-muted">constrained</span>`;
    case "oneOf":
      return `${kw("one of")}${codes}${qualifier}`;
    case "notEquals":
      return `${kw("not")}${codes}${label}${qualifier}`;
    case "notOneOf":
      return `${kw("none of")}${codes}${qualifier}`;
    default:
      // A requirement in words names other variables when it is shared ("at least one of …"),
      // and the object a field is required of ("must be present if point is an object").
      return `<span class="dd-rule-text">${g.text ? linkNames(g.text, g.kind === "combination" ? g.variables : within, vm, self, PLAIN) : "constrained"}</span>`;
  }
}

/** A condition, with each variable it reads that has a row as a link to that row. */
function condition(c: ConditionVM, vm: ViewModel, self: string | undefined, hl: Highlighter): string {
  return `<span class="dd-cond">${linkNames(c.text, c.triggers, vm, self, hl)}</span>`;
}

/**
 * `text` with every mention of the variables `names` (as whole names, longest first) turned
 * into a reference to its row. `self` is the row being rendered: named, never linked. A code's
 * label ("parous = 0 (Non-parous)") and a quoted value are text, never references.
 */
function linkNames(text: string, names: string[], vm: ViewModel, self: string | undefined, hl: Highlighter): string {
  const rows = [...new Set(names.map((n) => rowName(n, vm)))].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  if (rows.length === 0) return hl(text);
  let out = "";
  let plain = "";
  for (let i = 0; i < text.length; ) {
    const found = isNameChar(text.charAt(i - 1)) ? undefined : mention(text, i, rows);
    if (found === undefined) {
      const end = labelEnd(text, i) ?? quotedEnd(text, i) ?? i + 1;
      plain += text.slice(i, end);
      i = end;
      continue;
    }
    out += hl(plain) + reference(found.row, vm, self, hl, found.name);
    plain = "";
    i += found.name.length;
  }
  return out + hl(plain);
}

/** The first of `rows` that `text` names at `i`, and the name it gives it there. */
function mention(text: string, i: number, rows: readonly string[]): { row: string; name: string } | undefined {
  for (const row of rows) {
    if (text.charAt(i) !== row.charAt(0)) continue;
    const pattern = spelling(row);
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (match && !isNameChar(text.charAt(i + match[0].length))) return { row, name: match[0] };
  }
  return undefined;
}

const SPELLINGS = new Map<string, RegExp>();

/**
 * The names a row's variable goes by in a rule: its own, one position of the list whose items
 * it is (`parts[0].k` of `parts[].k`), and a position inside it that has no row (`days[0]`).
 */
function spelling(row: string): RegExp {
  let pattern = SPELLINGS.get(row);
  if (!pattern) {
    const own = row.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[\\\]/g, "\\[\\d*\\]");
    pattern = new RegExp(`${own}(?:\\[\\d+\\])*`, "y");
    SPELLINGS.set(row, pattern);
  }
  return pattern;
}

/** The row that holds a variable a rule names (`days` for `days[0]`). */
function rowName(name: string, vm: ViewModel): string {
  return vm.names.has(name) ? name : rowFor(name, vm.names);
}

function isNameChar(ch: string): boolean {
  return ch !== "" && /[\w$.[\]"]/.test(ch);
}

/** A value written before "(" at `i` -- "0 (", "-666 (", "\"NA\" (", "true (" -- opens its label. */
const VALUE_BEFORE_LABEL = /(?:^|[\s{,(])(?:-?\d[\d.eE+-]*|"(?:[^"\\]|\\.)*"|true|false|null) $/;

/** What a rule leaves unsaid of the values it allows -- "(required if point is an object)" -- is no label. */
const REQUIRED_NOTE = /^\(required[ )]/;

/** The end of the code label that opens at `i` (balanced parentheses), if one does. */
function labelEnd(text: string, i: number): number | undefined {
  if (text.charAt(i) !== "(" || REQUIRED_NOTE.test(text.slice(i, i + 10)) || !VALUE_BEFORE_LABEL.test(text.slice(0, i))) return undefined;
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text.charAt(j) === "(") depth += 1;
    else if (text.charAt(j) === ")" && (depth -= 1) === 0) return j + 1;
  }
  return undefined;
}

/** The end of the JSON string that opens at `i`, if one does. */
function quotedEnd(text: string, i: number): number | undefined {
  if (text.charAt(i) !== '"') return undefined;
  for (let j = i + 1; j < text.length; j += 1) {
    if (text.charAt(j) === "\\") j += 1;
    else if (text.charAt(j) === '"') return j + 1;
  }
  return undefined;
}

/**
 * A variable named in a skip pattern (as `shown`): a button that jumps to the row that holds it,
 * or plain code on that row itself or without one.
 */
function reference(name: string, vm: ViewModel, self: string | undefined, hl: Highlighter, shown = name): string {
  const row = rowName(name, vm);
  if (row === self || !vm.names.has(row)) return `<code class="dd-ref-self">${hl(shown)}</code>`;
  return `<button type="button" class="dd-ref" data-dd-goto="${escapeHtml(row)}" title="Go to ${escapeHtml(row)}">${hl(shown)}</button>`;
}

const ICON_SKIP = `<svg class="dd-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3v4.5A2.5 2.5 0 0 0 5.5 10H12m0 0-2.5-2.5M12 10l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------

/** Objects and arrays whose JSON text is at most this long are written out on the line: `[1, 2, 3]`. */
const INLINE_JSON = 60;

/**
 * Render a JSON value as a tree: scalars and short containers inline, longer objects and arrays
 * collapsible. An object at the root lists its entries directly -- the cell or panel already
 * contains it, so a summary to open first would only hide them. `open` expands the containers
 * among those entries (or a root container) one level. Never highlighted.
 */
export function jsonTree(value: JsonValue, open: boolean): string {
  const entries = entriesOf(value);
  if (entries && entries.length > 0 && !Array.isArray(value)) {
    return `<ul class="dd-tree-root">${entries.map(([key, val]) => entry(key, val, open, 0)).join("")}</ul>`;
  }
  return node(value, open, 0, "");
}

function entriesOf(value: JsonValue): Array<[string, JsonValue]> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return Array.isArray(value) ? value.map((v, i): [string, JsonValue] => [String(i), v]) : Object.entries(value);
}

/** One `key: value` line; a container too long for the line carries its key in its summary ("▸ examples: Array (2)"). */
function entry(key: string, value: JsonValue, open: boolean, depth: number): string {
  return `<li>${node(value, open, depth, `<span class="dd-key">${escapeHtml(key)}:</span> `)}</li>`;
}

function node(value: JsonValue, open: boolean, depth: number, label: string): string {
  const isArray = Array.isArray(value);
  const entries = entriesOf(value);
  if (entries === undefined || JSON.stringify(value).length <= INLINE_JSON) return `${label}${inline(value)}`;

  const summary = isArray ? `Array (${entries.length})` : `Object (${entries.length})`;
  const openAttr = open && depth < 1 ? " open" : "";
  const lis = entries.map(([key, val]) => entry(key, val, open, depth + 1)).join("");
  return `<details${openAttr}><summary>${label}${summary}</summary><ul>${lis}</ul></details>`;
}

/**
 * A value on one line, as JSON with its scalars coloured: `{"x": 1.5, "tier": "gold"}`. A
 * string's own quotes are left unescaped -- `"STRUCT("name" VARCHAR)"` reads better than
 * `"STRUCT(\"name\" VARCHAR)"`, and the quotes around it still mark it as a string.
 */
function inline(value: JsonValue): string {
  if (value === null) return `<span class="dd-num">null</span>`;
  if (typeof value === "string") return `<span class="dd-str">${quoted(value)}</span>`;
  if (typeof value === "number" || typeof value === "boolean") return `<span class="dd-num">${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  const members = Object.entries(value).map(([key, v]) => `<span class="dd-key">${quoted(key)}:</span> ${inline(v)}`);
  return `{${members.join(", ")}}`;
}

/** `text` as a JSON string, escaped for HTML, with its own `"` left as they are. */
function quoted(text: string): string {
  // Each escape is a backslash and one character, so `\\` stays whole and only `\"` changes.
  return escapeHtml(JSON.stringify(text).replace(/\\(.)/g, (escape, ch: string) => (ch === '"' ? ch : escape)));
}

/** Escaped (and optionally highlighted) text with line breaks preserved as `<br>`. */
export function multiline(text: string, hl: Highlighter = PLAIN): string {
  return hl(text).replaceAll("\n", "<br>");
}
