import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { loadDir, findRow, nestedTable } from "./_helpers.mjs";

const {
  schemaDocumentsToTable, buildViewModel,
  createLexicalIndex, lexicalDocumentFromRow, lexicalDocumentsFromTable, tokenize, stem, DEFAULT_STOP_WORDS,
  keywordScore, rankHybrid
} = await import("../dist/index.js");

const bcrpp = schemaDocumentsToTable(loadDir("multiple_schema_2"));
const docs = lexicalDocumentsFromTable(bcrpp);
const index = createLexicalIndex(docs);
const rowOf = (name) => bcrpp.rows.indexOf(findRow(bcrpp, name));
const nameOf = (row) => bcrpp.rows[row]["Variable name"];
const names = (hits) => hits.map((h) => nameOf(h.row));
const hitFor = (hits, name) => hits.find((h) => h.row === rowOf(name));
const fieldsOf = (hit) => hit.matches.map((m) => m.field);

/** `times` copies of a table with suffixed names and category titles; rows keep their identity across `rows` and `categories`. */
function cloneTable(base, times) {
  const rows = [];
  const categories = [];
  for (let i = 0; i < times; i += 1) {
    const suffix = i === 0 ? "" : `_c${i}`;
    const copies = new Map();
    for (const row of base.rows) {
      const copy = { ...row, "Variable name": row["Variable name"] + suffix };
      copies.set(row, copy);
      rows.push(copy);
    }
    for (const category of base.categories) {
      categories.push({ ...category, id: `${category.id}${suffix}`, title: i === 0 ? category.title : `${category.title} (${i})`, rows: category.rows.map((r) => copies.get(r)) });
    }
  }
  return { ...base, rows, categories };
}

test("tokenize: NFKD, diacritics, case, digits survive, punctuation splits", () => {
  assert.deepEqual(tokenize("age_preg1"), ["age", "preg1"]);
  assert.deepEqual(tokenize("AJAncestry"), ["ajancestry"]);
  assert.deepEqual(tokenize("kg/m2"), ["kg", "m2"]);
  assert.deepEqual(tokenize("777"), ["777"]);
  assert.deepEqual(tokenize("Waist-to-hip ratio (cm²)"), ["waist", "to", "hip", "ratio", "cm2"]);
  assert.deepEqual(tokenize("naïve Épée – ≤ 5"), ["naive", "epee", "5"]);
  assert.deepEqual(tokenize("  --  "), []);
});

test("stem: light English stemming", () => {
  assert.equal(stem("biopsies"), "biopsy");
  assert.equal(stem("sisters"), "sister");
  assert.equal(stem("classes"), "class");
  assert.equal(stem("values"), "value");
  assert.equal(stem("status"), "status");
  assert.equal(stem("diagnosis"), "diagnosis");
  assert.equal(stem("yes"), "yes");
  assert.equal(stem("ies"), "ies");
  assert.ok(DEFAULT_STOP_WORDS.includes("the"));
});

test("lexicalDocumentFromRow / lexicalDocumentsFromTable: fields, categories by identity, 0.2.0 `all` parity", () => {
  const row = findRow(bcrpp, "alcohol_init");
  const doc = lexicalDocumentFromRow(row, "My category");
  assert.equal(doc.name, "alcohol_init");
  assert.equal(doc.category, "My category");
  assert.match(doc.values, /^10–100 \(measured value\)\n777 = Nondrinker \[when alcohol_status = 4\]\n888 = Missing\/Unknown$/, "one line per valid value, sentinels included");
  assert.match(doc.format, /integer \+ coded values/);
  assert.match(doc.other, /Required/);
  assert.equal(lexicalDocumentFromRow(row).category, row.__category, "category defaults to the row's __category");

  assert.equal(docs.length, bcrpp.rows.length);
  const vmRows = [];
  for (const category of buildViewModel(bcrpp).categories) for (const r of category.rows) vmRows[r.index] = r;
  docs.forEach((d, i) => {
    assert.equal(d.all, vmRows[i].searchFields.all, `all text of ${d.name} equals the widget's data-search`);
    assert.equal(d.category, vmRows[i].category);
  });
});

