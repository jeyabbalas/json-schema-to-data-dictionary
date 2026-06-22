// Self-contained styles for the data-dictionary view. Works both inside a Shadow root
// (via :host) and in light DOM (via .dd-root). Theming is exposed through public CSS
// custom properties (--dd-accent, --dd-bg, …); we read them through private --_ vars so a
// value set on the host element always wins and dark-mode defaults still apply when unset.

export const STYLES = `
.dd-root, :host {
  --_font: var(--dd-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
  --_mono: var(--dd-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  --_bg: var(--dd-bg, #ffffff);
  --_surface: var(--dd-surface, #f6f8fa);
  --_fg: var(--dd-fg, #1b2330);
  --_muted: var(--dd-muted, #5c6675);
  --_border: var(--dd-border, #e4e8ef);
  --_accent: var(--dd-accent, #0a7d63);
  --_accent-weak: var(--dd-accent-weak, #e7f4ef);
  --_code-bg: var(--dd-code-bg, #eef1f6);
  --_sentinel: var(--dd-sentinel, #b25711);
  --_sentinel-bg: var(--dd-sentinel-bg, #fbf0e4);
  --_mark: var(--dd-mark, #ffe9a8);
  --_radius: var(--dd-radius, 10px);
  --_shadow: var(--dd-shadow, 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1));
}
@media (prefers-color-scheme: dark) {
  .dd-root[data-theme="auto"], :host([data-theme="auto"]) {
    --_bg: var(--dd-bg, #10141b);
    --_surface: var(--dd-surface, #161c26);
    --_fg: var(--dd-fg, #e7ecf3);
    --_muted: var(--dd-muted, #9aa6b6);
    --_border: var(--dd-border, #28303d);
    --_accent: var(--dd-accent, #54d6ad);
    --_accent-weak: var(--dd-accent-weak, #142a25);
    --_code-bg: var(--dd-code-bg, #1d2530);
    --_sentinel: var(--dd-sentinel, #f0a35e);
    --_sentinel-bg: var(--dd-sentinel-bg, #2a2016);
    --_mark: var(--dd-mark, #5b4f1f);
  }
}
.dd-root[data-theme="dark"], :host([data-theme="dark"]) {
  --_bg: var(--dd-bg, #10141b);
  --_surface: var(--dd-surface, #161c26);
  --_fg: var(--dd-fg, #e7ecf3);
  --_muted: var(--dd-muted, #9aa6b6);
  --_border: var(--dd-border, #28303d);
  --_accent: var(--dd-accent, #54d6ad);
  --_accent-weak: var(--dd-accent-weak, #142a25);
  --_code-bg: var(--dd-code-bg, #1d2530);
  --_sentinel: var(--dd-sentinel, #f0a35e);
  --_sentinel-bg: var(--dd-sentinel-bg, #2a2016);
  --_mark: var(--dd-mark, #5b4f1f);
}

:host { display: block; }
.dd-root {
  box-sizing: border-box;
  font-family: var(--_font);
  color: var(--_fg);
  background: var(--_bg);
  line-height: 1.5;
  font-size: 14px;
  -webkit-text-size-adjust: 100%;
}
.dd-root *, .dd-root *::before, .dd-root *::after { box-sizing: border-box; }

.dd-header { padding: 4px 2px 14px; }
.dd-title { font-size: 1.4rem; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
.dd-description { margin: 0 0 6px; color: var(--_fg); max-width: 80ch; }
.dd-comment { margin: 0 0 6px; color: var(--_muted); font-size: .92em; max-width: 80ch; }

.dd-toolbar {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  margin: 14px 0 6px;
}
.dd-search { position: relative; flex: 1 1 320px; min-width: 220px; }
.dd-search-input {
  width: 100%; font: inherit; color: inherit;
  padding: 9px 12px 9px 34px;
  border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_surface) var(--dd-search-icon, none);
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.dd-search::before {
  content: ""; position: absolute; left: 11px; top: 50%; width: 14px; height: 14px;
  transform: translateY(-50%); opacity: .5;
  background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23808a99' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
}
.dd-search-input:focus { border-color: var(--_accent); box-shadow: 0 0 0 3px var(--_accent-weak); }
.dd-count { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: .8em; color: var(--_muted); pointer-events: none; }

.dd-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dd-btn {
  font: inherit; font-size: .86em; color: var(--_fg);
  padding: 7px 11px; border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_surface); cursor: pointer; transition: background .15s, border-color .15s;
}
.dd-btn:hover { border-color: var(--_accent); }
.dd-btn:active { background: var(--_accent-weak); }
.dd-btn:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }

.dd-panel {
  margin: 10px 0; border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_surface); padding: 0;
}
.dd-panel > summary {
  cursor: pointer; padding: 10px 14px; font-weight: 550; list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.dd-panel > summary::-webkit-details-marker { display: none; }
.dd-panel > summary::before { content: "▸"; color: var(--_muted); transition: transform .15s; }
.dd-panel[open] > summary::before { transform: rotate(90deg); }
.dd-panel-body { padding: 4px 14px 14px; }
.dd-rules-list { margin: 0; padding-left: 18px; }
.dd-rules-list li { margin: 4px 0; }
.dd-rule-cond { font-family: var(--_mono); font-size: .88em; color: var(--_sentinel); }
.dd-rule-effects { color: var(--_muted); font-size: .9em; }

.dd-empty { padding: 22px 14px; color: var(--_muted); text-align: center; border: 1px dashed var(--_border); border-radius: var(--_radius); margin: 12px 0; }

.dd-category { margin: 16px 0; }
.dd-category-toggle {
  display: flex; align-items: center; gap: 9px; width: 100%;
  font: inherit; text-align: left; cursor: pointer;
  padding: 8px 4px; border: none; border-bottom: 2px solid var(--_border);
  background: transparent; color: inherit;
}
.dd-category-toggle:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
.dd-caret { color: var(--_muted); transition: transform .15s; font-size: .8em; }
.dd-category[data-collapsed="true"] .dd-caret { transform: rotate(-90deg); }
.dd-category-title { font-size: 1.07rem; font-weight: 600; }
.dd-category-count { margin-left: auto; font-size: .78em; color: var(--_muted); background: var(--_surface); padding: 2px 8px; border-radius: 999px; }
.dd-category-desc { margin: 6px 2px 10px; color: var(--_muted); max-width: 84ch; }
.dd-category[data-collapsed="true"] .dd-table-wrap, .dd-category[data-collapsed="true"] .dd-category-desc { display: none; }

.dd-table-wrap { overflow-x: auto; border: 1px solid var(--_border); border-radius: var(--_radius); box-shadow: var(--_shadow); }
.dd-table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 880px; }
.dd-table thead th {
  position: sticky; top: 0; z-index: 3;
  background: var(--_surface); color: var(--_muted);
  font-weight: 600; font-size: .76rem; text-transform: uppercase; letter-spacing: .04em;
  text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--_border); white-space: nowrap;
}
.dd-table tbody td, .dd-table tbody th { padding: 10px 12px; border-bottom: 1px solid var(--_border); vertical-align: top; text-align: left; font-weight: 400; }
.dd-table tbody tr:last-child td, .dd-table tbody tr:last-child th { border-bottom: none; }
.dd-table tbody tr:hover td, .dd-table tbody tr:hover th { background: color-mix(in srgb, var(--_accent-weak) 45%, transparent); }

.dd-col-name { position: sticky; left: 0; z-index: 2; background: var(--_bg); min-width: 12ch; }
.dd-table thead .dd-col-name { z-index: 4; background: var(--_surface); }
.dd-table tbody tr:hover .dd-col-name { background: color-mix(in srgb, var(--_accent-weak) 55%, var(--_bg)); }
.dd-col-name code { font-family: var(--_mono); font-weight: 600; font-size: .9em; word-break: break-word; }

.dd-desc { min-width: 18ch; max-width: 40ch; white-space: pre-line; }
.dd-format { color: var(--_muted); min-width: 14ch; }
.dd-values { min-width: 18ch; max-width: 36ch; }
.dd-constraints { min-width: 14ch; max-width: 32ch; }
.dd-additional { min-width: 10ch; }

.dd-badge { display: inline-block; font-family: var(--_mono); font-size: .82em; padding: 2px 8px; border-radius: 999px; background: var(--_accent-weak); color: var(--_accent); white-space: nowrap; }
.dd-badge[data-mixed="true"] { background: var(--_sentinel-bg); color: var(--_sentinel); }

.dd-vv { margin: 0; display: grid; gap: 3px; }
.dd-vv-row { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: baseline; }
.dd-vv-row dt { margin: 0; }
.dd-vv-row dd { margin: 0; color: var(--_muted); }
.dd-code { font-family: var(--_mono); font-size: .86em; padding: 1px 6px; border-radius: 6px; background: var(--_code-bg); white-space: nowrap; }
.dd-measure { color: var(--_fg); }
.dd-measure .dd-measure-label { font-family: var(--_mono); font-size: .9em; }
.dd-vv-sep { margin: 5px 0 2px; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--_sentinel); display: flex; align-items: center; gap: 6px; }
.dd-vv-sep::after { content: ""; flex: 1; height: 1px; background: var(--_border); }
.dd-sentinel .dd-code { background: var(--_sentinel-bg); color: var(--_sentinel); }
.dd-when { display: inline-block; font-size: .82em; color: var(--_sentinel); font-family: var(--_mono); }
.dd-when::before { content: "↳ when "; opacity: .8; }

.dd-constraints-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.dd-constraints-list li { display: flex; gap: 6px; align-items: baseline; }
.dd-constraints-list li::before { content: "•"; color: var(--_muted); }
.dd-conditional { color: var(--_sentinel); }
.dd-cond-badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; margin-left: 4px; }

.dd-tree { font-family: var(--_mono); font-size: .84em; }
.dd-tree details { margin: 0; }
.dd-tree summary { cursor: pointer; list-style: none; color: var(--_accent); }
.dd-tree summary::-webkit-details-marker { display: none; }
.dd-tree summary::before { content: "▸ "; color: var(--_muted); }
.dd-tree details[open] > summary::before { content: "▾ "; }
.dd-tree ul { list-style: none; margin: 0 0 0 14px; padding: 0; border-left: 1px solid var(--_border); padding-left: 10px; }
.dd-tree .dd-key { color: var(--_muted); }
.dd-tree .dd-str { color: var(--_accent); }
.dd-tree .dd-num { color: var(--_sentinel); }

.dd-muted { color: var(--_muted); }
mark.dd-hit { background: var(--_mark); color: inherit; border-radius: 3px; padding: 0 1px; }
.dd-footer { margin-top: 12px; font-size: .8em; color: var(--_muted); }
.dd-warning { color: var(--_sentinel); }

@media (max-width: 640px) {
  .dd-col-name { position: static; }
  .dd-table thead th { position: static; }
}
`;
