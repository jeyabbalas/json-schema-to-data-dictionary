// Excel workbook (.xlsx) writer: a small, dependency-free SpreadsheetML generator that runs the
// same in browsers and Node (it needs nothing beyond TextEncoder).
//
// `buildXlsx` turns a plain description of sheets, rows, cells and styles into the bytes of an
// Office Open XML package (ECMA-376). Every part is written in its schema's element order:
// Excel answers out-of-order elements with a "We found a problem with some content" repair
// prompt even where other readers are forgiving. Fonts, fills, borders, number formats, cell
// formats and strings are deduplicated. Strings are always shared strings (never inline strings
// or formulas), so a value such as "=SUM(A1)" stays text. All text is made XML-safe: line
// breaks are normalised to "\n", characters XML 1.0 forbids are dropped (C0 controls other than
// tab and line feed, U+FFFE, U+FFFF, unpaired surrogates) and a cell is capped at Excel's 32,767
// characters.
//
// The package is a ZIP archive whose parts are compressed by a built-in raw DEFLATE encoder
// (RFC 1951): LZ77 over a 32 KiB window with hash chains and lazy matching, then per block the
// smallest of a stored, fixed-Huffman or dynamic-Huffman encoding. The output is deterministic:
// the same input always gives the same bytes (fixed ZIP timestamps, no document dates unless
// asked for).

// --- Public types ---------------------------------------------------------------------------

/** "RRGGBB" or "AARRGGBB" hex colour (a leading "#" is accepted), e.g. "1F4E79". */
export type XlsxColor = string;

/** Font properties. Unset fields inherit: workbook default font < column < row < cell < run. */
export interface XlsxFont {
  bold?: boolean;
  italic?: boolean;
  /** Single underline. */
  underline?: boolean;
  strike?: boolean;
  /** Default: automatic (black). */
  color?: XlsxColor;
  /** points */
  size?: number;
  name?: string;
}

/**
 * One run of rich text: its font is merged over the cell's font (which is merged over the
 * workbook default font), and the run is written with a COMPLETE rPr so Excel never falls back
 * to unrelated defaults. Adjacent runs that end up with the same font are joined, and rich text
 * whose runs all have the cell's own font is written as a plain string.
 */
export interface XlsxRun {
  text: string;
  font?: XlsxFont;
}

/**
 * A cell value: a string (always a shared string, so "=SUM(A1)" stays text), a finite number,
 * a boolean, or rich text. `null`, `undefined`, "" and rich text without any text are empty
 * cells; NaN and ±Infinity are written as text.
 */
export type XlsxValue = string | number | boolean | null | undefined | XlsxRun[];

export type XlsxBorderStyle = "thin" | "medium" | "thick" | "hair" | "dotted" | "dashed";

export interface XlsxBorderEdge {
  style: XlsxBorderStyle;
  /** Default: automatic (black). */
  color?: XlsxColor;
}

export interface XlsxBorder {
  top?: XlsxBorderEdge;
  bottom?: XlsxBorderEdge;
  left?: XlsxBorderEdge;
  right?: XlsxBorderEdge;
}

export interface XlsxAlignment {
  horizontal?: "left" | "center" | "right";
  vertical?: "top" | "center" | "bottom";
  wrapText?: boolean;
  /**
   * Indent level (0–250, about three spaces each). Excel only indents left- or right-aligned
   * text: an indent without `horizontal` aligns left, and one with "center" is dropped.
   */
  indent?: number;
}

/** A cell format. Styles merge facet by facet: font fields, border edges and alignment fields individually. */
export interface XlsxStyle {
  font?: XlsxFont;
  /** solid fill */
  fill?: XlsxColor;
  border?: XlsxBorder;
  alignment?: XlsxAlignment;
  /** e.g. "0", "0.00", "@" */
  numberFormat?: string;
}

export interface XlsxCell {
  value: XlsxValue;
  style?: XlsxStyle;
}

export interface XlsxRow {
  /**
   * Cells left to right from column A. A bare value is a cell without its own style; `undefined`
   * is an empty cell (written only when its effective style is not the default, so a row
   * fill/border still paints it). The row style reaches only the cells listed here: pad with
   * `undefined` to paint a band across empty cells.
   */
  cells: Array<XlsxCell | XlsxValue>;
  /**
   * Default style for this row's cells. Effective cell style = merge(column.style, row.style,
   * cell.style), merged per facet (font fields individually, border edges individually,
   * alignment fields individually).
   */
  style?: XlsxStyle;
  /** points (0–409) */
  height?: number;
  /** 1–7: row grouping */
  outlineLevel?: number;
  hidden?: boolean;
}

export interface XlsxColumn {
  /** in characters, like Excel's column width (0–255) */
  width?: number;
  /** Also the format of the column's cells that are not written (e.g. typed in later). */
  style?: XlsxStyle;
  hidden?: boolean;
}

export interface XlsxSheet {
  /**
   * Sanitised by the writer: invalid characters []:*?/\ removed, trimmed, at most 31
   * characters, made unique (case-insensitive) within the workbook, never empty. Apostrophes
   * are also trimmed from both ends, and Excel's reserved name "History" gets a suffix.
   */
  name: string;
  columns?: XlsxColumn[];
  rows: XlsxRow[];
  /** Freeze the first `rows` rows and/or the first `columns` columns. */
  freeze?: { rows?: number; columns?: number };
  /** A1-style range, e.g. "A1:H266". Also writes the hidden _xlnm._FilterDatabase defined name. */
  autoFilter?: string;
  /**
   * A1-style ranges, e.g. ["A1:H1"]. Overlapping ranges throw; single cells are ignored. Only the
   * top-left cell's value shows: give the covered cells the same style (e.g. through the row
   * style) so fills and borders span the whole merge.
   */
  merges?: string[];
  /** Rows repeated at the top of each printed page, e.g. "1:1" -> _xlnm.Print_Titles. */
  printTitleRows?: string;
  page?: {
    orientation?: "portrait" | "landscape";
    /** fit all columns on one page width */
    fitToWidth?: boolean;
  };
  tabColor?: XlsxColor;
  /** default true */
  showGridLines?: boolean;
  /** percent (10–400) */
  zoom?: number;
  /**
   * Where the summary row of each row group sits: "below" the group (Excel's default) or
   * "above" it, e.g. a category heading followed by its grouped rows. Puts the group's
   * expand/collapse button on that row.
   */
  outlineSummary?: "above" | "below";
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  properties?: {
    title?: string;
    subject?: string;
    creator?: string;
    description?: string;
    keywords?: string;
    /** written as dcterms:created/modified; default: no dates are written (deterministic output) */
    created?: Date;
  };
  /** The workbook's Normal font. Default { name: "Calibri", size: 11 }. */
  defaultFont?: XlsxFont;
}

export interface XlsxOptions {
  /** DEFLATE-compress the parts (default true); false stores them uncompressed. */
  compress?: boolean;
}

/** The media type of an .xlsx file, e.g. for a download `Blob`. */
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// --- Public functions -----------------------------------------------------------------------

const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const MAX_CELL_TEXT = 32767;
const MAX_SHEET_NAME = 31;

/** 1 -> "A", 26 -> "Z", 27 -> "AA", 16384 -> "XFD". */
export function columnLetter(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > MAX_COLUMNS) {
    throw new RangeError(`columnLetter: expected a column number from 1 to ${MAX_COLUMNS}, got ${column}`);
  }
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** (1, 1) -> "A1" (1-based row, column) */
export function cellRef(row: number, column: number): string {
  if (!Number.isInteger(row) || row < 1 || row > MAX_ROWS) {
    throw new RangeError(`cellRef: expected a row number from 1 to ${MAX_ROWS}, got ${row}`);
  }
  return columnLetter(column) + row;
}

