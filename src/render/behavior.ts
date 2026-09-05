// Interactive behavior for the web component: the search box drives one ranked results
// list (the categories are hidden as a whole while a query is active — rows never move),
// category collapse/expand (materialising lazy rows on demand), CSV copy/download, the
// semantic status chip and keyboard shortcuts ("/" to focus, Esc to clear).
//
// `attachBehavior` wires a live DOM tree around a `SearchEngine`. `inlineScript` returns
// the self-contained script of the static `tableToHtml` output, which keeps its own in-place
// filter (every row is materialised there and the page has no engine).

import type { SemanticIndex, SemanticStatus } from "../search/types";
import type { ViewModel } from "./viewModel";
import type { SearchEngine, SearchResult } from "../search/types";
import { attachLazyRows } from "./lazyRows";
import { createResultsView } from "./results";
import { COMPONENT_ROW_OPTIONS } from "./markup";
import { eventTarget } from "./dom";
import type { Root } from "./dom";

export interface BehaviorOptions {
  vm: ViewModel;
  /** CSV export, computed on first use. */
  csv: () => string;
  filename: string;
  engine: SearchEngine;
  /** Drives the status chip when semantic search is configured. */
  semanticIndex?: SemanticIndex | undefined;
}

export function attachBehavior(root: Root, opts: BehaviorOptions): () => void {
  const { vm, engine } = opts;
  const search = root.querySelector<HTMLInputElement>("[data-dd-search]");
  const countEl = root.querySelector<HTMLElement>("[data-dd-count]");
  const empty = root.querySelector<HTMLElement>("[data-dd-empty]");
  const emptyQ = root.querySelector<HTMLElement>("[data-dd-empty-q]");
  const emptySemantic = root.querySelector<HTMLElement>("[data-dd-empty-semantic]");
  const categories = root.querySelector<HTMLElement>("[data-dd-categories]");
  const statusEl = root.querySelector<HTMLElement>("[data-dd-semantic-status]");
  const total = countEl?.dataset.total ?? String(vm.variableCount);

  const lazy = attachLazyRows(root, vm, { pageSize: vm.options.pageSize, rowOptions: COMPONENT_ROW_OPTIONS });
  const results = createResultsView(root, vm, {
    pageSize: vm.options.resultsPageSize,
    rowOptions: { ...COMPONENT_ROW_OPTIONS, categoryTag: true }
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
        setCount(`${total} variables`);
        if (empty) empty.hidden = true;
        if (emptySemantic) emptySemantic.hidden = true;
        return;
      }
      const r = engine.search(raw);
      results.render(r, raw);
      if (categories) categories.hidden = true;
      const shown = r.exactCount + r.relatedCount;
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
      return;
    }
    const button = target.closest<HTMLElement>("[data-dd-action]");
    if (!button) return;
    const action = button.dataset.ddAction;
    if (action === "expand-all" || action === "collapse-all") {
      const collapsed = action === "collapse-all";
      root.querySelectorAll<HTMLElement>("[data-dd-category]").forEach((cat) => setCollapsed(cat, collapsed));
    } else if (action === "copy") {
      void navigator.clipboard?.writeText(opts.csv()).then(() => flash(button, "Copied!"));
    } else if (action === "download") {
      downloadCsv(opts.csv(), opts.filename);
    }
  };
  root.addEventListener("click", onClick);

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

