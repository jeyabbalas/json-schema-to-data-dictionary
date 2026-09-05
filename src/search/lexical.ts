// Lexical (BM25F) index for as-you-type search over data-dictionary rows.
//
// Tokens are NFKD-normalised, diacritic-stripped, lower-cased runs of letters/digits, lightly
// stemmed (surface forms are kept for highlighting). Six weighted fields — name, description,
// values, category, format+type, other — feed one BM25F saturation per query term; the last
// query token also matches as a prefix (at most 64 expansions, the most frequent ones). A
// query is ANDed over its non-stop-word tokens, falling back to OR, and the 0.2.0 substring
// predicate (`all.includes(query)`) is always unioned in, so every row the plain filter found
// still matches ("kg/m2", "meno_", regex fragments).
//
// Scoring works on typed-array accumulators plus a "touched rows" list, so a query costs time
// proportional to the postings visited rather than to the number of documents.

import type { DataDictionaryRow, DataDictionaryTable } from "../types";
import type {
  LexicalDocument,
  LexicalField,
  LexicalHit,
  LexicalIndex,
  LexicalIndexOptions,
  LexicalMatch,
  LexicalSearchOptions
} from "./types";
import { additionalInfoText, constraintsText, validValueLine } from "../serialize";
import { humanizeName } from "./text";

export type {
  LexicalDocument,
  LexicalField,
  LexicalHit,
  LexicalIndex,
  LexicalIndexOptions,
  LexicalMatch,
  LexicalSearchMode,
  LexicalSearchOptions
} from "./types";

// ---------------------------------------------------------------------------
// Tokeniser and stemmer

const NON_ASCII = /[^\x00-\x7f]/;
const NON_ASCII_CHARS = /[^\x00-\x7f]/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const MARKS = /\p{M}+/gu;
const TOKEN_ASCII = /[a-z0-9]+/g;
const TOKEN_ANY = /[\p{L}\p{N}]+/gu;
const NON_TOKEN = /[^\p{L}\p{N}]/u;
const LETTER_DIGIT_RUNS = /\p{L}+|\p{N}+/gu;

/**
 * True when the text holds a non-ASCII letter, digit or combining mark. Dictionary text is
 * full of non-ASCII *punctuation* ("–", "≤", "—") that tokenises exactly like ASCII
 * punctuation, so only the few non-ASCII characters are inspected instead of running the
 * (much slower) Unicode-property regexes over the whole string.
 */
function needsUnicode(text: string): boolean {
  if (!NON_ASCII.test(text)) return false;
  NON_ASCII_CHARS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NON_ASCII_CHARS.exec(text)) !== null) if (WORD_CHAR.test(m[0])) return true;
  return false;
}

/** NFKD, strip combining marks, lower-case (ASCII fast path). */
export function normalizeText(text: string): string {
  return needsUnicode(text) ? text.normalize("NFKD").replace(MARKS, "").toLowerCase() : text.toLowerCase();
}

/** Runs of letters/digits of the normalised text: "kg/m2" -> ["kg", "m2"], "age_preg1" -> ["age", "preg1"]. */
export function tokenize(text: string): string[] {
  if (!needsUnicode(text)) return text.toLowerCase().match(TOKEN_ASCII) ?? [];
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase().match(TOKEN_ANY) ?? [];
}

/** Light English stemmer (tokens of 4+ chars): ies -> y, sses -> ss, drop a trailing s unless ss/us/is. */
export function stem(token: string): string {
  const n = token.length;
  if (n < 4 || token.charCodeAt(n - 1) !== 115 /* s */) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ss") || token.endsWith("us") || token.endsWith("is")) return token;
  return token.slice(0, -1);
}

/** Words that are indexed but never required under AND. */
export const DEFAULT_STOP_WORDS: readonly string[] = [
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have", "if", "in",
  "into", "is", "it", "its", "no", "not", "of", "on", "onto", "or", "so", "than", "that", "the", "their", "then",
  "there", "these", "this", "those", "to", "was", "were", "when", "which", "with"
];

/**
 * Surface terms of a variable name: the humanised tokens, letter/digit splits of those
 * ("preg1" -> "preg", "1") and the whole normalised raw name when it differs from every token
 * ("AJAncestry" -> "ajancestry", "age_preg1").
 */
function nameSurfaces(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const token of tokenize(humanizeName(raw))) {
    push(token);
    const parts = token.match(LETTER_DIGIT_RUNS);
    if (parts && parts.length > 1) for (const p of parts) push(p);
  }
  const whole = normalizeText(raw).trim();
  if (whole && !/\s/.test(whole)) push(whole);
  return out;
}

