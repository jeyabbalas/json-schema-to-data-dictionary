// Lazy row materialisation for the interactive table. A large dictionary renders only its
// first page of rows up front; every incomplete category keeps a sentinel row at the end of
// its <tbody>. One IntersectionObserver (600 px ahead of the viewport) pages rows in as a
// section approaches, and the sentinel's "Show more" button is the fallback when there is
// no observer (or the user prefers clicking). A page is inserted as one HTML string.

import type { RowVM, ViewModel } from "./viewModel";
import { rowMarkup } from "./rowMarkup";
import type { RowMarkupOptions } from "./rowMarkup";
import { moreLabel } from "./markup";
import { activeElement, eventTarget, focusRow } from "./dom";
import type { Root } from "./dom";

export interface LazyRowsOptions {
  pageSize: number;
  rowOptions: RowMarkupOptions;
}

export interface LazyRows {
  /** Materialise the next page of `section`; returns the number of rows added. */
  materializePage(section: HTMLElement): number;
  /** Materialise the first page of a section that has no rows yet (used when it is expanded). */
  ensureFirstPage(section: HTMLElement): void;
  /** Materialise every remaining row of every section (e.g. before printing). */
  materializeAll(): void;
  dispose(): void;
}

export function attachLazyRows(root: Root, vm: ViewModel, opts: LazyRowsOptions): LazyRows {
  const pageSize = Math.max(1, opts.pageSize);

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const section = (entry.target as HTMLElement).closest<HTMLElement>("[data-dd-category]");
              if (section) materialize(section, pageSize);
            }
          },
          { rootMargin: "600px 0px" }
        )
      : undefined;

  const sentinelOf = (tbody: HTMLElement): HTMLElement | undefined => {
    const last = tbody.lastElementChild;
    return last && last.hasAttribute("data-dd-more") ? (last as HTMLElement) : undefined;
  };

  function materialize(section: HTMLElement, limit: number): number {
    const category = vm.categories[Number(section.dataset.ddCat)];
    const tbody = section.querySelector<HTMLElement>("[data-dd-rows]");
    if (!category || !tbody) return 0;
    const total = category.rows.length;
    const next = Number(section.dataset.ddNext) || 0;
    if (next >= total) return 0;
    const end = Math.min(total, next + limit);

    let html = "";
    for (let i = next; i < end; i += 1) html += rowMarkup(category.rows[i] as RowVM, vm, opts.rowOptions);
    const sentinel = sentinelOf(tbody);
    if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
    else tbody.insertAdjacentHTML("beforeend", html);
    section.dataset.ddNext = String(end);

    if (sentinel) {
      if (end >= total) {
        observer?.unobserve(sentinel);
        const focused = sentinel.contains(activeElement(root));
        sentinel.remove();
        if (focused) focusRow(tbody.children[next] ?? null);
      } else {
        const button = sentinel.querySelector<HTMLElement>("[data-dd-more-btn]");
        if (button) button.textContent = moreLabel(total - end, pageSize);
        // Re-observing a sentinel that is still within the margin fires the callback again,
        // so pages keep arriving (one per frame) until the sentinel scrolls out of range.
        if (observer) {
          observer.unobserve(sentinel);
          observer.observe(sentinel);
        }
      }
    }
    return end - next;
  }

  const onClick = (e: Event): void => {
    const button = eventTarget(e)?.closest<HTMLElement>("[data-dd-more-btn]");
    const section = button?.closest<HTMLElement>("[data-dd-category]");
    if (!section) return;
    e.preventDefault();
    materialize(section, pageSize);
  };
  root.addEventListener("click", onClick);

  if (observer) root.querySelectorAll<HTMLElement>("[data-dd-more]").forEach((sentinel) => observer.observe(sentinel));

  return {
    materializePage: (section) => materialize(section, pageSize),
    ensureFirstPage(section) {
      if ((Number(section.dataset.ddNext) || 0) === 0) materialize(section, pageSize);
    },
    materializeAll() {
      root.querySelectorAll<HTMLElement>("[data-dd-category][data-dd-cat]").forEach((section) => materialize(section, Infinity));
    },
    dispose() {
      observer?.disconnect();
      root.removeEventListener("click", onClick);
    }
  };
}
