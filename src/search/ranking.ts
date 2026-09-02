// Keyword scoring and hybrid ranking for the results list.
//
// The keyword *match set* is exactly the substring predicate the widget has always used
// (`all.includes(q)`); scores only order matches. Results are grouped into buckets by where
// the query matched (variable name > description > values > elsewhere), and semantic-only
// "related" rows share the last bucket. Inside a bucket, reciprocal rank fusion (RRF) of the
// keyword ranking and the semantic ranking decides the order — so semantically closer rows
// float up without ever displacing a stronger keyword match.

import type { SemanticHit } from "./types";

export interface SearchFields {
  /** Lower-cased variable name. */
  name: string;
  /** Lower-cased description. */
  description: string;
  /** Lower-cased valid-values text. */
  values: string;
  /** Lower-cased blob of every column (the widget's `data-search`). */
  all: string;
}

export interface RankedResult {
  row: number;
  /** Fused score (higher is better; only comparable within one query). */
  score: number;
  /** True for keyword matches, false for semantic-only ("related") rows. */
  exact: boolean;
  keywordScore: number;
  semanticScore?: number | undefined;
}

/** 0 = no match; 6 exact name, 5 name prefix, 4 name contains, 3 description, 2 values, 1 elsewhere. */
export function keywordScore(fields: SearchFields, q: string): number {
  if (!q || !fields.all.includes(q)) return 0;
  if (fields.name === q) return 6;
  if (fields.name.startsWith(q)) return 5;
  if (fields.name.includes(q)) return 4;
  if (fields.description.includes(q)) return 3;
  if (fields.values.includes(q)) return 2;
  return 1;
}

/** Reciprocal rank fusion: Σ 1 / (k + rank) over every list a row appears in. */
export function fuseRankings(lists: ReadonlyArray<readonly SemanticHit[]>, k = 60): SemanticHit[] {
  const fused = new Map<number, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => fused.set(hit.row, (fused.get(hit.row) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...fused]
    .map(([row, score]) => ({ row, score }))
    .sort((a, b) => b.score - a.score || a.row - b.row);
}

/**
 * Rank rows for a query: every keyword match plus up to `maxRelated` semantic-only rows.
 * `hits` must be sorted best-first and already filtered by the similarity floor.
 */
export function rankResults(
  fields: readonly SearchFields[],
  q: string,
  hits: readonly SemanticHit[] | undefined,
  maxRelated: number
): RankedResult[] {
  const keyword: SemanticHit[] = [];
  fields.forEach((f, row) => {
    const score = keywordScore(f, q);
    if (score > 0) keyword.push({ row, score });
  });
  keyword.sort((a, b) => b.score - a.score || a.row - b.row);
  const kwScore = new Map(keyword.map((h) => [h.row, h.score]));

  const related = new Set<number>();
  const cap = Math.max(0, Math.floor(maxRelated));
  for (const h of hits ?? []) {
    if (related.size >= cap) break;
    if (!kwScore.has(h.row)) related.add(h.row);
  }
  const semantic = (hits ?? []).filter((h) => kwScore.has(h.row) || related.has(h.row));
  const semScore = new Map(semantic.map((h) => [h.row, h.score]));

  const results: RankedResult[] = fuseRankings([keyword, semantic]).map((f) => ({
    row: f.row,
    score: f.score,
    exact: kwScore.has(f.row),
    keywordScore: kwScore.get(f.row) ?? 0,
    semanticScore: semScore.get(f.row)
  }));
  results.sort((a, b) => bucket(a) - bucket(b) || b.score - a.score || b.keywordScore - a.keywordScore || a.row - b.row);
  return results;
}

/** 1 = exact name … 5 = values; 6 = matched elsewhere or related. */
function bucket(r: RankedResult): number {
  return r.exact && r.keywordScore >= 2 ? 7 - r.keywordScore : 6;
}
