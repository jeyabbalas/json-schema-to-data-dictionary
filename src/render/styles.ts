// Self-contained styles for the data-dictionary view. Works both inside a Shadow root
// (via :host) and in light DOM (via .dd-root). Theming is exposed through public CSS
// custom properties (--dd-accent, --dd-bg, …); we read them through private --_ vars so a
// value set on the host element always wins and dark-mode defaults still apply when unset.
//
// Layout: the root is a flex column -- header, then one scrolling viewport. Give the element a
// height (or put it in a container that has one) and the viewport takes what the header leaves,
// scrolling under a sticky column header; without one, the table is as tall as its content.
// Column widths are `--dd-col-<key>` (px, set by the resize handles or by the page), falling
// back to shares of the viewport's width (`cqw`: the frame inside the viewport is a size container).

export const STYLES = `
.dd-root, :host {
  --_font: var(--dd-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
  --_mono: var(--dd-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --_bg: var(--dd-bg, #ffffff);
  --_surface: var(--dd-surface, #f7f7f8);
  --_fg: var(--dd-fg, #1a1a1f);
  --_muted: var(--dd-muted, #6e6e78);
  --_border: var(--dd-border, #e7e7eb);
  --_accent: var(--dd-accent, #4f46e5);
  --_accent-weak: var(--dd-accent-weak, #eef0fe);
  --_code-bg: var(--dd-code-bg, #f1f1f4);
  --_sentinel: var(--dd-sentinel, #b45309);
  --_sentinel-bg: var(--dd-sentinel-bg, #fdf4e8);
  --_mark: var(--dd-mark, #fdeaa0);
  --_radius: var(--dd-radius, 8px);
  --_shadow: var(--dd-shadow, 0 1px 2px rgba(20,20,30,.05));
  --_faint: color-mix(in srgb, var(--_muted) 55%, var(--_bg));
  --_line: color-mix(in srgb, var(--_border) 65%, var(--_bg));
  --_hover: color-mix(in srgb, var(--_accent-weak) 45%, var(--_bg));
  --_head-h: 34px;
  /* Default widths: each column's minimum plus its share of whatever width is left over, so the
     columns fill the viewport exactly when it fits their minimums (1020px in all) and scroll
     sideways when it does not. --dd-col-<key> fixes a column at a width of its own. */
  --_spare: max(0px, 100cqw - 1020px);
  --_w-name: var(--dd-col-name, calc(140px + var(--_spare) * .12));
  --_w-description: var(--dd-col-description, calc(200px + var(--_spare) * .34));
  --_w-type: var(--dd-col-type, calc(120px + var(--_spare) * .05));
  --_w-format: var(--dd-col-format, calc(100px + var(--_spare) * .06));
  --_w-values: var(--dd-col-values, calc(200px + var(--_spare) * .23));
  --_w-constraints: var(--dd-col-constraints, calc(160px + var(--_spare) * .14));
  --_w-additional: var(--dd-col-additional, calc(100px + var(--_spare) * .06));
  --_w-total: calc(var(--_w-name) + var(--_w-description) + var(--_w-type) + var(--_w-format) + var(--_w-values) + var(--_w-constraints) + var(--_w-additional));
}
@media (prefers-color-scheme: dark) {
  .dd-root[data-theme="auto"], :host([data-theme="auto"]) {
    --_bg: var(--dd-bg, #111114);
    --_surface: var(--dd-surface, #18181c);
    --_fg: var(--dd-fg, #ececf0);
    --_muted: var(--dd-muted, #9898a3);
    --_border: var(--dd-border, #2a2a31);
    --_accent: var(--dd-accent, #9b9cf6);
    --_accent-weak: var(--dd-accent-weak, #23233d);
    --_code-bg: var(--dd-code-bg, #222228);
    --_sentinel: var(--dd-sentinel, #f2a65a);
    --_sentinel-bg: var(--dd-sentinel-bg, #2c2116);
    --_mark: var(--dd-mark, #5a4a17);
  }
}
.dd-root[data-theme="dark"], :host([data-theme="dark"]) {
  --_bg: var(--dd-bg, #111114);
  --_surface: var(--dd-surface, #18181c);
  --_fg: var(--dd-fg, #ececf0);
  --_muted: var(--dd-muted, #9898a3);
  --_border: var(--dd-border, #2a2a31);
  --_accent: var(--dd-accent, #9b9cf6);
  --_accent-weak: var(--dd-accent-weak, #23233d);
  --_code-bg: var(--dd-code-bg, #222228);
  --_sentinel: var(--dd-sentinel, #f2a65a);
  --_sentinel-bg: var(--dd-sentinel-bg, #2c2116);
  --_mark: var(--dd-mark, #5a4a17);
}

:host { display: block; height: 100%; }
.dd-root {
  box-sizing: border-box;
  display: flex; flex-direction: column;
  height: 100%;
  font-family: var(--_font);
  font-size: 13px; line-height: 1.5;
  color: var(--_fg);
  background: var(--_bg);
  -webkit-text-size-adjust: 100%;
  -webkit-font-smoothing: antialiased;
}
.dd-root *, .dd-root *::before, .dd-root *::after { box-sizing: border-box; }
.dd-root [hidden] { display: none !important; }
.dd-icon { width: 14px; height: 14px; flex: none; }

/* ---- Header & toolbar ---- */
.dd-header { flex: none; padding-bottom: 12px; }
.dd-title { font-size: 17px; font-weight: 600; letter-spacing: -0.012em; line-height: 1.3; margin: 0; }
/* The dataset's description and note: at most --dd-description-max-height tall, scrolling past
   it, so the table keeps its room. A shadow on an edge with more beyond it says so even while an
   overlay scrollbar is hidden: covers in the background colour scroll with the text and hide
   each shadow once its edge is reached. */
.dd-about {
  max-width: 120ch; max-height: var(--dd-description-max-height, min(25vh, 200px));
  margin-top: 4px; padding-right: 8px; overflow-y: auto; overscroll-behavior: contain;
  background:
    linear-gradient(var(--_bg) 40%, transparent) top / 100% 24px no-repeat local,
    linear-gradient(transparent, var(--_bg) 60%) bottom / 100% 24px no-repeat local,
    linear-gradient(color-mix(in srgb, var(--_fg) 14%, transparent), transparent) top / 100% 8px no-repeat scroll,
    linear-gradient(transparent, color-mix(in srgb, var(--_fg) 14%, transparent)) bottom / 100% 8px no-repeat scroll;
}
.dd-description, .dd-comment { margin: 4px 0 0; max-width: 120ch; color: var(--_muted); }
.dd-about > :first-child { margin-top: 0; }
.dd-comment { font-size: 12px; }

.dd-toolbar { display: grid; gap: 8px; margin-top: 14px; }
.dd-searchbar, .dd-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dd-panel-toggles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dd-search { position: relative; flex: 1 1 340px; min-width: 220px; max-width: 640px; }
.dd-search::before {
  content: ""; position: absolute; left: 11px; top: 50%; width: 14px; height: 14px; transform: translateY(-50%);
  background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23898993' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.6-3.6'/%3E%3C/svg%3E");
  pointer-events: none;
}
.dd-search-input {
  width: 100%; height: 34px; font: inherit; color: inherit;
  padding: 0 12px 0 33px;
  border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_bg) var(--dd-search-icon, none);
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.dd-search-input::placeholder { color: var(--_faint); }
.dd-search-input:focus { border-color: var(--_accent); box-shadow: 0 0 0 3px var(--_accent-weak); }
.dd-count { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); font-size: 11.5px; color: var(--_muted); pointer-events: none; white-space: nowrap; font-variant-numeric: tabular-nums; }

.dd-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-left: auto; }
.dd-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 10px;
  font: inherit; font-size: 12.5px; font-weight: 500; color: var(--_fg); white-space: nowrap;
  border: 1px solid var(--_border); border-radius: 7px; background: var(--_bg);
  cursor: pointer; transition: background .12s, border-color .12s, color .12s;
}
.dd-btn .dd-icon { color: var(--_muted); }
.dd-btn:hover { background: var(--_surface); }
.dd-btn:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
.dd-btn[aria-expanded="true"] { background: var(--_accent-weak); border-color: color-mix(in srgb, var(--_accent) 35%, var(--_border)); color: var(--_accent); }
.dd-btn[aria-expanded="true"] .dd-icon { color: var(--_accent); }
.dd-btn-icon { width: 30px; padding: 0; justify-content: center; }
.dd-btn-count { font-size: 11px; font-weight: 500; color: var(--_muted); font-variant-numeric: tabular-nums; }
.dd-btn[aria-expanded="true"] .dd-btn-count { color: inherit; }
.dd-btn-warn, .dd-btn-warn .dd-icon { color: var(--_sentinel); }

/* ---- Panels opened from the toolbar ---- */
.dd-panel {
  margin-top: 10px; max-height: min(36vh, 380px); overflow: auto;
  border: 1px solid var(--_border); border-radius: var(--_radius); background: var(--_bg);
  overscroll-behavior: contain;
}
.dd-panel-head {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px;
  padding: 6px 6px 6px 14px; background: var(--_surface); border-bottom: 1px solid var(--_border);
}
.dd-panel-title { font-weight: 600; }
.dd-panel-note { color: var(--_muted); font-size: 12px; }
.dd-panel-close { margin-left: auto; height: 26px; width: 26px; border-color: transparent; background: transparent; }
.dd-panel-body { padding: 4px 14px 12px; }
.dd-panel-body > .dd-tree { padding-top: 8px; }
.dd-warnings { margin: 8px 0 0; padding-left: 18px; color: var(--_sentinel); }
.dd-warnings li { margin: 3px 0; }

.dd-empty { flex: none; padding: 28px 14px; color: var(--_muted); text-align: center; }

/* ---- The sheet: one scrolling viewport, a sticky column header, category sections ---- */
.dd-viewport {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_bg); box-shadow: var(--_shadow);
}
/* The size container is this inner frame, not the scroller: it measures the width actually
   visible (container units of a scroll container do not subtract its scrollbar). */
.dd-frame { container-type: inline-size; }
.dd-sheet { position: relative; width: max(100%, var(--_w-total)); }
/* Content that should stay in view while the sheet scrolls sideways. */
.dd-pin { position: sticky; left: 0; width: 100cqw; max-width: 100%; }

/* Fixed layout sizes the columns from the first row: the header cells carry the widths. */
.dd-table { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: var(--_w-total); }
.dd-table th.dd-h-name { width: var(--_w-name); }
.dd-table th.dd-h-description { width: var(--_w-description); }
.dd-table th.dd-h-type { width: var(--_w-type); }
.dd-table th.dd-h-format { width: var(--_w-format); }
.dd-table th.dd-h-values { width: var(--_w-values); }
.dd-table th.dd-h-constraints { width: var(--_w-constraints); }
.dd-table th.dd-h-additional { width: var(--_w-additional); }

.dd-head { position: sticky; top: 0; z-index: 6; background: var(--_surface); }
.dd-head th {
  position: relative; height: var(--_head-h); padding: 0 12px;
  font-size: 11px; font-weight: 600; letter-spacing: .045em; text-transform: uppercase; text-align: left;
  color: var(--_muted); white-space: nowrap; overflow: visible;
  border-bottom: 1px solid var(--_border);
  background: var(--_surface);
}
.dd-head-label { display: block; overflow: hidden; text-overflow: ellipsis; }
.dd-head th.dd-col-name { position: sticky; left: 0; z-index: 2; }
.dd-resize {
  position: absolute; top: 0; right: -6px; z-index: 3; width: 12px; height: 100%;
  cursor: col-resize; touch-action: none; outline: none;
}
.dd-head th:last-child .dd-resize { right: 0; width: 8px; }
.dd-resize::after {
  content: ""; position: absolute; left: 50%; top: 9px; bottom: 9px; width: 1px; transform: translateX(-50%);
  background: var(--_border); transition: background .12s, top .12s, bottom .12s;
}
.dd-head th:last-child .dd-resize::after { left: auto; right: 0; transform: none; }
.dd-resize:hover::after, .dd-resize:focus-visible::after, .dd-resize[data-active]::after {
  top: 0; bottom: 0; width: 2px; background: var(--_accent);
}
.dd-root[data-dd-resizing], .dd-root[data-dd-resizing] * { cursor: col-resize !important; user-select: none; -webkit-user-select: none; }

/* The body tables' own headers: announced, not shown. */
.dd-sr-head th { height: 0; padding: 0 !important; border: 0 !important; line-height: 0; }
.dd-sr-head th > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Sections off screen skip layout and paint; the placeholder height keeps scrolling stable. */
.dd-category { content-visibility: auto; contain-intrinsic-size: auto 240px; }
.dd-group {
  position: sticky; top: var(--_head-h); z-index: 4;
  background: var(--_bg); border-bottom: 1px solid var(--_border);
}
.dd-category + .dd-category .dd-group { border-top: 1px solid var(--_border); }
.dd-category-toggle {
  display: flex; align-items: center; gap: 8px;
  font: inherit; text-align: left; cursor: pointer; color: inherit;
  padding: 9px 12px; border: none; background: transparent;
}
.dd-category-toggle:focus-visible { outline: 2px solid var(--_accent); outline-offset: -2px; }
/* The caret: a chevron drawn with two borders, pointing down when open, right when collapsed. */
.dd-category-toggle::before {
  content: ""; flex: none; width: 6px; height: 6px; margin: 0 4px 3px 2px;
  border-right: 1.6px solid var(--_muted); border-bottom: 1.6px solid var(--_muted);
  transform: rotate(45deg); transition: transform .15s, margin .15s;
}
.dd-category[data-collapsed="true"] .dd-category-toggle::before { transform: rotate(-45deg); margin-bottom: 0; }
.dd-category-title { font-weight: 600; font-size: 13px; }
.dd-category-count { font-size: 11.5px; color: var(--_muted); font-variant-numeric: tabular-nums; }
.dd-category-intro { border-bottom: 1px solid var(--_line); }
.dd-category-desc { margin: 0; padding: 8px 12px 9px 34px; color: var(--_muted); max-width: 120ch; }
.dd-category-desc p { margin: 0; }
.dd-category[data-collapsed="true"] .dd-table-wrap { display: none; }

/* ---- Rows ---- */
.dd-table tbody td, .dd-table tbody th {
  padding: 9px 12px; vertical-align: top; text-align: left; font-weight: 400;
  border-bottom: 1px solid var(--_line); overflow-wrap: break-word;
}
.dd-table tbody tr:last-child > td, .dd-table tbody tr:last-child > th { border-bottom: none; }
.dd-table tbody tr:hover > td, .dd-table tbody tr:hover > th { background: var(--_hover); }
.dd-row:focus-visible { outline: 2px solid var(--_accent); outline-offset: -2px; }
/* A row jumped to lands below the sticky column header and category bar, not under them. */
.dd-row { scroll-margin-top: calc(var(--_head-h) + 46px); }
.dd-results .dd-row { scroll-margin-top: calc(var(--_head-h) + 8px); }
@keyframes dd-flash { from { background: var(--_mark); } to { background: var(--_bg); } }
.dd-row.dd-flash > td, .dd-row.dd-flash > th { animation: dd-flash 2s ease-out; }

.dd-col-name { position: sticky; left: 0; z-index: 1; background: var(--_bg); }
.dd-table tbody .dd-col-name { box-shadow: inset -1px 0 0 var(--_line); }
.dd-col-name code { font-family: var(--_mono); font-weight: 600; font-size: 12.5px; word-break: break-word; }

/* Nested fields sit indented under their parent (one step per level, the deepest levels
   sharing the last) with a tree glyph in the gutter the indentation opens -- positioned, so a
   long path wrapping in the narrow column never strands the glyph on a line of its own. The
   muted prefix is the parent path, the bold leaf the field itself. The results list renders
   nested rows without data-dd-depth, so it gets neither. */
.dd-row[data-dd-depth] .dd-col-name { padding-left: 28px; }
.dd-row[data-dd-depth] .dd-col-name::before {
  content: "└"; content: "└" / ""; position: absolute; top: 9px; left: 13px;
  color: var(--_faint); font-family: var(--_mono); font-size: 12px; line-height: 1.5;
}
.dd-row[data-dd-depth="2"] .dd-col-name { padding-left: 42px; }
.dd-row[data-dd-depth="2"] .dd-col-name::before { left: 27px; }
.dd-row[data-dd-depth="3"] .dd-col-name { padding-left: 56px; }
.dd-row[data-dd-depth="3"] .dd-col-name::before { left: 41px; }
.dd-row[data-dd-depth="4"] .dd-col-name, .dd-row[data-dd-depth="5"] .dd-col-name, .dd-row[data-dd-depth="6"] .dd-col-name { padding-left: 70px; }
.dd-row[data-dd-depth="4"] .dd-col-name::before, .dd-row[data-dd-depth="5"] .dd-col-name::before, .dd-row[data-dd-depth="6"] .dd-col-name::before { left: 55px; }
.dd-name-prefix { font-weight: 400; color: var(--_muted); }

.dd-desc { white-space: pre-line; }
.dd-format { color: var(--_muted); }
.dd-muted { color: var(--_faint); }

/* A rectangle, not a pill: a long data type ("number + coded values") wraps in a narrow
   column, and a pill radius would round that block into a blob. */
.dd-badge {
  display: inline-block; font-family: var(--_mono); font-size: 11.5px; line-height: 1.5;
  padding: 1px 6px; border-radius: 5px; background: var(--_code-bg); color: var(--_fg);
}
.dd-badge[data-mixed="true"] { background: var(--_sentinel-bg); color: var(--_sentinel); }

/* Valid values: one grid, so labels line up whatever the width of their codes. */
.dd-vv { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 8px; row-gap: 3px; }
.dd-vv-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; }
.dd-vv-row dt { margin: 0; }
.dd-vv-row dd { margin: 0; min-width: 0; }
.dd-code {
  font-family: var(--_mono); font-size: 11.5px; padding: 1px 5px; border-radius: 4px;
  background: var(--_code-bg); white-space: nowrap;
}
.dd-measure-label { font-family: var(--_mono); font-size: 12px; }
.dd-measure dd { color: var(--_muted); }
/* A long range spans its row rather than widening the code column under it. */
.dd-vv-row.dd-measure-wide { display: flex; flex-wrap: wrap; column-gap: 8px; }
.dd-vv-sep {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin: 5px 0 1px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--_sentinel);
}
.dd-vv-sep::after { content: ""; flex: 1; height: 1px; background: var(--_line); }
.dd-sentinel .dd-code { background: var(--_sentinel-bg); color: var(--_sentinel); }

/* Skip patterns. On a value: the condition that sets it, its variables links to their rows. */
.dd-when { display: block; margin-top: 1px; font-size: 12px; color: var(--_muted); }
.dd-kw { color: var(--_muted); font-size: 11.5px; }
/* A condition reads as text -- its codes carry labels ("partner_present = 0 (No)") -- with the
   variables it names in the code font. */
.dd-cond { font-size: 12px; color: var(--_fg); }
.dd-cond .dd-ref, .dd-cond .dd-ref-self { font-family: var(--_mono); font-size: 11.5px; }
.dd-ref {
  font: inherit; color: var(--_accent); background: none; border: 0; padding: 0; margin: 0; cursor: pointer;
  text-decoration: underline dotted color-mix(in srgb, var(--_accent) 55%, transparent); text-underline-offset: 2px;
}
.dd-ref:hover { text-decoration-style: solid; }
.dd-ref:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; border-radius: 2px; }
.dd-ref-self { font: inherit; }
/* A long variable name breaks inside its cell rather than running over the next column. */
.dd-ref { max-width: 100%; text-align: left; overflow-wrap: anywhere; }
.dd-ref-self { overflow-wrap: anywhere; }

.dd-constraints-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.dd-constraints-list li { position: relative; padding-left: 11px; }
.dd-constraints-list li::before { content: ""; position: absolute; left: 0; top: .62em; width: 4px; height: 4px; border-radius: 50%; background: var(--_faint); }
.dd-conditional { color: var(--_fg); }
.dd-conditional::before { background: var(--_accent) !important; }

/* On a variable skip patterns read: a chip under its name opening a detail row beneath it. */
.dd-skips-toggle {
  display: flex; align-items: center; gap: 4px; width: fit-content; margin-top: 5px;
  font: inherit; font-size: 11.5px; font-weight: 500; line-height: 1.6; color: var(--_accent);
  padding: 0 8px 0 6px; border: 0; border-radius: 999px; background: var(--_accent-weak); cursor: pointer;
}
.dd-skips-toggle .dd-icon { width: 12px; height: 12px; }
.dd-skips-toggle:hover { background: color-mix(in srgb, var(--_accent) 16%, var(--_bg)); }
.dd-skips-toggle[aria-expanded="true"] { background: var(--_accent); color: var(--_bg); }
.dd-skips-toggle:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
.dd-row-open > td, .dd-row-open > th { border-bottom-color: transparent; }
.dd-table tbody .dd-detail > td { padding: 0; background: var(--_surface); }
.dd-detail .dd-pin { padding: 6px 16px 8px 28px; }

/* A list of skip patterns, in the panel and in a detail row: a three-column grid
   "if <condition> | → <value> <label> | <variables>", rules that read the same variable first
   kept together. */
/* A long condition or requirement wraps within its share; the variables keep room to read. */
.dd-rules { display: grid; grid-template-columns: fit-content(40%) fit-content(30%) minmax(12em, 1fr); column-gap: 20px; }
.dd-rule { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; padding: 7px 0; border-top: 1px solid var(--_line); }
.dd-rule:first-child { border-top: none; }
.dd-rule.dd-rule-opens:not(:first-child) { border-top-color: var(--_border); }
.dd-rule-if { font-size: 12px; }
.dd-rule-then { grid-column: 2 / -1; display: grid; grid-template-columns: subgrid; row-gap: 5px; }
.dd-rule-group { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline; }
.dd-rule-set { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; }
.dd-rule-set .dd-code { background: var(--_sentinel-bg); color: var(--_sentinel); }
.dd-rule-label { color: var(--_muted); }
.dd-rule-qual { font-size: 12px; font-style: italic; color: var(--_muted); }
.dd-rule-vars { display: flex; flex-wrap: wrap; gap: 2px 12px; font-family: var(--_mono); font-size: 11.5px; }
.dd-rule-vars .dd-ref-self { font-weight: 600; }
.dd-rule-text { font-size: 12px; }
/* A requirement in words wraps beside its arrow rather than under it. */
.dd-rule-set .dd-rule-text { flex: 1 1 0; min-width: 12ch; }
.dd-rule-note { grid-column: 1 / -1; margin-top: 3px; font-size: 11.5px; font-style: italic; color: var(--_muted); max-width: 120ch; }

/* The schema author's $comments: a note set apart from the definition it annotates (a variable,
   a section, the dataset), and -- under a skip pattern or a value -- why it is so. */
.dd-note { margin-top: 6px; padding: 1px 0 1px 8px; border-left: 2px solid var(--_border); font-size: 12px; color: var(--_muted); }
.dd-note:first-child { margin-top: 0; }
.dd-note-tag { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.dd-why { display: block; margin-top: 1px; font-size: 11.5px; font-style: italic; color: var(--_muted); }

.dd-tree { font-family: var(--_mono); font-size: 11.5px; }
.dd-tree details { margin: 0; }
.dd-tree summary { cursor: pointer; list-style: none; color: var(--_accent); }
.dd-tree summary::-webkit-details-marker { display: none; }
.dd-tree summary::before { content: "▸ "; color: var(--_faint); }
.dd-tree details[open] > summary::before { content: "▾ "; }
.dd-tree ul { list-style: none; margin: 0 0 0 5px; padding: 0 0 0 10px; border-left: 1px solid var(--_border); }
.dd-tree ul.dd-tree-root { margin: 0; padding: 0; border-left: 0; }
.dd-tree .dd-key { color: var(--_muted); }
.dd-tree .dd-str { color: var(--_accent); }
.dd-tree .dd-num { color: var(--_sentinel); }

mark.dd-hit { background: var(--_mark); color: inherit; border-radius: 3px; padding: 0 1px; }

/* Lazy paging: the sentinel row of an incomplete category, and the results list's foot. */
.dd-table tbody .dd-more > td { padding: 0; }
.dd-more .dd-pin { display: flex; justify-content: center; padding: 10px 12px; }
.dd-more-btn { font-size: 12px; }
.dd-results-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; padding: 10px 12px; color: var(--_muted); font-size: 12px; border-top: 1px solid var(--_line); }

/* Ranked results list: category tag under the name, "related" badge, semantic status chip. */
.dd-results .dd-row-cat { display: block; margin-top: 2px; font-size: 11px; font-weight: 400; color: var(--_muted); }
.dd-row[data-dd-match="related"] .dd-col-name::after {
  content: "related"; display: inline-block; margin-top: 4px; padding: 0 6px;
  font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
  border-radius: 999px; background: var(--_accent-weak); color: var(--_accent);
}
.dd-semantic-status { font-size: 12px; color: var(--_muted); white-space: nowrap; }
.dd-semantic-status[data-state="error"] { color: var(--_sentinel); }
.dd-semantic-status[data-state="ready"]::before { content: "✦ "; color: var(--_accent); }

/* Autofit's measuring table (columns.ts): laid out at max-content, never seen. */
.dd-probe { position: absolute; top: 0; left: 0; visibility: hidden; pointer-events: none; width: max-content !important; table-layout: auto !important; }
.dd-probe th, .dd-probe td { position: static !important; }

@media print {
  .dd-root { height: auto; }
  .dd-about { max-height: none; overflow: visible; background: none; }
  .dd-viewport { overflow: visible; border: none; box-shadow: none; }
  .dd-head, .dd-group, .dd-col-name, .dd-pin { position: static; }
  .dd-category { content-visibility: visible; contain-intrinsic-size: none; }
  .dd-toolbar, .dd-resize, .dd-panel { display: none; }
}
@media (max-width: 640px) {
  .dd-search { flex-basis: 100%; max-width: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dd-row.dd-flash > td, .dd-row.dd-flash > th { animation-duration: .01s; }
}
`;
