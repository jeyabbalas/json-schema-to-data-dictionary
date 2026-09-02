// Interactive behavior: search (filter + highlight + counts + empty state), category
// collapse/expand, CSV copy/download, and keyboard shortcuts ("/" to focus, Esc to clear).
//
// `attachBehavior` wires a live DOM tree (used by the web component). `inlineScript`
// returns an equivalent self-contained script string for the static `tableToHtml` output.
//
// With `semantic` configured (interactive component only), the search box drives a single
// ranked results list instead of the in-place filter: every keyword match plus up to
// `maxRelated` semantically related rows, restored to their categories when cleared.

import type { SemanticHit, SemanticIndex, SemanticStatus } from "../search/types";
import type { SearchFields } from "../search/ranking";
import { rankResults } from "../search/ranking";

export interface SemanticBehaviorOptions {
  index: SemanticIndex;
  /** Per-row search fields, positioned like `data-dd-row-index`. */
  rows: readonly SearchFields[];
  maxRelated: number;
  minScore: number | undefined;
  minQueryLength: number;
  debounceMs: number;
}

export interface BehaviorOptions {
  csv: string;
  filename: string;
  semantic?: SemanticBehaviorOptions | undefined;
}

type Root = Document | ShadowRoot | HTMLElement;

export function attachBehavior(root: Root, opts: BehaviorOptions): () => void {
  const search = root.querySelector<HTMLInputElement>("[data-dd-search]");
  const countEl = root.querySelector<HTMLElement>("[data-dd-count]");
  const empty = root.querySelector<HTMLElement>("[data-dd-empty]");
  const emptyQ = root.querySelector<HTMLElement>("[data-dd-empty-q]");

  // The counter overlays the right end of the input. Padding the input by the counter's width
  // keeps typed text clear of it, and browsers then draw their native clear ("x") button at the
  // content edge, i.e. just left of the counter, instead of underneath it.
  const fitCount = (): void => {
    if (!search || !countEl) return;
    search.style.paddingRight = `${countEl.offsetWidth + 18}px`;
  };

  const applyFilter = (raw: string): void => {
    const q = raw.trim().toLowerCase();
    clearHighlights(root);
    let total = 0;

    root.querySelectorAll<HTMLElement>("[data-dd-category]").forEach((cat) => {
      let visible = 0;
      cat.querySelectorAll<HTMLElement>("[data-dd-row]").forEach((row) => {
        const match = !q || (row.dataset.search ?? "").includes(q);
        row.hidden = !match;
        if (match) {
          visible += 1;
          total += 1;
          if (q) highlightRow(row, q);
        }
      });
      const catCount = cat.querySelector<HTMLElement>("[data-dd-cat-count]");
      if (catCount) catCount.textContent = q ? `${visible} / ${catCount.dataset.total ?? ""}` : (catCount.dataset.total ?? "");
      cat.hidden = !!q && visible === 0;
      if (q && visible > 0) setCollapsed(cat, false);
    });

    if (countEl) {
      const t = countEl.dataset.total ?? "0";
      countEl.textContent = q ? `${total} / ${t} variables` : `${t} variables`;
    }
    if (empty) {
      empty.hidden = !(q && total === 0);
      if (emptyQ) emptyQ.textContent = raw.trim();
    }
    fitCount();
  };

  const ranked = opts.semantic ? createRankedSearch(root, opts.semantic, { countEl, empty, emptyQ, fitCount }) : undefined;
  const apply = ranked ? ranked.apply : applyFilter;
  fitCount();

  const onInput = (): void => apply(search?.value ?? "");
  search?.addEventListener("input", onInput);

  root.querySelectorAll<HTMLElement>("[data-dd-category-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.closest<HTMLElement>("[data-dd-category]");
      if (cat) setCollapsed(cat, cat.dataset.collapsed !== "true");
    });
  });

  root.querySelectorAll<HTMLElement>("[data-dd-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "expand-all" || action === "collapse-all") {
        const collapsed = action === "collapse-all";
        root.querySelectorAll<HTMLElement>("[data-dd-category]").forEach((cat) => setCollapsed(cat, collapsed));
      } else if (action === "copy") {
        void navigator.clipboard?.writeText(opts.csv).then(() => flash(btn, "Copied!"));
      } else if (action === "download") {
        downloadCsv(opts.csv, opts.filename);
      }
    });
  });

  const doc = ("ownerDocument" in root && root.ownerDocument) || (typeof document !== "undefined" ? document : undefined);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "/" && !isTyping(e.target)) {
      e.preventDefault();
      search?.focus();
    } else if (e.key === "Escape" && e.target === search && search) {
      search.value = "";
      apply("");
    }
  };
  doc?.addEventListener("keydown", onKey);

  return () => {
    search?.removeEventListener("input", onInput);
    doc?.removeEventListener("keydown", onKey);
    ranked?.dispose();
  };
}

