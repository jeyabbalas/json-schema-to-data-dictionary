// Ranking metrics shared by `scripts/eval-search.mjs` (real models) and
// `tests/search-eval.test.mjs` (fake embedder). A "run" is a function that maps a query
// string to an ordered list of variable names; every query in the labelled set has the
// variable names that should rank near the top and a list of tags.

/** Fraction of `expected` found in the first `k` results. */
export function recallAtK(ranked, expected, k) {
  if (expected.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const name of expected) if (top.has(name)) hit += 1;
  return hit / expected.length;
}

/** Reciprocal rank of the first expected name (0 when none is ranked). */
export function reciprocalRank(ranked, expected) {
  const want = new Set(expected);
  for (let i = 0; i < ranked.length; i += 1) if (want.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

/**
 * Evaluate `run(query) -> string[]` over `queries` ([{ q, expect, tags }]).
 * Returns { perQuery, overall, byTag } with recall@5, recall@10 and MRR (means).
 */
export async function evaluate(queries, run, options = {}) {
  const ks = options.ks ?? [5, 10];
  const perQuery = [];
  for (const query of queries) {
    const ranked = await run(query.q);
    const row = { q: query.q, tags: query.tags ?? [], expect: query.expect, ranked: ranked.slice(0, Math.max(...ks)), mrr: reciprocalRank(ranked, query.expect) };
    for (const k of ks) row[`recall@${k}`] = recallAtK(ranked, query.expect, k);
    row.missed = query.expect.filter((name) => !ranked.slice(0, Math.max(...ks)).includes(name));
    perQuery.push(row);
  }
  const metrics = ["mrr", ...ks.map((k) => `recall@${k}`)];
  const mean = (rows, key) => (rows.length ? rows.reduce((a, r) => a + r[key], 0) / rows.length : 0);
  const summarize = (rows) => Object.fromEntries([["n", rows.length], ...metrics.map((m) => [m, mean(rows, m)])]);
  const tags = [...new Set(perQuery.flatMap((r) => r.tags))].sort();
  return {
    perQuery,
    overall: summarize(perQuery),
    byTag: Object.fromEntries(tags.map((tag) => [tag, summarize(perQuery.filter((r) => r.tags.includes(tag)))]))
  };
}

/** Render a summary as an aligned text table (systems × metrics). */
export function formatTable(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => (typeof r[c] === "number" ? r[c].toFixed(3) : String(r[c] ?? ""))));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (parts) => parts.map((p, i) => p.padEnd(widths[i])).join("  ");
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}
