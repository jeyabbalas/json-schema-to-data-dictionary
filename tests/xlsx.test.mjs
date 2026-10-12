import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import ExcelJS from "exceljs";
import { buildXlsx, cellRef, columnLetter, XLSX_MEDIA_TYPE, _deflateRaw } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const scale = Number(process.env.DD_PERF_SCALE ?? 1);
const BLOCK_TYPES = [undefined, "stored", "fixed", "dynamic"];

// --- Helpers --------------------------------------------------------------------------------

/** mulberry32: a seeded PRNG, so the "random" inputs are the same on every run. */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(length, seed) {
  const rand = prng(seed);
  return Uint8Array.from({ length }, () => Math.floor(rand() * 256));
}

const utf8 = (text) => new TextEncoder().encode(text);

function concat(...parts) {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

/** Text shaped like worksheet XML: repetitive tags around varying numbers. */
function xmlLike(length) {
  let text = "";
  for (let i = 0; text.length < length; i += 1) {
    text += `<row r="${i + 1}"><c r="A${i + 1}" s="${i % 7}" t="s"><v>${(i * 37) % 1009}</v></c><c r="B${i + 1}"><v>${i * 0.25}</v></c></row>`;
  }
  return utf8(text.slice(0, length));
}

/** Deflate with our encoder, inflate with zlib, and require the original bytes back. */
function assertRoundTrip(data, label) {
  for (const blockType of BLOCK_TYPES) {
    const packed = _deflateRaw(data, blockType ? { blockType } : {});
    const back = inflateRawSync(packed);
    assert.ok(Buffer.from(data).equals(back), `${label} (${blockType ?? "auto"}): ${data.length} bytes did not round-trip`);
  }
}

let crcTable;
/** CRC-32 written independently of the library's. */
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Read a ZIP archive through its central directory, checking each entry against its local
 * header and its data against the recorded CRC-32 and sizes. Returns name -> entry, in order.
 */
function readZip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, "end of central directory record");
  const count = buf.readUInt16LE(end + 10);
  assert.equal(buf.readUInt16LE(end + 8), count);
  const size = buf.readUInt32LE(end + 12);
  let at = buf.readUInt32LE(end + 16);
  assert.equal(at + size, end, "the central directory ends where the end record starts");
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "central directory header");
    const entry = {
      method: buf.readUInt16LE(at + 10),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24)
    };
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    const local = buf.readUInt32LE(at + 42);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: local header`);
    assert.equal(buf.readUInt16LE(local + 8), entry.method, `${name}: method`);
    assert.equal(buf.readUInt32LE(local + 14), entry.crc, `${name}: local CRC-32`);
    assert.equal(buf.readUInt32LE(local + 18), entry.compressedSize, `${name}: local compressed size`);
    assert.equal(buf.readUInt32LE(local + 22), entry.size, `${name}: local size`);
    const localNameLength = buf.readUInt16LE(local + 26);
    assert.equal(buf.toString("utf8", local + 30, local + 30 + localNameLength), name);
    const start = local + 30 + localNameLength + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + entry.compressedSize);
    assert.ok(entry.method === 0 || entry.method === 8, `${name}: method ${entry.method}`);
    entry.data = entry.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(entry.data.length, entry.size, `${name}: inflated size`);
    assert.equal(crc32(entry.data), entry.crc, `${name}: CRC-32 of the data`);
    entries.set(name, entry);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

function partText(bytes, name) {
  const entry = readZip(bytes).get(name);
  assert.ok(entry, `missing part ${name}`);
  return entry.data.toString("utf8");
}

async function loadExcel(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  return workbook;
}

/** A one-sheet workbook. */
function oneSheet(sheet) {
  return { sheets: [{ name: "Sheet", rows: [], ...sheet }] };
}

/** Assert that every tag occurs in `xml`, the first occurrences in the order given. */
function assertOrder(xml, tags, label) {
  let last = -1;
  for (const tag of tags) {
    const at = xml.indexOf(`<${tag}`);
    assert.ok(at > last, `${label}: <${tag}> missing or out of order`);
    last = at;
  }
}

const HEADER = { font: { bold: true, color: "FFFFFF" }, fill: "1F4E79", alignment: { vertical: "center" }, border: { bottom: { style: "medium", color: "000000" } } };
const WRAP_TOP = { alignment: { vertical: "top", wrapText: true } };

/** A workbook that touches every feature of the writer. */
function sampleWorkbook(properties = {}) {
  return {
    properties: { title: "Sample dictionary", subject: "Testing", creator: "xlsx.test", description: "A workbook for the tests", keywords: "xlsx test", ...properties },
    sheets: [
      {
        name: "Data dictionary",
        columns: [{ width: 20, style: WRAP_TOP }, { width: 48, style: WRAP_TOP }, { width: 14 }, { hidden: true }],
        freeze: { rows: 2, columns: 1 },
        autoFilter: "A2:D6",
        merges: ["A1:D1"],
        printTitleRows: "1:2",
        page: { orientation: "landscape", fitToWidth: true },
        tabColor: "00B050",
        showGridLines: false,
        zoom: 85,
        outlineSummary: "above",
        rows: [
          { cells: ["Sample dictionary", undefined, undefined, undefined], style: { font: { bold: true, size: 14 } }, height: 24 },
          { cells: ["Variable", "Description", "Value", "Hidden"], style: HEADER },
          {
            cells: [
              "age",
              [{ text: "Age", font: { bold: true } }, { text: " at baseline, in years", font: { italic: true, color: "7F7F7F", size: 9 } }],
              { value: 42.5, style: { numberFormat: "0.00" } },
              "secret"
            ],
            outlineLevel: 1
          },
          { cells: ["smoker", "Ever smoked", true, null], outlineLevel: 1, hidden: true },
          { cells: ["formula", "=SUM(A1)", { value: 0.125, style: { numberFormat: "0.0%" } }], height: 30 },
          {
            cells: [
              "code",
              { value: "007", style: { numberFormat: "@" } },
              { value: "x", style: { alignment: { horizontal: "right", indent: 2 }, border: { left: { style: "thin" }, right: { style: "dashed", color: "FF0000" } } } }
            ]
          }
        ]
      },
      { name: "Notes", rows: [{ cells: ["Second sheet"] }], freeze: { rows: 1 } },
      { name: "It's data", rows: [{ cells: ["x", "y"] }], freeze: { columns: 2 }, autoFilter: "A1:B1" }
    ]
  };
}

// --- DEFLATE --------------------------------------------------------------------------------

test("deflate: edge-case inputs round-trip through zlib in every block type", () => {
  const cases = {
    empty: new Uint8Array(0),
    "1 byte": Uint8Array.of(0x41),
    "short text": utf8("Hello, hello, hello DEFLATE!"),
    "1 MB of XML-like text": xmlLike(1 << 20),
    "300 KB of pseudo-random bytes": randomBytes(300_000, 1),
    "all 256 byte values": Uint8Array.from({ length: 256 }, (_, i) => i),
    "all 256 byte values, 64 times": Uint8Array.from({ length: 256 * 64 }, (_, i) => i & 255),
    "100,000 × a": new Uint8Array(100_000).fill(0x61),
    "UTF-8 text": utf8("Ünïcödé — 日本語のテキスト 😀 ".repeat(500))
  };
  for (const [label, data] of Object.entries(cases)) assertRoundTrip(data, label);
});

test("deflate: matches of lengths around 258 round-trip", () => {
  for (const length of [3, 4, 5, 10, 256, 257, 258, 259, 260, 515, 516, 517, 1000]) {
    const unit = randomBytes(length, length);
    assertRoundTrip(concat(randomBytes(1000, 1), unit, randomBytes(40, 2), unit, unit), `repeat of ${length}`);
    assertRoundTrip(new Uint8Array(length + 1).fill(7), `run of ${length + 1}`);
  }
});

test("deflate: a match exactly 32,768 bytes back is used; one byte farther is out of the window", () => {
  const block = randomBytes(300, 7);
  const atDistance = (distance) => concat(block, randomBytes(distance - block.length, 8), block);
  const inWindow = atDistance(32768);
  const outOfWindow = atDistance(32769);
  assertRoundTrip(inWindow, "distance 32,768");
  assertRoundTrip(outOfWindow, "distance 32,769");
  const inSize = _deflateRaw(inWindow).length;
  const outSize = _deflateRaw(outOfWindow).length;
  // The repeated 300 bytes cost a few bytes as one match, and ~300 as literals.
  assert.ok(inSize < outSize - 250, `distance 32,768 -> ${inSize} bytes, 32,769 -> ${outSize} bytes`);
});

test("deflate: input sizes around block boundaries round-trip", () => {
  // Pseudo-random bytes give one symbol per byte, so a 16,384-symbol block ends exactly at
  // these sizes; stored blocks hold at most 65,535 bytes.
  for (const size of [16383, 16384, 16385, 32767, 32768, 32769, 65535, 65536, 65537, 131073]) {
    assertRoundTrip(randomBytes(size, size), `${size} random bytes`);
    assertRoundTrip(xmlLike(size), `${size} bytes of XML-like text`);
  }
});

test("deflate: compresses like zlib level 6; incompressible data costs only stored-block headers", () => {
  const xml = xmlLike(1 << 20);
  const ours = _deflateRaw(xml).length;
  const zlib6 = deflateRawSync(xml, { level: 6 }).length;
  assert.ok(ours <= zlib6 * 1.05, `ours ${ours} bytes vs zlib level 6 ${zlib6}`);
  const random = randomBytes(300_000, 3);
  const packed = _deflateRaw(random).length;
  assert.ok(packed <= random.length + 5 * Math.ceil(random.length / 16384) + 8, `300,000 random bytes -> ${packed}`);
});

// --- ZIP container --------------------------------------------------------------------------

test("zip: every entry's CRC-32 and sizes check out; fixed timestamps; [Content_Types].xml first", () => {
  const bytes = buildXlsx(sampleWorkbook());
  const entries = readZip(bytes);
  assert.deepEqual(
    [...entries.keys()],
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
      "xl/sharedStrings.xml"
    ]
  );
  for (const [name, entry] of entries) {
    assert.equal(entry.time, 0, `${name}: DOS time 00:00`);
    assert.equal(entry.date, (1 << 5) | 1, `${name}: DOS date 1980-01-01`);
    assert.ok(entry.method === 8 ? entry.compressedSize < entry.size : entry.compressedSize === entry.size, `${name}: deflated only when smaller`);
  }
  assert.equal(entries.get("xl/worksheets/sheet1.xml").method, 8);
  for (const [name, entry] of entries) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) assert.match(entry.data.toString("utf8"), /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/);
  }
});

test("zip: compress: false stores every part; the file is larger and has the same contents", async () => {
  const packed = buildXlsx(sampleWorkbook());
  const stored = buildXlsx(sampleWorkbook(), { compress: false });
  assert.ok(stored.length > packed.length, `stored ${stored.length} vs deflated ${packed.length}`);
  const a = readZip(packed);
  const b = readZip(stored);
  assert.deepEqual([...b.keys()], [...a.keys()]);
  for (const [name, entry] of b) {
    assert.equal(entry.method, 0, `${name} is stored`);
    assert.ok(entry.data.equals(a.get(name).data), `${name} has the same contents`);
  }
  const workbook = await loadExcel(stored);
  assert.equal(workbook.getWorksheet("Data dictionary").getCell("A3").value, "age");
});

test("determinism: the same input builds identical bytes; dates only when given", () => {
  const plain = sampleWorkbook();
  assert.ok(Buffer.from(buildXlsx(plain)).equals(Buffer.from(buildXlsx(sampleWorkbook()))));
  assert.doesNotMatch(partText(buildXlsx(plain), "docProps/core.xml"), /dcterms:created/);

  const dated = sampleWorkbook({ created: new Date("2024-05-06T07:08:09.123Z") });
  assert.ok(Buffer.from(buildXlsx(dated)).equals(Buffer.from(buildXlsx(dated))));
  const core = partText(buildXlsx(dated), "docProps/core.xml");
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2024-05-06T07:08:09Z<\/dcterms:created>/);
  assert.match(core, /<dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-06T07:08:09Z<\/dcterms:modified>/);
});

// --- XML structure --------------------------------------------------------------------------

test("xml: worksheet, sheetPr, workbook and styles children follow the ECMA-376 order", () => {
  const bytes = buildXlsx(sampleWorkbook());
  const sheet = partText(bytes, "xl/worksheets/sheet1.xml");
  assertOrder(
    sheet,
    ["worksheet", "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "autoFilter", "mergeCells", "pageMargins", "pageSetup"],
    "CT_Worksheet"
  );
  assertOrder(sheet, ["sheetPr", "tabColor", "outlinePr", "pageSetUpPr", "dimension"], "CT_SheetPr");
  assert.match(sheet, /<sheetPr><tabColor rgb="FF00B050"\/><outlinePr summaryBelow="0"\/><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
  assert.match(sheet, /<dimension ref="A1:D6"\/>/);
  assert.match(sheet, /<sheetFormatPr defaultRowHeight="15" outlineLevelRow="1"\/>/);
  assert.match(sheet, /<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"\/>/);

  const workbook = partText(bytes, "xl/workbook.xml");
  assertOrder(workbook, ["workbook", "workbookPr", "bookViews", "sheets", "definedNames", "calcPr"], "CT_Workbook");
  const styles = partText(bytes, "xl/styles.xml");
  assertOrder(styles, ["styleSheet", "numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles"], "CT_Stylesheet");
  // Notes has no sheetPr, cols, autoFilter or page setup at all.
  const notes = partText(bytes, "xl/worksheets/sheet2.xml");
  for (const tag of ["sheetPr", "cols", "autoFilter", "mergeCells", "pageSetup"]) assert.ok(!notes.includes(`<${tag}`), `Notes has no <${tag}>`);
});

test("xml: frozen panes carry the selections Excel writes for each layout", () => {
  const bytes = buildXlsx(sampleWorkbook());
  assert.match(
    partText(bytes, "xl/worksheets/sheet1.xml"),
    /<sheetView showGridLines="0" tabSelected="1" zoomScale="85" zoomScaleNormal="85" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"\/><selection pane="topRight" activeCell="B1" sqref="B1"\/><selection pane="bottomLeft" activeCell="A3" sqref="A3"\/><selection pane="bottomRight" activeCell="B3" sqref="B3"\/><\/sheetView>/
  );
  assert.match(
    partText(bytes, "xl/worksheets/sheet2.xml"),
    /<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/><selection pane="bottomLeft" activeCell="A2" sqref="A2"\/><\/sheetView>/
  );
  assert.match(
    partText(bytes, "xl/worksheets/sheet3.xml"),
    /<sheetView workbookViewId="0"><pane xSplit="2" topLeftCell="C1" activePane="topRight" state="frozen"\/><selection pane="topRight" activeCell="C1" sqref="C1"\/><\/sheetView>/
  );
  const unfrozen = partText(buildXlsx(oneSheet({ rows: [{ cells: [1] }], freeze: { rows: 0, columns: 0 } })), "xl/worksheets/sheet1.xml");
  assert.ok(!unfrozen.includes("<pane"), "no pane without frozen rows or columns");
});

test("xml: defined names quote sheet names; the filter database name is hidden", () => {
  const workbook = partText(buildXlsx(sampleWorkbook()), "xl/workbook.xml");
  assert.match(workbook, /<bookViews><workbookView activeTab="0"\/><\/bookViews>/);
  assert.ok(workbook.includes(`<sheet name="It's data" sheetId="3" r:id="rId3"/>`), workbook);
  assert.ok(
    workbook.includes(
      "<definedNames>" +
        `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Data dictionary'!$A$2:$D$6</definedName>` +
        `<definedName name="_xlnm._FilterDatabase" localSheetId="2" hidden="1">'It''s data'!$A$1:$B$1</definedName>` +
        `<definedName name="_xlnm.Print_Titles" localSheetId="0">'Data dictionary'!$1:$2</definedName>` +
        "</definedNames>"
    ),
    workbook
  );
  const plain = partText(buildXlsx(oneSheet({ rows: [{ cells: ["x"] }] })), "xl/workbook.xml");
  assert.ok(!plain.includes("<definedNames"), "no definedNames element when there are none");
});

