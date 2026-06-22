// json-schema-data-dictionary
// Turn interlinked JSON Schema documents describing a tabular dataset into a flat,
// spreadsheet-like data dictionary and an embeddable, searchable HTML table.

// --- Core extraction ---
export { schemaDocumentsToTable } from "./extract";
export { analyzeProperty } from "./analyze";
export { SchemaRegistry } from "./registry";

// --- Serialization / export ---
export { toPlainRows, tableToCsv, validValuesText, constraintsText, additionalInfoText } from "./serialize";

// --- Rendering ---
export { tableToHtml, STYLES } from "./render/html";
export { renderDataDictionary, defineDataDictionaryElement, ELEMENT_TAG } from "./render/component";
export { buildViewModel } from "./render/viewModel";

// --- Formats catalog (useful for tooling / custom renderers) ---
export { STRING_FORMATS, describeFormat, formatLabel, isKnownFormat } from "./formats";

// --- Types ---
export type {
  JsonValue,
  JsonPrimitive,
  JsonSchema,
  JsonSchemaObject,
  SchemaDocumentInput,
  SourceInfo,
  ValidValue,
  ValidValueKind,
  ConstraintItem,
  ConditionalEffect,
  ConditionalRule,
  DataDictionaryRow,
  DataDictionaryCategory,
  DataDictionaryTable,
  SchemaToTableOptions,
  PlainRowsOptions,
  RenderHtmlOptions,
  RenderOptions
} from "./types";
export type { AnalyzeContext, PropertyAnalysis } from "./analyze";
export type { DataDictionaryElement } from "./render/component";
export type { ViewModel, CategoryVM, RowVM, ValueVM, ConstraintVM, RuleVM, ResolvedOptions } from "./render/viewModel";
export type { FormatDescriptor } from "./formats";
