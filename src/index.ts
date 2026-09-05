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

// --- Search: lexical (BM25F) index, hybrid engine, and semantic search (opt-in; bring your own Embedder) ---
export { createSearchEngine } from "./search/engine";
export { createLexicalIndex, lexicalDocumentFromRow, lexicalDocumentsFromTable, tokenize, stem, DEFAULT_STOP_WORDS } from "./search/lexical";
export { createSemanticIndex, DEFAULT_MIN_SCORE } from "./search/semanticIndex";
export { buildEmbedChunks, prepareTexts, humanizeName, EMBED_TEXT_VERSION } from "./search/text";
export { cacheKey, createMemoryVectorCache, createIndexedDbVectorCache, createDefaultVectorCache } from "./search/cache";
export { keywordScore, fuseRankings, rankResults, rankHybrid } from "./search/ranking";
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
export type {
  Embedder,
  EmbedderInfo,
  EmbedKind,
  VectorCache,
  SemanticHit,
  SemanticStatus,
  SemanticIndex,
  SemanticSearchQuery,
  LexicalDocument,
  LexicalField,
  LexicalMatch,
  LexicalHit,
  LexicalIndex,
  LexicalIndexOptions,
  LexicalSearchOptions,
  LexicalSearchMode,
  RankedResult,
  FusionOptions,
  RankHybridOptions,
  SemanticResultState,
  SearchResult,
  SearchEngine,
  SearchEngineOptions
} from "./search/types";
export type { SemanticIndexOptions } from "./search/semanticIndex";
export type { EmbedChunk, EmbedChunkOptions, PreparedTexts } from "./search/text";
export type { IndexedDbVectorCacheOptions } from "./search/cache";
export type { SearchFields } from "./search/ranking";
export type { TransformersModuleLike, TransformersEmbedderOptions, KnownEmbeddingModel } from "./search/transformers";
export type { EmbedderPort } from "./search/worker";
export type { AnalyzeContext, PropertyAnalysis } from "./analyze";
export type { DataDictionaryElement } from "./render/component";
export type { ViewModel, CategoryVM, RowVM, ValueVM, ConstraintVM, RuleVM, ResolvedOptions } from "./render/viewModel";
export type { FormatDescriptor } from "./formats";
