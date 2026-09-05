// Markup for one data-dictionary row, plus the cell helpers (valid values, constraints,
// JSON tree). Shared by the initial page, lazily materialised pages and the ranked results
// list, so a row renders identically wherever it appears. Every value derived from the
// schema is HTML-escaped before interpolation — the highlighter escapes as it marks.

import type { JsonValue } from "../types";
import { escapeHtml } from "../utils";
import { PLAIN } from "./highlight";
import type { Highlighter } from "./highlight";
import type { ConstraintVM, RowVM, ValueVM, ViewModel } from "./viewModel";

export interface RowMarkupOptions {
  /** Emit the `data-search` blob the static inline script filters on. */
  searchAttr: boolean;
  /** Emit `data-dd-row-index` (position in `table.rows`) on rows that have one. */
  rowIndex: boolean;
  /** Emit the category tag shown under the variable name in the results list. */
  categoryTag: boolean;
  /** Wraps query hits in `<mark class="dd-hit">`. Default: plain escaping. */
  highlight?: Highlighter | undefined;
  /** Results list only: keyword ("exact") or semantic-only ("related") match. */
  match?: "exact" | "related" | undefined;
  /** Results list only: similarity shown in a related row's tooltip. */
  similarity?: number | undefined;
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
  return `
          <tr class="dd-row" data-dd-row${indexAttr}${matchAttr}${searchAttr}>
            <th class="dd-col-name" scope="row"${titleAttr}><code>${hl(row.name)}</code>${categoryTag}</th>
            <td class="dd-desc">${row.description ? multiline(row.description, hl) : empty}</td>
            <td class="dd-type">${row.dataType ? `<span class="dd-badge" data-mixed="${mixed}">${hl(row.dataType)}</span>` : empty}</td>
            <td class="dd-format">${row.format ? multiline(row.format, hl) : empty}</td>
            <td class="dd-values">${validValues(row, hl) || empty}</td>
            <td class="dd-constraints">${constraints(row.constraints, hl) || empty}</td>
            <td class="dd-additional">${row.additionalInformation === null ? empty : `<div class="dd-tree">${jsonTree(row.additionalInformation, vm.options.expandAdditionalInfo)}</div>`}</td>
          </tr>`;
}

function validValues(row: RowVM, hl: Highlighter): string {
  if (row.measurements.length === 0 && row.values.length === 0 && row.sentinels.length === 0) return "";
  const parts: string[] = [`<dl class="dd-vv">`];

  for (const m of row.measurements) {
    parts.push(
      `<div class="dd-vv-row dd-measure"><dt><span class="dd-measure-label">${hl(m.display)}</span></dt><dd>${hl(m.description ?? "measured value")}</dd></div>`
    );
  }
  for (const v of row.values) parts.push(valueRow(v, false, hl));
  if (row.sentinels.length) {
    parts.push(`<div class="dd-vv-sep">special codes</div>`);
    for (const v of row.sentinels) parts.push(valueRow(v, true, hl));
  }

  parts.push(`</dl>`);
  return parts.join("");
}

function valueRow(v: ValueVM, sentinel: boolean, hl: Highlighter): string {
  const text = v.label ?? v.description ?? "";
  const when = v.condition ? ` <span class="dd-when">${hl(v.condition)}</span>` : "";
  const dd = text || when ? `<dd>${hl(text)}${when}</dd>` : `<dd></dd>`;
  return `<div class="dd-vv-row${sentinel ? " dd-sentinel" : ""}"><dt><code class="dd-code">${hl(v.display)}</code></dt>${dd}</div>`;
}

function constraints(items: ConstraintVM[], hl: Highlighter): string {
  if (items.length === 0) return "";
  const lis = items
    .map((c) => {
      const badge = c.conditional ? `<span class="dd-cond-badge">conditional</span>` : "";
      return `<li class="${c.conditional ? "dd-conditional" : ""}"><span>${hl(c.text)}${badge}</span></li>`;
    })
    .join("");
  return `<ul class="dd-constraints-list">${lis}</ul>`;
}

// ---------------------------------------------------------------------------

/** Render a JSON value as a collapsible tree (objects/arrays) or inline scalar. Never highlighted. */
export function jsonTree(value: JsonValue, open: boolean): string {
  return node(value, open, 0);
}

function node(value: JsonValue, open: boolean, depth: number): string {
  if (value === null) return `<span class="dd-num">null</span>`;
  if (typeof value === "string") return `<span class="dd-str">${escapeHtml(JSON.stringify(value))}</span>`;
  if (typeof value === "number" || typeof value === "boolean") return `<span class="dd-num">${escapeHtml(String(value))}</span>`;

  const isArray = Array.isArray(value);
  const entries: Array<[string, JsonValue]> = isArray
    ? (value as JsonValue[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, JsonValue>);

  if (entries.length === 0) return `<span class="dd-num">${isArray ? "[]" : "{}"}</span>`;

  const summary = isArray ? `Array (${entries.length})` : `Object (${entries.length})`;
  const openAttr = open && depth < 1 ? " open" : "";
  const lis = entries
    .map(([key, val]) => `<li><span class="dd-key">${escapeHtml(key)}:</span> ${node(val, open && depth < 1, depth + 1)}</li>`)
    .join("");
  return `<details${openAttr}><summary>${summary}</summary><ul>${lis}</ul></details>`;
}

/** Escaped (and optionally highlighted) text with line breaks preserved as `<br>`. */
export function multiline(text: string, hl: Highlighter = PLAIN): string {
  return hl(text).replaceAll("\n", "<br>");
}