/**
 * Build an .xlsx workbook and return the file's bytes (for `new Blob([bytes], { type:
 * XLSX_MEDIA_TYPE })` or `fs.writeFileSync`). Throws a descriptive Error for a workbook without
 * sheets, a sheet with more than 1,048,576 rows or 16,384 columns, and malformed colours,
 * ranges or option values.
 */
export function buildXlsx(workbook: XlsxWorkbook, options: XlsxOptions = {}): Uint8Array {
  const sheets = workbook?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error("buildXlsx: the workbook has no sheets");
  const names = sheetNames(sheets);
  const styles = new StyleSheet(workbook.defaultFont);
  const strings = new SharedStrings(styles);

  const worksheets: Uint8Array[] = [];
  const filterNames: string[] = [];
  const titleNames: string[] = [];
  for (let i = 0; i < sheets.length; i += 1) {
    const name = names[i] as string;
    const part = worksheetPart(sheets[i] ?? { name, rows: [] }, i, name, styles, strings);
    worksheets.push(part.xml);
    // Defined names refer to the sheet by its quoted name: 'My sheet'!$A$1:$H$266.
    const target = escapeXml(`'${name.replace(/'/g, "''")}'!`);
    if (part.autoFilter) {
      filterNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${target}${rangeRef(part.autoFilter, true)}</definedName>`);
    }
    if (part.printTitles) {
      titleNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${target}$${part.printTitles[0]}:$${part.printTitles[1]}</definedName>`);
    }
  }

  return zip(
    [
      { name: "[Content_Types].xml", data: utf8(contentTypesXml(sheets.length)) },
      { name: "_rels/.rels", data: utf8(ROOT_RELS) },
      { name: "docProps/core.xml", data: utf8(corePropertiesXml(workbook.properties)) },
      { name: "docProps/app.xml", data: utf8(appPropertiesXml(names)) },
      { name: "xl/workbook.xml", data: utf8(workbookXml(names, filterNames.join("") + titleNames.join(""))) },
      { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRelsXml(sheets.length)) },
      { name: "xl/styles.xml", data: utf8(styles.xml()) },
      ...worksheets.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
      { name: "xl/sharedStrings.xml", data: strings.xml() }
    ],
    options.compress !== false
  );
}

/** @internal Raw DEFLATE, exported for the test suite only; `blockType` forces one block encoding. */
export function _deflateRaw(data: Uint8Array, options: { blockType?: "stored" | "fixed" | "dynamic" } = {}): Uint8Array {
  return deflateRaw(data, options.blockType);
}

// --- Package parts --------------------------------------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_TYPE = "application/vnd.openxmlformats-officedocument";

const ROOT_RELS =
  XML_HEADER +
  `<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${NS_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${NS_RELATIONSHIPS}/extended-properties" Target="docProps/app.xml"/>` +
  "</Relationships>";

function contentTypesXml(sheetCount: number): string {
  let sheets = "";
  for (let i = 1; i <= sheetCount; i += 1) {
    sheets += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="${OFFICE_TYPE}.spreadsheetml.worksheet+xml"/>`;
  }
  return (
    XML_HEADER +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${OFFICE_TYPE}.spreadsheetml.sheet.main+xml"/>` +
    sheets +
    `<Override PartName="/xl/styles.xml" ContentType="${OFFICE_TYPE}.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${OFFICE_TYPE}.spreadsheetml.sharedStrings+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    `<Override PartName="/docProps/app.xml" ContentType="${OFFICE_TYPE}.extended-properties+xml"/>` +
    "</Types>"
  );
}

function workbookRelsXml(sheetCount: number): string {
  let rels = "";
  for (let i = 1; i <= sheetCount; i += 1) {
    rels += `<Relationship Id="rId${i}" Type="${NS_RELATIONSHIPS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  rels += `<Relationship Id="rId${sheetCount + 1}" Type="${NS_RELATIONSHIPS}/styles" Target="styles.xml"/>`;
  rels += `<Relationship Id="rId${sheetCount + 2}" Type="${NS_RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>`;
  return `${XML_HEADER}<Relationships xmlns="${NS_PACKAGE_RELATIONSHIPS}">${rels}</Relationships>`;
}

// CT_Workbook order: workbookPr, bookViews, sheets, definedNames, calcPr. A current calcId keeps
// Excel from recalculating on open (and then asking to save an unchanged file).
function workbookXml(names: string[], definedNames: string): string {
  const sheets = names.map((name, i) => `<sheet name="${escapeAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  return (
    XML_HEADER +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_RELATIONSHIPS}">` +
    '<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews>' +
    `<sheets>${sheets}</sheets>` +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : "") +
    '<calcPr calcId="191029"/></workbook>'
  );
}

function corePropertiesXml(properties: XlsxWorkbook["properties"]): string {
  const p = properties ?? {};
  let body = "";
  const add = (tag: string, value: unknown): void => {
    const text = value === undefined || value === null ? "" : cleanText(String(value));
    if (text) body += `<${tag}>${escapeXml(text)}</${tag}>`;
  };
  add("dc:title", p.title);
  add("dc:subject", p.subject);
  add("dc:creator", p.creator);
  add("cp:keywords", p.keywords);
  add("dc:description", p.description);
  if (p.created instanceof Date && !Number.isNaN(p.created.getTime())) {
    const when = p.created.toISOString().replace(/\.\d{3}Z$/, "Z");
    body += `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>`;
    body += `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>`;
  }
  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `${body}</cp:coreProperties>`
  );
}

