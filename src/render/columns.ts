// Column widths of the rendered table. Every table of a dictionary -- the sticky column
// header, one per category, the results list -- sizes its <col>s from the same custom
// properties on `.dd-root` (`--dd-col-<key>`), so one property write resizes a column
// everywhere. A column without one keeps the stylesheet's proportional default.
//
// `attachColumnResize` is the reader-facing part: drag a header edge, double-click it (or
// press Enter on it) to fit the column to its content, arrow keys to nudge it. It is written
// to be self-contained -- no imports, no module-level references -- because the static
// `tableToHtml` output inlines its source text (see inlineScript in behavior.ts).

import type { ColumnWidths, DataDictionaryColumn } from "../types";

/** The columns in display order: public name, key of the `<col>` class / custom property, header label. */
export const COLUMNS: ReadonlyArray<{ column: DataDictionaryColumn; key: string; label: string }> = [
  { column: "Variable name", key: "name", label: "Variable" },
  { column: "Description", key: "description", label: "Description" },
  { column: "Data type", key: "type", label: "Data type" },
  { column: "Format", key: "format", label: "Format" },
  { column: "Valid values", key: "values", label: "Valid values" },
  { column: "Constraints", key: "constraints", label: "Constraints" },
  { column: "Additional information", key: "additional", label: "Additional" }
];

/** Widths keyed by column key (`{ description: 420 }`), as the runtime and the markup use them. */
export type WidthsByKey = Record<string, number>;

/** Public widths -> widths by key, keeping finite positive numbers (rounded to whole pixels). */
export function widthsByKey(widths: ColumnWidths | undefined): WidthsByKey {
  const out: WidthsByKey = {};
  if (!widths) return out;
  for (const { column, key } of COLUMNS) {
    const w = widths[column];
    if (typeof w === "number" && Number.isFinite(w) && w > 0) out[key] = Math.round(w);
  }
  return out;
}

/** Widths by key -> public widths. */
export function widthsByColumn(byKey: WidthsByKey): ColumnWidths {
  const out: ColumnWidths = {};
  for (const { column, key } of COLUMNS) {
    const w = byKey[key];
    if (typeof w === "number") out[column] = w;
  }
  return out;
}

/** The public name of a column key, or `null`. */
export function columnOfKey(key: string | null): DataDictionaryColumn | null {
  return COLUMNS.find((c) => c.key === key)?.column ?? null;
}

/** `style` attribute value declaring `byKey` as `--dd-col-*` properties ("" when empty). */
export function columnStyle(byKey: WidthsByKey): string {
  return Object.entries(byKey)
    .map(([key, w]) => `--dd-col-${key}:${w}px`)
    .join(";");
}

/**
 * Make the column header's edges resizable. `root` is the `.dd-root` element; `initial` the
 * widths to start from; `onChange` hears every committed change with all the widths set so far
 * (and the key that changed, `null` for a reset). Returns a detach function.
 *
 * SELF-CONTAINED: the static HTML inlines `String(attachColumnResize)`, so nothing in here may
 * refer to anything outside the function body.
 */
