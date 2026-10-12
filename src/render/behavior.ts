// Interactive behavior for the web component: the search box drives one ranked results
// list (the categories are hidden as a whole while a query is active — rows never move),
// category collapse/expand (materialising lazy rows on demand), the toolbar's panels, jumps
// to the variables skip patterns name, column resizing, CSV copy and the download (an Excel
// workbook by default), the semantic status chip and keyboard shortcuts ("/" to focus, Esc to
// clear).
//
// `attachBehavior` wires a live DOM tree around a `SearchEngine`. `inlineScript` returns
// the self-contained script of the static `tableToHtml` output, which keeps its own in-place
// filter (every row is materialised there and the page has no engine).

import type { SemanticIndex, SemanticStatus } from "../search/types";
import type { RowVM, ViewModel } from "./viewModel";
import { rowVMsByTableIndex } from "./viewModel";
import type { SearchEngine, SearchResult } from "../search/types";
import { attachLazyRows } from "./lazyRows";
import { createResultsView } from "./results";
import { COMPONENT_ROW_OPTIONS } from "./markup";
import { skipsDetailMarkup } from "./rowMarkup";
import { attachColumnResize } from "./columns";
import type { WidthsByKey } from "./columns";
import { eventTarget, focusRow, insertRows } from "./dom";
import type { Root } from "./dom";

/** A file the download button saves. */
export interface DownloadFile {
  data: Uint8Array | string;
  filename: string;
  /** Media type of the file. */
  type: string;
}

export interface BehaviorOptions {
  vm: ViewModel;
  /** CSV text for the copy button, computed on first use. */
  csv: () => string;
  /** The file the download button saves (an Excel workbook or a CSV file), computed on use. */
  download: () => DownloadFile;
  engine: SearchEngine;
  /** Drives the status chip when semantic search is configured. */
  semanticIndex?: SemanticIndex | undefined;
  /** Column widths to start from (by key); defaults to the view model's. */
  columnWidths?: WidthsByKey | undefined;
  /** Hears every committed column-width change (all widths set so far, the key that changed). */
  onColumnsChange?: ((widths: WidthsByKey, key: string | null) => void) | undefined;
}

