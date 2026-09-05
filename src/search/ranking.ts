// Ranking for the results list.
//
// `rankHybrid` (the 0.3 path) fuses the lexical BM25F hits with the semantic hits by weighted
// reciprocal rank fusion — scale-free, since BM25F scores and mean-centred cosines have
// unrelated ranges. Rows whose name equals the whole query form a tier of their own; every
// other lexical match plus up to `maxRelated` semantic-only ("related") rows follow in fused
// order. `matches` carries the fields and surface terms that explain a hit.
//
// The legacy path (`keywordScore`, `fuseRankings`, `rankResults`) keeps the 0.2 behaviour:
// the keyword *match set* is exactly the substring predicate the widget has always used
// (`all.includes(q)`), scores only order matches, and rows are bucketed by where the query
// matched (variable name > description > values > elsewhere) before RRF orders each bucket.

import type { LexicalHit, LexicalMatch, RankHybridOptions, RankedResult, SemanticHit } from "./types";

export type { RankedResult, RankHybridOptions, FusionOptions } from "./types";

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

  const results: RankedResult[] = fuseRankings([keyword, semantic]).map((f) => {
    const kw = kwScore.get(f.row) ?? 0;
    return {
      row: f.row,
      score: f.score,
      exact: kwScore.has(f.row),
      exactName: kw === 6,
      keywordScore: kw,
      lexicalScore: kw,
      semanticScore: semScore.get(f.row),
      matches: []
    };
  });
  results.sort((a, b) => bucket(a) - bucket(b) || b.score - a.score || b.keywordScore - a.keywordScore || a.row - b.row);
  return results;
}

/** 1 = exact name … 5 = values; 6 = matched elsewhere or related. */
function bucket(r: RankedResult): number {
  return r.exact && r.keywordScore >= 2 ? 7 - r.keywordScore : 6;
}

/** Legacy 6..1 bucket of a lexical hit, derived from its flags and matched fields. */
export function keywordBucket(hit: Pick<LexicalHit, "exactName" | "namePrefix" | "matches">): number {
  if (hit.exactName) return 6;
  if (hit.namePrefix) return 5;
  let best = 1;
  for (const m of hit.matches) {
    if (m.field === "name") return 4;
    if (m.field === "description") best = Math.max(best, 3);
    else if (m.field === "values") best = Math.max(best, 2);
  }
  return best;
}

/**
 * Fuse lexical hits (sorted as returned by the lexical index) with semantic hits (best first,
 * above the floor). The semantic list is restricted to lexical rows plus the top `maxRelated`
 * rows the lexical pass missed, so unrelated tail hits never dilute the fusion.
 */
export function rankHybrid(
  lexical: readonly LexicalHit[],
  semantic: readonly SemanticHit[] | undefined,
  options: RankHybridOptions
): RankedResult[] {
  const k = options.k ?? 60;
  const lexicalWeight = options.lexicalWeight ?? 1;
  const semanticWeight = options.semanticWeight ?? 1;
  const cap = Math.max(0, Math.floor(options.maxRelated));

  const byRow = new Map<number, LexicalHit>();
  const fused = new Map<number, number>();
  lexical.forEach((hit, rank) => {
    if (byRow.has(hit.row)) return;
    byRow.set(hit.row, hit);
    fused.set(hit.row, lexicalWeight / (k + rank + 1));
  });

  const semScore = new Map<number, number>();
  let related = 0;
  let rank = 0;
  for (const hit of semantic ?? []) {
    if (semScore.has(hit.row)) continue;
    if (!byRow.has(hit.row)) {
      if (related >= cap) continue;
      related += 1;
    }
    semScore.set(hit.row, hit.score);
    fused.set(hit.row, (fused.get(hit.row) ?? 0) + semanticWeight / (k + rank + 1));
    rank += 1;
  }

  const results: RankedResult[] = [];
  for (const [row, score] of fused) {
    const hit = byRow.get(row);
    const matches: LexicalMatch[] = hit ? hit.matches : [];
    results.push({
      row,
      score,
      exact: hit !== undefined,
      exactName: hit?.exactName ?? false,
      keywordScore: hit ? keywordBucket(hit) : 0,
      lexicalScore: hit?.score ?? 0,
      semanticScore: semScore.get(row),
      matches
    });
  }
  results.sort(
    (a, b) =>
      Number(b.exactName) - Number(a.exactName) ||
      (a.exactName ? b.lexicalScore - a.lexicalScore : 0) ||
      b.score - a.score ||
      b.lexicalScore - a.lexicalScore ||
      (b.semanticScore ?? -Infinity) - (a.semanticScore ?? -Infinity) ||
      a.row - b.row
  );
  return results;
}
