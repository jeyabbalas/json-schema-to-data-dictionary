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

// --- Semantic search (opt-in; bring your own Embedder) ---
export { createSemanticIndex, DEFAULT_MIN_SCORE } from "./search/semanticIndex";
export { buildEmbedChunks, humanizeName, EMBED_TEXT_VERSION } from "./search/text";
export { cacheKey, createMemoryVectorCache, createIndexedDbVectorCache, createDefaultVectorCache } from "./search/cache";
export { keywordScore, fuseRankings, rankResults } from "./search/ranking";
export { createTransformersEmbedder, DEFAULT_EMBEDDING_MODEL, KNOWN_EMBEDDING_MODELS } from "./search/transformers";
export { serveEmbedder, createWorkerEmbedder } from "./search/worker";

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
  RenderOptions,
  SemanticSearchOptions
} from "./types";
export type { Embedder, EmbedKind, VectorCache, SemanticHit, SemanticStatus, SemanticIndex, SemanticSearchQuery } from "./search/types";
export type { SemanticIndexOptions } from "./search/semanticIndex";
export type { EmbedChunk, EmbedChunkOptions } from "./search/text";
export type { IndexedDbVectorCacheOptions } from "./search/cache";
export type { SearchFields, RankedResult } from "./search/ranking";
export type { TransformersModuleLike, TransformersEmbedderOptions, KnownEmbeddingModel } from "./search/transformers";
export type { EmbedderPort } from "./search/worker";
export type { AnalyzeContext, PropertyAnalysis } from "./analyze";
export type { DataDictionaryElement } from "./render/component";
export type { ViewModel, CategoryVM, RowVM, ValueVM, ConstraintVM, RuleVM, ResolvedOptions } from "./render/viewModel";
export type { FormatDescriptor } from "./formats";