test("xml: styles keep Excel's mandatory defaults and deduplicate equal styles", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    // A fresh but equal style object for every cell.
    cells: [{ value: i, style: { font: { bold: true }, fill: "#ffeeaa", numberFormat: "0.000" } }, { value: "x", style: { numberFormat: "0.00" } }, { value: 1, style: { numberFormat: "@" } }]
  }));
  const styles = partText(buildXlsx(oneSheet({ rows, columns: [{ style: { numberFormat: "#,##0.0" } }] })), "xl/styles.xml");
  assert.match(styles, /<fills count="3"><fill><patternFill patternType="none"\/><\/fill><fill><patternFill patternType="gray125"\/><\/fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFEEAA"\/>/);
  assert.match(styles, /<borders count="1"><border><left\/><right\/><top\/><bottom\/><diagonal\/><\/border><\/borders>/);
  assert.match(styles, /<fonts count="2"><font><sz val="11"\/><name val="Calibri"\/><\/font><font><b\/><sz val="11"\/><name val="Calibri"\/><\/font><\/fonts>/);
  assert.match(styles, /<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0"\/><numFmt numFmtId="165" formatCode="0.000"\/><\/numFmts>/);
  assert.match(styles, /<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"\/>/);
  assert.match(styles, /<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"\/>/, "0.00 is built-in format 2");
  assert.match(styles, /<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"\/>/, "@ is built-in format 49");
  assert.match(styles, /<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"\/><\/cellStyleXfs>/);
  assert.match(styles, /<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"\/><\/cellStyles>/);
});

test("xml: shared strings are deduplicated and counted; rich text runs carry a complete rPr", () => {
  const bold = { bold: true };
  const bytes = buildXlsx({
    defaultFont: { name: "Arial", size: 10 },
    sheets: [
      {
        name: "S",
        rows: [
          { cells: ["a", "b", "a"] },
          { cells: ["b", [{ text: "x ", font: bold }, { text: "y" }], [{ text: "x ", font: { bold: true } }, { text: "y" }]] },
          { cells: [{ value: [{ text: "z", font: { italic: true } }], style: { font: { color: "FF0000", size: 12 } } }] }
        ]
      }
    ]
  });
  const sst = partText(bytes, "xl/sharedStrings.xml");
  assert.match(sst, /<sst xmlns="[^"]+" count="7" uniqueCount="4">/);
  assert.ok(sst.includes("<si><t>a</t></si><si><t>b</t></si>"));
  assert.ok(
    sst.includes(
      '<si><r><rPr><b/><sz val="10"/><rFont val="Arial"/></rPr><t xml:space="preserve">x </t></r><r><rPr><sz val="10"/><rFont val="Arial"/></rPr><t xml:space="preserve">y</t></r></si>'
    ),
    sst
  );
  assert.ok(sst.includes('<si><r><rPr><i/><sz val="12"/><color rgb="FFFF0000"/><rFont val="Arial"/></rPr><t xml:space="preserve">z</t></r></si>'), sst);
  assert.match(partText(bytes, "xl/styles.xml"), /<fonts count="2"><font><sz val="10"\/><name val="Arial"\/><\/font>/);
});

test("xml: empty cells are written only when they carry a format; the row style reaches only listed cells", () => {
  const sheet = partText(
    buildXlsx(
      oneSheet({
        columns: [undefined, undefined, undefined, { style: { fill: "EEEEEE" } }],
        rows: [
          { cells: [undefined, "x", null, "", [], [{ text: "" }]] },
          { cells: [undefined, "y", undefined], style: { fill: "DDEBF7" } },
          { cells: [], height: 20 },
          { cells: [undefined, undefined, undefined, undefined] }
        ]
      })
    ),
    "xl/worksheets/sheet1.xml"
  );
  // A1, C1, E1 and F1 are empty without a format; D1 is empty too but has column D's fill.
  assert.match(sheet, /<row r="1"><c r="B1" t="s"><v>0<\/v><\/c><c r="D1" s="1"\/><\/row>/);
  assert.match(sheet, /<row r="2"><c r="A2" s="2"\/><c r="B2" s="2" t="s"><v>1<\/v><\/c><c r="C2" s="2"\/><\/row>/);
  assert.match(sheet, /<row r="3" ht="20" customHeight="1"\/>/);
  assert.match(sheet, /<row r="4"><c r="D4" s="1"\/><\/row>/, "a column style counts as a format");
  assert.match(sheet, /<col min="4" max="4" width="9.140625" style="1"\/>/);
  assert.ok(!/<row r="\d+" s=/.test(sheet), "rows carry no style of their own");
});

// --- Read back with ExcelJS -----------------------------------------------------------------

test("exceljs: sheet names are sanitised and made unique", async () => {
  const names = ["Data dictionary", "data DICTIONARY", "a[b]:c*?/\\d", "   ", "'quoted'", "x".repeat(40), "x".repeat(40), "History", "Tab\tname\u0001", "", "<&>\"'"];
  const workbook = await loadExcel(buildXlsx({ sheets: names.map((name) => ({ name, rows: [{ cells: [name] }] })) }));
  assert.deepEqual(
    workbook.worksheets.map((ws) => ws.name),
    ["Data dictionary", "data DICTIONARY (2)", "abcd", "Sheet4", "quoted", "x".repeat(31), `${"x".repeat(27)} (2)`, "History (2)", "Tabname", "Sheet10", '<&>"']
  );
  assert.ok(workbook.worksheets.every((ws) => ws.name.length <= 31));
});

test("exceljs: plain, number, boolean and empty cells; non-finite numbers and formulas stay text", async () => {
  const workbook = await loadExcel(
    buildXlsx(oneSheet({ rows: [{ cells: ["text", 42, -3.5, 1e21, 0.1 + 0.2, true, false, null, undefined, "", NaN, Infinity, -Infinity, "=SUM(A1)", "  padded  ", 2 ** 53 + 2, -0] }] }))
  );
  const ws = workbook.worksheets[0];
  const values = ws.getRow(1).values.slice(1);
  assert.deepEqual(values.slice(0, 7), ["text", 42, -3.5, 1e21, 0.1 + 0.2, true, false]);
  for (const ref of ["H1", "I1", "J1"]) assert.equal(ws.getCell(ref).value, null, `${ref} is empty`);
  assert.deepEqual(values.slice(10), ["NaN", "Infinity", "-Infinity", "=SUM(A1)", "  padded  ", 2 ** 53 + 2, 0]);
  assert.equal(ws.getCell("N1").type, ExcelJS.ValueType.String, "a leading = stays text");
  assert.equal(ws.getCell("N1").formula, undefined);
  assert.equal(ws.getCell("B1").type, ExcelJS.ValueType.Number);
  assert.equal(ws.getCell("F1").type, ExcelJS.ValueType.Boolean);
});

test("exceljs: rich text runs keep their text and fonts, merged over the cell font", async () => {
  const bold = { bold: true };
  const workbook = await loadExcel(
    buildXlsx(
      oneSheet({
        rows: [
          {
            cells: [
              {
                value: [
                  { text: "Bold ", font: bold },
                  { text: "red italic", font: { italic: true, color: "C00000", size: 9 } },
                  { text: " plain" },
                  { text: " struck", font: { strike: true, underline: true, name: "Courier New" } }
                ],
                style: { font: { name: "Arial", size: 12, color: "1F4E79" } }
              },
              [{ text: "same " }, { text: "font" }],
              [{ text: "a", font: bold }, { text: "b", font: { bold: true } }, { text: "" }, { text: "c", font: { italic: true } }],
              [],
              [{ text: "" }, { text: "" }]
            ]
          }
        ]
      })
    )
  );
  const ws = workbook.worksheets[0];
  const navy = { argb: "FF1F4E79" };
  assert.deepEqual(ws.getCell("A1").value.richText, [
    { text: "Bold ", font: { bold: true, size: 12, color: navy, name: "Arial" } },
    { text: "red italic", font: { italic: true, size: 9, color: { argb: "FFC00000" }, name: "Arial" } },
    { text: " plain", font: { size: 12, color: navy, name: "Arial" } },
    { text: " struck", font: { strike: true, underline: true, size: 12, color: navy, name: "Courier New" } }
  ]);
  assert.equal(ws.getCell("B1").value, "same font", "runs in the cell's own font become a plain string");
  assert.deepEqual(
    ws.getCell("C1").value.richText.map((run) => [run.text, !!run.font.bold, !!run.font.italic]),
    [
      ["ab", true, false],
      ["c", false, true]
    ],
    "adjacent runs with the same font are joined"
  );
  assert.equal(ws.getCell("D1").value, null, "no runs: empty");
  assert.equal(ws.getCell("E1").value, null, "only empty runs: empty");
});

test("exceljs: cell styles merge column < row < cell per facet", async () => {
  const workbook = await loadExcel(
    buildXlsx(
      oneSheet({
        columns: [{ width: 12, style: { font: { italic: true }, alignment: { vertical: "top", wrapText: true }, numberFormat: "0" } }],
        rows: [
          {
            style: { font: { bold: true }, fill: "DDEBF7", border: { bottom: { style: "thin", color: "999999" } } },
            cells: [
              {
                value: 1.5,
                style: { font: { color: "FF0000" }, border: { top: { style: "medium" } }, alignment: { horizontal: "right", indent: 2 }, numberFormat: "0.000" }
              },
              { value: "indent only", style: { alignment: { indent: 3 } } },
              { value: "centred", style: { alignment: { horizontal: "center", indent: 3 }, font: { bold: false, underline: true, size: 9, name: "Georgia" } } }
            ]
          },
          { cells: [7] }
        ]
      })
    )
  );
  const ws = workbook.worksheets[0];
  const a1 = ws.getCell("A1");
  assert.deepEqual(a1.font, { bold: true, italic: true, size: 11, color: { argb: "FFFF0000" }, name: "Calibri" });
  assert.equal(a1.fill.pattern, "solid");
  assert.equal(a1.fill.fgColor.argb, "FFDDEBF7");
  assert.deepEqual(a1.border.bottom, { style: "thin", color: { argb: "FF999999" } });
  assert.deepEqual(a1.border.top, { style: "medium" });
  assert.equal(a1.border.left, undefined);
  assert.deepEqual(a1.alignment, { horizontal: "right", vertical: "top", wrapText: true, indent: 2 });
  assert.equal(a1.numFmt, "0.000");
  assert.deepEqual(ws.getCell("B1").alignment, { horizontal: "left", indent: 3 }, "an indent alone aligns left");
  const c1 = ws.getCell("C1");
  assert.deepEqual(c1.alignment, { horizontal: "center" }, "centred text drops the indent");
  assert.deepEqual(c1.font, { underline: true, size: 9, name: "Georgia" }, "the cell turns the row's bold off");
  const a2 = ws.getCell("A2");
  assert.deepEqual(a2.font, { italic: true, size: 11, name: "Calibri" }, "the column style applies without a row style");
  assert.equal(a2.numFmt, "0");
  assert.deepEqual(a2.alignment, { vertical: "top", wrapText: true });
});

test("exceljs: layout, views, filters, merges, rows, page setup, print titles and properties", async () => {
  const workbook = await loadExcel(buildXlsx(sampleWorkbook()));
  assert.equal(workbook.title, "Sample dictionary");
  assert.equal(workbook.subject, "Testing");
  assert.equal(workbook.creator, "xlsx.test");
  assert.equal(workbook.description, "A workbook for the tests");
  assert.equal(workbook.keywords, "xlsx test");
  assert.deepEqual(
    workbook.worksheets.map((ws) => ws.name),
    ["Data dictionary", "Notes", "It's data"]
  );

  const ws = workbook.getWorksheet("Data dictionary");
  assert.equal(ws.getColumn(1).width, 20);
  assert.equal(ws.getColumn(2).width, 48);
  assert.equal(ws.getColumn(3).width, 14);
  assert.equal(ws.getColumn(4).hidden, true);
  assert.deepEqual(ws.getColumn(1).alignment, { vertical: "top", wrapText: true });

  const [view] = ws.views;
  assert.equal(view.state, "frozen");
  assert.equal(view.xSplit, 1);
  assert.equal(view.ySplit, 2);
  assert.equal(view.topLeftCell, "B3");
  assert.equal(view.showGridLines, false);
  assert.equal(view.zoomScale, 85);
  assert.deepEqual(ws.properties.tabColor, { argb: "FF00B050" });
  assert.equal(ws.properties.outlineLevelRow, 1);
  assert.equal(ws.properties.outlineProperties.summaryBelow, false);

  assert.equal(ws.autoFilter, "A2:D6");
  assert.deepEqual(ws.model.merges, ["A1:D1"]);
  assert.equal(ws.getCell("C1").master.address, "A1");

  assert.equal(ws.getRow(1).height, 24);
  assert.equal(ws.getRow(3).outlineLevel, 1);
  assert.equal(ws.getRow(4).outlineLevel, 1);
  assert.equal(ws.getRow(4).hidden, true);
  assert.equal(ws.getRow(3).hidden, false);
  assert.equal(ws.getRow(5).height, 30);

  assert.equal(ws.pageSetup.orientation, "landscape");
  assert.equal(ws.pageSetup.fitToPage, true);
  assert.equal(ws.pageSetup.fitToWidth, 1);
  assert.equal(ws.pageSetup.fitToHeight, 0);
  assert.equal(ws.pageSetup.printTitlesRow, "1:2");

  assert.equal(ws.getCell("C3").value, 42.5);
  assert.equal(ws.getCell("C3").numFmt, "0.00");
  assert.equal(ws.getCell("C5").numFmt, "0.0%");
  assert.equal(ws.getCell("B6").value, "007");
  assert.equal(ws.getCell("B6").numFmt, "@");
  assert.deepEqual(ws.getCell("C6").border.right, { style: "dashed", color: { argb: "FFFF0000" } });
  assert.deepEqual(ws.getCell("C6").border.left, { style: "thin" });
  assert.deepEqual(ws.getCell("A2").font, { bold: true, size: 11, color: { argb: "FFFFFFFF" }, name: "Calibri" });
  assert.equal(ws.getCell("D2").fill.fgColor.argb, "FF1F4E79");

  const [notes] = workbook.getWorksheet("Notes").views;
  assert.deepEqual([notes.state, notes.xSplit, notes.ySplit, notes.topLeftCell], ["frozen", 0, 1, "A2"]);
  const [third] = workbook.getWorksheet("It's data").views;
  assert.deepEqual([third.state, third.xSplit, third.ySplit, third.topLeftCell], ["frozen", 2, 0, "C1"]);
  assert.equal(workbook.getWorksheet("It's data").autoFilter, "A1:B1");
});

test("exceljs: text hygiene: control characters, surrogates, line breaks, escaping and the 32,767-character cap", async () => {
  const long = "abcdefghij".repeat(4000);
  const longRich = [
    { text: "x".repeat(30000), font: { bold: true } },
    { text: "y".repeat(5000), font: { italic: true } },
    { text: "never written" }
  ];
  const workbook = await loadExcel(
    buildXlsx({
      properties: { title: "Title <&>\"' \u0001" },
      sheets: [
        {
          name: "Text",
          rows: [
            {
              cells: [
                "a\u0000b\u0007c\u000bd\u001fe\ufffef\uffffg",
                "tab\tand\nnewline",
                "\ud800lone\udc00 surrogates, a pair: 😀",
                "windows\r\nand\rmac",
                "<tag attr=\"v\">&amp; 'quoted'</tag>",
                long,
                longRich,
                "\u0001\u0002"
              ]
            }
          ]
        }
      ]
    })
  );
  assert.equal(workbook.title, "Title <&>\"' ");
  const ws = workbook.worksheets[0];
  assert.equal(ws.getCell("A1").value, "abcdefg");
  assert.equal(ws.getCell("B1").value, "tab\tand\nnewline");
  assert.equal(ws.getCell("C1").value, "lone surrogates, a pair: 😀");
  assert.equal(ws.getCell("D1").value, "windows\nand\nmac");
  assert.equal(ws.getCell("E1").value, "<tag attr=\"v\">&amp; 'quoted'</tag>");
  const truncated = ws.getCell("F1").value;
  assert.equal(truncated.length, 32767);
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncated.slice(0, -1), long.slice(0, 32766));
  const runs = ws.getCell("G1").value.richText;
  assert.equal(runs.map((run) => run.text).join("").length, 32767);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].text, `${"y".repeat(2766)}…`);
  assert.equal(ws.getCell("H1").value, null, "a string of control characters only is empty");
});

// --- Validation and helpers -----------------------------------------------------------------

test("validation: clear errors for impossible workbooks and malformed options", () => {
  assert.throws(() => buildXlsx({ sheets: [] }), /buildXlsx: the workbook has no sheets/);
  assert.throws(() => buildXlsx({}), /no sheets/);
  assert.throws(() => buildXlsx(oneSheet({ rows: new Array(1048577) })), /has 1048577 rows; Excel allows at most 1048576/);
  assert.throws(() => buildXlsx(oneSheet({ rows: [{ cells: new Array(16385).fill(1) }] })), /row 1 has 16385 cells; Excel allows at most 16384 columns/);
  assert.throws(() => buildXlsx(oneSheet({ columns: new Array(16385).fill({ width: 5 }) })), /has 16385 columns/);
  assert.throws(() => buildXlsx(oneSheet({ rows: [{ cells: [{ value: 1, style: { fill: "red" } }] }] })), /invalid colour "red"/);
  assert.throws(() => buildXlsx(oneSheet({ tabColor: "#12345" })), /invalid colour/);
  assert.throws(() => buildXlsx(oneSheet({ autoFilter: "A1:B" })), /autoFilter: "A1:B" is not an A1-style range/);
  assert.throws(() => buildXlsx(oneSheet({ merges: ["A1:XFE1"] })), /not an A1-style range/);
  assert.throws(() => buildXlsx(oneSheet({ merges: ["A1:B2", "B2:C3"] })), /ranges A1:B2 and B2:C3 overlap/);
  assert.throws(() => buildXlsx(oneSheet({ printTitleRows: "A:B" })), /printTitleRows: "A:B" is not a row range/);
  assert.throws(() => buildXlsx(oneSheet({ page: { orientation: "sideways" } })), /page\.orientation: "sideways" is not one of portrait, landscape/);
  assert.throws(() => buildXlsx(oneSheet({ rows: [{ cells: [{ value: 1, style: { alignment: { vertical: "middle" } } }] }] })), /alignment\.vertical: "middle"/);
  assert.throws(() => buildXlsx(oneSheet({ rows: [{ cells: [{ value: 1, style: { border: { top: { style: "wavy" } } } }] }] })), /border style: "wavy"/);

  // Exactly at Excel's limits is fine.
  const edge = buildXlsx(oneSheet({ rows: Object.assign(new Array(1048576), { 1048575: { cells: new Array(16384).fill(1) } }) }));
  assert.match(partText(edge, "xl/worksheets/sheet1.xml"), /<dimension ref="A1048576:XFD1048576"\/>.*<c r="XFD1048576"><v>1<\/v><\/c><\/row><\/sheetData>/s);
  // Duplicate and single-cell merges are dropped rather than rejected.
  assert.match(partText(buildXlsx(oneSheet({ merges: ["A1:B1", "a1:b1", "C3", "$C$5:$D$6"] })), "xl/worksheets/sheet1.xml"), /<mergeCells count="2"><mergeCell ref="A1:B1"\/><mergeCell ref="C5:D6"\/><\/mergeCells>/);
});

test("columnLetter, cellRef and XLSX_MEDIA_TYPE", () => {
  const letters = { 1: "A", 2: "B", 26: "Z", 27: "AA", 52: "AZ", 53: "BA", 702: "ZZ", 703: "AAA", 16384: "XFD" };
  for (const [column, expected] of Object.entries(letters)) assert.equal(columnLetter(Number(column)), expected);
  assert.equal(cellRef(1, 1), "A1");
  assert.equal(cellRef(266, 8), "H266");
  assert.equal(cellRef(1048576, 16384), "XFD1048576");
  for (const bad of [0, -1, 1.5, 16385, NaN]) assert.throws(() => columnLetter(bad), RangeError);
  assert.throws(() => cellRef(0, 1), RangeError);
  assert.throws(() => cellRef(1048577, 1), RangeError);
  assert.equal(XLSX_MEDIA_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

// --- Read back with openpyxl ----------------------------------------------------------------

const hasOpenpyxl = spawnSync("python3", ["-I", "-c", "import openpyxl"], { stdio: "ignore" }).status === 0;

const OPENPYXL_SCRIPT = `
import json, sys
from openpyxl import load_workbook
from openpyxl.cell.rich_text import CellRichText

wb = load_workbook(sys.argv[1], rich_text=True)
ws = wb["Data dictionary"]

def rgb(color):
    return color.rgb if color is not None and color.type == "rgb" else None

def value(cell):
    v = cell.value
    if isinstance(v, CellRichText):
        return [{"text": b.text, "bold": bool(b.font.b), "italic": bool(b.font.i), "color": rgb(b.font.color), "size": b.font.sz, "font": b.font.rFont} for b in v]
    return v

def style(cell):
    f, a, b = cell.font, cell.alignment, cell.border
    return {
        "bold": bool(f.b), "italic": bool(f.i), "size": f.sz, "color": rgb(f.color), "name": f.name,
        "fill": cell.fill.fgColor.rgb if cell.fill.fill_type == "solid" else None,
        "horizontal": a.horizontal, "vertical": a.vertical, "wrap": bool(a.wrap_text), "indent": a.indent,
        "left": b.left.style, "right": [b.right.style, rgb(b.right.color)], "bottom": [b.bottom.style, rgb(b.bottom.color)],
        "numFmt": cell.number_format,
    }

print(json.dumps({
    "sheets": wb.sheetnames,
    "title": wb.properties.title,
    "creator": wb.properties.creator,
    "values": {ref: value(ws[ref]) for ref in ["A1", "A3", "B3", "C3", "C4", "B5", "C5", "B6"]},
    "types": {ref: ws[ref].data_type for ref in ["B5", "C3", "C4"]},
    "styles": {ref: style(ws[ref]) for ref in ["A2", "C3", "C6"]},
    "freeze": ws.freeze_panes,
    "autoFilter": ws.auto_filter.ref,
    "merges": sorted(str(r) for r in ws.merged_cells.ranges),
    "printTitleRows": ws.print_title_rows,
    "rows": {str(r): [ws.row_dimensions[r].height, ws.row_dimensions[r].outlineLevel, bool(ws.row_dimensions[r].hidden)] for r in (1, 3, 4, 5)},
    "columns": {k: [d.width, bool(d.hidden)] for k, d in sorted(ws.column_dimensions.items())},
    "tabColor": rgb(ws.sheet_properties.tabColor),
    "summaryBelow": ws.sheet_properties.outlinePr.summaryBelow,
    "fitToPage": ws.sheet_properties.pageSetUpPr.fitToPage,
    "orientation": ws.page_setup.orientation,
    "gridLines": ws.sheet_view.showGridLines,
    "zoom": ws.sheet_view.zoomScale,
}))
`;

test("openpyxl: reads values, rich text, styles and layout back", { skip: hasOpenpyxl ? false : "python3 with openpyxl is not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-test-"));
  try {
    const path = join(dir, "sample.xlsx");
    writeFileSync(path, buildXlsx(sampleWorkbook()));
    const run = spawnSync("python3", ["-I", "-c", OPENPYXL_SCRIPT, path], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.sheets, ["Data dictionary", "Notes", "It's data"]);
    assert.equal(out.title, "Sample dictionary");
    assert.equal(out.creator, "xlsx.test");
    assert.deepEqual(out.values, {
      A1: "Sample dictionary",
      A3: "age",
      B3: [
        { text: "Age", bold: true, italic: false, color: null, size: 11, font: "Calibri" },
        { text: " at baseline, in years", bold: false, italic: true, color: "FF7F7F7F", size: 9, font: "Calibri" }
      ],
      C3: 42.5,
      C4: true,
      B5: "=SUM(A1)",
      C5: 0.125,
      B6: "007"
    });
    assert.deepEqual(out.types, { B5: "s", C3: "n", C4: "b" });
    assert.deepEqual(out.styles.A2, {
      bold: true,
      italic: false,
      size: 11,
      color: "FFFFFFFF",
      name: "Calibri",
      fill: "FF1F4E79",
      horizontal: null,
      vertical: "center",
      wrap: true,
      indent: 0,
      left: null,
      right: [null, null],
      bottom: ["medium", "FF000000"],
      numFmt: "General"
    });
    assert.equal(out.styles.C3.numFmt, "0.00");
    assert.deepEqual([out.styles.C6.horizontal, out.styles.C6.indent, out.styles.C6.left, out.styles.C6.right], ["right", 2, "thin", ["dashed", "FFFF0000"]]);
    assert.equal(out.freeze, "B3");
    assert.equal(out.autoFilter, "A2:D6");
    assert.deepEqual(out.merges, ["A1:D1"]);
    assert.equal(out.printTitleRows, "$1:$2");
    assert.deepEqual(out.rows, { 1: [24, 0, false], 3: [null, 1, false], 4: [null, 1, true], 5: [30, 0, false] });
    assert.deepEqual(out.columns, { A: [20, false], B: [48, false], C: [14, false], D: [9.140625, true] });
    assert.equal(out.tabColor, "FF00B050");
    assert.equal(out.summaryBelow, false);
    assert.equal(out.fitToPage, true);
    assert.equal(out.orientation, "landscape");
    assert.equal(out.gridLines, false);
    assert.equal(out.zoom, 85);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Browser bundle and performance ---------------------------------------------------------

test("browser bundle: builds the same bytes in a context with nothing but TextEncoder", () => {
  const code = readFileSync(join(HERE, "..", "dist", "json-schema-data-dictionary.global.js"), "utf8");
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(code, context);
  context.input = sampleWorkbook();
  const bytes = vm.runInContext("JsonSchemaDataDictionary.buildXlsx(input)", context);
  assert.ok(Buffer.from(bytes).equals(Buffer.from(buildXlsx(sampleWorkbook()))));
});

/** 10,000 variables × 8 rich-text columns, the shape of a large data dictionary export. */
function bigWorkbook(rows) {
  const rand = prng(42);
  const words = "participant age years measured at baseline visit recorded menopausal status premenopausal postmenopausal unknown missing value code category questionnaire smoking alcohol body mass index height weight derived from self reported".split(" ");
  const phrase = (n) => Array.from({ length: n }, () => words[Math.floor(rand() * words.length)]).join(" ");
  const BOLD = { bold: true };
  const MUTED = { italic: true, color: "7F7F7F" };
  const CODE = { name: "Consolas", size: 10 };
  const out = [{ cells: ["Category", "Variable name", "Description", "Data type", "Format", "Valid values", "Constraints", "Additional information"], style: HEADER }];
  for (let i = 0; i < rows; i += 1) {
    out.push({
      outlineLevel: 1,
      cells: [
        [{ text: `Category ${i % 97}: ${phrase(3)}`, font: BOLD }],
        [{ text: `var_${i}`, font: CODE }, { text: ` (${phrase(2)})`, font: MUTED }],
        [{ text: `${phrase(25)}.` }, { text: ` ${phrase(12)}`, font: MUTED }],
        [{ text: i % 3 ? "integer" : "number + coded values", font: BOLD }],
        [{ text: i % 5 ? "pattern ^[A-Z]{3}[0-9]{4}$" : "date-time", font: CODE }],
        [
          { text: "1", font: BOLD },
          { text: ` = ${phrase(4)}\n` },
          { text: "2", font: BOLD },
          { text: ` = ${phrase(4)}\n` },
          { text: "888", font: BOLD },
          { text: ` = ${phrase(3)} [when ${phrase(3)}]`, font: MUTED }
        ],
        [{ text: `Minimum ${i % 100}; maximum ${(i % 100) + 50}. ${phrase(8)}.` }],
        [{ text: `{"source":"${phrase(3)}","ref":"#/definitions/${phrase(1)}","note":"${phrase(10)}"}`, font: CODE }]
      ]
    });
  }
  return {
    properties: { title: "Big" },
    sheets: [{ name: "Data dictionary", columns: Array.from({ length: 8 }, () => ({ width: 30, style: WRAP_TOP })), freeze: { rows: 1 }, autoFilter: `A1:H${rows + 1}`, rows: out }]
  };
}

test("perf: 10,000 rows × 8 rich-text columns (~20 MB of XML) build within budget", () => {
  const workbook = bigWorkbook(10_000);
  // The best of two builds: node --test runs the other files alongside this one.
  let best = Infinity;
  let bytes;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const start = performance.now();
    bytes = buildXlsx(workbook);
    best = Math.min(best, performance.now() - start);
  }
  const entries = readZip(bytes);
  const xmlBytes = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  assert.ok(xmlBytes > 18e6, `${(xmlBytes / 1e6).toFixed(1)} MB of XML`);
  assert.ok(best < 6000 * scale, `build took ${best.toFixed(0)} ms for ${(xmlBytes / 1e6).toFixed(1)} MB of XML`);
  assert.ok(bytes.length * 8 < xmlBytes, `compressed ${(xmlBytes / bytes.length).toFixed(1)}×`);
  const sheet = entries.get("xl/worksheets/sheet1.xml").data.toString("utf8");
  assert.equal(sheet.split("<row ").length - 1, 10_001);
  assert.match(sheet, /<dimension ref="A1:H10001"\/>/);
});
