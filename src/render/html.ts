// Static, self-contained HTML string for the data dictionary: inline <style>, the shared
// markup, and an inline <script> that wires search/collapse/export. Suitable for SSR or
// writing to a file. For an interactive in-app mount, use renderDataDictionary instead.
// The page has to work offline, so the file its download button saves -- an Excel workbook
// by default -- is built here and embedded (base64).

import type { DataDictionaryTable, RenderHtmlOptions } from "../types";
import { bytesToBase64, slugify } from "../utils";
import { tableToCsv } from "../serialize";
import { tableToXlsx, XLSX_MEDIA_TYPE } from "../excel";
import { buildViewModel } from "./viewModel";
import { buildMarkup } from "./markup";
import { STYLES } from "./styles";
import { inlineScript } from "./behavior";
import type { EmbeddedFile } from "./behavior";

export { STYLES } from "./styles";

let counter = 0;

/**
 * Render the table as a standalone, interactive HTML fragment (style + markup + script).
 * Wrap it in a full HTML document yourself, or drop it into an existing page. Every row is
 * materialised (the inline script filters in place); the embedded exports are JSON with `<`
 * escaped, so a value can never close the `<script>`.
 */
export function tableToHtml(table: DataDictionaryTable, options: RenderHtmlOptions = {}): string {
  const vm = buildViewModel(table, options);
  const id = `dd-${slugify(vm.title)}-${(counter += 1)}`;
  const exporting = vm.options.includeExport;
  const csv = exporting ? tableToCsv(table) : "";
  let file: EmbeddedFile | null = null;
  if (exporting) {
    file =
      vm.options.exportFormat === "csv"
        ? { name: `${slugify(vm.title)}.csv`, type: "text/csv;charset=utf-8", text: `\uFEFF${csv}` } // the BOM tells Excel it is UTF-8
        : { name: `${slugify(vm.title)}.xlsx`, type: XLSX_MEDIA_TYPE, base64: bytesToBase64(tableToXlsx(table, { title: vm.title })) };
  }

  return [
    `<style>${STYLES}</style>`,
    `<div class="dd-embed" id="${id}">${buildMarkup(vm, "static")}</div>`,
    `<script>${inlineScript(id, csv, file, vm.options.columnWidths)}</script>`
  ].join("\n");
}
