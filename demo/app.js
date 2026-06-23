/*
 * Demo app for json-schema-data-dictionary.
 *
 * No schema editor: users either pick a built-in preset (window.DEMO_PRESETS,
 * generated from tests/fixtures by build-presets.mjs) or upload their own .json
 * files / folders. Each document is handed to the library as { uri, name, schema }
 * with a synthetic uri of https://demo.local/<path> so that relative $refs between
 * documents resolve exactly as they would on disk.
 */
(function () {
  "use strict";

  var API = window.JsonSchemaDataDictionary;
  var SYNTH_BASE = "https://demo.local/";

  var $ = function (sel) { return document.querySelector(sel); };

  // --- State --------------------------------------------------------------
  var docs = [];            // [{ path, schema }]
  var rootIndex = null;     // null = auto-detect; number = explicit root document
  var docsFromPreset = false;
  var lastTable = null;

  // --- Messages -----------------------------------------------------------
  function clearMessages() { $("#messages").replaceChildren(); }
  function addMessage(type, text) {
    var div = document.createElement("div");
    div.className = "message " + type;
    div.textContent = text;
    $("#messages").appendChild(div);
  }

  // --- Presets ------------------------------------------------------------
  function populatePresetSelect() {
    var sel = $("#preset-select");
    var presets = window.DEMO_PRESETS || [];
    sel.replaceChildren();
    if (!presets.length) {
      var o = document.createElement("option");
      o.textContent = "(no examples available — run npm run demo)";
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    presets.forEach(function (p, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = p.label;
      sel.appendChild(opt);
    });
  }

  function loadPreset(i) {
    var p = (window.DEMO_PRESETS || [])[i];
    if (!p) return;
    $("#preset-select").value = String(i);
    $("#preset-description").textContent = p.description || "";
    docs = p.documents.map(function (d) { return { path: d.path, schema: d.schema }; });
    docsFromPreset = true;
    rootIndex = null;
    afterDocsChanged();
  }

  // --- File / folder ingestion -------------------------------------------
  // Folder uploads (webkitdirectory / dropped directories) prefix every path with
  // the chosen folder's name. Strip that single common top segment so paths line up
  // with the relative $refs (e.g. "myset/categories/x.json" -> "categories/x.json").
  function stripCommonTopFolder(paths) {
    if (!paths.length) return paths;
    var i = paths[0].indexOf("/");
    var top = i === -1 ? paths[0] : paths[0].slice(0, i);
    var everyUnderTop = paths.every(function (p) { return p.indexOf(top + "/") === 0; });
    return everyUnderTop ? paths.map(function (p) { return p.slice(top.length + 1); }) : paths;
  }

  function isJson(name) { return /\.json$/i.test(name); }

  // Read + parse a list of { path, file } items, then merge into `docs`.
  function ingest(items) {
    if (!items.length) {
      clearMessages();
      addMessage("error", "No .json files found in that selection.");
      return Promise.resolve();
    }
    var paths = stripCommonTopFolder(items.map(function (it) { return it.path; }));
    var errors = [];
    var reads = items.map(function (it, k) {
      var path = paths[k];
      return it.file.text().then(
        function (text) {
          try { return { path: path, schema: JSON.parse(text) }; }
          catch (err) {
            errors.push({ type: "error", text: "JSON parse error in “" + path + "”: " + err.message });
            return null;
          }
        },
        function () {
          errors.push({ type: "error", text: "Could not read “" + path + "”." });
          return null;
        }
      );
    });

    return Promise.all(reads).then(function (results) {
      var parsed = results.filter(Boolean);
      if (!parsed.length) {
        clearMessages();
        errors.forEach(function (e) { addMessage(e.type, e.text); });
        return;
      }
      // Uploading replaces a preset, but multiple uploads accumulate into one set.
      if (docsFromPreset) { docs = []; docsFromPreset = false; }
      parsed.forEach(function (d) {
        var idx = docs.findIndex(function (x) { return x.path === d.path; });
        if (idx >= 0) docs[idx] = d; else docs.push(d);
      });
      rootIndex = null;
      afterDocsChanged(errors); // surface any per-file parse errors alongside the result
    });
  }

  function addFiles(fileList) {
    var items = Array.prototype.slice.call(fileList)
      .filter(function (f) { return isJson(f.name); })
      .map(function (f) { return { path: f.webkitRelativePath || f.name, file: f }; });
    return ingest(items);
  }

  // Recursively gather files (with relative paths) from a dropped directory entry.
  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (file) { out.push({ path: prefix + entry.name, file: file }); resolve(); },
          function () { resolve(); }
        );
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var readBatch = function () {
          reader.readEntries(function (batch) {
            if (!batch.length) { resolve(); return; }
            Promise.all(batch.map(function (child) {
              return walkEntry(child, prefix + entry.name + "/", out);
            })).then(readBatch); // readEntries yields in chunks; keep going until empty
          }, function () { resolve(); });
        };
        readBatch();
      } else {
        resolve();
      }
    });
  }

  function handleDrop(e) {
    var dt = e.dataTransfer;
    var entries = [];
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      // webkitGetAsEntry() must be called synchronously during the drop event.
      entries = Array.prototype.slice.call(dt.items)
        .map(function (it) { return it.webkitGetAsEntry(); })
        .filter(Boolean);
    }
    if (entries.length) {
      var collected = [];
      Promise.all(entries.map(function (entry) { return walkEntry(entry, "", collected); }))
        .then(function () {
          ingest(collected.filter(function (c) { return isJson(c.path); }));
        });
    } else if (dt.files && dt.files.length) {
      addFiles(dt.files);
    }
  }

  // --- Manifest + root selector ------------------------------------------
  function renderDocList() {
    var field = $("#doc-list-field");
    var list = $("#doc-list");
    $("#doc-count").textContent = String(docs.length);
    field.hidden = docs.length === 0;
    list.replaceChildren();
    docs.forEach(function (d, i) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "doc-path";
      name.textContent = d.path;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "doc-remove";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-label", "Remove " + d.path);
      btn.textContent = "×";
      li.append(name, btn);
      list.appendChild(li);
    });
  }

  function populateRootSelect() {
    var sel = $("#root-select");
    sel.replaceChildren();
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto-detect";
    sel.appendChild(auto);
    docs.forEach(function (d, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = d.path;
      sel.appendChild(o);
    });
    sel.value = rootIndex == null ? "" : String(rootIndex);
  }

  function removeDoc(i) {
    docs.splice(i, 1);
    rootIndex = null; // indices shifted; fall back to auto-detect
    afterDocsChanged();
  }

  function clearAll() {
    docs = [];
    rootIndex = null;
    docsFromPreset = false;
    afterDocsChanged();
  }

  // --- Build inputs + render ---------------------------------------------
  function buildInputs() {
    return docs.map(function (d) {
      var path = String(d.path || "document.json").replace(/^\/+/, "");
      return {
        uri: SYNTH_BASE + path,
        name: path.split("/").pop() || "document.json",
        schema: d.schema
      };
    });
  }

  function setExportsEnabled(on) {
    $("#download-html-btn").disabled = !on;
    $("#download-csv-btn").disabled = !on;
    // Excel export also needs the (vendored) ExcelJS global to have loaded.
    $("#download-excel-btn").disabled = !on || !window.ExcelJS;
  }

  function afterDocsChanged(extras) {
    renderDocList();
    populateRootSelect();
    render(extras);
  }

  function render(extras) {
    clearMessages();
    (extras || []).forEach(function (m) { addMessage(m.type, m.text); });

    var out = $("#output");
    if (!docs.length) {
      out.replaceChildren();
      lastTable = null;
      setExportsEnabled(false);
      addMessage("info", "Select an example or upload one or more JSON Schema files to begin.");
      return;
    }

    var table;
    try {
      var opts = rootIndex != null ? { rootIndex: rootIndex } : {};
      table = API.schemaDocumentsToTable(buildInputs(), opts);
    } catch (err) {
      out.replaceChildren();
      lastTable = null;
      setExportsEnabled(false);
      addMessage("error", "Couldn’t build the data dictionary: " + err.message);
      return;
    }

    lastTable = table;
    (table.warnings || []).forEach(function (w) { addMessage("warning", w); });

    API.renderDataDictionary(out, table, {
      shadow: $("#shadow").checked,
      theme: $("#theme").value,
      expandCategories: $("#expand-categories").checked,
      expandAdditionalInfo: $("#expand-additional").checked
    });
    setExportsEnabled(true);
  }

  // --- Export -------------------------------------------------------------
  function slug(s) {
    return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "data-dictionary";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
    });
  }

  function downloadBlob(filename, type, content) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadHtml() {
    if (!lastTable) return;
    var widget = API.tableToHtml(lastTable, { theme: $("#theme").value });
    var page =
      "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      "<title>" + escapeHtml(lastTable.title || "Data dictionary") + "</title>\n" +
      "<style>body{margin:0;padding:24px;max-width:1200px;margin-inline:auto;background:#fafbfc;}</style>\n" +
      "</head>\n<body>\n" + widget + "\n</body>\n</html>\n";
    downloadBlob(slug(lastTable.title) + ".html", "text/html;charset=utf-8", page);
  }

  function downloadCsv() {
    if (!lastTable) return;
    downloadBlob(slug(lastTable.title) + ".csv", "text/csv;charset=utf-8", API.tableToCsv(lastTable));
  }

  // Build a formatted .xlsx with ExcelJS: a leading Category column plus the seven
  // standard columns, a bold frozen header, auto-filter, sized columns and wrapped
  // long-text cells. Complex columns are stringified by toPlainRows into one cell each.
  var XLSX_COLUMNS = ["Category", "Variable name", "Description", "Data type", "Format", "Valid values", "Constraints", "Additional information"];
  var XLSX_WIDTHS = { "Category": 18, "Variable name": 26, "Description": 48, "Data type": 16, "Format": 18, "Valid values": 40, "Constraints": 32, "Additional information": 30 };
  var XLSX_WRAP = { "Description": 1, "Format": 1, "Valid values": 1, "Constraints": 1, "Additional information": 1 };

  function downloadExcel() {
    if (!lastTable || !window.ExcelJS) return;

    // includeInternalColumns adds the "Category" (and an unused "Source") field.
    var plain = API.toPlainRows(lastTable, { includeInternalColumns: true });

    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet("Data dictionary", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = XLSX_COLUMNS.map(function (c) {
      return { header: c, key: c, width: XLSX_WIDTHS[c], style: { alignment: { vertical: "top", wrapText: !!XLSX_WRAP[c] } } };
    });

    // Header row: bold white text on a dark fill.
    var head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.alignment = { vertical: "middle", wrapText: true };
    head.eachCell(function (cell) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    });

    plain.forEach(function (r) {
      var record = {};
      XLSX_COLUMNS.forEach(function (c) { record[c] = r[c] != null ? r[c] : ""; });
      ws.addRow(record);
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: XLSX_COLUMNS.length } };

    wb.xlsx.writeBuffer().then(
      function (buf) {
        downloadBlob(slug(lastTable.title) + ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf);
      },
      function (err) { addMessage("error", "Couldn’t build the Excel file: " + err.message); }
    );
  }

  // --- Wiring -------------------------------------------------------------
  function wire() {
    $("#preset-select").addEventListener("change", function (e) { loadPreset(Number(e.target.value)); });

    $("#file-input").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });
    $("#folder-input").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });

    var dz = $("#drop-zone");
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    });
    ["dragleave", "dragend"].forEach(function (ev) {
      dz.addEventListener(ev, function () { dz.classList.remove("dragover"); });
    });
    dz.addEventListener("drop", function (e) {
      e.preventDefault();
      dz.classList.remove("dragover");
      handleDrop(e);
    });

    $("#doc-list").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-index]");
      if (btn) removeDoc(Number(btn.dataset.index));
    });
    $("#clear-btn").addEventListener("click", clearAll);

    $("#root-select").addEventListener("change", function (e) {
      rootIndex = e.target.value === "" ? null : Number(e.target.value);
      render();
    });
    ["#theme", "#shadow", "#expand-categories", "#expand-additional"].forEach(function (sel) {
      $(sel).addEventListener("change", function () { render(); });
    });

    $("#download-html-btn").addEventListener("click", downloadHtml);
    $("#download-csv-btn").addEventListener("click", downloadCsv);
    $("#download-excel-btn").addEventListener("click", downloadExcel);
  }

  // --- Bootstrap ----------------------------------------------------------
  function start() {
    if (!API) {
      var banner = $("#missing-bundle");
      if (banner) banner.hidden = false;
      return;
    }
    populatePresetSelect();
    wire();
    if ((window.DEMO_PRESETS || []).length) loadPreset(0);
    else render(); // show the empty-state prompt
  }

  start();
})();
