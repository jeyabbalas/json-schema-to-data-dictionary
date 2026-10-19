// Builds the inner HTML for the data dictionary. Shared by the static `tableToHtml` string
// ("static" target: every row materialised, `data-search` blobs for the inline filter) and
// the interactive web component ("component" target: an always-present results section,
// row indexes and — for large dictionaries — only the first page of rows plus a sentinel
// row per category that pages the rest in, see lazyRows.ts). Every value derived from the
// schema is HTML-escaped before interpolation.
//
// Layout: a header (title, toolbar, the panels the toolbar opens) above one scrolling
// viewport. The viewport holds a sticky column header -- the only visible one, carrying the
// resize handles -- then the results list and the category sections. Each section is its own
// table (so off-screen sections skip layout) whose <thead> is kept for assistive technology
// but not shown; all of them size their columns from the same custom properties (columns.ts).

import { escapeHtml } from "../utils";
import type { CategoryVM, ViewModel } from "./viewModel";
import { jsonTree, multiline, note, rowMarkup, rulesMarkup } from "./rowMarkup";
import type { RowMarkupOptions } from "./rowMarkup";
import { COLUMNS, columnStyle } from "./columns";

export type MarkupTarget = "static" | "component";

/** Row options of the static output: the inline script filters on `data-search`. */
export const STATIC_ROW_OPTIONS: RowMarkupOptions = { searchAttr: true, rowIndex: false, categoryTag: false, indent: true, skipDetails: true };
/** Row options of the component's category sections (the results list adds the category tag and drops the indentation). */
export const COMPONENT_ROW_OPTIONS: RowMarkupOptions = { searchAttr: false, rowIndex: true, categoryTag: false, indent: true };

let counter = 0;