// ---------------------------------------------------------------------------
// Ranked results (semantic search mode)

interface RankedSearch {
  apply(raw: string): void;
  dispose(): void;
}

interface SharedElements {
  countEl: HTMLElement | null;
  empty: HTMLElement | null;
  emptyQ: HTMLElement | null;
  fitCount: () => void;
}

function createRankedSearch(root: Root, semantic: SemanticBehaviorOptions, els: SharedElements): RankedSearch {
  const { index, rows, maxRelated, minScore, minQueryLength, debounceMs } = semantic;
  const results = root.querySelector<HTMLElement>("[data-dd-results]");
  const resultsBody = root.querySelector<HTMLElement>("[data-dd-results-body]");
  const statusEl = root.querySelector<HTMLElement>("[data-dd-semantic-status]");
  const emptySemantic = root.querySelector<HTMLElement>("[data-dd-empty-semantic]");
  const categories = [...root.querySelectorAll<HTMLElement>("[data-dd-category]")];

  // Every row's home <tbody> (in original order) so the categories can be restored, and a
  // lookup from table index to row element for the ranked list.
  const homes = new Map<HTMLElement, HTMLElement[]>();
  const rowEls = new Map<number, HTMLElement>();
  root.querySelectorAll<HTMLElement>("[data-dd-row]").forEach((row) => {
    const parent = row.parentElement;
    if (!parent) return;
    const list = homes.get(parent) ?? [];
    list.push(row);
    homes.set(parent, list);
    const idx = Number(row.dataset.ddRowIndex);
    if (Number.isInteger(idx) && idx >= 0) rowEls.set(idx, row);
  });

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight = false;
  let pending: { q: string; seq: number } | undefined;
  let disposed = false;
  let lastRaw = "";
  let currentQ = "";
  let semanticPending = false;

  const eligible = (q: string): boolean => q.length >= minQueryLength && !/^[\d\s.,\-]+$/.test(q) && index.status.state === "ready";

  const restoreRows = (): void => {
    for (const [tbody, list] of homes) tbody.append(...list);
    for (const row of rowEls.values()) {
      delete row.dataset.ddMatch;
      row.querySelector(".dd-col-name")?.removeAttribute("title");
    }
  };

  const render = (raw: string, hits: readonly SemanticHit[] | undefined): void => {
    const q = raw.trim().toLowerCase();
    clearHighlights(root);
    restoreRows();

    if (!q) {
      for (const list of homes.values()) for (const row of list) row.hidden = false;
      for (const cat of categories) {
        cat.hidden = false;
        const catCount = cat.querySelector<HTMLElement>("[data-dd-cat-count]");
        if (catCount) catCount.textContent = catCount.dataset.total ?? "";
      }
      if (results) results.hidden = true;
      if (els.countEl) els.countEl.textContent = `${els.countEl.dataset.total ?? "0"} variables`;
      if (els.empty) els.empty.hidden = true;
      if (emptySemantic) emptySemantic.hidden = true;
      els.fitCount();
      return;
    }

    for (const list of homes.values()) for (const row of list) row.hidden = true;
    let shown = 0;
    let related = 0;
    for (const r of rankResults(rows, q, hits, maxRelated)) {
      const row = rowEls.get(r.row);
      if (!row) continue;
      shown += 1;
      row.hidden = false;
      row.dataset.ddMatch = r.exact ? "exact" : "related";
      if (!r.exact) {
        related += 1;
        const nameCell = row.querySelector<HTMLElement>(".dd-col-name");
        if (nameCell) nameCell.title = `Related · similarity ${(r.semanticScore ?? 0).toFixed(2)}`;
      }
      resultsBody?.appendChild(row);
      if (r.exact) highlightRow(row, q);
    }
    for (const cat of categories) cat.hidden = true;
    if (results) results.hidden = shown === 0;
    if (els.countEl) {
      const t = els.countEl.dataset.total ?? "0";
      els.countEl.textContent = `${shown} / ${t} variables${related ? ` · ${related} related` : ""}`;
    }
    if (els.empty) {
      els.empty.hidden = shown > 0;
      if (els.emptyQ) els.emptyQ.textContent = raw.trim();
    }
    if (emptySemantic) emptySemantic.hidden = !(shown === 0 && semanticPending);
    els.fitCount();
  };

  // Latest-wins: at most one semantic query in flight and one pending.
  const runSemantic = (q: string, mySeq: number): void => {
    if (disposed || mySeq !== seq) return;
    if (inflight) {
      pending = { q, seq: mySeq };
      return;
    }
    inflight = true;
    let keywordHits = 0;
    for (const f of rows) if (f.all.includes(q)) keywordHits += 1;
    index
      .search(q, { limit: maxRelated + keywordHits, ...(minScore !== undefined ? { minScore } : {}) })
      .then(
        (hits) => {
          if (disposed || mySeq !== seq) return;
          semanticPending = false;
          render(lastRaw, hits);
        },
        () => {
          if (disposed || mySeq !== seq) return;
          semanticPending = false;
          render(lastRaw, undefined);
        }
      )
      .then(() => {
        inflight = false;
        const next = pending;
        pending = undefined;
        if (next && next.seq === seq) runSemantic(next.q, next.seq);
      });
  };

  const schedule = (q: string, mySeq: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runSemantic(q, mySeq);
    }, debounceMs);
  };

  const apply = (raw: string): void => {
    lastRaw = raw;
    currentQ = raw.trim().toLowerCase();
    seq += 1;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
    semanticPending = eligible(currentQ);
    render(raw, undefined);
    if (semanticPending) schedule(currentQ, seq);
  };

  const renderStatus = (status: SemanticStatus): void => {
    if (statusEl) {
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
    }
    // A query typed while the model was still loading gets its related rows once ready.
    if (status.state === "ready" && !disposed && currentQ && eligible(currentQ) && !semanticPending) {
      semanticPending = true;
      render(lastRaw, undefined);
      schedule(currentQ, seq);
    }
  };

  const unsubscribe = index.subscribe(renderStatus);
  renderStatus(index.status);

  return {
    apply,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    }
  };
}

