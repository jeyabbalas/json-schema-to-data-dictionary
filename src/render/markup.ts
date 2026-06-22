// Builds the inner HTML for the data dictionary. Shared by the static `tableToHtml`
// string and the interactive web component, so both render identically. Every value
// derived from the schema is HTML-escaped before interpolation.

import type { JsonValue } from "../types";
import { escapeHtml } from "../utils";
import type { CategoryVM, ConstraintVM, RowVM, ValueVM, ViewModel } from "./viewModel";

export function buildMarkup(vm: ViewModel): string {
  const o = vm.options;
  return `
<div class="dd-root" data-theme="${o.theme}" data-dd-root>
  ${header(vm)}
  <div class="dd-empty" data-dd-empty hidden>No variables match “<span data-dd-empty-q></span>”.</div>
  ${vm.categories.map((c) => category(c, vm)).join("\n")}
  ${footer(vm)}
</div>`.trim();
}

function header(vm: ViewModel): string {
  const o = vm.options;
  const actions = [
    `<button class="dd-btn" type="button" data-dd-action="expand-all">Expand all</button>`,
    `<button class="dd-btn" type="button" data-dd-action="collapse-all">Collapse all</button>`,
    ...(o.includeExport
      ? [
          `<button class="dd-btn" type="button" data-dd-action="copy" title="Copy the dictionary as CSV">Copy CSV</button>`,
          `<button class="dd-btn" type="button" data-dd-action="download" title="Download the dictionary as CSV">Download CSV</button>`
        ]
      : [])
  ].join("");

  return `
  <header class="dd-header">
    <h2 class="dd-title">${escapeHtml(vm.title)}</h2>
    ${vm.description ? `<p class="dd-description">${multiline(vm.description)}</p>` : ""}
    ${vm.comment ? `<p class="dd-comment">${multiline(vm.comment)}</p>` : ""}
    <div class="dd-toolbar">
      <div class="dd-search">
        <input class="dd-search-input" type="search" inputmode="search" autocomplete="off"
               placeholder="${escapeHtml(o.searchPlaceholder)}" aria-label="Search variables" data-dd-search>
        <span class="dd-count" data-dd-count data-total="${vm.variableCount}">${vm.variableCount} variables</span>
      </div>
      <div class="dd-actions">${actions}</div>
    </div>
    ${rulesPanel(vm)}
    ${datasetInfoPanel(vm)}
  </header>`;
}

function rulesPanel(vm: ViewModel): string {
  if (vm.rules.length === 0) return "";
  const items = vm.rules
    .map((r) => {
      const effects = r.effects.length ? `<div class="dd-rule-effects">${escapeHtml(r.effects.join(" · "))}</div>` : "";
      const desc = r.description ? `<div class="dd-muted">${escapeHtml(r.description)}</div>` : "";
      return `<li><span class="dd-rule-cond">when ${escapeHtml(r.condition)}</span>${desc}${effects}</li>`;
    })
    .join("");
  return `
    <details class="dd-panel">
      <summary>${vm.rules.length} skip pattern${vm.rules.length === 1 ? "" : "s"} / conditional rule${vm.rules.length === 1 ? "" : "s"}</summary>
      <div class="dd-panel-body"><ul class="dd-rules-list">${items}</ul></div>
    </details>`;
}

function datasetInfoPanel(vm: ViewModel): string {
  if (vm.additionalInformation === null) return "";
  return `
    <details class="dd-panel"${vm.options.expandAdditionalInfo ? " open" : ""}>
      <summary>Dataset metadata</summary>
      <div class="dd-panel-body dd-tree">${jsonTree(vm.additionalInformation, vm.options.expandAdditionalInfo)}</div>
    </details>`;
}

