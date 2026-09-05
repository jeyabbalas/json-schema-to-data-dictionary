// Builds the inner HTML for the data dictionary. Shared by the static `tableToHtml` string
// ("static" target: every row materialised, `data-search` blobs for the inline filter) and
// the interactive web component ("component" target: an always-present results section,
// row indexes and — for large dictionaries — only the first page of rows plus a sentinel
// row per category that pages the rest in, see lazyRows.ts). Every value derived from the
// schema is HTML-escaped before interpolation.

import { escapeHtml } from "../utils";
import type { CategoryVM, ViewModel } from "./viewModel";
import { jsonTree, multiline, rowMarkup } from "./rowMarkup";
import type { RowMarkupOptions } from "./rowMarkup";

export type MarkupTarget = "static" | "component";

/** Row options of the static output: the inline script filters on `data-search`. */
export const STATIC_ROW_OPTIONS: RowMarkupOptions = { searchAttr: true, rowIndex: false, categoryTag: false };
/** Row options of the component's category sections (the results list adds the category tag). */
export const COMPONENT_ROW_OPTIONS: RowMarkupOptions = { searchAttr: false, rowIndex: true, categoryTag: false };

let counter = 0;

export function buildMarkup(vm: ViewModel, target: MarkupTarget): string {
  const o = vm.options;
  const component = target === "component";
  const uid = `dd${(counter += 1)}`;
  const rowOptions = component ? COMPONENT_ROW_OPTIONS : STATIC_ROW_OPTIONS;
  const pageSize = component ? o.pageSize : Infinity;
  const pages = initialPages(vm, pageSize);
  const emptySemantic = component ? ` <span data-dd-empty-semantic hidden>Looking for related variables…</span>` : "";
  return `
<div class="dd-root" data-theme="${o.theme}" data-dd-root>
  ${header(vm)}
  <div class="dd-empty" data-dd-empty hidden>No variables match “<span data-dd-empty-q></span>”.${emptySemantic}</div>
  ${component ? resultsSection() : ""}
  <div class="dd-categories" data-dd-categories>
  ${vm.categories.map((c, i) => categorySection(c, i, vm, pages[i] ?? c.rows.length, pageSize, uid, rowOptions)).join("\n")}
  </div>
  ${footer(vm)}
</div>`.trim();
}

/**
 * Rows materialised up front per category: every row for small dictionaries (or when
 * `pageSize` is `Infinity`), otherwise the first `pageSize` rows in category order — so the
 * first paint is one page of rows plus cheap section headers; the rest arrive lazily.
 */
export function initialPages(vm: ViewModel, pageSize: number): number[] {
  const total = vm.categories.reduce((n, c) => n + c.rows.length, 0);
  if (!(total > 5 * pageSize)) return vm.categories.map((c) => c.rows.length);
  let budget = pageSize;
  return vm.categories.map((c) => {
    const n = Math.min(budget, c.rows.length);
    budget -= n;
    return n;
  });
}

/** Thousands-separated count for labels ("1,234"). */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Label of a category's "Show more" button. */
export function moreLabel(remaining: number, pageSize: number): string {
  return `Show ${formatCount(Math.min(pageSize, remaining))} more · ${formatCount(remaining)} remaining`;
}

/** Sentinel row closing an incomplete category: observed for lazy paging, clickable as the fallback. */
export function moreRowMarkup(next: number, total: number, pageSize: number): string {
  return `<tr class="dd-more" data-dd-more><td colspan="7"><button class="dd-btn dd-more-btn" type="button" data-dd-more-btn>${moreLabel(total - next, pageSize)}</button></td></tr>`;
}

/** Column widths for `table-layout: fixed` (percentages live in the stylesheet). */
export function colGroup(): string {
  return `<colgroup><col class="dd-c-name"><col class="dd-c-desc"><col class="dd-c-type"><col class="dd-c-format"><col class="dd-c-values"><col class="dd-c-constraints"><col class="dd-c-additional"></colgroup>`;
}

/** Flat, ranked results table used while a query is active (component only). */
function resultsSection(): string {
  return `
  <section class="dd-results" data-dd-results hidden aria-label="Search results" aria-busy="false">
    <div class="dd-table-wrap">
      <table class="dd-table">
        ${colGroup()}
        ${tableHead()}
        <tbody data-dd-results-body></tbody>
      </table>
    </div>
    <div class="dd-results-foot" data-dd-results-foot hidden>
      <span class="dd-results-status" data-dd-results-status></span>
      <button class="dd-btn" type="button" data-dd-results-more>Show more</button>
    </div>
  </section>`;
}

function tableHead(): string {
  return `<thead>
          <tr>
            <th class="dd-col-name" scope="col">Variable</th>
            <th scope="col">Description</th>
            <th scope="col">Data type</th>
            <th scope="col">Format</th>
            <th scope="col">Valid values</th>
            <th scope="col">Constraints</th>
            <th scope="col">Additional</th>
          </tr>
        </thead>`;
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
        <span class="dd-count" role="status" data-dd-count data-total="${vm.variableCount}">${vm.variableCount} variables</span>
      </div>
      ${o.semanticSearch ? `<span class="dd-semantic-status" role="status" data-dd-semantic-status hidden></span>` : ""}
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

/**
 * One category: the toggle, the description and a table holding the first `next` rows.
 * `data-dd-next` / `data-total` track materialisation; a sentinel row follows while
 * `next < total`.
 */
function categorySection(
  c: CategoryVM,
  i: number,
  vm: ViewModel,
  next: number,
  pageSize: number,
  uid: string,
  rowOptions: RowMarkupOptions
): string {
  const collapsed = !vm.options.expandCategories;
  const total = c.rows.length;
  const id = `${uid}-c${i}`;
  const rows = c.rows.slice(0, next).map((row) => rowMarkup(row, vm, rowOptions)).join("\n");
  return `
  <section class="dd-category" data-dd-category data-dd-cat="${i}" data-dd-next="${next}" data-total="${total}" data-collapsed="${collapsed}">
    <button class="dd-category-toggle" type="button" aria-expanded="${!collapsed}" aria-controls="${id}" data-dd-category-toggle>
      <span class="dd-caret" aria-hidden="true">▾</span>
      <span class="dd-category-title">${escapeHtml(c.title)}</span>
      <span class="dd-category-count" data-dd-cat-count data-total="${total}">${total}</span>
    </button>
    ${c.description ? `<p class="dd-category-desc">${multiline(c.description)}</p>` : ""}
    <div class="dd-table-wrap" data-dd-table-wrap id="${id}">
      <table class="dd-table">
        ${colGroup()}
        ${tableHead()}
        <tbody data-dd-rows>
          ${rows}${next < total ? moreRowMarkup(next, total, pageSize) : ""}
        </tbody>
      </table>
    </div>
  </section>`;
}

function footer(vm: ViewModel): string {
  if (vm.warnings.length === 0) return "";
  return `
  <details class="dd-footer">
    <summary class="dd-warning">${vm.warnings.length} extraction warning${vm.warnings.length === 1 ? "" : "s"}</summary>
    <ul>${vm.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
  </details>`;
}
