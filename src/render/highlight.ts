// Query highlighting for rows rendered as HTML strings. Instead of walking the text nodes of
// a live row after the fact (slow at scale), a row is rendered with its highlights baked in:
// a highlighter turns raw text into HTML-escaped text with every term wrapped in
// `<mark class="dd-hit">`. One case-insensitive alternation per query (longest term first,
// so a phrase wins over its words) keeps that a single pass per cell.

import { escapeHtml } from "../utils";

/** Turns raw text into escaped HTML, wrapping query hits in `<mark class="dd-hit">`. */
export type Highlighter = (text: string) => string;

/** The no-highlight highlighter: plain HTML escaping. */
export const PLAIN: Highlighter = (text) => escapeHtml(text);

/** A highlighter for `terms` (matched case-insensitively). No terms: plain escaping. */
export function createHighlighter(terms: readonly string[]): Highlighter {
  const clean = uniqueLongestFirst(terms);
  if (clean.length === 0) return PLAIN;
  const re = new RegExp(clean.map(escapeRegExp).join("|"), "giu");
  return (text) => {
    re.lastIndex = 0;
    let m = re.exec(text);
    if (!m) return escapeHtml(text);
    let out = "";
    let last = 0;
    while (m) {
      if (m.index > last) out += escapeHtml(text.slice(last, m.index));
      out += `<mark class="dd-hit">${escapeHtml(m[0])}</mark>`;
      last = m.index + m[0].length;
      m = re.exec(text);
    }
    return last < text.length ? out + escapeHtml(text.slice(last)) : out;
  };
}

function uniqueLongestFirst(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Escape for `new RegExp(..., "u")`: only syntax characters may be escaped in unicode mode. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
