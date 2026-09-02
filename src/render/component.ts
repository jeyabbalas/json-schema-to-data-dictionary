// Interactive renderer: a <json-data-dictionary> custom element (Shadow DOM by default for
// style isolation) plus the renderDataDictionary() convenience mount.
//
// The element class is created lazily so importing this module in a non-DOM environment
// (Node, SSR) does not reference HTMLElement at evaluation time.

import type { DataDictionaryTable, RenderOptions, SemanticSearchOptions } from "../types";
import type { Embedder, SemanticIndex } from "../search/types";
import type { SearchFields } from "../search/ranking";
import { createSemanticIndex } from "../search/semanticIndex";
import { slugify } from "../utils";
import { tableToCsv } from "../serialize";
import { buildViewModel } from "./viewModel";
import type { ViewModel } from "./viewModel";
import { buildMarkup } from "./markup";
import { STYLES } from "./styles";
import { attachBehavior } from "./behavior";
import type { SemanticBehaviorOptions } from "./behavior";

export const ELEMENT_TAG = "json-data-dictionary";
const GLOBAL_STYLE_ID = "json-data-dictionary-styles";

export interface DataDictionaryElement extends HTMLElement {
  table: DataDictionaryTable | undefined;
  options: RenderOptions;
  /** The semantic index behind the search box, when `options.semanticSearch` is set. */
  readonly semanticIndex: SemanticIndex | undefined;
}

interface SemanticState {
  table: DataDictionaryTable;
  embedder: Embedder;
  index: SemanticIndex;
  unsubscribe: () => void;
}

let ElementClass: (new () => DataDictionaryElement) | undefined;

function getElementClass(): new () => DataDictionaryElement {
  if (ElementClass) return ElementClass;
  if (typeof HTMLElement === "undefined") throw new Error("A DOM environment is required to use <json-data-dictionary>.");

  class JsonDataDictionaryElement extends HTMLElement {
    private _table: DataDictionaryTable | undefined;
    private _options: RenderOptions = {};
    private _cleanup: (() => void) | undefined;
    private _semantic: SemanticState | undefined;

    get semanticIndex(): SemanticIndex | undefined {
      return this._semantic?.index;
    }

    get table(): DataDictionaryTable | undefined {
      return this._table;
    }
    set table(value: DataDictionaryTable | undefined) {
      this._table = value;
      this.renderNow();
    }

    get options(): RenderOptions {
      return this._options;
    }
    set options(value: RenderOptions) {
      this._options = value ?? {};
      this.renderNow();
    }

    connectedCallback(): void {
      this.renderNow();
    }

    disconnectedCallback(): void {
      this._cleanup?.();
      this._cleanup = undefined;
      this.dropSemanticIndex();
    }

    // One index per (table, embedder) pair, kept across re-renders. Rebuilding after a table
    // or embedder change is cheap: vectors come back from the cache, the model is never reloaded.
    private syncSemanticIndex(): void {
      const cfg = this._options.semanticSearch;
      const current = this._semantic;
      if (current && (!cfg || !this._table || current.table !== this._table || current.embedder !== cfg.embedder)) {
        this.dropSemanticIndex();
      }
      if (!cfg || !this._table || this._semantic) return;
      try {
        const index = createSemanticIndex(this._table, { embedder: cfg.embedder, cache: cfg.cache });
        const unsubscribe = cfg.onStatus ? index.subscribe(cfg.onStatus) : () => {};
        this._semantic = { table: this._table, embedder: cfg.embedder, index, unsubscribe };
        cfg.onStatus?.(index.status);
      } catch {
        /* keyword search keeps working without an index */
      }
    }

    private dropSemanticIndex(): void {
      const state = this._semantic;
      if (!state) return;
      this._semantic = undefined;
      state.unsubscribe();
      state.index.dispose();
    }

    private renderNow(): void {
      if (!this.isConnected || !this._table) return;
      this.syncSemanticIndex();
      const vm = buildViewModel(this._table, this._options);
      const useShadow = this._options.shadow !== false;
      const markup = buildMarkup(vm);
      const csv = tableToCsv(this._table);
      const filename = `${slugify(vm.title)}.csv`;
      const cfg = this._options.semanticSearch;
      const semantic = this._semantic && cfg ? semanticBehavior(this._semantic.index, cfg, vm) : undefined;

      this._cleanup?.();

      let container: ShadowRoot | HTMLElement;
      if (useShadow) {
        const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>${STYLES}</style>${markup}`;
        container = shadow;
      } else {
        ensureGlobalStyles(this.ownerDocument);
        this.innerHTML = markup;
        container = this;
      }
      this._cleanup = attachBehavior(container, { csv, filename, ...(semantic ? { semantic } : {}) });
    }
  }

  ElementClass = JsonDataDictionaryElement as unknown as new () => DataDictionaryElement;
  return ElementClass;
}

/** Register the <json-data-dictionary> custom element (no-op outside a DOM / if already defined). */
export function defineDataDictionaryElement(tag: string = ELEMENT_TAG): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(tag)) customElements.define(tag, getElementClass());
}

/**
 * Render the data dictionary into a container element as an interactive, searchable table.
 * Uses a Shadow DOM for style isolation by default; pass `{ shadow: false }` to render in
 * light DOM so your app's CSS cascades in.
 */
export function renderDataDictionary(
  container: HTMLElement,
  table: DataDictionaryTable,
  options: RenderOptions = {}
): DataDictionaryElement {
  if (typeof document === "undefined") throw new Error("renderDataDictionary requires a DOM environment.");
  defineDataDictionaryElement();
  const doc = container.ownerDocument ?? document;
  const el = doc.createElement(ELEMENT_TAG) as DataDictionaryElement;
  el.options = options;
  el.table = table;
  if (options.replace === false) container.appendChild(el);
  else container.replaceChildren(el);
  return el;
}

const EMPTY_FIELDS: SearchFields = { name: "", description: "", values: "", all: "" };

function semanticBehavior(index: SemanticIndex, cfg: SemanticSearchOptions, vm: ViewModel): SemanticBehaviorOptions {
  const rows: SearchFields[] = Array.from({ length: vm.variableCount }, () => EMPTY_FIELDS);
  for (const category of vm.categories) {
    for (const row of category.rows) if (row.index >= 0 && row.index < rows.length) rows[row.index] = row.searchFields;
  }
  return {
    index,
    rows,
    maxRelated: cfg.maxRelated ?? 10,
    minScore: cfg.minScore,
    minQueryLength: cfg.minQueryLength ?? 3,
    debounceMs: cfg.debounceMs ?? 250
  };
}

function ensureGlobalStyles(doc: Document): void {
  if (!doc || doc.getElementById(GLOBAL_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = GLOBAL_STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

// Auto-register when loaded in a browser-like environment so `<json-data-dictionary>`
// works without an explicit define() call.
if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined") {
  try {
    defineDataDictionaryElement();
  } catch {
    /* ignore */
  }
}