test("createLexicalIndex: name-field tokens (splits, whole names), exact names first", () => {
  assert.equal(index.size, bcrpp.rows.length);
  assert.ok(index.vocabularySize > 300);

  let hits = index.search("preg1");
  assert.equal(names(hits)[0], "age_preg1", "letter/digit token of the name");
  assert.ok(fieldsOf(hits[0]).includes("name"));

  hits = index.search("ancestry");
  assert.equal(names(hits)[0], "AJAncestry", "humanised camel-case token");
  hits = index.search("AJAncestry");
  assert.equal(hits[0].exactName, true, "whole raw name (case-insensitive)");
  assert.equal(hits[0].substringOnly, false, "the whole normalised raw name is a real term");
  assert.deepEqual(hits[0].matches[0], { field: "name", terms: ["ajancestry"] });
  hits = index.search("aj ancestry");
  assert.equal(hits[0].exactName, true, "the humanised name counts as an exact name");

  hits = index.search("meno_age");
  assert.equal(names(hits)[0], "meno_age");
  assert.equal(hits[0].exactName, true);
  assert.ok(hits[0].matches[0].terms.includes("meno_age"), "the whole query matches the whole name");
  assert.ok(names(hits).includes("meno_status"), "AND over the tokens still finds meno_status (has 'age' in its description)");

  hits = index.search("status");
  assert.equal(names(hits)[0], "Status", "exactName is a tier above every score");
  assert.ok(hits[0].score < Math.max(...hits.slice(1).map((h) => h.score)) || hits[0].score >= hits[1].score);
});

test("createLexicalIndex: name beats description; bonuses", () => {
  const hits = index.search("cancer");
  assert.ok(hits.length >= 15);
  const nameRows = hits.filter((h) => fieldsOf(h).includes("name"));
  const otherRows = hits.filter((h) => !fieldsOf(h).includes("name"));
  assert.ok(nameRows.length >= 5 && otherRows.length >= 5, `name ${nameRows.length}, others ${otherRows.length}`);
  const worstName = Math.min(...nameRows.map((h) => h.score));
  const bestOther = Math.max(...otherRows.map((h) => h.score));
  assert.ok(worstName > bestOther, "every name match outranks every description-only match");
  assert.ok(hits.slice(0, nameRows.length).every((h) => fieldsOf(h).includes("name")));
  assert.ok(nameRows.every((h) => /cancer/i.test(nameOf(h.row))));
  assert.ok(otherRows.every((h) => !/cancer/i.test(nameOf(h.row)) && /cancer/i.test(bcrpp.rows[h.row]["Description"] + docs[h.row].values)));

  const smoking = index.search("smoking");
  assert.ok(smoking.every((h) => h.namePrefix === nameOf(h.row).toLowerCase().startsWith("smoking")));
  assert.ok(smoking.filter((h) => h.namePrefix).every((h) => h.score > 5), "name-prefix bonus");
});

test("createLexicalIndex: prefix matching of the last token", () => {
  const hits = index.search("hrt");
  const expected = ["hrtuse", "hrt_dur", "hrtuse_ep", "hrtep_dur", "hrtuse_eonly", "hrteonly_dur"];
  assert.deepEqual(new Set(names(hits).slice(0, 6)), new Set(expected), "the six hrt* rows come first");
  assert.ok(hits.slice(0, 6).every((h) => h.namePrefix && !h.substringOnly));
  assert.deepEqual(hitFor(hits, "hrtuse").matches, [{ field: "name", terms: ["hrt"] }], "prefix hits highlight the typed prefix");

  const noPrefix = index.search("hrt", { prefixLastToken: false });
  assert.equal(hitFor(noPrefix, "hrt_dur").substringOnly, false, "'hrt' is a real token of hrt_dur");
  assert.equal(hitFor(noPrefix, "hrtuse").substringOnly, true, "without prefixing, hrtuse only matches as a substring");
  assert.equal(hitFor(noPrefix, "hrtuse").score, 0.5);

  assert.equal(names(index.search("biopsi"))[0].startsWith("Biopsies"), true, "prefixes match surface forms, not just stems");
  const identifier = index.search("smoking_st");
  assert.deepEqual(new Set(names(identifier).slice(0, 2)), new Set(["smoking_status", "smoking_stop"]), "identifier-style prefix");
  assert.ok(identifier.slice(0, 2).every((h) => h.namePrefix));
  assert.ok(identifier.slice(2).every((h) => !h.namePrefix));
});