export function buildMarkup(vm: ViewModel, target: MarkupTarget): string {
  const o = vm.options;
  const component = target === "component";
  const uid = `dd${(counter += 1)}`;
  const rowOptions = component ? COMPONENT_ROW_OPTIONS : STATIC_ROW_OPTIONS;
  const pageSize = component ? o.pageSize : Infinity;
  const pages = initialPages(vm, pageSize);
  const emptySemantic = component ? ` <span data-dd-empty-semantic hidden>Looking for related variables…</span>` : "";
  const style = columnStyle(o.columnWidths);
  return `
<div class="dd-root" data-theme="${o.theme}" data-dd-root${style ? ` style="${style}"` : ""}>
  ${header(vm, uid)}
  <div class="dd-empty" data-dd-empty hidden>No variables match “<span data-dd-empty-q></span>”.${emptySemantic}</div>
  <div class="dd-viewport" data-dd-viewport>
    <div class="dd-frame">
      <div class="dd-sheet">
        ${columnHeader()}
        ${component ? resultsSection() : ""}
        <div class="dd-categories" data-dd-categories>
        ${vm.categories.map((c, i) => categorySection(c, i, vm, pages[i] ?? c.rows.length, pageSize, uid, rowOptions)).join("\n")}
        </div>
      </div>
    </div>
  </div>
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
  return `<tr class="dd-more" data-dd-more><td colspan="7"><div class="dd-pin"><button class="dd-btn dd-more-btn" type="button" data-dd-more-btn>${moreLabel(total - next, pageSize)}</button></div></td></tr>`;
}

/**
 * The visible column header: sticky at the top of the viewport, one resize handle per column
 * edge. The body tables carry their own (visually hidden) headers for screen readers, so the
 * labels here are hidden from them and only the handles are announced.
 */
function columnHeader(): string {
  const cells = COLUMNS.map(
    (c) =>
      `<th class="dd-h-${c.key}${c.key === "name" ? " dd-col-name" : ""}"><span class="dd-head-label" data-dd-head-label aria-hidden="true">${c.label}</span>` +
      `<span class="dd-resize" data-dd-resize="${c.key}" role="separator" aria-orientation="vertical" aria-label="Resize the ${c.label} column" aria-valuemin="56" aria-valuemax="1600" tabindex="0" title="Drag to resize · double-click to fit"></span></th>`
  ).join("");
  return `<div class="dd-head" data-dd-head><table class="dd-table" role="presentation"><thead><tr>${cells}</tr></thead></table></div>`;
}

/**
 * Header of a body table: what screen readers announce for each cell, not shown. Being the
 * table's first row, its cells also carry the column widths (`table-layout: fixed`).
 */
function tableHead(): string {
  return `<thead class="dd-sr-head"><tr>${COLUMNS.map((c) => `<th class="dd-h-${c.key}${c.key === "name" ? " dd-col-name" : ""}" scope="col"><span>${c.label}</span></th>`).join("")}</tr></thead>`;
}

/** Flat, ranked results table used while a query is active (component only). */
function resultsSection(): string {
  return `
  <section class="dd-results" data-dd-results hidden aria-label="Search results" aria-busy="false">
    <table class="dd-table">
      ${tableHead()}
      <tbody data-dd-results-body></tbody>
    </table>
    <div class="dd-results-foot dd-pin" data-dd-results-foot hidden>
      <span class="dd-results-status" data-dd-results-status></span>
      <button class="dd-btn" type="button" data-dd-results-more>Show more</button>
    </div>
  </section>`;
}

function header(vm: ViewModel, uid: string): string {
  const o = vm.options;
  const panels: string[] = [];
  const toggles: string[] = [];
  if (vm.rules.length > 0) {
    toggles.push(panelToggle(uid, "rules", `${ICON_RULES}Skip logic <span class="dd-btn-count">${formatCount(vm.rules.length)}</span>`, "Skip patterns: what each answer sets elsewhere"));
    panels.push(panel(uid, "rules", "Skip logic", `${formatCount(vm.rules.length)} rule${vm.rules.length === 1 ? "" : "s"}`, rulesMarkup(sortByTrigger(vm), vm, undefined)));
  }
  if (vm.additionalInformation !== null) {
    toggles.push(panelToggle(uid, "meta", `${ICON_INFO}Metadata`, "Dataset metadata"));
    panels.push(panel(uid, "meta", "Dataset metadata", "", `<div class="dd-tree">${jsonTree(vm.additionalInformation, true)}</div>`));
  }
  if (vm.warnings.length > 0) {
    const n = vm.warnings.length;
    toggles.push(panelToggle(uid, "warnings", `${ICON_WARN}${formatCount(n)} warning${n === 1 ? "" : "s"}`, "Extraction warnings", " dd-btn-warn"));
    panels.push(panel(uid, "warnings", "Extraction warnings", "", `<ul class="dd-warnings">${vm.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`));
  }
  const allCollapsed = !o.expandCategories;
  const actions = `<div class="dd-actions">${[
    `<button class="dd-btn" type="button" data-dd-action="reset-widths" title="Reset the column widths" hidden>${ICON_RESET}Reset widths</button>`,
    `<button class="dd-btn dd-btn-icon" type="button" data-dd-action="${allCollapsed ? "expand-all" : "collapse-all"}" title="${allCollapsed ? "Expand all" : "Collapse all"}" aria-label="${allCollapsed ? "Expand all" : "Collapse all"}">${ICON_COLLAPSE}</button>`,
    ...(o.includeExport
      ? [
          `<button class="dd-btn" type="button" data-dd-action="copy" title="Copy the dictionary as CSV">${ICON_COPY}Copy</button>`,
          o.exportFormat === "csv"
            ? `<button class="dd-btn" type="button" data-dd-action="download" title="Download the dictionary as CSV">${ICON_DOWNLOAD}CSV</button>`
            : `<button class="dd-btn" type="button" data-dd-action="download" title="Download the dictionary as an Excel workbook (.xlsx)">${ICON_DOWNLOAD}Excel</button>`
        ]
      : [])
  ].join("")}</div>`;

  // The dataset's description and note in a box of bounded height, scrolling when longer, so a
  // long one never takes the table's room. Then the search box on a line of its own, then the
  // panel toggles under it -- what the reader should not miss -- with the table's own controls
  // at the far end. A dictionary with nothing to open keeps those controls beside the search
  // box instead of on a line of their own.
  const about =
    (vm.description ? `<p class="dd-description">${multiline(vm.description)}</p>` : "") +
    (vm.comment ? `<div class="dd-comment">${note(vm.comment)}</div>` : "");
  return `
  <header class="dd-header">
    <h2 class="dd-title">${escapeHtml(vm.title)}</h2>
    ${about ? `<div class="dd-about">${about}</div>` : ""}
    <div class="dd-toolbar">
      <div class="dd-searchbar">
        <div class="dd-search">
          <input class="dd-search-input" type="search" inputmode="search" autocomplete="off" spellcheck="false"
                 placeholder="${escapeHtml(o.searchPlaceholder)}" aria-label="Search variables" data-dd-search>
          <span class="dd-count" role="status" data-dd-count data-total="${vm.variableCount}">${vm.variableCount} variables</span>
        </div>
        ${o.semanticSearch ? `<span class="dd-semantic-status" part="semantic-status" role="status" data-dd-semantic-status hidden></span>` : ""}
        ${toggles.length ? "" : actions}
      </div>
      ${toggles.length ? `<div class="dd-tools"><div class="dd-panel-toggles">${toggles.join("")}</div>${actions}</div>` : ""}
    </div>
    ${panels.join("")}
  </header>`;
}

function panelToggle(uid: string, key: string, label: string, title: string, extra = ""): string {
  return `<button class="dd-btn${extra}" type="button" data-dd-panel-toggle="${key}" aria-expanded="false" aria-controls="${uid}-${key}" title="${escapeHtml(title)}">${label}</button>`;
}

function panel(uid: string, key: string, title: string, note: string, body: string): string {
  return `
    <section class="dd-panel" id="${uid}-${key}" data-dd-panel="${key}" aria-label="${escapeHtml(title)}" hidden>
      <div class="dd-panel-head"><span class="dd-panel-title">${escapeHtml(title)}</span>${note ? `<span class="dd-panel-note">${escapeHtml(note)}</span>` : ""}<button class="dd-btn dd-btn-icon dd-panel-close" type="button" data-dd-panel-close aria-label="Close">${ICON_CLOSE}</button></div>
      <div class="dd-panel-body">${body}</div>
    </section>`;
}

/** The rules grouped by the first variable they read (in order of first appearance), stable otherwise. */
function sortByTrigger(vm: ViewModel): ViewModel["rules"] {
  const order = new Map<string, number>();
  vm.rules.forEach((r) => {
    const first = r.triggers[0] ?? "";
    if (!order.has(first)) order.set(first, order.size);
  });
  return vm.rules
    .map((rule, i) => ({ rule, i, group: order.get(rule.triggers[0] ?? "") ?? 0 }))
    .sort((a, b) => a.group - b.group || a.i - b.i)
    .map((x) => x.rule);
}

/**
 * One category: a sticky bar (toggle, title, count), the description and a table holding the
 * first `next` rows. `data-dd-next` / `data-total` track materialisation; a sentinel row
 * follows while `next < total`.
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
    <div class="dd-group">
      <button class="dd-category-toggle dd-pin" type="button" aria-expanded="${!collapsed}" aria-controls="${id}" data-dd-category-toggle>
        <span class="dd-category-title">${escapeHtml(c.title)}</span>
        <span class="dd-category-count" data-dd-cat-count data-total="${total}">${total}</span>
      </button>
    </div>
    <div class="dd-table-wrap" data-dd-table-wrap id="${id}">
      ${c.description || c.comment ? `<div class="dd-category-intro"><div class="dd-category-desc dd-pin">${c.description ? `<p>${multiline(c.description)}</p>` : ""}${note(c.comment)}</div></div>` : ""}
      <table class="dd-table">
        ${tableHead()}
        <tbody data-dd-rows>
          ${rows}${next < total ? moreRowMarkup(next, total, pageSize) : ""}
        </tbody>
      </table>
    </div>
  </section>`;
}

// Icons: 16px strokes in currentColor, hidden from assistive technology (each button has a label).
const svg = (body: string): string =>
  `<svg class="dd-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_RULES = svg(`<path d="M3 2.5v5A2.5 2.5 0 0 0 5.5 10H13m0 0-2.5-2.5M13 10l-2.5 2.5"/>`);
const ICON_INFO = svg(`<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.5M8 5.2v.05"/>`);
const ICON_WARN = svg(`<path d="M8 2.5 14 13H2L8 2.5Z"/><path d="M8 6.5v3M8 11.2v.05"/>`);
const ICON_RESET = svg(`<path d="M2.5 8h11M2.5 8l2-2M2.5 8l2 2M13.5 8l-2-2M13.5 8l-2 2"/>`);
const ICON_COLLAPSE = svg(`<path d="m4.5 6 3.5-3 3.5 3M4.5 10l3.5 3 3.5-3"/>`);
const ICON_COPY = svg(`<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>`);
const ICON_DOWNLOAD = svg(`<path d="M8 2.5v8m0 0-3-3m3 3 3-3M3 13.5h10"/>`);
const ICON_CLOSE = svg(`<path d="m4.5 4.5 7 7m0-7-7 7"/>`);
