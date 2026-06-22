// Static, self-contained HTML string for the data dictionary: inline <style>, the shared
// markup, and an inline <script> that wires search/collapse/export. Suitable for SSR or
// writing to a file. For an interactive in-app mount, use renderDataDictionary instead.

import type { DataDictionaryTable, RenderHtmlOptions } from "../types";
import { slugify } from "../utils";
import { tableToCsv } from "../serialize";
import { buildViewModel } from "./viewModel";
import { buildMarkup } from "./markup";
import { STYLES } from "./styles";
import { inlineScript } from "./behavior";

export { STYLES } from "./styles";

let counter = 0;

/**
 * Render the table as a standalone, interactive HTML fragment (style + markup + script).
 * Wrap it in a full HTML document yourself, or drop it into an existing page.
 */
export function tableToHtml(table: DataDictionaryTable, options: RenderHtmlOptions = {}): string {
  const vm = buildViewModel(table, options);
  const id = `dd-${slugify(vm.title)}-${(counter += 1)}`;
  const csv = tableToCsv(table);
  const filename = `${slugify(vm.title)}.csv`;

  return [
    `<style>${STYLES}</style>`,
    `<div class="dd-embed" id="${id}">${buildMarkup(vm)}</div>`,
    `<script>${inlineScript(id, csv, filename)}</script>`
  ].join("\n");
}