test("createLexicalIndex: AND, then OR; stop words optional", () => {
  const and = index.search("smoking status");
  assert.equal(names(and)[0], "smoking_status");
  assert.ok(and.every((h) => h.matches.some((m) => m.terms.includes("smoking")) && h.matches.some((m) => m.terms.includes("status"))), "every hit has both tokens");

  const or = index.search("smoking menopause");
  assert.ok(names(or).some((n) => n.startsWith("smoking_")) && names(or).some((n) => n.startsWith("meno_")), "no row has both: OR fallback");
  assert.deepEqual(index.search("smoking menopause", { mode: "and" }), []);
  assert.ok(index.search("smoking menopause", { mode: "or" }).length === or.length);

  const stop = index.search("age at menarche");
  assert.equal(names(stop)[0], "agemenarche");
  assert.ok(stop[0].matches.every((m) => !m.terms.includes("at")), "stop words never appear in matches");

  const onlyStop = index.search("the");
  assert.ok(onlyStop.length > 10, "a query made only of stop words still matches");
  assert.ok(onlyStop.every((h) => h.matches.length === 0));
});

test("createLexicalIndex: the 0.2.0 substring predicate is always unioned in", () => {
  const fields = docs.map((d) => ({ name: d.name.toLowerCase(), description: d.description.toLowerCase(), values: d.values.toLowerCase(), all: d.all }));
  const queries = ["hrt", "meno_age", "kg/m2", "777", "ajancestry", "sisters", "smoking", "body mass", "meno_", "age_preg", "waist-to-hip", "888 = missing", "^(0", "cig/day", "mets", "bbd", "screen", "yyyy", "_dur", "oral contraceptive", "status = 2", "(kg)"];
  for (const q of queries) {
    const legacy = fields.map((f, i) => (keywordScore(f, q) > 0 ? i : -1)).filter((i) => i >= 0);
    const rows = new Set(index.search(q).map((h) => h.row));
    const missed = legacy.filter((r) => !rows.has(r)).map(nameOf);
    assert.deepEqual(missed, [], `"${q}" still matches every 0.2.0 row`);
    assert.ok(legacy.length > 0, `"${q}" is a real 0.2.0 query`);
  }
  // No letter or digit at all: only the substring predicate can match.
  const fragment = index.search("_.+$");
  assert.deepEqual(names(fragment), ["subject_id"]);
  assert.ok(fragment.every((h) => h.substringOnly && h.score === 0.5 && h.matches.length === 0 && !h.exactName));
  // Digits of a regex fragment are tokens too: the regex rows match through their format field.
  const regex = index.search("^(0[1-9]");
  assert.ok(["subject_id", "record_date"].every((n) => names(regex).includes(n)));
  assert.ok(index.search("kg/m2").every((h) => !h.substringOnly), "token matches are not substring-only");
});