export function attachBehavior(root: Root, opts: BehaviorOptions): () => void {
  const { vm, engine } = opts;
  const search = root.querySelector<HTMLInputElement>("[data-dd-search]");
  const countEl = root.querySelector<HTMLElement>("[data-dd-count]");
  const empty = root.querySelector<HTMLElement>("[data-dd-empty]");
  const emptyQ = root.querySelector<HTMLElement>("[data-dd-empty-q]");
  const emptySemantic = root.querySelector<HTMLElement>("[data-dd-empty-semantic]");
  const categories = root.querySelector<HTMLElement>("[data-dd-categories]");
  const viewport = root.querySelector<HTMLElement>("[data-dd-viewport]");
  const resultsBody = root.querySelector<HTMLElement>("[data-dd-results-body]");
  const statusEl = root.querySelector<HTMLElement>("[data-dd-semantic-status]");
  const ddRoot = root.querySelector<HTMLElement>("[data-dd-root]");
  const total = countEl?.dataset.total ?? String(vm.variableCount);

  const lazy = attachLazyRows(root, vm, { pageSize: vm.options.pageSize, rowOptions: COMPONENT_ROW_OPTIONS });
  const results = createResultsView(root, vm, {
    pageSize: vm.options.resultsPageSize,
    rowOptions: { ...COMPONENT_ROW_OPTIONS, categoryTag: true, indent: false }
  });

  // The counter overlays the right end of the input. Padding the input by the counter's width
  // keeps typed text clear of it, and browsers then draw their native clear ("x") button at the
  // content edge, i.e. just left of the counter, instead of underneath it.
  const fitCount = (): void => {
    if (!search || !countEl) return;
    search.style.paddingRight = `${countEl.offsetWidth + 18}px`;
  };
  const setCount = (text: string): void => {
    if (!countEl || countEl.textContent === text) return;
    countEl.textContent = text;
    fitCount();
  };

  let lastRaw = "";
  let inApply = false;

  const apply = (raw: string): void => {
    inApply = true;
    try {
      lastRaw = raw;
      const q = raw.trim().toLowerCase();
      if (!q) {
        results.clear();
        if (categories) categories.hidden = false;
        if (viewport) viewport.hidden = false;
        setCount(`${total} variables`);
        if (empty) empty.hidden = true;
        if (emptySemantic) emptySemantic.hidden = true;
        return;
      }
      const r = engine.search(raw);
      results.render(r, raw);
      if (categories) categories.hidden = true;
      const shown = r.exactCount + r.relatedCount;
      // Nothing to show: the empty-state line replaces the sheet (and its bare column header).
      if (viewport) viewport.hidden = shown === 0;
      setCount(`${shown} / ${total} variables${r.relatedCount ? ` · ${r.relatedCount} related` : ""}`);
      if (empty) {
        empty.hidden = shown > 0;
        if (emptyQ) emptyQ.textContent = raw.trim();
      }
      const looking = r.semantic.state === "pending" || r.semantic.state === "partial";
      if (emptySemantic) emptySemantic.hidden = !(shown === 0 && looking);
    } finally {
      inApply = false;
    }
  };

  fitCount();
  const onInput = (): void => apply(search?.value ?? "");
  search?.addEventListener("input", onInput);

  // Semantic hits (or an index that became ready) re-render the current query in place. The
  // engine only reports on its current query; re-applying the box's value keeps both in step.
  const unsubscribeEngine = engine.subscribe((r: SearchResult) => {
    if (inApply || !lastRaw.trim()) return;
    const current = engine.current;
    if (current && r.normalizedQuery !== current.normalizedQuery) return;
    apply(lastRaw);
  });

  const sections = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>("[data-dd-category]")];
  const syncCollapseAll = (): void => syncCollapseButton(root, sections());

  // Where each variable lives, for the jumps from skip patterns: its section and position there.
  let places: Map<string, { cat: number; position: number; index: number }> | undefined;
  const placeOf = (name: string): { cat: number; position: number; index: number } | undefined => {
    if (!places) {
      places = new Map();
      vm.categories.forEach((c, cat) =>
        c.rows.forEach((row, position) => {
          if (!places?.has(row.name)) places?.set(row.name, { cat, position, index: row.index });
        })
      );
    }
    return places.get(name);
  };

  /** Bring a variable's row into view and flash it: in the results list if it is there, else in its section. */
  const goTo = (name: string): void => {
    const place = placeOf(name);
    if (!place) return;
    const selector = `[data-dd-row-index="${place.index}"]`;
    let row = search?.value.trim() ? resultsBody?.querySelector<HTMLElement>(selector) ?? null : null;
    if (!row) {
      if (search?.value.trim()) {
        search.value = "";
        apply("");
      }
      const section = sections()[place.cat];
      if (!section) return;
      if (section.dataset.collapsed === "true") {
        setCollapsed(section, false);
        syncCollapseAll();
      }
      lazy.materializeThrough(section, place.position);
      row = section.querySelector<HTMLElement>(selector);
    }
    if (!row) return;
    const smooth = !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    row.scrollIntoView?.({ block: "start", behavior: smooth ? "smooth" : "auto" });
    row.classList.remove("dd-flash");
    void row.offsetWidth; // restart the animation when the same row is flashed twice
    row.classList.add("dd-flash");
    const flashed = row;
    setTimeout(() => flashed.classList.remove("dd-flash"), 2100);
    focusRow(row, true);
  };

  // A variable's skip-pattern row is built the first time it is opened (rows are re-rendered on
  // every keystroke of a search, and most such rows are never opened).
  let rowVMs: Array<RowVM | undefined> | undefined;
  const ensureDetail = (button: HTMLElement): void => {
    const row = button.closest<HTMLElement>("tr");
    if (!row || row.nextElementSibling?.hasAttribute("data-dd-detail")) return;
    rowVMs ??= rowVMsByTableIndex(vm);
    const rowVM = rowVMs[Number(row.dataset.ddRowIndex)];
    if (!rowVM || !row.parentElement) return;
    const { id, html } = skipsDetailMarkup(rowVM, vm);
    insertRows(row.parentElement, html, row.nextSibling);
    button.setAttribute("aria-controls", id);
  };

  const togglePanel = (key: string, open?: boolean): void => {
    for (const panel of root.querySelectorAll<HTMLElement>("[data-dd-panel]")) {
      const show = panel.dataset.ddPanel === key ? (open ?? panel.hidden) : false;
      panel.hidden = !show;
      root.querySelector(`[data-dd-panel-toggle="${panel.dataset.ddPanel}"]`)?.setAttribute("aria-expanded", String(show));
    }
  };

  const onClick = (e: Event): void => {
    const target = eventTarget(e);
    if (!target) return;
    const toggle = target.closest<HTMLElement>("[data-dd-category-toggle]");
    if (toggle) {
      const cat = toggle.closest<HTMLElement>("[data-dd-category]");
      if (!cat) return;
      const collapsed = cat.dataset.collapsed !== "true";
      setCollapsed(cat, collapsed);
      if (!collapsed) lazy.ensureFirstPage(cat);
      syncCollapseAll();
      return;
    }
    const ref = target.closest<HTMLElement>("[data-dd-goto]");
    if (ref) {
      e.preventDefault();
      goTo(ref.dataset.ddGoto ?? "");
      return;
    }
    const skips = target.closest<HTMLElement>("[data-dd-skips]");
    if (skips) {
      ensureDetail(skips);
      toggleDetail(skips);
      return;
    }
    const panelToggle = target.closest<HTMLElement>("[data-dd-panel-toggle]");
    if (panelToggle) {
      togglePanel(panelToggle.dataset.ddPanelToggle ?? "");
      return;
    }
    if (target.closest("[data-dd-panel-close]")) {
      const key = target.closest<HTMLElement>("[data-dd-panel]")?.dataset.ddPanel ?? "";
      togglePanel(key, false);
      root.querySelector<HTMLElement>(`[data-dd-panel-toggle="${key}"]`)?.focus();
      return;
    }
    const button = target.closest<HTMLElement>("[data-dd-action]");
    if (!button) return;
    const action = button.dataset.ddAction;
    if (action === "expand-all" || action === "collapse-all") {
      const collapsed = action === "collapse-all";
      for (const cat of sections()) {
        setCollapsed(cat, collapsed);
        if (!collapsed) lazy.ensureFirstPage(cat);
      }
      syncCollapseAll();
    } else if (action === "copy") {
      void navigator.clipboard?.writeText(opts.csv()).then(() => flash(button, "Copied"));
    } else if (action === "download") {
      downloadFile(opts.download());
    }
  };
  root.addEventListener("click", onClick);

  const detachColumns = ddRoot
    ? attachColumnResize(ddRoot, opts.columnWidths ?? vm.options.columnWidths, opts.onColumnsChange ?? null)
    : () => {};

  const renderStatus = (status: SemanticStatus): void => {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.dataset.state = status.state;
    statusEl.removeAttribute("title");
    switch (status.state) {
      case "loading":
        statusEl.textContent =
          status.progress === undefined ? "Loading semantic model…" : `Loading semantic model… ${Math.round(status.progress * 100)} %`;
        break;
      case "indexing":
        statusEl.textContent = `Indexing variables… ${status.done} / ${status.total}`;
        break;
      case "ready":
        statusEl.textContent = "Semantic search on";
        break;
      case "error":
        statusEl.textContent = "Semantic search unavailable";
        statusEl.title = status.message;
        break;
    }
  };
  const unsubscribeIndex = opts.semanticIndex?.subscribe(renderStatus);
  if (opts.semanticIndex) renderStatus(opts.semanticIndex.status);

  // The listener sits on the document, where Shadow DOM retargets `event.target` to the host
  // element; the composed path still starts at the real origin.
  const doc = ("ownerDocument" in root && root.ownerDocument) || (typeof document !== "undefined" ? document : undefined);
  const onKey = (e: KeyboardEvent): void => {
    const origin = eventTarget(e);
    if (e.key === "/" && !isTyping(origin)) {
      e.preventDefault();
      search?.focus();
    } else if (e.key === "Escape" && search && origin === search) {
      search.value = "";
      apply("");
    } else if (e.key === "Escape" && origin && root.contains(origin) && origin.closest("[data-dd-panel]")) {
      // Several dictionaries can share the document: only a panel of this one closes.
      const key = origin.closest<HTMLElement>("[data-dd-panel]")?.dataset.ddPanel ?? "";
      togglePanel(key, false);
      root.querySelector<HTMLElement>(`[data-dd-panel-toggle="${key}"]`)?.focus();
    }
  };
  doc?.addEventListener("keydown", onKey);

  // Print every row, not just the materialised pages.
  const win = doc?.defaultView ?? undefined;
  const onBeforePrint = (): void => lazy.materializeAll();
  win?.addEventListener("beforeprint", onBeforePrint);

  return () => {
    search?.removeEventListener("input", onInput);
    root.removeEventListener("click", onClick);
    doc?.removeEventListener("keydown", onKey);
    win?.removeEventListener("beforeprint", onBeforePrint);
    unsubscribeEngine();
    unsubscribeIndex?.();
    detachColumns();
    results.dispose();
    lazy.dispose();
  };
}