function isTyping(target: Element | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

function flash(btn: HTMLElement, text: string): void {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Self-contained behavior script for the static HTML output, scoped to `#${rootId}`: the
 * in-place filter (hide/highlight rows, per-category counts), collapse/expand, CSV export
 * and shortcuts. `<` is escaped in the embedded JSON so no value can close the script.
 */
export function inlineScript(rootId: string, csv: string, filename: string): string {
  const data = JSON.stringify({ id: rootId, csv, filename }).replace(/</g, "\\u003c");
  return `(function(){
var D=${data};var root=document.getElementById(D.id);if(!root)return;
function isTyping(t){return t&&t.tagName&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable);}
function origin(e){return e.composedPath?e.composedPath()[0]:e.target;}
function setCollapsed(c,v){c.dataset.collapsed=String(v);var t=c.querySelector('[data-dd-category-toggle]');if(t)t.setAttribute('aria-expanded',String(!v));}
function clearHi(){var ps=new Set();root.querySelectorAll('mark.dd-hit').forEach(function(m){var p=m.parentNode;if(!p)return;p.replaceChild(document.createTextNode(m.textContent||''),m);ps.add(p);});ps.forEach(function(p){p.normalize();});}
function hi(row,q){var w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT,{acceptNode:function(n){if(!n.nodeValue||!n.nodeValue.trim())return NodeFilter.FILTER_REJECT;var e=n.parentElement;while(e&&e!==row){if(e.classList.contains('dd-additional'))return NodeFilter.FILTER_REJECT;e=e.parentElement;}return NodeFilter.FILTER_ACCEPT;}});var ns=[];while(w.nextNode())ns.push(w.currentNode);ns.forEach(function(n){var tx=n.nodeValue||'',lo=tx.toLowerCase(),i=lo.indexOf(q);if(i<0)return;var f=document.createDocumentFragment(),last=0;while(i>=0){if(i>last)f.appendChild(document.createTextNode(tx.slice(last,i)));var mk=document.createElement('mark');mk.className='dd-hit';mk.textContent=tx.slice(i,i+q.length);f.appendChild(mk);last=i+q.length;i=lo.indexOf(q,last);}if(last<tx.length)f.appendChild(document.createTextNode(tx.slice(last)));if(n.parentNode)n.parentNode.replaceChild(f,n);});}
var search=root.querySelector('[data-dd-search]'),countEl=root.querySelector('[data-dd-count]'),empty=root.querySelector('[data-dd-empty]'),emptyQ=root.querySelector('[data-dd-empty-q]');
function fit(){if(search&&countEl)search.style.paddingRight=(countEl.offsetWidth+18)+'px';}
function filter(raw){var q=(raw||'').trim().toLowerCase();clearHi();var total=0;root.querySelectorAll('[data-dd-category]').forEach(function(cat){var vis=0;cat.querySelectorAll('[data-dd-row]').forEach(function(row){var m=!q||(row.dataset.search||'').indexOf(q)>=0;row.hidden=!m;if(m){vis++;total++;if(q)hi(row,q);}});var cc=cat.querySelector('[data-dd-cat-count]');if(cc)cc.textContent=q?vis+' / '+(cc.dataset.total||''):(cc.dataset.total||'');cat.hidden=!!q&&vis===0;if(q&&vis>0)setCollapsed(cat,false);});if(countEl){var t=countEl.dataset.total||'0';countEl.textContent=q?total+' / '+t+' variables':t+' variables';}if(empty){empty.hidden=!(q&&total===0);if(emptyQ)emptyQ.textContent=(raw||'').trim();}fit();}
var rows=root.querySelectorAll('[data-dd-row]').length,wait=rows>2000?120:rows>500?40:0,timer=null;
function onInput(){if(!wait){filter(search.value);return;}if(timer)clearTimeout(timer);timer=setTimeout(function(){timer=null;filter(search.value);},wait);}
fit();if(search)search.addEventListener('input',onInput);
root.querySelectorAll('[data-dd-category-toggle]').forEach(function(b){b.addEventListener('click',function(){var c=b.closest('[data-dd-category]');if(c)setCollapsed(c,c.dataset.collapsed!=='true');});});
root.querySelectorAll('[data-dd-action]').forEach(function(b){b.addEventListener('click',function(){var a=b.getAttribute('data-dd-action');if(a==='expand-all'||a==='collapse-all'){var col=a==='collapse-all';root.querySelectorAll('[data-dd-category]').forEach(function(c){setCollapsed(c,col);});}else if(a==='copy'){if(navigator.clipboard)navigator.clipboard.writeText(D.csv).then(function(){var o=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=o;},1200);});}else if(a==='download'){var bl=new Blob([D.csv],{type:'text/csv;charset=utf-8'}),u=URL.createObjectURL(bl),an=document.createElement('a');an.href=u;an.download=D.filename;document.body.appendChild(an);an.click();an.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);}});});
document.addEventListener('keydown',function(e){var t=origin(e);if(e.key==='/'&&!isTyping(t)){e.preventDefault();if(search)search.focus();}else if(e.key==='Escape'&&t===search&&search){if(timer){clearTimeout(timer);timer=null;}search.value='';filter('');}});
})();`;
}
