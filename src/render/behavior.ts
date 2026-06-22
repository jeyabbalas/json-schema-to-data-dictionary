// Interactive behavior: search (filter + highlight + counts + empty state), category
// collapse/expand, CSV copy/download, and keyboard shortcuts ("/" to focus, Esc to clear).
//
// `attachBehavior` wires a live DOM tree (used by the web component). `inlineScript`
// returns an equivalent self-contained script string for the static `tableToHtml` output.

export interface BehaviorOptions {
  csv: string;
  filename: string;
}

type Root = Document | ShadowRoot | HTMLElement;

export function attachBehavior(root: Root, opts: BehaviorOptions): () => void {
  const search = root.querySelector<HTMLInputElement>("[data-dd-search]");
  const countEl = root.querySelector<HTMLElement>("[data-dd-count]");
  const empty = root.querySelector<HTMLElement>("[data-dd-empty]");
  const emptyQ = root.querySelector<HTMLElement>("[data-dd-empty-q]");

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
  };

  const onInput = (): void => applyFilter(search?.value ?? "");
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
      applyFilter("");
    }
  };
  doc?.addEventListener("keydown", onKey);

  return () => {
    search?.removeEventListener("input", onInput);
    doc?.removeEventListener("keydown", onKey);
  };
}

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

function highlightRow(row: HTMLElement, q: string): void {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let el = node.parentElement;
      while (el && el !== row) {
        if (el.classList.contains("dd-additional")) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

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
function filter(raw){var q=(raw||'').trim().toLowerCase();clearHi();var total=0;root.querySelectorAll('[data-dd-category]').forEach(function(cat){var vis=0;cat.querySelectorAll('[data-dd-row]').forEach(function(row){var m=!q||(row.dataset.search||'').indexOf(q)>=0;row.hidden=!m;if(m){vis++;total++;if(q)hi(row,q);}});var cc=cat.querySelector('[data-dd-cat-count]');if(cc)cc.textContent=q?vis+' / '+(cc.dataset.total||''):(cc.dataset.total||'');cat.hidden=!!q&&vis===0;if(q&&vis>0)setCollapsed(cat,false);});if(countEl){var t=countEl.dataset.total||'0';countEl.textContent=q?total+' / '+t+' variables':t+' variables';}if(empty){empty.hidden=!(q&&total===0);if(emptyQ)emptyQ.textContent=(raw||'').trim();}}
if(search)search.addEventListener('input',function(){filter(search.value);});
root.querySelectorAll('[data-dd-category-toggle]').forEach(function(b){b.addEventListener('click',function(){var c=b.closest('[data-dd-category]');if(c)setCollapsed(c,c.dataset.collapsed!=='true');});});
root.querySelectorAll('[data-dd-action]').forEach(function(b){b.addEventListener('click',function(){var a=b.dataset.action;if(a==='expand-all'||a==='collapse-all'){var col=a==='collapse-all';root.querySelectorAll('[data-dd-category]').forEach(function(c){setCollapsed(c,col);});}else if(a==='copy'){if(navigator.clipboard)navigator.clipboard.writeText(D.csv).then(function(){var o=b.textContent;b.textContent='Copied!';setTimeout(function(){b.textContent=o;},1200);});}else if(a==='download'){var bl=new Blob([D.csv],{type:'text/csv;charset=utf-8'}),u=URL.createObjectURL(bl),an=document.createElement('a');an.href=u;an.download=D.filename;document.body.appendChild(an);an.click();an.remove();setTimeout(function(){URL.revokeObjectURL(u);},1000);}});});
document.addEventListener('keydown',function(e){if(e.key==='/'&&!isTyping(e.target)){e.preventDefault();if(search)search.focus();}else if(e.key==='Escape'&&e.target===search&&search){search.value='';filter('');}});
})();`;
}
