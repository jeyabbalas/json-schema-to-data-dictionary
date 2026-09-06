// Builds the natural-language "chunks" that get embedded for each row. A row always gets
// one identity chunk (name + description) and, when it has substantive categories, one or
// more values chunks. A row's semantic score is the best of its chunks.
//
// Template v2: the identity chunk carries both the humanised and the raw name, so queries
// typed as identifiers ("age_preg1") and as words ("age at first pregnancy") both land, and
// drops regex formats (they make unrelated rows alike). Deliberately NOT embedded:
// constraints, "Additional information" JSON, sentinel/missing codes and category titles —
// the lexical index covers those.
//
// The template is unchanged since 0.3: a nested field's path (`visits[].date`) humanises to
// words like any other name ("visits date"), and names without brackets read exactly as they
// did, so cached vectors and snapshots stay valid and EMBED_TEXT_VERSION stays at 2.

import type { DataDictionaryTable, ValidValue } from "../types";

/** Bump whenever the chunk template changes; it is part of every cache key. */
export const EMBED_TEXT_VERSION = 2;

/**
 * Generic data-dictionary sentences embedded alongside every table. Their vectors (cached
 * like any other) stabilise the estimate of the embedding space's mean direction, which the
 * index subtracts before comparing vectors — small dictionaries alone cannot estimate it.
 */
export const BACKGROUND_TEXTS: readonly string[] = [
  "Identifier assigned to each record in the dataset.",
  "Date on which the information was collected.",
  "Numeric measurement recorded at the baseline visit.",
  "Categorical variable coded as integer values with labels.",
  "Free-text description of the variable and its coding.",
  "Yes or no indicator of whether an event occurred.",
  "Number of years since the reference date.",
  "Value reported by the participant on the questionnaire.",
  "Missing or unknown value recorded with a special code.",
  "Age of the participant at the time of the measurement.",
  "Status at the end of follow-up.",
  "Total count of items reported."
];

export interface EmbedChunk {
  /** Index into `table.rows`. */
  row: number;
  text: string;
}

export interface EmbedChunkOptions {
  /** Labels per values chunk. Default: 12. */
  maxLabelsPerChunk?: number | undefined;
  /** Description characters kept in the identity chunk. Default: 600. */
  maxChars?: number | undefined;
}

/** Everything the semantic index (and the snapshot builder) needs to embed a table. */
export interface PreparedTexts {
  chunks: EmbedChunk[];
  /** Distinct texts to embed: the background sentences first, then row texts in first-use order. */
  uniqueTexts: string[];
  /** Per chunk: index into `uniqueTexts`. */
  chunkText: number[];
  /** Per chunk: index into `table.rows`. */
  chunkRow: number[];
  /** Number of leading `uniqueTexts` that are background sentences (0 for an empty table). */
  backgroundCount: number;
}

/** `age_at_menarche` -> "age at menarche", `bodyMassIndex` -> "body Mass Index", `visits[].date` -> "visits date". */
export function humanizeName(name: string): string {
  return name
    .replace(/[_\-.[\]*"]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildEmbedChunks(table: DataDictionaryTable, options: EmbedChunkOptions = {}): EmbedChunk[] {
  const maxLabels = Math.max(1, options.maxLabelsPerChunk ?? 12);
  const maxChars = Math.max(40, options.maxChars ?? 600);
  const chunks: EmbedChunk[] = [];

  table.rows.forEach((row, index) => {
    const raw = clean(row["Variable name"], 200);
    const name = humanizeName(raw) || raw;
    const alias = raw && raw !== name ? ` (${raw})` : "";
    const description = clean(row["Description"], maxChars);
    const format = clean(row["Format"], 80);
    const dataType = clean(row["Data type"], 80);

    let identity: string;
    if (description) {
      identity = `${name}${alias}: ${description}`;
      // Regex formats ("Matches pattern ^...$") are noise to a language model.
      if (format && !format.startsWith("Matches pattern")) identity += ` (${format})`;
    } else {
      identity = dataType ? `${name}${alias} (${dataType})` : `${name}${alias}`;
    }
    chunks.push({ row: index, text: identity });

    const labels: string[] = [];
    for (const v of row["Valid values"]) {
      if (v.kind === "measurement" || v.kind === "sentinel") continue;
      const label = valueLabel(v);
      if (label) labels.push(label);
    }
    if (labels.length === 0) return;

    const lead = description ? `${name}: ${firstSentence(description)}.` : `${name}.`;
    for (let i = 0; i < labels.length; i += maxLabels) {
      chunks.push({ row: index, text: `${lead} Values: ${labels.slice(i, i + maxLabels).join("; ")}` });
    }
  });

  return chunks;
}

/**
 * Chunks plus the interned list of distinct texts to embed. Identical texts (repeated
 * question blocks, shared code lists) embed once; the background sentences come first so a
 * partially built index estimates the mean direction from them before anything else.
 */
export function prepareTexts(table: DataDictionaryTable, options: EmbedChunkOptions = {}): PreparedTexts {
  const chunks = buildEmbedChunks(table, options);
  const uniqueTexts: string[] = [];
  const textIndex = new Map<string, number>();
  const intern = (text: string): number => {
    let i = textIndex.get(text);
    if (i === undefined) {
      i = uniqueTexts.length;
      uniqueTexts.push(text);
      textIndex.set(text, i);
    }
    return i;
  };
  // An empty table embeds nothing at all (no background sentences either).
  if (chunks.length > 0) for (const text of BACKGROUND_TEXTS) intern(text);
  const backgroundCount = uniqueTexts.length;
  const chunkText = chunks.map((c) => intern(c.text));
  const chunkRow = chunks.map((c) => c.row);
  return { chunks, uniqueTexts, chunkText, chunkRow, backgroundCount };
}

function clean(text: string | undefined, maxChars: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars).trimEnd()}…` : t;
}

function valueLabel(v: ValidValue): string {
  const label = v.label ? clean(v.label, 120) : "";
  const desc = v.description ? clean(v.description, 160) : "";
  if (label && desc && desc.toLowerCase() !== label.toLowerCase()) return `${label} (${desc})`;
  return label || desc; // a bare code carries no meaning worth embedding
}

function firstSentence(text: string): string {
  const m = /^(.*?[.!?])(\s|$)/.exec(text);
  return (m?.[1] ?? text).trim().replace(/[.!?]+$/, "");
}