// ---------------------------------------------------------------------------

function setCollapsed(cat: HTMLElement, collapsed: boolean): void {
  cat.dataset.collapsed = String(collapsed);
  const toggle = cat.querySelector<HTMLElement>("[data-dd-category-toggle]");
  toggle?.setAttribute("aria-expanded", String(!collapsed));
}

/** Open or close the skip-pattern row under a variable that skip patterns read. */
function toggleDetail(button: HTMLElement): void {
  const row = button.closest<HTMLElement>("tr");
  const detail = row?.nextElementSibling as HTMLElement | null | undefined;
  if (!row || !detail || !detail.hasAttribute("data-dd-detail")) return;
  const open = !!detail.hidden; // `hidden` may also be "until-found", which is hidden too
  detail.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  row.classList.toggle("dd-row-open", open);
}

/** One button collapses every section, or expands them all once they are all collapsed. */
function syncCollapseButton(root: Root, sections: HTMLElement[]): void {
  const button = root.querySelector<HTMLElement>('[data-dd-action="collapse-all"], [data-dd-action="expand-all"]');
  if (!button) return;
  const expand = sections.length > 0 && sections.every((s) => s.dataset.collapsed === "true");
  const label = expand ? "Expand all" : "Collapse all";
  button.dataset.ddAction = expand ? "expand-all" : "collapse-all";
  button.title = label;
  button.setAttribute("aria-label", label);
}