function appPropertiesXml(names: string[]): string {
  const titles = names.map((name) => `<vt:lpstr>${escapeXml(name)}</vt:lpstr>`).join("");
  return (
    XML_HEADER +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>" +
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>' +
    `<vt:variant><vt:i4>${names.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
    `<TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>` +
    "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>" +
    "<AppVersion>16.0300</AppVersion></Properties>"
  );
}

// --- Worksheets -----------------------------------------------------------------------------

/** Width Excel gives a column of the default 11-point font (8.43 characters plus padding). */
const DEFAULT_COLUMN_WIDTH = 9.140625;

interface WorksheetPart {
  xml: Uint8Array;
  autoFilter: CellRange | undefined;
  printTitles: [number, number] | undefined;
}

// CT_Worksheet order: sheetPr, dimension, sheetViews, sheetFormatPr, cols, sheetData, autoFilter,
// mergeCells, pageMargins, pageSetup. The dimension depends on the cells written, so the rows
// are rendered first and the head is put in front of them afterwards.
function worksheetPart(sheet: XlsxSheet, index: number, name: string, styles: StyleSheet, strings: SharedStrings): WorksheetPart {
  const where = `buildXlsx: sheet "${name}"`;
  const rows = sheet.rows ?? [];
  const columns = sheet.columns ?? [];
  if (rows.length > MAX_ROWS) throw new Error(`${where} has ${rows.length} rows; Excel allows at most ${MAX_ROWS}`);
  if (columns.length > MAX_COLUMNS) throw new Error(`${where} has ${columns.length} columns; Excel allows at most ${MAX_COLUMNS}`);
  const autoFilter = sheet.autoFilter ? parseRange(sheet.autoFilter, `${where}: autoFilter`) : undefined;
  const merges = mergeRanges(sheet.merges ?? [], `${where}: merges`);
  const printTitles = sheet.printTitleRows ? parseRowRange(sheet.printTitleRows, `${where}: printTitleRows`) : undefined;
  const orientation = oneOf(sheet.page?.orientation, ["portrait", "landscape"], `${where}: page.orientation`);
  const fitToWidth = !!sheet.page?.fitToWidth;
  const outlineSummary = oneOf(sheet.outlineSummary, ["above", "below"], `${where}: outlineSummary`);
  const columnStyles = columns.map((column) => column?.style);

  let cols = "";
  columns.forEach((column, c) => {
    if (!column) return;
    const width = finite(column.width) ? num(clamp(column.width, 0, 255)) : undefined;
    const xf = column.style ? styles.xf(column.style, undefined, undefined) : 0;
    if (width === undefined && xf === 0 && !column.hidden) return;
    cols +=
      `<col min="${c + 1}" max="${c + 1}" width="${width ?? DEFAULT_COLUMN_WIDTH}"` +
      (xf ? ` style="${xf}"` : "") +
      (column.hidden ? ' hidden="1"' : "") +
      (width !== undefined ? ' customWidth="1"' : "") +
      "/>";
  });

  const body = new Utf8Writer();
  let minRow = 0;
  let maxRow = 0;
  let minColumn = MAX_COLUMNS;
  let maxColumn = 0;
  let maxOutline = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const cells = row.cells ?? [];
    if (cells.length > MAX_COLUMNS) {
      throw new Error(`${where}: row ${r + 1} has ${cells.length} cells; Excel allows at most ${MAX_COLUMNS} columns`);
    }
    const rowNumber = r + 1;
    let xml = "";
    for (let c = 0; c < cells.length; c += 1) {
      const entry = cells[c];
      let value: unknown = entry;
      let style: XlsxStyle | undefined;
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        value = entry.value;
        style = entry.style;
      }
      const xf = styles.xf(columnStyles[c], row.style, style);
      const cell = cellXml(letter(c) + rowNumber, xf, value, styles, strings);
      if (!cell) continue;
      xml += cell;
      if (minRow === 0) minRow = rowNumber;
      maxRow = rowNumber;
      if (c < minColumn) minColumn = c;
      if (c > maxColumn) maxColumn = c;
    }
    let attrs = "";
    if (finite(row.height)) attrs += ` ht="${num(clamp(row.height, 0, 409))}" customHeight="1"`;
    if (row.hidden) attrs += ' hidden="1"';
    const outline = clampInt(row.outlineLevel, 0, 7);
    if (outline > 0) {
      attrs += ` outlineLevel="${outline}"`;
      maxOutline = Math.max(maxOutline, outline);
    }
    if (xml) body.write(`<row r="${rowNumber}"${attrs}>${xml}</row>`);
    else if (attrs) body.write(`<row r="${rowNumber}"${attrs}/>`);
  }

  let sheetPr = "";
  if (sheet.tabColor) sheetPr += `<tabColor rgb="${argb(sheet.tabColor)}"/>`;
  if (outlineSummary === "above") sheetPr += '<outlinePr summaryBelow="0"/>';
  if (fitToWidth) sheetPr += '<pageSetUpPr fitToPage="1"/>';

  let view = "";
  if (sheet.showGridLines === false) view += ' showGridLines="0"';
  if (index === 0) view += ' tabSelected="1"';
  const zoom = finite(sheet.zoom) ? clampInt(sheet.zoom, 10, 400) : 100;
  if (zoom !== 100) view += ` zoomScale="${zoom}" zoomScaleNormal="${zoom}"`;
  const pane = frozenPaneXml(clampInt(sheet.freeze?.rows, 0, MAX_ROWS - 1), clampInt(sheet.freeze?.columns, 0, MAX_COLUMNS - 1));

  const used = minRow === 0 ? undefined : { r1: minRow, c1: minColumn + 1, r2: maxRow, c2: maxColumn + 1 };
  const head =
    XML_HEADER +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_RELATIONSHIPS}">` +
    (sheetPr ? `<sheetPr>${sheetPr}</sheetPr>` : "") +
    `<dimension ref="${used ? rangeRef(used) : "A1"}"/>` +
    `<sheetViews><sheetView${view} workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="${styles.defaultRowHeight}"${maxOutline ? ` outlineLevelRow="${maxOutline}"` : ""}/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    "<sheetData>";

  let tail = "</sheetData>";
  if (autoFilter) tail += `<autoFilter ref="${rangeRef(autoFilter)}"/>`;
  if (merges.length > 0) {
    tail += `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join("")}</mergeCells>`;
  }
  tail += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
  if (orientation || fitToWidth) {
    tail += `<pageSetup${orientation ? ` orientation="${orientation}"` : ""}${fitToWidth ? ' fitToWidth="1" fitToHeight="0"' : ""}/>`;
  }
  tail += "</worksheet>";

  return { xml: concatBytes([utf8(head), ...body.finish(), utf8(tail)]), autoFilter, printTitles };
}

/** One `<c>` element, or "" for an empty cell that needs no format of its own. */
function cellXml(ref: string, xf: number, value: unknown, styles: StyleSheet, strings: SharedStrings): string {
  const s = xf === 0 ? "" : ` s="${xf}"`;
  let index = -1;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (Array.isArray(value)) index = strings.rich(value as XlsxRun[], styles.fontOf(xf));
  else if (value !== null && value !== undefined) index = strings.plain(String(value));
  if (index >= 0) return `<c r="${ref}"${s} t="s"><v>${index}</v></c>`;
  return xf === 0 ? "" : `<c r="${ref}"${s}/>`;
}

// Frozen panes with the selections Excel itself writes for each layout: one per pane that
// scrolls, each on the first cell of its pane.
function frozenPaneXml(rows: number, columns: number): string {
  if (rows === 0 && columns === 0) return "";
  const topLeft = cellRef(rows + 1, columns + 1);
  const selection = (pane: string, cell: string): string => `<selection pane="${pane}" activeCell="${cell}" sqref="${cell}"/>`;
  if (rows > 0 && columns > 0) {
    return (
      `<pane xSplit="${columns}" ySplit="${rows}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>` +
      selection("topRight", cellRef(1, columns + 1)) +
      selection("bottomLeft", cellRef(rows + 1, 1)) +
      selection("bottomRight", topLeft)
    );
  }
  if (rows > 0) return `<pane ySplit="${rows}" topLeftCell="${topLeft}" activePane="bottomLeft" state="frozen"/>${selection("bottomLeft", topLeft)}`;
  return `<pane xSplit="${columns}" topLeftCell="${topLeft}" activePane="topRight" state="frozen"/>${selection("topRight", topLeft)}`;
}