function uniqueTokens(normalised: string, cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of normalised.match(needsUnicode(normalised) ? TOKEN_ANY : TOKEN_ASCII) ?? []) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Documents

/** Lexical document for one row (`categoryTitle` defaults to the row's `__category`). */
export function lexicalDocumentFromRow(row: DataDictionaryRow, categoryTitle?: string): LexicalDocument {
  const name = row["Variable name"];
  const description = row["Description"];
  const dataType = row["Data type"];
  const format = row["Format"];
  const lines = row["Valid values"].map(validValueLine);
  const constraints = constraintsText(row["Constraints"]);
  const info = additionalInfoText(row["Additional information"]);
  return {
    name,
    description,
    values: lines.join("\n"),
    category: categoryTitle ?? row.__category ?? "",
    format: [format, dataType].filter(Boolean).join("\n"),
    other: [constraints, info].filter(Boolean).join("\n"),
    // Same composition as the widget's `data-search` attribute (0.2.0 substring parity).
    all: [name, description, dataType, format, lines.join("; "), constraints, info].join("  ").toLowerCase()
  };
}

/** One document per `table.rows` entry; categories are resolved by row identity. */
export function lexicalDocumentsFromTable(table: DataDictionaryTable): LexicalDocument[] {
  const titles = new Map<DataDictionaryRow, string>();
  for (const category of table.categories) {
    for (const row of category.rows) if (!titles.has(row)) titles.set(row, category.title);
  }
  return table.rows.map((row) => lexicalDocumentFromRow(row, titles.get(row) ?? row.__category ?? ""));
}

// ---------------------------------------------------------------------------
// Index

const FIELDS: readonly LexicalField[] = ["name", "description", "values", "category", "format", "other"];
const F = FIELDS.length;
const WEIGHT = new Float32Array([8, 3, 2, 1, 1, 0.5]);
const LENGTH_B = new Float32Array([0.3, 0.75, 0.75, 0.5, 0.5, 0.75]);
const K1 = 1.2;
const NAME_PREFIX_BONUS = 3;
const NAME_TOKEN_BONUS = 1.5;
const SUBSTRING_SCORE = 0.5;
const MAX_QUERY_TERMS = 16;
const EXACT_BIT = 64;
const PREFIX_BIT = 128;
const NAME_BIT = 1;

interface PostingBuild {
  rows: number[];
  tf: number[];
}

interface Posting {
  rows: Int32Array;
  /** `rows.length × F` term frequencies. */
  tf: Float32Array;
  df: number;
}

interface QueryTerm {
  surface: string;
  stem: string;
  required: boolean;
  /** Excluded from `matches` (stop words). */
  silent: boolean;
  /** The whole query as one identifier-like term ("meno_age"); never required. */
  whole: boolean;
  exact: Posting | undefined;
  expansions: Posting[];
  /** Surface forms of the exactly matched stem, longest first. */
  exactForms: string[];
}

interface Slot {
  best: Float32Array;
  mask: Uint8Array;
}

