// Interactive renderer: a <json-data-dictionary> custom element (Shadow DOM by default for
// style isolation) plus the renderDataDictionary() convenience mount.
//
// The element class is created lazily so importing this module in a non-DOM environment
// (Node, SSR) does not reference HTMLElement at evaluation time.

import type { DataDictionaryTable, RenderOptions } from "../types";
import { slugify } from "../utils";
import { tableToCsv } from "../serialize";
import { buildViewModel } from "./viewModel";
import { buildMarkup } from "./markup";
import { STYLES } from "./styles";
import { attachBehavior } from "./behavior";

export const ELEMENT_TAG = "json-data-dictionary";
const GLOBAL_STYLE_ID = "json-data-dictionary-styles";

export interface DataDictionaryElement extends HTMLElement {
  table: DataDictionaryTable | undefined;
  options: RenderOptions;
}

let ElementClass: (new () => DataDictionaryElement) | undefined;

function getElementClass(): new () => DataDictionaryElement {
  if (ElementClass) return ElementClass;
  if (typeof HTMLElement === "undefined") throw new Error("A DOM environment is required to use <json-data-dictionary>.");

  class JsonDataDictionaryElement extends HTMLElement {
    private _table: DataDictionaryTable | undefined;
    private _options: RenderOptions = {};
    private _cleanup: (() => void) | undefined;

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
    }

    private renderNow(): void {
      if (!this.isConnected || !this._table) return;
      const vm = buildViewModel(this._table, this._options);
      const useShadow = this._options.shadow !== false;
      const markup = buildMarkup(vm);
      const csv = tableToCsv(this._table);
      const filename = `${slugify(vm.title)}.csv`;

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
      this._cleanup = attachBehavior(container, { csv, filename });
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