export function attachColumnResize(
  root: HTMLElement,
  initial: Record<string, number>,
  onChange?: ((widths: Record<string, number>, key: string | null) => void) | null
): () => void {
  const MIN = 56;
  const MAX = 1600;
  const FIT_MAX = 640;
  const STEP = 16;
  const head = root.querySelector<HTMLElement>("[data-dd-head]");
  const reset = root.querySelector<HTMLElement>('[data-dd-action="reset-widths"]');
  if (!head) return () => {};
  let widths: Record<string, number> = {};

  const clamp = (w: number, max: number = MAX): number => Math.round(Math.min(max, Math.max(MIN, w)));
  const set = (key: string, w: number | null): void => {
    if (w === null) {
      delete widths[key];
      root.style.removeProperty(`--dd-col-${key}`);
    } else {
      widths[key] = w;
      root.style.setProperty(`--dd-col-${key}`, `${w}px`);
    }
  };
  const commit = (key: string | null): void => {
    if (reset) reset.hidden = Object.keys(widths).length === 0;
    onChange?.({ ...widths }, key);
  };
  const handleOf = (e: Event): HTMLElement | null => {
    const t = e.target as Element | null;
    return t && typeof t.closest === "function" ? t.closest<HTMLElement>("[data-dd-resize]") : null;
  };
  const keyOf = (handle: HTMLElement): string => handle.getAttribute("data-dd-resize") ?? "";
  const cellOf = (handle: HTMLElement): HTMLElement | null => handle.closest<HTMLElement>("th");
  // A width the reader set is exact; otherwise ask the layout.
  const widthOf = (handle: HTMLElement): number => widths[keyOf(handle)] ?? Math.max(MIN, cellOf(handle)?.getBoundingClientRect().width ?? 0);
  const announce = (handle: HTMLElement, w: number): void => handle.setAttribute("aria-valuenow", String(Math.round(w)));

  for (const key of Object.keys(initial)) {
    const w = initial[key];
    if (typeof w === "number" && w > 0) set(key, clamp(w));
  }
  if (reset) reset.hidden = Object.keys(widths).length === 0;

  // Fit a column to its content: copy its cells (materialised rows only, at most 400) into an
  // invisible auto-layout table in the sheet, so the same styles apply, and read its width.
  const fit = (handle: HTMLElement): void => {
    const th = cellOf(handle);
    const tr = th?.parentElement;
    if (!th || !tr) return;
    const index = Array.prototype.indexOf.call(tr.children, th);
    const doc = root.ownerDocument;
    const probe = doc.createElement("table");
    probe.className = "dd-table dd-probe";
    probe.setAttribute("aria-hidden", "true");
    const body = doc.createElement("tbody");
    probe.appendChild(body);
    const rows = root.querySelectorAll<HTMLElement>("[data-dd-row]");
    let n = 0;
    for (let i = 0; i < rows.length && n < 400; i += 1) {
      const row = rows[i] as HTMLElement;
      const cell = row.children[index];
      if (!cell) continue;
      const copy = row.cloneNode(false) as HTMLElement;
      copy.appendChild(cell.cloneNode(true));
      body.appendChild(copy);
      n += 1;
    }
    const label = th.querySelector<HTMLElement>("[data-dd-head-label]");
    const labelWidth = label ? label.scrollWidth + 30 : 0;
    (head.parentElement ?? root).appendChild(probe);
    const content = n > 0 ? probe.getBoundingClientRect().width : 0;
    probe.remove();
    const w = clamp(Math.max(content, labelWidth) + 1, FIT_MAX);
    set(keyOf(handle), w);
    announce(handle, w);
    commit(keyOf(handle));
  };

  let drag: { handle: HTMLElement; key: string; x: number; w: number; id: number; next: number | null } | null = null;
  let frame = 0;
  const onDown = (e: PointerEvent): void => {
    const handle = handleOf(e);
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    drag = { handle, key: keyOf(handle), x: e.clientX, w: widthOf(handle), id: e.pointerId, next: null };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    handle.setAttribute("data-active", "");
    root.setAttribute("data-dd-resizing", "");
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.next = clamp(drag.w + e.clientX - drag.x);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag && drag.next !== null) {
        set(drag.key, drag.next);
        announce(drag.handle, drag.next);
      }
    });
  };
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    d.handle.removeAttribute("data-active");
    root.removeAttribute("data-dd-resizing");
    if (d.next === null) return;
    set(d.key, d.next);
    announce(d.handle, d.next);
    commit(d.key);
  };
  const onDouble = (e: MouseEvent): void => {
    const handle = handleOf(e);
    if (!handle) return;
    e.preventDefault();
    fit(handle);
  };
  const onKey = (e: KeyboardEvent): void => {
    const handle = handleOf(e);
    if (!handle) return;
    const key = keyOf(handle);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = (e.shiftKey ? 4 : 1) * STEP * (e.key === "ArrowRight" ? 1 : -1);
      const w = clamp(widthOf(handle) + step);
      set(key, w);
      announce(handle, w);
      commit(key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      fit(handle);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      set(key, null);
      announce(handle, widthOf(handle));
      commit(key);
    }
  };
  const onFocus = (e: FocusEvent): void => {
    const handle = handleOf(e);
    if (handle) announce(handle, widthOf(handle));
  };
  const onReset = (): void => {
    for (const key of Object.keys(widths)) root.style.removeProperty(`--dd-col-${key}`);
    widths = {};
    commit(null);
  };

  head.addEventListener("pointerdown", onDown);
  head.addEventListener("pointermove", onMove);
  head.addEventListener("pointerup", onUp);
  head.addEventListener("pointercancel", onUp);
  head.addEventListener("dblclick", onDouble);
  head.addEventListener("keydown", onKey);
  head.addEventListener("focusin", onFocus);
  reset?.addEventListener("click", onReset);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    head.removeEventListener("pointerdown", onDown);
    head.removeEventListener("pointermove", onMove);
    head.removeEventListener("pointerup", onUp);
    head.removeEventListener("pointercancel", onUp);
    head.removeEventListener("dblclick", onDouble);
    head.removeEventListener("keydown", onKey);
    head.removeEventListener("focusin", onFocus);
    reset?.removeEventListener("click", onReset);
  };
}