/** Excel-safe, unique sheet names (see `XlsxSheet.name`). */
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>(["history"]); // Excel reserves "History" for change tracking
  return Array.from(sheets, (sheet, i) => {
    const raw = cleanText(String(sheet?.name ?? "")).replace(/[\u0000-\u001f[\]:*?/\\]/g, "");
    let base = trimSheetName(cutText(trimSheetName(raw), MAX_SHEET_NAME));
    if (!base) base = `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = trimSheetName(cutText(base, MAX_SHEET_NAME - suffix.length)) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** Excel rejects sheet names that begin or end with an apostrophe. */
function trimSheetName(name: string): string {
  return name.replace(/^[\s']+|[\s']+$/g, "");
}

// --- Cell ranges ----------------------------------------------------------------------------

interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

const letterCache: string[] = [];

/** Column letters for a 0-based column index. */
function letter(column: number): string {
  return letterCache[column] ?? (letterCache[column] = columnLetter(column + 1));
}

/** "A1:H266" (or "$A$1:$H$266"); a single cell is just "A1". */
function rangeRef(range: CellRange, absolute = false): string {
  const d = absolute ? "$" : "";
  const first = `${d}${letter(range.c1 - 1)}${d}${range.r1}`;
  if (range.r1 === range.r2 && range.c1 === range.c2) return first;
  return `${first}:${d}${letter(range.c2 - 1)}${d}${range.r2}`;
}

function parseRange(ref: string, what: string): CellRange {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(String(ref).trim());
  const c1 = m ? columnNumber(m[1] as string) : 0;
  const r1 = m ? Number(m[2]) : 0;
  const c2 = m && m[3] ? columnNumber(m[3]) : c1;
  const r2 = m && m[4] ? Number(m[4]) : r1;
  const valid = (r: number, c: number): boolean => r >= 1 && r <= MAX_ROWS && c >= 1 && c <= MAX_COLUMNS;
  if (!m || !valid(r1, c1) || !valid(r2, c2)) throw new Error(`${what}: "${ref}" is not an A1-style range such as "A1:H20"`);
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
}

function parseRowRange(ref: string, what: string): [number, number] {
  const m = /^\$?(\d{1,7})(?::\$?(\d{1,7}))?$/.exec(String(ref).trim());
  const first = m ? Number(m[1]) : 0;
  const last = m && m[2] ? Number(m[2]) : first;
  if (!m || first < 1 || last < 1 || first > MAX_ROWS || last > MAX_ROWS) throw new Error(`${what}: "${ref}" is not a row range such as "1:1"`);
  return [Math.min(first, last), Math.max(first, last)];
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** Parsed merge ranges: duplicates and single cells dropped; overlaps throw (Excel repairs them away). */
function mergeRanges(refs: string[], what: string): CellRange[] {
  const ranges: CellRange[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const range = parseRange(ref, what);
    const key = rangeRef(range);
    if ((range.r1 === range.r2 && range.c1 === range.c2) || seen.has(key)) continue;
    seen.add(key);
    ranges.push(range);
  }
  let open: CellRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1)) {
    open = open.filter((o) => o.r2 >= range.r1);
    const clash = open.find((o) => o.c1 <= range.c2 && range.c1 <= o.c2);
    if (clash) throw new Error(`${what}: ranges ${rangeRef(clash)} and ${rangeRef(range)} overlap`);
    open.push(range);
  }
  return ranges;
}

// --- Styles ---------------------------------------------------------------------------------

/** A font with every property resolved. */
interface FontSpec {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
  /** ARGB, or undefined for automatic. */
  color: string | undefined;
  name: string;
}

const BORDER_STYLES = ["thin", "medium", "thick", "hair", "dotted", "dashed", "double", "mediumDashed", "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot"];
const BUILTIN_NUMBER_FORMATS: ReadonlyArray<readonly [string, number]> = [
  ["General", 0],
  ["0", 1],
  ["0.00", 2],
  ["#,##0", 3],
  ["#,##0.00", 4],
  ["0%", 9],
  ["0.00%", 10],
  ["0.00E+00", 11],
  ["# ?/?", 12],
  ["# ??/??", 13],
  ["@", 49]
];
/** Entries kept per identity cache map, so fresh style objects per cell cannot grow it without bound. */
const CACHE_LIMIT = 4096;

/** `map.get(key)`, or else `make()`, remembered while the map holds fewer than CACHE_LIMIT entries. */
function memo<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    if (map.size < CACHE_LIMIT) map.set(key, value);
  }
  return value;
}

/** An append-only list of XML snippets that hands out one index per distinct snippet. */
class Pool {
  readonly items: string[] = [];
  private readonly index = new Map<string, number>();

  add(xml: string): number {
    let i = this.index.get(xml);
    if (i === undefined) {
      i = this.items.length;
      this.items.push(xml);
      this.index.set(xml, i);
    }
    return i;
  }
}

/** The styles part: deduplicated fonts, fills, borders, number formats and cell formats (xfs). */
class StyleSheet {
  readonly defaultFont: FontSpec;
  /** points; Excel recomputes it from the default font anyway */
  readonly defaultRowHeight: number;
  private readonly fonts = new Pool();
  private readonly fills = new Pool();
  private readonly borders = new Pool();
  private readonly xfs = new Pool();
  private readonly numberFormats = new Map<string, number>();
  /** The resolved font of each xf, for rich text in cells of that format. */
  private readonly xfFonts: FontSpec[] = [];
  private readonly xfCache = new Map<XlsxStyle | undefined, Map<XlsxStyle | undefined, Map<XlsxStyle | undefined, number>>>();
  private readonly runCache = new Map<FontSpec, Map<XlsxFont | undefined, string>>();

  constructor(font: XlsxFont | undefined) {
    const base: FontSpec = { bold: false, italic: false, underline: false, strike: false, size: 11, color: undefined, name: "Calibri" };
    this.defaultFont = mergeFont(base, font);
    this.defaultRowHeight = Math.round(((this.defaultFont.size * 15) / 11) * 4) / 4;
    // Mandatory first entries: font 0 is the Normal font, fills 0 and 1 are reserved by Excel
    // (none and gray125), border 0 is no border, and xf 0 is the default cell format.
    this.fonts.add(fontXml(this.defaultFont));
    this.fills.add('<fill><patternFill patternType="none"/></fill>');
    this.fills.add('<fill><patternFill patternType="gray125"/></fill>');
    this.borders.add("<border><left/><right/><top/><bottom/><diagonal/></border>");
    this.xfs.add('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
    this.xfFonts.push(this.defaultFont);
  }

  /** The cell format index for a cell's column, row and cell styles (merged in that order). */
  xf(column: XlsxStyle | undefined, row: XlsxStyle | undefined, cell: XlsxStyle | undefined): number {
    const byRow = memo(this.xfCache, column, () => new Map<XlsxStyle | undefined, Map<XlsxStyle | undefined, number>>());
    const byCell = memo(byRow, row, () => new Map<XlsxStyle | undefined, number>());
    return memo(byCell, cell, () => this.register([column, row, cell]));
  }

  fontOf(xf: number): FontSpec {
    return this.xfFonts[xf] ?? this.defaultFont;
  }

  /** The complete `<rPr>` of a rich-text run: the run's font merged over the cell's font. */
  runProperties(cellFont: FontSpec, font: XlsxFont | undefined): string {
    const byFont = memo(this.runCache, cellFont, () => new Map<XlsxFont | undefined, string>());
    return memo(byFont, font, () => {
      const f = mergeFont(cellFont, font);
      return `<rPr>${fontFlags(f)}<sz val="${f.size}"/>${f.color ? `<color rgb="${f.color}"/>` : ""}<rFont val="${escapeAttr(f.name)}"/></rPr>`;
    });
  }

  // CT_Stylesheet order: numFmts, fonts, fills, borders, cellStyleXfs, cellXfs, cellStyles, dxfs, tableStyles.
  xml(): string {
    const list = (tag: string, items: string[]): string => `<${tag} count="${items.length}">${items.join("")}</${tag}>`;
    const numFmts = [...this.numberFormats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeAttr(code)}"/>`);
    return (
      XML_HEADER +
      `<styleSheet xmlns="${NS_MAIN}">` +
      (numFmts.length > 0 ? list("numFmts", numFmts) : "") +
      list("fonts", this.fonts.items) +
      list("fills", this.fills.items) +
      list("borders", this.borders.items) +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      list("cellXfs", this.xfs.items) +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      "</styleSheet>"
    );
  }

  private register(layers: Array<XlsxStyle | undefined>): number {
    let font = this.defaultFont;
    let fill: XlsxColor | undefined;
    let numberFormat: string | undefined;
    const border: XlsxBorder = {};
    const alignment: XlsxAlignment = {};
    for (const style of layers) {
      if (!style) continue;
      font = mergeFont(font, style.font);
      if (style.fill !== undefined) fill = style.fill;
      if (style.numberFormat !== undefined) numberFormat = style.numberFormat;
      const b = style.border;
      if (b) {
        if (b.left) border.left = b.left;
        if (b.right) border.right = b.right;
        if (b.top) border.top = b.top;
        if (b.bottom) border.bottom = b.bottom;
      }
      const a = style.alignment;
      if (a) {
        if (a.horizontal !== undefined) alignment.horizontal = a.horizontal;
        if (a.vertical !== undefined) alignment.vertical = a.vertical;
        if (a.wrapText !== undefined) alignment.wrapText = a.wrapText;
        if (a.indent !== undefined) alignment.indent = a.indent;
      }
    }
    const fontId = this.fonts.add(fontXml(font));
    const fillId = fill ? this.fills.add(`<fill><patternFill patternType="solid"><fgColor rgb="${argb(fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderXmlText = borderXml(border);
    const borderId = borderXmlText ? this.borders.add(borderXmlText) : 0;
    const numFmtId = numberFormat ? this.numberFormatId(numberFormat) : 0;
    const align = alignmentXml(alignment);
    let attrs = `numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`;
    if (numFmtId) attrs += ' applyNumberFormat="1"';
    if (fontId) attrs += ' applyFont="1"';
    if (fillId) attrs += ' applyFill="1"';
    if (borderId) attrs += ' applyBorder="1"';
    const xf = this.xfs.add(align ? `<xf ${attrs} applyAlignment="1">${align}</xf>` : `<xf ${attrs}/>`);
    this.xfFonts[xf] ??= font;
    return xf;
  }

  /** Built-in format ids for the common codes; custom codes get ids from 164 up. */
  private numberFormatId(code: string): number {
    const text = cleanText(String(code));
    if (!text) return 0;
    const builtin = BUILTIN_NUMBER_FORMATS.find(([c]) => c === text);
    if (builtin) return builtin[1];
    let id = this.numberFormats.get(text);
    if (id === undefined) {
      id = 164 + this.numberFormats.size;
      this.numberFormats.set(text, id);
    }
    return id;
  }
}

function mergeFont(base: FontSpec, font: XlsxFont | undefined): FontSpec {
  if (!font) return base;
  return {
    bold: font.bold ?? base.bold,
    italic: font.italic ?? base.italic,
    underline: font.underline ?? base.underline,
    strike: font.strike ?? base.strike,
    size: fontSize(font.size) ?? base.size,
    color: font.color ? argb(font.color) : base.color,
    name: fontName(font.name) ?? base.name
  };
}

function fontSize(size: unknown): number | undefined {
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? clamp(Math.round(size * 100) / 100, 1, 409) : undefined;
}

/** Font names are limited to 31 characters (Windows' LF_FACESIZE). */
function fontName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const text = cutText(cleanText(name).replace(/[\u0000-\u001f]/g, "").trim(), 31).trim();
  return text || undefined;
}

// CT_Font and CT_RPrElt are unordered choices; this is the order Excel writes.
function fontFlags(f: FontSpec): string {
  return (f.bold ? "<b/>" : "") + (f.italic ? "<i/>" : "") + (f.strike ? "<strike/>" : "") + (f.underline ? "<u/>" : "");
}

function fontXml(f: FontSpec): string {
  return `<font>${fontFlags(f)}<sz val="${f.size}"/>${f.color ? `<color rgb="${f.color}"/>` : ""}<name val="${escapeAttr(f.name)}"/></font>`;
}

// CT_Border order: left, right, top, bottom, diagonal.
function borderXml(border: XlsxBorder): string {
  if (!border.left && !border.right && !border.top && !border.bottom) return "";
  const edge = (tag: string, e: XlsxBorderEdge | undefined): string => {
    if (!e) return `<${tag}/>`;
    const style = oneOf(e.style, BORDER_STYLES, "buildXlsx: border style") ?? "thin";
    return e.color ? `<${tag} style="${style}"><color rgb="${argb(e.color)}"/></${tag}>` : `<${tag} style="${style}"/>`;
  };
  return `<border>${edge("left", border.left)}${edge("right", border.right)}${edge("top", border.top)}${edge("bottom", border.bottom)}<diagonal/></border>`;
}

function alignmentXml(a: XlsxAlignment): string {
  let horizontal = oneOf(a.horizontal, ["left", "center", "right"], "buildXlsx: alignment.horizontal");
  const vertical = oneOf(a.vertical, ["top", "center", "bottom"], "buildXlsx: alignment.vertical");
  let indent = clampInt(a.indent, 0, 250);
  if (indent > 0 && horizontal === undefined) horizontal = "left";
  if (horizontal === "center") indent = 0;
  let attrs = "";
  if (horizontal) attrs += ` horizontal="${horizontal}"`;
  if (vertical) attrs += ` vertical="${vertical}"`;
  if (a.wrapText) attrs += ' wrapText="1"';
  if (indent > 0) attrs += ` indent="${indent}"`;
  return attrs ? `<alignment${attrs}/>` : "";
}

/** "RRGGBB" / "AARRGGBB" (optionally with "#") -> upper-case ARGB. */
function argb(color: XlsxColor): string {
  const hex = String(color).trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-f]{8}$/i.test(hex)) return hex.toUpperCase();
  throw new Error(`buildXlsx: invalid colour ${JSON.stringify(color)}; expected "RRGGBB" or "AARRGGBB" hex`);
}

function oneOf<T extends string>(value: T | undefined, allowed: readonly string[], what: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value)) throw new Error(`${what}: ${JSON.stringify(value)} is not one of ${allowed.join(", ")}`);
  return value;
}

// --- Shared strings -------------------------------------------------------------------------

/** The shared string table: every distinct plain string and rich text value, once. */
class SharedStrings {
  /** The content of each `<si>`. */
  private readonly items: string[] = [];
  private readonly plainIndex = new Map<string, number>();
  private readonly richIndex = new Map<string, number>();
  /** String cells written (`count`; `uniqueCount` is the number of items). */
  private count = 0;

  constructor(private readonly styles: StyleSheet) {}

  /** The index of a plain string, or -1 when it is empty. */
  plain(value: string): number {
    const text = capText(cleanText(value));
    if (!text) return -1;
    this.count += 1;
    let i = this.plainIndex.get(text);
    if (i === undefined) {
      i = this.items.length;
      this.items.push(/^\s|\s$|[\n\t]/.test(text) ? `<t xml:space="preserve">${escapeXml(text)}</t>` : `<t>${escapeXml(text)}</t>`);
      this.plainIndex.set(text, i);
    }
    return i;
  }

  /** The index of a rich text value in a cell with font `cellFont`, or -1 when it has no text. */
  rich(runs: XlsxRun[], cellFont: FontSpec): number {
    const texts = runs.map((run) => (run && run.text !== undefined && run.text !== null ? cleanText(String(run.text)) : ""));
    const total = texts.reduce((sum, text) => sum + text.length, 0);
    if (total === 0) return -1;
    // Over Excel's limit, keep MAX_CELL_TEXT - 1 characters and end with "…".
    let budget = total > MAX_CELL_TEXT ? MAX_CELL_TEXT - 1 : Infinity;
    const cellRPr = this.styles.runProperties(cellFont, undefined);
    let xml = "";
    let plain = "";
    let ownFontOnly = true;
    let rPr = "";
    let text = "";
    for (let i = 0; i < runs.length && budget >= 0; i += 1) {
      let part = texts[i] as string;
      if (!part) continue;
      if (part.length > budget) {
        part = `${cutText(part, budget)}…`;
        budget = -1;
      } else {
        budget -= part.length;
      }
      const runRPr = this.styles.runProperties(cellFont, runs[i]?.font);
      if (runRPr !== cellRPr) ownFontOnly = false;
      plain += part;
      if (runRPr === rPr) {
        text += part;
        continue;
      }
      if (text) xml += `<r>${rPr}<t xml:space="preserve">${escapeXml(text)}</t></r>`;
      rPr = runRPr;
      text = part;
    }
    if (ownFontOnly) return this.plain(plain);
    xml += `<r>${rPr}<t xml:space="preserve">${escapeXml(text)}</t></r>`;
    this.count += 1;
    let i = this.richIndex.get(xml);
    if (i === undefined) {
      i = this.items.length;
      this.items.push(xml);
      this.richIndex.set(xml, i);
    }
    return i;
  }

  xml(): Uint8Array {
    const out = new Utf8Writer();
    out.write(`${XML_HEADER}<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${this.items.length}">`);
    for (const item of this.items) out.write(`<si>${item}</si>`);
    out.write("</sst>");
    return concatBytes(out.finish());
  }
}

