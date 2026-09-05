// Small DOM helpers shared by the interactive modules: the root a behaviour attaches to,
// composed-path-aware event origins (Shadow DOM retargets `event.target` to the host for
// listeners outside the tree, e.g. on `document`), and focus hand-off after "Show more".

export type Root = Document | ShadowRoot | HTMLElement;

/** The element an event originated from, seen through shadow boundaries. */
export function eventTarget(e: Event): Element | null {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  const origin = (path[0] ?? e.target) as { nodeType?: number; parentElement?: Element | null } | null;
  if (!origin || typeof origin.nodeType !== "number") return null;
  return origin.nodeType === 1 ? (origin as unknown as Element) : (origin.parentElement ?? null);
}

/** The focused element as seen from `root` (inside the shadow tree when there is one). */
export function activeElement(root: Root): Element | null {
  try {
    if ("activeElement" in root) return root.activeElement;
    return root.ownerDocument.activeElement;
  } catch {
    // Some DOM implementations throw here before anything was ever focused.
    return null;
  }
}

/** Move keyboard focus to a freshly inserted row (made programmatically focusable). */
export function focusRow(row: Element | null): void {
  const el = row as (HTMLElement & { focus?: () => void }) | null;
  if (!el || typeof el.focus !== "function") return;
  el.tabIndex = -1;
  el.focus();
}
