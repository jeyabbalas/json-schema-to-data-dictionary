// Interactive renderer: a <json-data-dictionary> custom element (Shadow DOM by default for
// style isolation) plus the renderDataDictionary() convenience mount.
//
// The element class is created lazily so importing this module in a non-DOM environment
// (Node, SSR) does not reference HTMLElement at evaluation time.

import type { DataDictionaryTable, RenderOptions } from "../types";
import type { Embedder, SemanticIndex } from "../search/types";
import { createSemanticIndex } from "../search/semanticIndex";
import { slugify } from "../utils";
import { tableToCsv } from "../serialize";
import { buildViewModel, rowsByTableIndex } from "./viewModel";
import type { ViewModel } from "./viewModel";
import { buildMarkup } from "./markup";
import { STYLES } from "./styles";
import { attachBehavior } from "./behavior";
import { createSearchEngine } from "../search/engine";
import type { SearchEngine } from "../search/types";

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

    /**
     * The ONE place the search engine is built (one per render; disposed in `_cleanup`, the
     * semantic index is not — it outlives re-renders).
     */
    private createEngine(table: DataDictionaryTable): SearchEngine {
      const cfg = this._options.semanticSearch;
      const index = this._semantic?.index;
      return createSearchEngine(table, {
        ...(cfg && index ? { semantic: index } : {}),
        ...(cfg?.maxRelated !== undefined ? { maxRelated: cfg.maxRelated } : {}),
        ...(cfg?.minScore !== undefined ? { minScore: cfg.minScore } : {}),
        ...(cfg?.minQueryLength !== undefined ? { minQueryLength: cfg.minQueryLength } : {}),
        ...(cfg?.debounceMs !== undefined ? { debounceMs: cfg.debounceMs } : {})
      });
    }

    private renderNow(): void {
      if (!this.isConnected || !this._table) return;
      const table = this._table;
      this.syncSemanticIndex();
      const vm = buildViewModel(table, this._options);
      const useShadow = this._options.shadow !== false;
      const markup = buildMarkup(vm, "component");
      const filename = `${slugify(vm.title)}.csv`;
      // The CSV is only needed for copy/download: build it on first use, once per render.
      let csvCache: string | undefined;
      const csv = (): string => (csvCache ??= tableToCsv(table));
      const engine = this.createEngine(table);

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
      const detach = attachBehavior(container, { vm, csv, filename, engine, semanticIndex: this._semantic?.index });
      this._cleanup = () => {
        detach();
        engine.dispose();
      };
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