test("createLexicalIndex: flags, sorting, limit, tokens(), empty index", () => {
  const prefix = index.search("meno_");
  assert.ok(prefix.slice(0, 3).every((h) => h.namePrefix && nameOf(h.row).startsWith("meno_")));
  assert.equal(prefix[0].exactName, false);

  const sisters = index.search("sisters");
  assert.equal(sisters[0].exactName, true);
  assert.ok(sisters.slice(1).every((h, i, a) => i === 0 || a[i - 1].score >= h.score), "score-descending after the exact-name tier");
  assert.ok(hitFor(sisters, "brCancerSis").matches.some((m) => m.field === "description" && m.terms.includes("sisters")), "surface forms, not stems, are reported");

  assert.equal(index.search("smoking", { limit: 2 }).length, 2);
  assert.deepEqual(index.tokens("Age_Preg1 kg/m2 Épée"), ["age", "preg1", "kg", "m2", "epee"]);
  assert.deepEqual(index.search("   "), []);

  const empty = createLexicalIndex([]);
  assert.equal(empty.size, 0);
  assert.deepEqual(empty.search("x"), []);
});

test("createLexicalIndex: category and other fields are indexed lexically", () => {
  const cat = index.search("anthropometry");
  assert.ok(cat.length >= 5 && cat.every((h) => bcrpp.rows[h.row].__category.includes("Anthropometry")));
  assert.ok(cat.every((h) => fieldsOf(h).includes("category")));
  const other = index.search("required");
  assert.ok(other.length === bcrpp.rows.length, "constraints text ('Required') reaches every row");
});

test("rankHybrid: tiers, fusion, cap, no duplicates, keywordScore derivation", () => {
  const L = (row, score, extra = {}) => ({ row, score, exactName: false, namePrefix: false, substringOnly: false, matches: [{ field: "description", terms: ["x"] }], ...extra });
  const lexical = [
    L(9, 1, { exactName: true, namePrefix: true, matches: [{ field: "name", terms: ["x"] }] }),
    L(0, 10, { matches: [{ field: "name", terms: ["x"] }] }),
    L(1, 9, { namePrefix: true }),
    L(2, 8),
    L(3, 7, { matches: [{ field: "values", terms: ["x"] }] }),
    L(4, 0.5, { substringOnly: true, matches: [] })
  ];
  const semantic = [{ row: 2, score: 0.9 }, { row: 7, score: 0.8 }, { row: 8, score: 0.7 }, { row: 6, score: 0.6 }, { row: 0, score: 0.5 }];

  const ranked = rankHybrid(lexical, semantic, { maxRelated: 2 });
  assert.equal(ranked[0].row, 9, "exact names first, whatever the scores");
  assert.equal(ranked[0].keywordScore, 6);
  assert.equal(new Set(ranked.map((r) => r.row)).size, ranked.length, "no duplicates");
  assert.deepEqual(ranked.filter((r) => !r.exact).map((r) => r.row), [7, 8], "related rows capped at maxRelated, in semantic order");
  assert.ok(ranked.every((r) => r.exact === lexical.some((l) => l.row === r.row)));
  const pos = (row) => ranked.findIndex((r) => r.row === row);
  assert.ok(pos(2) < pos(1), "a row in both lists beats a row in one list");
  assert.ok(pos(0) < pos(1) && pos(1) < pos(3), "lexical order is kept among lexical-only rows");
  assert.equal(ranked.find((r) => r.row === 2).semanticScore, 0.9);
  assert.equal(ranked.find((r) => r.row === 1).semanticScore, undefined);
  assert.deepEqual(ranked.map((r) => [r.row, r.keywordScore]).sort((a, b) => a[0] - b[0]), [[0, 4], [1, 5], [2, 3], [3, 2], [4, 1], [7, 0], [8, 0], [9, 6]]);
  assert.equal(ranked.find((r) => r.row === 0).lexicalScore, 10);
  assert.deepEqual(ranked.find((r) => r.row === 7).matches, []);

  const lexicalOnly = rankHybrid(lexical, undefined, { maxRelated: 5 });
  assert.deepEqual(lexicalOnly.map((r) => r.row), [9, 0, 1, 2, 3, 4]);
  assert.deepEqual(rankHybrid([], semantic, { maxRelated: 0 }), []);
  assert.deepEqual(rankHybrid([], semantic, { maxRelated: 10 }).map((r) => r.row), [2, 7, 8, 6, 0]);

  const noSemantic = rankHybrid(lexical, semantic, { maxRelated: 2, semanticWeight: 0 });
  assert.deepEqual(noSemantic.filter((r) => r.exact).map((r) => r.row), [9, 0, 1, 2, 3, 4], "semanticWeight 0 keeps the lexical order");
  const heavy = rankHybrid(lexical, semantic, { maxRelated: 2, lexicalWeight: 0.01, k: 1 });
  assert.equal(heavy[1].row, 2, "with a tiny lexical weight the best semantic row comes right after the exact-name tier");
});