function category(c: CategoryVM, vm: ViewModel): string {
  const collapsed = !vm.options.expandCategories;
  return `
  <section class="dd-category" data-dd-category data-collapsed="${collapsed}">
    <button class="dd-category-toggle" type="button" aria-expanded="${!collapsed}" data-dd-category-toggle>
      <span class="dd-caret" aria-hidden="true">▾</span>
      <span class="dd-category-title">${escapeHtml(c.title)}</span>
      <span class="dd-category-count" data-dd-cat-count data-total="${c.rows.length}">${c.rows.length}</span>
    </button>
    ${c.description ? `<p class="dd-category-desc">${multiline(c.description)}</p>` : ""}
    <div class="dd-table-wrap" data-dd-table-wrap>
      <table class="dd-table">
        <thead>
          <tr>
            <th class="dd-col-name" scope="col">Variable</th>
            <th scope="col">Description</th>
            <th scope="col">Data type</th>
            <th scope="col">Format</th>
            <th scope="col">Valid values</th>
            <th scope="col">Constraints</th>
            <th scope="col">Additional</th>
          </tr>
        </thead>
        <tbody>
          ${c.rows.map((row) => rowMarkup(row, vm)).join("\n")}
        </tbody>
      </table>
    </div>
  </section>`;
}

function rowMarkup(row: RowVM, vm: ViewModel): string {
  const empty = `<span class="dd-muted">${escapeHtml(vm.options.emptyCell)}</span>`;
  const mixed = /coded values/.test(row.dataType);
  return `
          <tr class="dd-row" data-dd-row data-search="${escapeHtml(row.searchText)}">
            <th class="dd-col-name" scope="row"><code>${escapeHtml(row.name)}</code></th>
            <td class="dd-desc">${row.description ? multiline(row.description) : empty}</td>
            <td class="dd-type">${row.dataType ? `<span class="dd-badge" data-mixed="${mixed}">${escapeHtml(row.dataType)}</span>` : empty}</td>
            <td class="dd-format">${row.format ? multiline(row.format) : empty}</td>
            <td class="dd-values">${validValues(row) || empty}</td>
            <td class="dd-constraints">${constraints(row.constraints) || empty}</td>
            <td class="dd-additional">${row.additionalInformation === null ? empty : `<div class="dd-tree">${jsonTree(row.additionalInformation, vm.options.expandAdditionalInfo)}</div>`}</td>
          </tr>`;
}

function validValues(row: RowVM): string {
  if (row.measurements.length === 0 && row.values.length === 0 && row.sentinels.length === 0) return "";
  const parts: string[] = [`<dl class="dd-vv">`];

  for (const m of row.measurements) {
    parts.push(
      `<div class="dd-vv-row dd-measure"><dt><span class="dd-measure-label">${escapeHtml(m.display)}</span></dt><dd>${escapeHtml(m.description ?? "measured value")}</dd></div>`
    );
  }
  for (const v of row.values) parts.push(valueRow(v, false));
  if (row.sentinels.length) {
    parts.push(`<div class="dd-vv-sep">special codes</div>`);
    for (const v of row.sentinels) parts.push(valueRow(v, true));
  }

  parts.push(`</dl>`);
  return parts.join("");
}

function valueRow(v: ValueVM, sentinel: boolean): string {
  const text = v.label ?? v.description ?? "";
  const when = v.condition ? ` <span class="dd-when">${escapeHtml(v.condition)}</span>` : "";
  const dd = text || when ? `<dd>${escapeHtml(text)}${when}</dd>` : `<dd></dd>`;
  return `<div class="dd-vv-row${sentinel ? " dd-sentinel" : ""}"><dt><code class="dd-code">${escapeHtml(v.display)}</code></dt>${dd}</div>`;
}

function constraints(items: ConstraintVM[]): string {
  if (items.length === 0) return "";
  const lis = items
    .map((c) => {
      const badge = c.conditional ? `<span class="dd-cond-badge">conditional</span>` : "";
      return `<li class="${c.conditional ? "dd-conditional" : ""}"><span>${escapeHtml(c.text)}${badge}</span></li>`;
    })
    .join("");
  return `<ul class="dd-constraints-list">${lis}</ul>`;
}

function footer(vm: ViewModel): string {
  if (vm.warnings.length === 0) return "";
  return `
  <details class="dd-footer">
    <summary class="dd-warning">${vm.warnings.length} extraction warning${vm.warnings.length === 1 ? "" : "s"}</summary>
    <ul>${vm.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
  </details>`;
}

// ---------------------------------------------------------------------------

/** Render a JSON value as a collapsible tree (objects/arrays) or inline scalar. */
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

function multiline(text: string): string {
  return escapeHtml(text).replaceAll("\n", "<br>");
}