function isTyping(target: Element | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

function flash(btn: HTMLElement, text: string): void {
  const original = btn.innerHTML;
  btn.textContent = text;
  setTimeout(() => {
    btn.innerHTML = original;
  }, 1200);
}

function downloadFile(file: DownloadFile): void {
  const blob = new Blob([file.data as BlobPart], { type: file.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The file the static page's download button saves, embedded in the page: text as it is, an
 * Excel workbook as base64.
 */
export interface EmbeddedFile {
  name: string;
  type: string;
  text?: string;
  base64?: string;
}

/**
 * Self-contained behavior script for the static HTML output, scoped to `#${rootId}`: the
 * in-place filter (hide/highlight rows, per-category counts), collapse/expand, the toolbar's
 * panels, jumps to the variables skip patterns name, column resizing (the component's own
 * `attachColumnResize`, inlined as source), CSV copy, the download and shortcuts. `<` is
 * escaped in the embedded JSON so no value can close the script.
 */
export function inlineScript(rootId: string, csv: string, file: EmbeddedFile | null, widths: WidthsByKey = {}): string {
  const data = JSON.stringify({ id: rootId, csv, file, widths }).replace(/</g, "\\u003c");
  return `(function(){
var D=${data};var root=document.getElementById(D.id);if(!root)return;var dd=root.querySelector('[data-dd-root]');
function isTyping(t){return t&&t.tagName&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable);}
function origin(e){return e.composedPath?e.composedPath()[0]:e.target;}
function setCollapsed(c,v){c.dataset.collapsed=String(v);var t=c.querySelector('[data-dd-category-toggle]');if(t)t.setAttribute('aria-expanded',String(!v));}
function cats(){return Array.prototype.slice.call(root.querySelectorAll('[data-dd-category]'));}
function syncAll(){var b=root.querySelector('[data-dd-action="collapse-all"],[data-dd-action="expand-all"]');if(!b)return;var cs=cats(),ex=cs.length>0&&cs.every(function(c){return c.dataset.collapsed==='true';}),l=ex?'Expand all':'Collapse all';b.setAttribute('data-dd-action',ex?'expand-all':'collapse-all');b.title=l;b.setAttribute('aria-label',l);}
function panel(k,open){root.querySelectorAll('[data-dd-panel]').forEach(function(p){var key=p.getAttribute('data-dd-panel'),show=key===k?(open===undefined?p.hidden:open):false;p.hidden=!show;var t=root.querySelector('[data-dd-panel-toggle="'+key+'"]');if(t)t.setAttribute('aria-expanded',String(show));});}
function clearHi(){var ps=new Set();root.querySelectorAll('mark.dd-hit').forEach(function(m){var p=m.parentNode;if(!p)return;p.replaceChild(document.createTextNode(m.textContent||''),m);ps.add(p);});ps.forEach(function(p){p.normalize();});}
function hi(row,q){var w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT,{acceptNode:function(n){if(!n.nodeValue||!n.nodeValue.trim())return NodeFilter.FILTER_REJECT;var e=n.parentElement;while(e&&e!==row){if(e.classList.contains('dd-additional')||e.classList.contains('dd-skips-toggle'))return NodeFilter.FILTER_REJECT;e=e.parentElement;}return NodeFilter.FILTER_ACCEPT;}});var ns=[];while(w.nextNode())ns.push(w.currentNode);ns.forEach(function(n){var tx=n.nodeValue||'',lo=tx.toLowerCase(),i=lo.indexOf(q);if(i<0)return;var f=document.createDocumentFragment(),last=0;while(i>=0){if(i>last)f.appendChild(document.createTextNode(tx.slice(last,i)));var mk=document.createElement('mark');mk.className='dd-hit';mk.textContent=tx.slice(i,i+q.length);f.appendChild(mk);last=i+q.length;i=lo.indexOf(q,last);}if(last<tx.length)f.appendChild(document.createTextNode(tx.slice(last)));if(n.parentNode)n.parentNode.replaceChild(f,n);});}
var search=root.querySelector('[data-dd-search]'),countEl=root.querySelector('[data-dd-count]'),empty=root.querySelector('[data-dd-empty]'),emptyQ=root.querySelector('[data-dd-empty-q]'),viewport=root.querySelector('[data-dd-viewport]');
function fit(){if(search&&countEl)search.style.paddingRight=(countEl.offsetWidth+18)+'px';}
function closeDetails(){root.querySelectorAll('[data-dd-detail]').forEach(function(d){d.hidden=true;var r=d.previousElementSibling;if(r){r.classList.remove('dd-row-open');var b=r.querySelector('[data-dd-skips]');if(b)b.setAttribute('aria-expanded','false');}});}
function filter(raw){var q=(raw||'').trim().toLowerCase();clearHi();closeDetails();var total=0;cats().forEach(function(cat){var vis=0;cat.querySelectorAll('[data-dd-row]').forEach(function(row){var m=!q||(row.dataset.search||'').indexOf(q)>=0;row.hidden=!m;if(m){vis++;total++;if(q)hi(row,q);}});var cc=cat.querySelector('[data-dd-cat-count]');if(cc)cc.textContent=q?vis+' / '+(cc.dataset.total||''):(cc.dataset.total||'');cat.hidden=!!q&&vis===0;if(q&&vis>0)setCollapsed(cat,false);});if(q)syncAll();if(viewport)viewport.hidden=!!q&&total===0;if(countEl){var t=countEl.dataset.total||'0';countEl.textContent=q?total+' / '+t+' variables':t+' variables';}if(empty){empty.hidden=!(q&&total===0);if(emptyQ)emptyQ.textContent=(raw||'').trim();}fit();}
function goTo(name){var rows=root.querySelectorAll('[data-dd-row]'),row=null;for(var i=0;i<rows.length;i++){var c=rows[i].querySelector('.dd-col-name code');if(c&&c.textContent===name){row=rows[i];break;}}if(!row)return;if(row.hidden&&search){if(timer){clearTimeout(timer);timer=null;}search.value='';filter('');}var cat=row.closest('[data-dd-category]');if(cat&&cat.dataset.collapsed==='true'){setCollapsed(cat,false);syncAll();}var still=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;row.scrollIntoView({block:'start',behavior:still?'auto':'smooth'});row.classList.remove('dd-flash');void row.offsetWidth;row.classList.add('dd-flash');setTimeout(function(){row.classList.remove('dd-flash');},2100);row.tabIndex=-1;row.focus({preventScroll:true});}
var rows=root.querySelectorAll('[data-dd-row]').length,wait=rows>2000?120:rows>500?40:0,timer=null;
function onInput(){if(!wait){filter(search.value);return;}if(timer)clearTimeout(timer);timer=setTimeout(function(){timer=null;filter(search.value);},wait);}
fit();if(search)search.addEventListener('input',onInput);
root.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;
var tg=t.closest('[data-dd-category-toggle]');if(tg){var c=tg.closest('[data-dd-category]');if(c){setCollapsed(c,c.dataset.collapsed!=='true');syncAll();}return;}
var r=t.closest('[data-dd-goto]');if(r){e.preventDefault();goTo(r.getAttribute('data-dd-goto'));return;}
var sk=t.closest('[data-dd-skips]');if(sk){var row=sk.closest('tr'),det=row&&row.nextElementSibling;if(det&&det.hasAttribute('data-dd-detail')){var op=det.hidden;det.hidden=!op;sk.setAttribute('aria-expanded',String(op));row.classList.toggle('dd-row-open',op);}return;}
var pt=t.closest('[data-dd-panel-toggle]');if(pt){panel(pt.getAttribute('data-dd-panel-toggle'));return;}
if(t.closest('[data-dd-panel-close]')){var p=t.closest('[data-dd-panel]');if(p)panel(p.getAttribute('data-dd-panel'),false);return;}
var b=t.closest('[data-dd-action]');if(!b)return;var a=b.getAttribute('data-dd-action');
if(a==='expand-all'||a==='collapse-all'){var col=a==='collapse-all';cats().forEach(function(c){setCollapsed(c,col);});syncAll();}
else if(a==='copy'){if(navigator.clipboard)navigator.clipboard.writeText(D.csv).then(function(){var o=b.innerHTML;b.textContent='Copied';setTimeout(function(){b.innerHTML=o;},1200);});}
else if(a==='download'&&D.file){var f=D.file,body=f.text;if(f.base64){var bin=atob(f.base64);body=new Uint8Array(bin.length);for(var k=0;k<bin.length;k++)body[k]=bin.charCodeAt(k);}var bl=new Blob([body],{type:f.type}),u=URL.createObjectURL(bl),an=document.createElement('a');an.href=u;an.download=f.name;document.body.appendChild(an);an.click();an.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);}});
document.addEventListener('keydown',function(e){var t=origin(e);if(e.key==='/'&&!isTyping(t)){e.preventDefault();if(search)search.focus();}else if(e.key==='Escape'&&t===search&&search){if(timer){clearTimeout(timer);timer=null;}search.value='';filter('');}else if(e.key==='Escape'&&t&&t.closest&&root.contains(t)&&t.closest('[data-dd-panel]')){panel(t.closest('[data-dd-panel]').getAttribute('data-dd-panel'),false);}});
if(dd)(${String(attachColumnResize)})(dd,D.widths,null);
})();`;
}