// ---------------------------------------------------------------------------

function setCollapsed(cat: HTMLElement, collapsed: boolean): void {
  cat.dataset.collapsed = String(collapsed);
  const toggle = cat.querySelector<HTMLElement>("[data-dd-category-toggle]");
  toggle?.setAttribute("aria-expanded", String(!collapsed));
}

function isTyping(target: EventTarget | null): boolean {
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

function clearHighlights(root: Root): void {
  root.querySelectorAll("mark.dd-hit").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  });
}

/** Text nodes under `node`, skipping the JSON tree and the results-only category tag. */
function collectTextNodes(node: Node, out: Text[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      if ((child.nodeValue ?? "").trim()) out.push(child as Text);
    } else if (child.nodeType === 1) {
      const el = child as HTMLElement;
      if (el.classList.contains("dd-additional") || el.classList.contains("dd-row-cat")) continue;
      collectTextNodes(el, out);
    }
  }
}

function highlightRow(row: HTMLElement, q: string): void {
  const nodes: Text[] = [];
  collectTextNodes(row, nodes);

  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx >= 0) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className = "dd-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

/** Self-contained behavior script for the static HTML output, scoped to `#${rootId}`. */
export function inlineScript(rootId: string, csv: string, filename: string): string {
  const data = JSON.stringify({ id: rootId, csv, filename });
  return `(function(){
var D=${data};var root=document.getElementById(D.id);if(!root)return;
function isTyping(t){return t&&t.tagName&&(/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)||t.isContentEditable);}
function setCollapsed(c,v){c.dataset.collapsed=String(v);var t=c.querySelector('[data-dd-category-toggle]');if(t)t.setAttribute('aria-expanded',String(!v));}
function clearHi(){root.querySelectorAll('mark.dd-hit').forEach(function(m){var p=m.parentNode;if(!p)return;p.replaceChild(document.createTextNode(m.textContent||''),m);p.normalize();});}
function hi(row,q){var w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT,{acceptNode:function(n){if(!n.nodeValue||!n.nodeValue.trim())return NodeFilter.FILTER_REJECT;var e=n.parentElement;while(e&&e!==row){if(e.classList.contains('dd-additional'))return NodeFilter.FILTER_REJECT;e=e.parentElement;}return NodeFilter.FILTER_ACCEPT;}});var ns=[];while(w.nextNode())ns.push(w.currentNode);ns.forEach(function(n){var tx=n.nodeValue||'',lo=tx.toLowerCase(),i=lo.indexOf(q);if(i<0)return;var f=document.createDocumentFragment(),last=0;while(i>=0){if(i>last)f.appendChild(document.createTextNode(tx.slice(last,i)));var mk=document.createElement('mark');mk.className='dd-hit';mk.textContent=tx.slice(i,i+q.length);f.appendChild(mk);last=i+q.length;i=lo.indexOf(q,last);}if(last<tx.length)f.appendChild(document.createTextNode(tx.slice(last)));if(n.parentNode)n.parentNode.replaceChild(f,n);});}
var search=root.querySelector('[data-dd-search]'),countEl=root.querySelector('[data-dd-count]'),empty=root.querySelector('[data-dd-empty]'),emptyQ=root.querySelector('[data-dd-empty-q]');
function fit(){if(search&&countEl)search.style.paddingRight=(countEl.offsetWidth+18)+'px';}
function filter(raw){var q=(raw||'').trim().toLowerCase();clearHi();var total=0;root.querySelectorAll('[data-dd-category]').forEach(function(cat){var vis=0;cat.querySelectorAll('[data-dd-row]').forEach(function(row){var m=!q||(row.dataset.search||'').indexOf(q)>=0;row.hidden=!m;if(m){vis++;total++;if(q)hi(row,q);}});var cc=cat.querySelector('[data-dd-cat-count]');if(cc)cc.textContent=q?vis+' / '+(cc.dataset.total||''):(cc.dataset.total||'');cat.hidden=!!q&&vis===0;if(q&&vis>0)setCollapsed(cat,false);});if(countEl){var t=countEl.dataset.total||'0';countEl.textContent=q?total+' / '+t+' variables':t+' variables';}if(empty){empty.hidden=!(q&&total===0);if(emptyQ)emptyQ.textContent=(raw||'').trim();}fit();}
fit();if(search)search.addEventListener('input',function(){filter(search.value);});
root.querySelectorAll('[data-dd-category-toggle]').forEach(function(b){b.addEventListener('click',function(){var c=b.closest('[data-dd-category]');if(c)setCollapsed(c,c.dataset.collapsed!=='true');});});
root.querySelectorAll('[data-dd-action]').forEach(function(b){b.addEventListener('click',function(){var a=b.dataset.action;if(a==='expand-all'||a==='collapse-all'){var col=a==='collapse-all';root.querySelectorAll('[data-dd-category]').forEach(function(c){setCollapsed(c,col);});}else if(a==='copy'){if(navigator.clipboard)navigator.clipboard.writeText(D.csv).then(function(){var o=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=o;},1200);});}else if(a==='download'){var bl=new Blob([D.csv],{type:'text/csv;charset=utf-8'}),u=URL.createObjectURL(bl),an=document.createElement('a');an.href=u;an.download=D.filename;document.body.appendChild(an);an.click();an.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);}});});
document.addEventListener('keydown',function(e){if(e.key==='/'&&!isTyping(e.target)){e.preventDefault();if(search)search.focus();}else if(e.key==='Escape'&&e.target===search&&search){search.value='';filter('');}});
})();`;
}