export function createLexicalIndex(docs: readonly LexicalDocument[], options: LexicalIndexOptions = {}): LexicalIndex {
  const N = docs.length;
  const stopWords = new Set<string>(options.stopWords === false ? [] : (options.stopWords ?? DEFAULT_STOP_WORDS));
  const maxExpansions = Math.max(1, Math.floor(options.maxExpansions ?? 64));
  const minPrefixLength = Math.max(1, Math.floor(options.minPrefixLength ?? 2));

  // --- build -----------------------------------------------------------------------------
  const stemOf = new Map<string, string>();
  const building = new Map<string, PostingBuild>();
  const bySurface = new Map<string, PostingBuild>();
  const lengths = new Float32Array(N * F);
  const nameLower: string[] = new Array<string>(N);
  const humanLower: string[] = new Array<string>(N);

  const addField = (row: number, field: number, surfaces: readonly string[]): void => {
    lengths[row * F + field] = surfaces.length;
    for (const surface of surfaces) {
      let posting = bySurface.get(surface);
      if (!posting) {
        const st = stem(surface);
        posting = building.get(st);
        if (!posting) {
          posting = { rows: [], tf: [] };
          building.set(st, posting);
        }
        bySurface.set(surface, posting);
        stemOf.set(surface, st);
      }
      const last = posting.rows.length - 1;
      if (last < 0 || posting.rows[last] !== row) {
        posting.rows.push(row);
        posting.tf.push(0, 0, 0, 0, 0, 0);
      }
      const at = (posting.rows.length - 1) * F + field;
      posting.tf[at] = (posting.tf[at] as number) + 1;
    }
  };

  // Code lists, category titles, types and constraints repeat across many rows: tokenise each
  // distinct text once (descriptions are mostly unique and are not memoised).
  const memo = new Map<string, string[]>();
  const tokensOf = (text: string): string[] => {
    let tokens = memo.get(text);
    if (!tokens) {
      tokens = tokenize(text);
      memo.set(text, tokens);
    }
    return tokens;
  };

  for (let row = 0; row < N; row += 1) {
    const doc = docs[row] as LexicalDocument;
    nameLower[row] = doc.name.trim().toLowerCase();
    humanLower[row] = humanizeName(doc.name).toLowerCase();
    addField(row, 0, nameSurfaces(doc.name));
    addField(row, 1, tokenize(doc.description));
    addField(row, 2, tokensOf(doc.values));
    addField(row, 3, tokensOf(doc.category));
    addField(row, 4, tokensOf(doc.format));
    addField(row, 5, tokensOf(doc.other));
  }
  memo.clear();

  const postings = new Map<string, Posting>();
  for (const [st, p] of building) postings.set(st, { rows: Int32Array.from(p.rows), tf: Float32Array.from(p.tf), df: p.rows.length });
  building.clear();
  bySurface.clear();

  // Surface forms per stem (for highlighting) and the sorted vocabulary for prefix lookups.
  const forms = new Map<string, string[]>();
  for (const [surface, st] of stemOf) {
    const list = forms.get(st);
    if (list) list.push(surface);
    else forms.set(st, [surface]);
  }
  for (const list of forms.values()) if (list.length > 1) list.sort(byLengthDesc);
  const vocab = [...stemOf.keys()].sort();

  // Per-document, per-field 1 / (1 - b + b * len / avgLen).
  const invB = new Float32Array(N * F);
  {
    const avg = new Float64Array(F);
    for (let row = 0; row < N; row += 1) for (let f = 0; f < F; f += 1) avg[f] = (avg[f] as number) + (lengths[row * F + f] as number);
    for (let f = 0; f < F; f += 1) avg[f] = N > 0 && (avg[f] as number) > 0 ? (avg[f] as number) / N : 1;
    for (let row = 0; row < N; row += 1) {
      for (let f = 0; f < F; f += 1) {
        const b = LENGTH_B[f] as number;
        invB[row * F + f] = 1 / (1 - b + (b * (lengths[row * F + f] as number)) / (avg[f] as number));
      }
    }
  }

  // Substring fallback: every `all` blob in one string, so a query needs one native scan
  // instead of N `includes` calls. "\u0000" never occurs in a query.
  const offsets = new Int32Array(N + 1);
  let blob = "";
  {
    const parts: string[] = new Array<string>(N);
    let pos = 0;
    for (let row = 0; row < N; row += 1) {
      const all = (docs[row] as LexicalDocument).all;
      parts[row] = all;
      offsets[row] = pos;
      pos += all.length + 1;
    }
    offsets[N] = pos;
    blob = parts.join("\u0000");
  }

  // --- query scratch (reused; only touched rows are ever reset) --------------------------
  const acc = new Float64Array(N);
  const reqHits = new Uint8Array(N);
  const touchedFlag = new Uint8Array(N);
  const selected = new Uint8Array(N);
  const touched = new Int32Array(N);
  const termRows = new Int32Array(N);
  const slots: Slot[] = [];

  const rowAt = (pos: number): number => {
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] as number) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const postingOf = (surface: string): Posting | undefined => postings.get(stemOf.get(surface) ?? stem(surface));

  /** Postings of vocabulary surfaces starting with `prefix` (minus `exclude`), the most frequent first. */
  const prefixPostings = (prefix: string, exclude: Posting | undefined): Posting[] => {
    let lo = 0;
    let hi = vocab.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((vocab[mid] as string) < prefix) lo = mid + 1;
      else hi = mid;
    }
    const seen = new Set<Posting>();
    const out: Posting[] = [];
    for (let i = lo; i < vocab.length; i += 1) {
      const surface = vocab[i] as string;
      if (!surface.startsWith(prefix)) break;
      const p = postingOf(surface);
      if (!p || p === exclude || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    if (out.length > maxExpansions) {
      out.sort((a, b) => b.df - a.df);
      out.length = maxExpansions;
    }
    return out;
  };

  const buildTerms = (query: string, usePrefix: boolean): QueryTerm[] => {
    const normalised = normalizeText(query).trim();
    const tokens = uniqueTokens(normalised, MAX_QUERY_TERMS - 1);
    const terms: QueryTerm[] = tokens.map((surface) => ({
      surface,
      stem: stemOf.get(surface) ?? stem(surface),
      required: !stopWords.has(surface),
      silent: stopWords.has(surface),
      whole: false,
      exact: undefined,
      expansions: [],
      exactForms: []
    }));
    // A query made only of stop words treats them as ordinary words.
    if (terms.length > 0 && !terms.some((t) => t.required)) for (const t of terms) t.required = true;
    // "meno_age", "kg/m2": the whole query as one identifier-like term (matches whole names).
    if (tokens.length > 1 && !/\s/.test(normalised) && NON_TOKEN.test(normalised)) {
      terms.push({ surface: normalised, stem: stemOf.get(normalised) ?? stem(normalised), required: false, silent: false, whole: true, exact: undefined, expansions: [], exactForms: [] });
    }
    terms.forEach((term, i) => {
      term.exact = postings.get(term.stem);
      if (term.exact) {
        term.expansions.push(term.exact);
        term.exactForms = forms.get(term.stem) ?? [term.surface];
      }
      const last = term.whole || i === tokens.length - 1;
      if (usePrefix && last && term.surface.length >= minPrefixLength) term.expansions.push(...prefixPostings(term.surface, term.exact));
    });
    return terms;
  };

  const search = (query: string, opts: LexicalSearchOptions = {}): LexicalHit[] => {
    const q = query.trim().toLowerCase();
    if (!q || N === 0) return [];
    const mode = opts.mode ?? "auto";
    const terms = buildTerms(query, opts.prefixLastToken ?? true);

    // --- BM25F over every term -------------------------------------------------------
    let touchedCount = 0;
    let requiredTotal = 0;
    let requiredMatched = 0;
    terms.forEach((term, t) => {
      if (term.required) requiredTotal += 1;
      if (term.expansions.length === 0) return;
      let slot = slots[t];
      if (!slot) {
        slot = { best: new Float32Array(N), mask: new Uint8Array(N) };
        slots[t] = slot;
      }
      const best = slot.best;
      const mask = slot.mask;
      let count = 0;
      for (const p of term.expansions) {
        const bit = p === term.exact ? EXACT_BIT : PREFIX_BIT;
        const rows = p.rows;
        const tf = p.tf;
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i] as number;
          const off = i * F;
          const doff = row * F;
          let wtf = 0;
          let bits = bit;
          for (let f = 0; f < F; f += 1) {
            const c = tf[off + f] as number;
            if (c > 0) {
              bits |= 1 << f;
              wtf += (WEIGHT[f] as number) * c * (invB[doff + f] as number);
            }
          }
          const prev = best[row] as number;
          if (prev === 0) termRows[count++] = row;
          if (wtf > prev) best[row] = wtf;
          mask[row] = (mask[row] as number) | bits;
        }
      }
      if (count === 0) return;
      if (term.required) requiredMatched += 1;
      const idf = Math.log(1 + (N - count + 0.5) / (count + 0.5));
      for (let i = 0; i < count; i += 1) {
        const row = termRows[i] as number;
        const tb = best[row] as number;
        acc[row] = (acc[row] as number) + (idf * tb) / (K1 + tb);
        if (term.required) reqHits[row] = (reqHits[row] as number) + 1;
        if (touchedFlag[row] === 0) {
          touchedFlag[row] = 1;
          touched[touchedCount++] = row;
        }
      }
    });

    // --- AND -> OR ---------------------------------------------------------------------
    const hits: LexicalHit[] = [];
    let candidates: number[] = [];
    if (mode === "and" && requiredMatched < requiredTotal) candidates = [];
    else if (mode === "or" || requiredMatched === 0) candidates = Array.from(touched.subarray(0, touchedCount));
    else {
      for (let i = 0; i < touchedCount; i += 1) {
        const row = touched[i] as number;
        if (reqHits[row] === requiredMatched) candidates.push(row);
      }
      if (candidates.length === 0 && mode === "auto") candidates = Array.from(touched.subarray(0, touchedCount));
    }

    const nameFlags = (row: number): [exactName: boolean, namePrefix: boolean] => {
      const raw = nameLower[row] as string;
      const human = humanLower[row] as string;
      const exactName = raw === q || human === q;
      return [exactName, exactName || raw.startsWith(q) || human.startsWith(q)];
    };

    // A row's matches and name bonus depend only on its per-term field masks, and a query with
    // thousands of hits sees only a handful of distinct mask tuples: build each once and share
    // the `matches` array between those rows (callers treat it as read-only).
    const explained = new Map<number | string, { matches: LexicalMatch[]; nameTokens: number }>();
    const explain = (row: number): { matches: LexicalMatch[]; nameTokens: number } => {
      let key = 0;
      let extra = "";
      for (let t = 0; t < terms.length; t += 1) {
        const slot = slots[t];
        const m = slot && (terms[t] as QueryTerm).expansions.length > 0 ? (slot.mask[row] as number) : 0;
        if (t < 3) key |= m << (8 * t);
        else extra += `,${m}`;
      }
      const cacheKey = extra ? `${key}${extra}` : key;
      let entry = explained.get(cacheKey);
      if (entry) return entry;
      let nameTokens = 0;
      const fieldTerms: Array<string[] | undefined> = [undefined, undefined, undefined, undefined, undefined, undefined];
      for (let t = 0; t < terms.length; t += 1) {
        const term = terms[t] as QueryTerm;
        const slot = slots[t];
        if (!slot || term.expansions.length === 0) continue;
        const m = slot.mask[row] as number;
        if (m === 0 || term.silent) continue;
        if (m & NAME_BIT && !term.whole) nameTokens += 1;
        for (let f = 0; f < F; f += 1) {
          if ((m & (1 << f)) === 0) continue;
          const list = fieldTerms[f] ?? (fieldTerms[f] = []);
          if (m & EXACT_BIT) list.push(...term.exactForms);
          if (m & PREFIX_BIT) list.push(term.surface);
        }
      }
      const matches: LexicalMatch[] = [];
      for (let f = 0; f < F; f += 1) {
        const list = fieldTerms[f];
        if (list) matches.push({ field: FIELDS[f] as LexicalField, terms: uniqueLongestFirst(list) });
      }
      entry = { matches, nameTokens };
      explained.set(cacheKey, entry);
      return entry;
    };

    for (const row of candidates) {
      selected[row] = 1;
      const { matches, nameTokens } = explain(row);
      let score = (acc[row] as number) + nameTokens * NAME_TOKEN_BONUS;
      const [exactName, namePrefix] = nameFlags(row);
      if (namePrefix) score += NAME_PREFIX_BONUS;
      hits.push({ row, score, exactName, namePrefix, substringOnly: false, matches });
    }

    // --- substring fallback (0.2.0 parity) ----------------------------------------------
    const substringRows: number[] = [];
    if (!q.includes("\u0000")) {
      let pos = blob.indexOf(q);
      while (pos >= 0) {
        const row = rowAt(pos);
        if (selected[row] === 0) {
          const [exactName, namePrefix] = nameFlags(row);
          hits.push({ row, score: SUBSTRING_SCORE, exactName, namePrefix, substringOnly: true, matches: [] });
          substringRows.push(row);
        }
        pos = blob.indexOf(q, offsets[row + 1] as number);
      }
    }

    // --- reset scratch -----------------------------------------------------------------
    for (let i = 0; i < touchedCount; i += 1) {
      const row = touched[i] as number;
      acc[row] = 0;
      reqHits[row] = 0;
      touchedFlag[row] = 0;
      selected[row] = 0;
      for (let t = 0; t < terms.length; t += 1) {
        const slot = slots[t];
        if (slot) {
          slot.best[row] = 0;
          slot.mask[row] = 0;
        }
      }
    }
    for (const row of substringRows) selected[row] = 0;

    hits.sort((a, b) => Number(b.exactName) - Number(a.exactName) || b.score - a.score || a.row - b.row);
    if (opts.limit !== undefined && hits.length > opts.limit) hits.length = Math.max(0, Math.floor(opts.limit));
    return hits;
  };

  return {
    get size() {
      return N;
    },
    get vocabularySize() {
      return vocab.length;
    },
    search,
    tokens(query) {
      return uniqueTokens(normalizeText(query), MAX_QUERY_TERMS);
    }
  };
}

function byLengthDesc(a: string, b: string): number {
  return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
}

function uniqueLongestFirst(terms: readonly string[]): string[] {
  return [...new Set(terms)].sort(byLengthDesc);
}