test("timing: 10k-row synthetic table (build < 1 s, query < 50 ms; targets 100 ms / 5 ms)", () => {
  const big = cloneTable(bcrpp, 95);
  assert.equal(big.rows.length, 10070);
  let t0 = performance.now();
  const bigDocs = lexicalDocumentsFromTable(big);
  const docsMs = performance.now() - t0;
  t0 = performance.now();
  const bigIndex = createLexicalIndex(bigDocs);
  const buildMs = performance.now() - t0;
  const timings = [];
  for (const q of ["smok", "smoking_status_c12", "meno", "body mass", "missing", "888", "xyzzy"]) {
    bigIndex.search(q);
    const t1 = performance.now();
    let n = 0;
    for (let i = 0; i < 5; i += 1) n = bigIndex.search(q).length;
    timings.push({ q, hits: n, ms: (performance.now() - t1) / 5 });
  }
  const worst = Math.max(...timings.map((t) => t.ms));
  console.log(`lexical 10k: documents ${docsMs.toFixed(1)} ms, build ${buildMs.toFixed(1)} ms (vocab ${bigIndex.vocabularySize}); ` + timings.map((t) => `"${t.q}" ${t.hits} hits ${t.ms.toFixed(2)} ms`).join(", "));
  assert.ok(buildMs < 1000, `build ${buildMs} ms`);
  assert.ok(worst < 50, `worst query ${worst} ms`);
  assert.equal(bigIndex.search("smoking_status_c12")[0].row, big.rows.findIndex((r) => r["Variable name"] === "smoking_status_c12"));
  assert.ok(bigIndex.search("smoking_status_c12")[0].exactName);
});

test("createLexicalIndex: nested paths match by leaf, by parent, as a typed path and as words", () => {
  assert.deepEqual(tokenize("visits[].date"), ["visits", "date"]);
  assert.deepEqual(tokenize("genotype[0]"), ["genotype", "0"]);
  const nested = nestedTable();
  const nestedNames = nested.rows.map((r) => r["Variable name"]);
  const nestedIndex = createLexicalIndex(lexicalDocumentsFromTable(nested));
  const at = (hits, i) => nestedNames[hits[i].row];

  let hits = nestedIndex.search("date");
  assert.equal(at(hits, 0), "visits[].date");
  assert.ok(hits[0].matches.some((m) => m.field === "name" && m.terms.includes("date")));

  hits = nestedIndex.search("visits[].date");
  assert.equal(at(hits, 0), "visits[].date");
  assert.equal(hits[0].exactName, true);
  assert.ok(hits[0].matches[0].terms.includes("visits[].date"), "the whole path is a term of the name field");
  assert.equal(nestedIndex.search("visits date")[0].exactName, true, "the humanised path counts as an exact name");

  hits = nestedIndex.search("visits");
  const byName = new Map(hits.map((h) => [nestedNames[h.row], h]));
  assert.equal(byName.get("visits").exactName, true);
  for (const child of ["visits[].date", "visits[].weight", "visits[].labs[].name"]) {
    assert.ok(byName.get(child), `${child} is a hit`);
    assert.equal(byName.get(child).namePrefix, true);
    assert.equal(byName.get(child).exactName, false);
  }
  assert.equal(at(nestedIndex.search("zip"), 0), "contact.address.zip");
});
