// The ranked results list shown while a query is active. Rows never move between the
// categories and this list: each render builds the visible page as ONE HTML string from
// the view model (highlights baked in) and assigns it to the <tbody>. The list is paged by
// `resultsPageSize` with a "Show more" button; the number of rows shown survives semantic
// updates of the same query so a list the user expanded does not snap back when related
// rows arrive.

import type { ViewModel } from "./viewModel";
import { rowVMsByTableIndex } from "./viewModel";
import { rowMarkup } from "./rowMarkup";
import type { RowMarkupOptions } from "./rowMarkup";
import { createHighlighter, PLAIN } from "./highlight";
import type { Highlighter } from "./highlight";
import { formatCount } from "./markup";
import { activeElement, eventTarget, focusRow, insertRows } from "./dom";
import type { Root } from "./dom";
import type { SearchResult } from "../search/types";

export interface ResultsViewOptions {
  pageSize: number;
  rowOptions: RowMarkupOptions;
}

export interface ResultsView {
  /** Show `result` for the query typed as `raw` (re-renders in place for the same query). */
  render(result: SearchResult, raw: string): void;
  /** Append the next page of results. */
  showMore(): void;
  /** Empty and hide the list. */
  clear(): void;
  dispose(): void;
}

export function createResultsView(root: Root, vm: ViewModel, opts: ResultsViewOptions): ResultsView {
  const section = root.querySelector<HTMLElement>("[data-dd-results]");
  const body = root.querySelector<HTMLElement>("[data-dd-results-body]");
  const foot = root.querySelector<HTMLElement>("[data-dd-results-foot]");
  const status = root.querySelector<HTMLElement>("[data-dd-results-status]");
  const more = root.querySelector<HTMLElement>("[data-dd-results-more]");
  const pageSize = Math.max(1, opts.pageSize);
  const rows = rowVMsByTableIndex(vm);

  let current: SearchResult | undefined;
  let shown = 0;
  let highlight: Highlighter = PLAIN;

  const pageHtml = (from: number, to: number): string => {
    if (!current) return "";
    let html = "";
    for (let i = from; i < to; i += 1) {
      const r = current.results[i];
      const row = r ? rows[r.row] : undefined;
      if (!r || !row) continue;
      html += rowMarkup(row, vm, {
        ...opts.rowOptions,
        highlight,
        match: r.exact ? "exact" : "related",
        similarity: r.semanticScore
      });
    }
    return html;
  };

  const updateFoot = (): void => {
    const total = current?.results.length ?? 0;
    const remaining = total - shown;
    if (foot) foot.hidden = remaining <= 0;
    if (status) status.textContent = remaining > 0 ? `Showing ${formatCount(shown)} of ${formatCount(total)} matches` : "";
    if (more) more.textContent = `Show ${formatCount(Math.min(pageSize, Math.max(0, remaining)))} more`;
  };

  const onClick = (e: Event): void => {
    if (!eventTarget(e)?.closest("[data-dd-results-more]")) return;
    e.preventDefault();
    showMore();
  };
  root.addEventListener("click", onClick);

  function showMore(): void {
    if (!current || !body) return;
    const total = current.results.length;
    if (shown >= total) return;
    const from = shown;
    shown = Math.min(total, shown + pageSize);
    const focused = more !== null && activeElement(root) === more;
    insertRows(body, pageHtml(from, shown), null);
    updateFoot();
    // When the button disappears under the reader's focus, continue from the first new row.
    if (focused && shown >= total) focusRow(body.children[from] ?? null);
  }

  return {
    render(result, raw) {
      const total = result.results.length;
      const sameQuery = current !== undefined && current.normalizedQuery === result.normalizedQuery;
      const firstPage = Math.min(pageSize, total);
      shown = sameQuery ? Math.min(total, Math.max(shown, firstPage)) : firstPage;
      current = result;
      highlight = createHighlighter(result.terms.length ? result.terms : [result.normalizedQuery]);
      if (body) body.innerHTML = pageHtml(0, shown);
      if (section) {
        section.hidden = total === 0;
        section.setAttribute("aria-busy", String(result.semantic.state === "pending"));
        section.setAttribute("aria-label", `Search results for “${raw.trim()}”`);
      }
      updateFoot();
    },
    showMore,
    clear() {
      current = undefined;
      shown = 0;
      highlight = PLAIN;
      if (body) body.innerHTML = "";
      if (section) {
        section.hidden = true;
        section.setAttribute("aria-busy", "false");
        section.setAttribute("aria-label", "Search results");
      }
      if (foot) foot.hidden = true;
    },
    dispose() {
      root.removeEventListener("click", onClick);
    }
  };
}