// --- Text -----------------------------------------------------------------------------------

const NEEDS_CLEANING = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\r\ud800-\udfff\ufffe\uffff]/;

/** Normalise line breaks to "\n" and drop what XML 1.0 forbids: control characters, U+FFFE/U+FFFF, unpaired surrogates. */
function cleanText(text: string): string {
  if (!NEEDS_CLEANING.test(text)) return text;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/** Cap a cell's text at Excel's 32,767 characters, ending a truncated text with "…". */
function capText(text: string): string {
  return text.length > MAX_CELL_TEXT ? `${cutText(text, MAX_CELL_TEXT - 1)}…` : text;
}

/** The first `length` UTF-16 units of `text`, without splitting a surrogate pair. */
function cutText(text: string, length: number): string {
  if (text.length <= length) return text;
  const end = length > 0 && /[\ud800-\udbff]/.test(text.charAt(length - 1)) ? length - 1 : length;
  return text.slice(0, end);
}

function escapeXml(text: string): string {
  if (!/[&<>"]/.test(text)) return text;
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Attribute values also keep tabs and line breaks, which XML parsers would turn into spaces. */
function escapeAttr(text: string): string {
  return escapeXml(text).replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

let encoder: TextEncoder | undefined;

function utf8(text: string): Uint8Array {
  return (encoder ??= new TextEncoder()).encode(text);
}

/** Collects a large document as UTF-8 chunks, so no single string grows without bound. */
class Utf8Writer {
  private readonly chunks: Uint8Array[] = [];
  private pending = "";

  write(text: string): void {
    this.pending += text;
    if (this.pending.length >= 1 << 20) this.flush();
  }

  finish(): Uint8Array[] {
    this.flush();
    return this.chunks;
  }

  private flush(): void {
    if (!this.pending) return;
    this.chunks.push(utf8(this.pending));
    this.pending = "";
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: unknown, min: number, max: number): number {
  return finite(value) ? clamp(Math.round(value), min, max) : min;
}

/** A number for an attribute, rounded to 4 decimals. */
function num(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// --- ZIP ------------------------------------------------------------------------------------

interface ZipPart {
  name: string;
  data: Uint8Array;
}

// 1980-01-01 00:00, the earliest DOS date: a fixed timestamp keeps the output deterministic.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A ZIP archive (no ZIP64): local headers and data, then the central directory and its end record. */
function zip(parts: ZipPart[], compress: boolean): Uint8Array {
  const entries = parts.map((part) => {
    const packed = compress && part.data.length > 0 ? deflateRaw(part.data) : undefined;
    const deflated = packed !== undefined && packed.length < part.data.length;
    return { name: utf8(part.name), crc: crc32(part.data), size: part.data.length, body: deflated ? packed : part.data, method: deflated ? 8 : 0 };
  });
  let total = 22;
  for (const e of entries) total += 30 + 46 + 2 * e.name.length + e.body.length;
  if (total > 0xffffffff || entries.length > 0xffff) throw new Error("buildXlsx: the workbook is too large for a ZIP archive (over 4 GiB)");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  // Fields shared by the local header (at +4) and the central directory header (at +6).
  const common = (pos: number, e: (typeof entries)[number]): void => {
    view.setUint16(pos, 20, true); // version needed to extract: 2.0 (deflate)
    view.setUint16(pos + 2, 0, true); // flags
    view.setUint16(pos + 4, e.method, true);
    view.setUint16(pos + 6, DOS_TIME, true);
    view.setUint16(pos + 8, DOS_DATE, true);
    view.setUint32(pos + 10, e.crc, true);
    view.setUint32(pos + 14, e.body.length, true);
    view.setUint32(pos + 18, e.size, true);
    view.setUint16(pos + 22, e.name.length, true);
    view.setUint16(pos + 24, 0, true); // extra field length
  };
  for (const e of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    common(at + 4, e);
    out.set(e.name, at + 30);
    out.set(e.body, at + 30 + e.name.length);
    at += 30 + e.name.length + e.body.length;
  }
  const directory = at;
  entries.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by: 2.0, MS-DOS attributes
    common(at + 6, e);
    // comment length, disk number, internal and external attributes stay 0
    view.setUint32(at + 42, offsets[i] as number, true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

let crcTable: Int32Array | undefined;

function crc32(data: Uint8Array): number {
  let table = crcTable;
  if (!table) {
    table = crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < data.length; i += 1) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

// --- DEFLATE (RFC 1951) ---------------------------------------------------------------------

type BlockType = "stored" | "fixed" | "dynamic";

const WINDOW_SIZE = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
/** Chain links cover two windows, so a link reachable from the current window is never overwritten. */
const LINK_MASK = 0xffff;
// zlib's level-6 tuning: follow up to 128 earlier occurrences per search (a quarter of that
// once an 8-byte match is pending), stop at a 128-byte match, and take a 16-byte match without
// looking one byte further for a longer one.
const MAX_CHAIN = 128;
const GOOD_MATCH = 8;
const LAZY_MATCH = 16;
const NICE_MATCH = 128;
/** A 3-byte match farther back than this costs more than three literals. */
const TOO_FAR = 4096;
/** Literals and matches per block; each block gets its own Huffman codes. */
const BLOCK_SYMBOLS = 16384;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order code length code lengths are sent in. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
/** Extra bits after code length symbols 16 (repeat 3–6×), 17 (3–10 zeros) and 18 (11–138 zeros). */
const RUN_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];

interface DeflateTables {
  /** Match length (3–258) -> length symbol (257–285). */
  lengthSymbol: Uint16Array;
  /** Match distance (1–32768) -> distance code (0–29). */
  distanceCode: Uint8Array;
  fixedLitLengths: Uint8Array;
  fixedLitCodes: Uint16Array;
  fixedDistLengths: Uint8Array;
  fixedDistCodes: Uint16Array;
}

let tables: DeflateTables | undefined;

function deflateTables(): DeflateTables {
  if (tables) return tables;
  const lengthSymbol = new Uint16Array(MAX_MATCH + 1);
  LENGTH_BASE.forEach((base, code) => {
    for (let k = 0; k < 1 << LENGTH_EXTRA[code]! && base + k <= MAX_MATCH; k += 1) lengthSymbol[base + k] = 257 + code;
  });
  lengthSymbol[MAX_MATCH] = 285; // 258 has a symbol of its own (284 with all extra bits set also spells it)
  const distanceCode = new Uint8Array(WINDOW_SIZE + 1);
  DIST_BASE.forEach((base, code) => distanceCode.fill(code, base, base + (1 << DIST_EXTRA[code]!)));
  const fixedLitLengths = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
  const fixedDistLengths = new Uint8Array(30).fill(5);
  tables = {
    lengthSymbol,
    distanceCode,
    fixedLitLengths,
    fixedLitCodes: canonicalCodes(fixedLitLengths),
    fixedDistLengths,
    fixedDistCodes: canonicalCodes(fixedDistLengths)
  };
  return tables;
}

/** The symbols of the block being collected, and the input bytes they cover. */
interface Block {
  /** A literal byte, or a match length. */
  values: Uint16Array;
  /** 0 for a literal, else the match distance. */
  distances: Uint16Array;
  size: number;
  litFreq: Uint32Array;
  distFreq: Uint32Array;
  start: number;
  end: number;
}

/** Raw DEFLATE: LZ77 with hash chains and lazy matching, then one Huffman-coded (or stored) block per BLOCK_SYMBOLS symbols. */
function deflateRaw(data: Uint8Array, force?: BlockType): Uint8Array {
  const { lengthSymbol, distanceCode } = deflateTables();
  const n = data.length;
  const out = new BitWriter((n >>> 2) + 1024);
  const block: Block = {
    values: new Uint16Array(BLOCK_SYMBOLS),
    distances: new Uint16Array(BLOCK_SYMBOLS),
    size: 0,
    litFreq: new Uint32Array(286),
    distFreq: new Uint32Array(30),
    start: 0,
    end: 0
  };
  const emit = (final: boolean): void => {
    writeBlock(out, data, block, final, force);
    block.size = 0;
    block.start = block.end;
    block.litFreq.fill(0);
    block.distFreq.fill(0);
  };
  const literal = (byte: number): void => {
    block.values[block.size] = byte;
    block.distances[block.size] = 0;
    block.litFreq[byte]! += 1;
    block.end += 1;
    block.size += 1;
    if (block.size === BLOCK_SYMBOLS) emit(false);
  };
  const match = (length: number, distance: number): void => {
    block.values[block.size] = length;
    block.distances[block.size] = distance;
    block.litFreq[lengthSymbol[length]!]! += 1;
    block.distFreq[distanceCode[distance]!]! += 1;
    block.end += length;
    block.size += 1;
    if (block.size === BLOCK_SYMBOLS) emit(false);
  };

  // head[hash of 3 bytes] = the latest position with that hash; links[p & LINK_MASK] = the
  // previous one before p. Chains run strictly backwards and stop at the window's edge.
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const links = new Int32Array(LINK_MASK + 1);
  const insert = (p: number): number => {
    const hash = Math.imul((data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!, 0x9e3779b1) >>> (32 - HASH_BITS);
    const previous = head[hash]!;
    head[hash] = p;
    links[p & LINK_MASK] = previous;
    return previous;
  };
  let matchDistance = 0;
  /** The length of the longest match at `p` longer than `atLeast` (its distance in `matchDistance`), or 0. */
  const longestMatch = (p: number, candidate: number, atLeast: number): number => {
    const maxLength = Math.min(MAX_MATCH, n - p);
    let best = Math.max(atLeast, MIN_MATCH - 1);
    if (best >= maxLength) return 0;
    const limit = p > WINDOW_SIZE ? p - WINDOW_SIZE : 0;
    let chain = atLeast >= GOOD_MATCH ? MAX_CHAIN >> 2 : MAX_CHAIN;
    let found = 0;
    for (let c = candidate; c >= limit && chain > 0; c = links[c & LINK_MASK]!, chain -= 1) {
      // Check the byte that would make this match the longest first: most candidates fail there.
      if (data[c + best] !== data[p + best] || data[c] !== data[p] || data[c + 1] !== data[p + 1]) continue;
      let length = 2;
      while (length < maxLength && data[c + length] === data[p + length]) length += 1;
      if (length > best) {
        best = found = length;
        matchDistance = p - c;
        if (length >= NICE_MATCH || length === maxLength) break;
      }
    }
    return found === MIN_MATCH && matchDistance > TOO_FAR ? 0 : found;
  };

  // Lazy matching (as zlib's deflate_slow): the match found at p - 1 is only emitted once p
  // turns out to have no longer one; otherwise p - 1 becomes a literal.
  let pending = false; // the byte at p - 1 is not emitted yet
  let pendingLength = 0; // ... and the match starting there (0: none)
  let pendingDistance = 0;
  let p = 0;
  while (p < n) {
    let length = 0;
    let distance = 0;
    if (p + MIN_MATCH <= n) {
      const candidate = insert(p);
      if (!pending || pendingLength < LAZY_MATCH) {
        length = longestMatch(p, candidate, pending ? pendingLength : 0);
        distance = matchDistance;
      }
    }
    if (pending && pendingLength >= MIN_MATCH && length === 0) {
      match(pendingLength, pendingDistance);
      const end = p - 1 + pendingLength;
      const last = Math.min(end, n - MIN_MATCH + 1);
      for (let q = p + 1; q < last; q += 1) insert(q);
      p = end;
      pending = false;
      continue;
    }
    if (pending) literal(data[p - 1]!);
    pending = true;
    pendingLength = length;
    pendingDistance = distance;
    p += 1;
  }
  if (pending) literal(data[n - 1]!);
  emit(true);
  return out.finish();
}

/** Encode one block as the smallest of stored, fixed Huffman and dynamic Huffman (or as `force`). */
function writeBlock(out: BitWriter, data: Uint8Array, block: Block, final: boolean, force: BlockType | undefined): void {
  const { fixedLitLengths, fixedLitCodes, fixedDistLengths, fixedDistCodes } = deflateTables();
  const { litFreq, distFreq } = block;
  litFreq[256] = 1; // end of block
  const litLengths = huffmanLengths(litFreq, 15);
  const distLengths = huffmanLengths(distFreq, 15);
  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit -= 1;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist -= 1;
  // The code lengths of both codes, run-length encoded tree by tree as zlib does, as
  // [symbol, extra bits value] pairs, then coded with a third Huffman code.
  const runs: number[] = [];
  pushLengthRuns(litLengths, hlit, runs);
  pushLengthRuns(distLengths, hdist, runs);
  const runFreq = new Uint32Array(19);
  for (let i = 0; i < runs.length; i += 2) runFreq[runs[i]!]! += 1;
  const runLengths = huffmanLengths(runFreq, 7);
  let hclen = 19;
  while (hclen > 4 && runLengths[CODE_LENGTH_ORDER[hclen - 1]!] === 0) hclen -= 1;

  // Exact sizes in bits of both Huffman encodings, and a bound for the stored one.
  let dynamicBits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (let i = 0; i < runs.length; i += 2) dynamicBits += runLengths[runs[i]!]! + RUN_EXTRA_BITS[runs[i]!]!;
  let fixedBits = 3;
  for (let s = 0; s < 286; s += 1) {
    const f = litFreq[s]!;
    if (f === 0) continue;
    const extra = s > 256 ? LENGTH_EXTRA[s - 257]! : 0;
    dynamicBits += f * (litLengths[s]! + extra);
    fixedBits += f * (fixedLitLengths[s]! + extra);
  }
  for (let d = 0; d < 30; d += 1) {
    const f = distFreq[d]!;
    if (f === 0) continue;
    dynamicBits += f * (distLengths[d]! + DIST_EXTRA[d]!);
    fixedBits += f * (5 + DIST_EXTRA[d]!);
  }
  const length = block.end - block.start;
  const storedBits = 8 * length + 40 * Math.max(1, Math.ceil(length / 65535));
  const type = force ?? (storedBits <= Math.min(fixedBits, dynamicBits) ? "stored" : fixedBits <= dynamicBits ? "fixed" : "dynamic");

  out.reserve(length + 6 * block.size + 1024);
  if (type === "stored") {
    // At most 65,535 bytes per stored block: header bits, pad to a byte, LEN, NLEN, the bytes.
    let offset = block.start;
    do {
      const size = Math.min(65535, block.end - offset);
      out.bits(final && offset + size === block.end ? 1 : 0, 3);
      out.alignToByte();
      out.bits(size, 16);
      out.bits(size ^ 0xffff, 16);
      out.copy(data, offset, size);
      offset += size;
    } while (offset < block.end);
  } else if (type === "fixed") {
    out.bits(final ? 3 : 2, 3); // BFINAL, BTYPE = 01
    writeSymbols(out, block, fixedLitCodes, fixedLitLengths, fixedDistCodes, fixedDistLengths);
  } else {
    out.bits(final ? 5 : 4, 3); // BFINAL, BTYPE = 10
    out.bits(hlit - 257, 5);
    out.bits(hdist - 1, 5);
    out.bits(hclen - 4, 4);
    for (let i = 0; i < hclen; i += 1) out.bits(runLengths[CODE_LENGTH_ORDER[i]!]!, 3);
    const runCodes = canonicalCodes(runLengths);
    for (let i = 0; i < runs.length; i += 2) {
      const symbol = runs[i]!;
      out.bits(runCodes[symbol]!, runLengths[symbol]!);
      if (symbol >= 16) out.bits(runs[i + 1]!, RUN_EXTRA_BITS[symbol]!);
    }
    writeSymbols(out, block, canonicalCodes(litLengths), litLengths, canonicalCodes(distLengths), distLengths);
  }
}

function writeSymbols(out: BitWriter, block: Block, litCodes: Uint16Array, litLengths: Uint8Array, distCodes: Uint16Array, distLengths: Uint8Array): void {
  const { lengthSymbol, distanceCode } = deflateTables();
  const { values, distances } = block;
  for (let i = 0; i < block.size; i += 1) {
    const value = values[i]!;
    const distance = distances[i]!;
    if (distance === 0) {
      out.bits(litCodes[value]!, litLengths[value]!);
      continue;
    }
    const symbol = lengthSymbol[value]!;
    out.bits(litCodes[symbol]!, litLengths[symbol]!);
    const lengthExtra = LENGTH_EXTRA[symbol - 257]!;
    if (lengthExtra) out.bits(value - LENGTH_BASE[symbol - 257]!, lengthExtra);
    const code = distanceCode[distance]!;
    out.bits(distCodes[code]!, distLengths[code]!);
    const distExtra = DIST_EXTRA[code]!;
    if (distExtra) out.bits(distance - DIST_BASE[code]!, distExtra);
  }
  out.bits(litCodes[256]!, litLengths[256]!);
}

/**
 * Huffman code lengths of at most `maxBits` for symbol frequencies. Every code returned is
 * complete with at least two symbols (zlib's inflate rejects some incomplete codes), so an
 * unused symbol is added when fewer than two occur.
 */
function huffmanLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const lengths = new Uint8Array(freq.length);
  const symbols: number[] = [];
  for (let s = 0; s < freq.length; s += 1) if (freq[s]) symbols.push(s);
  if (symbols.length < 2) {
    const used = symbols[0] ?? 0;
    lengths[used] = 1;
    lengths[used === 0 ? 1 : 0] = 1;
    return lengths;
  }
  symbols.sort((a, b) => freq[a]! - freq[b]! || a - b);
  const m = symbols.length;

  // Two-queue construction: leaves 0..m-1 in frequency order, internal nodes m..2m-2 in the
  // order they are made (their weights never decrease), each joining the two lightest nodes.
  const weight = new Float64Array(2 * m - 1);
  const parent = new Int32Array(2 * m - 1);
  for (let i = 0; i < m; i += 1) weight[i] = freq[symbols[i]!]!;
  let leaf = 0;
  let inner = m;
  for (let node = m; node < 2 * m - 1; node += 1) {
    for (let k = 0; k < 2; k += 1) {
      let child: number;
      if (leaf < m && (inner === node || weight[leaf]! <= weight[inner]!)) child = leaf++;
      else child = inner++;
      weight[node]! += weight[child]!;
      parent[child] = node;
    }
  }
  const depth = new Int32Array(2 * m - 1); // the root, node 2m-2, has depth 0
  for (let node = 2 * m - 3; node >= 0; node -= 1) depth[node] = depth[parent[node]!]! + 1;
  let maxDepth = 0;
  for (let i = 0; i < m; i += 1) maxDepth = Math.max(maxDepth, depth[i]!);
  const count = new Int32Array(Math.max(maxDepth, maxBits) + 1);
  for (let i = 0; i < m; i += 1) count[depth[i]!]! += 1;

  if (maxDepth > maxBits) {
    // Length-limit as miniz does: put the overlong codes at maxBits, which oversubscribes the
    // code; then, until Kraft's sum is exactly 1 again, take one code off maxBits and split the
    // longest shorter code into two one bit longer (each round lowers the sum by 2^-maxBits).
    for (let d = maxBits + 1; d <= maxDepth; d += 1) {
      count[maxBits]! += count[d]!;
      count[d] = 0;
    }
    let total = 0;
    for (let d = 1; d <= maxBits; d += 1) total += count[d]! * 2 ** (maxBits - d);
    for (; total > 2 ** maxBits; total -= 1) {
      count[maxBits]! -= 1;
      for (let d = maxBits - 1; d > 0; d -= 1) {
        if (count[d]! > 0) {
          count[d]! -= 1;
          count[d + 1]! += 2;
          break;
        }
      }
    }
  }
  // The most frequent symbols (at the end of `symbols`) get the shortest codes.
  let next = m;
  for (let bits = 1; bits <= maxBits; bits += 1) {
    for (let k = count[bits]!; k > 0; k -= 1) lengths[symbols[--next]!] = bits;
  }
  return lengths;
}

/** Run-length encode code lengths as [symbol, extra] pairs: 16 repeats the previous length 3–6×, 17 and 18 write 3–10 and 11–138 zeros. */
function pushLengthRuns(lengths: Uint8Array, count: number, out: number[]): void {
  let i = 0;
  while (i < count) {
    const length = lengths[i]!;
    let run = 1;
    while (i + run < count && lengths[i + run] === length) run += 1;
    i += run;
    if (length === 0) {
      for (; run >= 11; run -= Math.min(run, 138)) out.push(18, Math.min(run, 138) - 11);
      if (run >= 3) {
        out.push(17, run - 3);
        run = 0;
      }
    } else {
      out.push(length, 0);
      run -= 1;
      for (; run >= 3; run -= Math.min(run, 6)) out.push(16, Math.min(run, 6) - 3);
    }
    for (; run > 0; run -= 1) out.push(length, 0);
  }
}

/** Canonical Huffman codes (RFC 1951 3.2.2) for code lengths, bit-reversed for LSB-first output. */
function canonicalCodes(lengths: Uint8Array): Uint16Array {
  const count = new Uint32Array(16);
  for (let s = 0; s < lengths.length; s += 1) count[lengths[s]!]! += 1;
  count[0] = 0;
  const next = new Uint32Array(16);
  for (let bits = 1, code = 0; bits < 16; bits += 1) {
    code = (code + count[bits - 1]!) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s += 1) {
    const length = lengths[s]!;
    if (length === 0) continue;
    let code = next[length]!;
    next[length] = code + 1;
    let reversed = 0;
    for (let k = 0; k < length; k += 1, code >>>= 1) reversed = (reversed << 1) | (code & 1);
    codes[s] = reversed;
  }
  return codes;
}

/** Packs bit fields least significant bit first, as DEFLATE streams are laid out. */
class BitWriter {
  private bytes: Uint8Array;
  private length = 0;
  private buffer = 0;
  private count = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  /** Make room for `extra` more bytes. */
  reserve(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.length + extra, this.bytes.length * 2));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  /** Append the low `count` bits (at most 16) of `value`. */
  bits(value: number, count: number): void {
    this.buffer |= value << this.count;
    this.count += count;
    while (this.count >= 8) {
      this.bytes[this.length] = this.buffer & 0xff;
      this.length += 1;
      this.buffer >>>= 8;
      this.count -= 8;
    }
  }

  alignToByte(): void {
    if (this.count > 0) this.bits(0, 8 - this.count);
  }

  copy(data: Uint8Array, offset: number, size: number): void {
    this.bytes.set(data.subarray(offset, offset + size), this.length);
    this.length += size;
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.bytes.slice(0, this.length);
  }
}
