// Builds the natural-language "chunks" that get embedded for each row. A row always gets
// one identity chunk (name + description) and, when it has substantive categories, one or
// more values chunks. A row's semantic score is the best of its chunks.
//
// Deliberately NOT embedded: constraints, "Additional information" JSON, sentinel/missing
// codes and category titles — they make unrelated rows look alike.

import type { DataDictionaryTable, ValidValue } from "../types";

/** Bump whenever the chunk template changes; it is part of every cache key. */
export const EMBED_TEXT_VERSION = 1;

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

/** `age_at_menarche` -> "age at menarche", `bodyMassIndex` -> "body Mass Index". */
export function humanizeName(name: string): string {
  return name
    .replace(/[_\-.]+/g, " ")
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
    const name = humanizeName(row["Variable name"]) || row["Variable name"];
    const description = clean(row["Description"], maxChars);
    const format = clean(row["Format"], 80);
    const dataType = clean(row["Data type"], 80);

    let identity = description ? `${name}: ${description}` : dataType ? `${name} (${dataType})` : name;
    if (description && format) identity += ` (${format})`;
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
