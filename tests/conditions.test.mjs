// How skip-pattern rules read: conditions (`if`) and what each clause requires (`then` /
// `else` / a dependent schema), on small schemas -- each sentence must say exactly what the
// schema enforces. HESP (hesp.test.mjs) covers the shapes a real survey uses.

import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, buildViewModel } from "../dist/index.js";
import { findRow } from "./_helpers.mjs";

const YES_NO = { oneOf: [{ const: 0, title: "No" }, { const: 1, title: "Yes" }, { const: 999, title: "Missing" }] };

/** A one-file table: `properties` on the row object (all required unless `optional` says otherwise), `rules` in its allOf. */
function build(properties, rules, { optional = [] } = {}) {
  const required = Object.keys(properties).filter((name) => !optional.includes(name));
  return schemaDocumentsToTable([
    { uri: "https://example.org/t.json", schema: { type: "array", items: { type: "object", properties, required, allOf: rules } } }
  ]);
}
const texts = (table, name) => findRow(table, name)["Constraints"].filter((c) => c.keyword === "conditional").map((c) => c.text);

test("a condition on a variable that may be absent also holds when it is absent", () => {
  const props = { smoker: YES_NO, packs: { type: "integer", minimum: 0 } };
  const rule = { if: { properties: { smoker: { const: 1 } } }, then: { required: ["packs"] } };
  const optional = build(props, [rule], { optional: ["smoker", "packs"] });
  assert.deepEqual(texts(optional, "packs"), ["When smoker = 1 (Yes) or smoker is absent, a value is required."]);
  // Required by the row object, or by the `if` itself: present whenever the rule is read.
  assert.deepEqual(texts(build(props, [rule]), "packs"), ["When smoker = 1 (Yes), a value is required."]);
  const inIf = { ...rule, if: { ...rule.if, required: ["smoker"] } };
  assert.deepEqual(texts(build(props, [inIf], { optional: ["smoker", "packs"] }), "packs"), ["When smoker = 1 (Yes), a value is required."]);
});

test("else reads as the opposite condition", () => {
  const props = { smoker: YES_NO, packs: { anyOf: [{ type: "integer", minimum: 0 }, { const: 777, title: "Not applicable" }] } };
  const table = build(props, [{ if: { properties: { smoker: { const: 1 } } }, then: { properties: { packs: { not: { const: 777 } } } }, else: { properties: { packs: { const: 777 } } } }]);
  assert.deepEqual(texts(table, "packs"), [
    "When smoker = 1 (Yes), value ≠ 777 (Not applicable).",
    "When smoker ≠ 1 (Yes), value = 777 (Not applicable)."
  ]);
  assert.equal(findRow(table, "packs")["Valid values"].find((v) => v.value === 777).condition, "smoker ≠ 1 (Yes)");
});

test("a rule nested in a clause applies under both conditions", () => {
  const props = { smoker: YES_NO, quit: YES_NO, quit_age: { anyOf: [{ type: "integer", minimum: 10, maximum: 100 }, { const: 777, title: "Not applicable" }] } };
  const table = build(props, [
    { if: { properties: { smoker: { const: 1 } } }, then: { if: { properties: { quit: { const: 0 } } }, then: { properties: { quit_age: { const: 777 } } } } }
  ]);
  assert.deepEqual(texts(table, "quit_age"), ["When smoker = 1 (Yes) and quit = 0 (No), value = 777 (Not applicable)."]);
  assert.deepEqual(table.conditionalRules[0].triggers, ["smoker", "quit"]);
});

test("conditions with oneOf, not and allOf, and a clause that forbids the case", () => {
  const props = { a: YES_NO, b: YES_NO, c: YES_NO };
  const table = build(props, [
    { if: { oneOf: [{ properties: { a: { const: 1 } } }, { properties: { b: { const: 1 } } }] }, then: { properties: { c: { const: 1 } } } },
    { if: { not: { properties: { a: { enum: [0, 1] } } } }, then: { properties: { c: { const: 999 } } } },
    { if: { allOf: [{ properties: { a: { const: 0 } } }, { properties: { b: { const: 0 } } }] }, then: false }
  ]);
  const conditions = table.conditionalRules.map((r) => r.condition);
  assert.deepEqual(conditions, ["exactly one of: a = 1 (Yes); b = 1 (Yes)", "a ∉ {0 (No), 1 (Yes)}", "a = 0 (No) and b = 0 (No)"]);
  assert.ok(texts(table, "a").includes("Not allowed: a = 0 (No) and b = 0 (No)."), "a forbidden combination is a constraint of each variable it reads");
  assert.deepEqual(table.conditionalRules[2].effects.map((e) => [e.variable, e.kind]), [["a", "forbidden"], ["b", "forbidden"]]);
});

test("dependentSchemas reads like a then clause", () => {
  const props = { pregnant: YES_NO, weeks: { type: "integer", minimum: 1, maximum: 42 } };
  const table = schemaDocumentsToTable([
    {
      uri: "https://example.org/t.json",
      schema: { type: "array", items: { type: "object", properties: props, dependentSchemas: { weeks: { properties: { pregnant: { const: 1 } } } } } }
    }
  ]);
  // `pregnant` may be absent from a record, and `properties` constrains only a value that is there.
  assert.deepEqual(texts(table, "pregnant"), ["When weeks is present, value = 1 (Yes) or absent."]);
});

test("a code labelled with itself reads once; long sets are not labelled", () => {
  const count = { oneOf: [0, 1, 2, 3].map((n) => ({ const: n, title: String(n) })) };
  const many = { enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], enumDescriptions: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] };
  const table = build({ n: count, m: many, x: YES_NO }, [
    { if: { properties: { n: { const: 0 } } }, then: { properties: { x: { const: 999 } } } },
    { if: { properties: { m: { enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] } } }, then: { properties: { x: { const: 0 } } } }
  ]);
  assert.equal(table.conditionalRules[0].condition, "n = 0");
  assert.equal(table.conditionalRules[1].condition, "m ∈ {1, 2, 3, 4, 5, 6, 7, 8, 9}");
});

test("$comments: on the variable (a note), on a code, on a shared definition, on a rule and its clause", () => {
  const schema = {
    type: "array",
    items: {
      type: "object",
      required: ["a", "b"],
      properties: {
        a: { title: "A", description: "First.", $comment: "Asked from wave 2.", oneOf: [{ const: 1, title: "Yes", $comment: "Includes proxy answers." }, { const: 0, title: "No" }, { $ref: "#/$defs/na" }] },
        b: { $ref: "#/$defs/shared", title: "B" }
      },
      allOf: [{ $comment: "Rule comment.", if: { properties: { a: { const: 0 } } }, then: { $comment: "Clause comment.", properties: { b: { $comment: "About b.", const: "x" } } } }]
    },
    $defs: {
      na: { const: -666, title: "Not applicable", $comment: "Set by routing." },
      shared: { type: "string", title: "Shared", description: "Shared text.", $comment: "Shared note." }
    }
  };
  const table = schemaDocumentsToTable([{ uri: "https://example.org/c.json", schema }]);
  const a = findRow(table, "a");
  assert.equal(a["Description"], "A\nFirst.\nAsked from wave 2.", "the comment is the description's last line, for flat exports");
  assert.equal(a.__comment, "Asked from wave 2.");
  assert.equal(a["Valid values"].find((v) => v.value === 1).comment, "Includes proxy answers.");
  assert.equal(a["Valid values"].find((v) => v.value === -666).comment, "Set by routing.", "a shared definition's comment travels with its code");

  const b = findRow(table, "b");
  assert.equal(b["Description"], "B\nShared text.\nShared note.", "own title first, the definition's title replaced");
  assert.equal(b.__comment, "Shared note.");
  const rule = b["Constraints"].find((c) => c.keyword === "conditional");
  assert.equal(rule.comment, "Rule comment. Clause comment. About b.");

  const row = buildViewModel(table).categories[0].rows.find((r) => r.name === "a");
  assert.equal(row.description, "A\nFirst.");
  assert.equal(row.comment, "Asked from wave 2.");
});

// --- Cases an independent check of the sentences found (each against its own validator) ------

test("the opposite of a test that needs its variable present also holds when it is absent", () => {
  const props = { smoker: YES_NO, packs: { anyOf: [{ type: "integer", minimum: 0 }, { const: 777, title: "Not applicable" }] } };
  const rule = { if: { required: ["smoker"], properties: { smoker: { const: 1 } } }, else: { properties: { packs: { const: 777 } } } };
  // `smoker` may be absent from a record: then the `if` fails, and `else` applies.
  const optional = build(props, [rule], { optional: ["smoker"] });
  assert.deepEqual(texts(optional, "packs"), ["When smoker ≠ 1 (Yes) or smoker is absent, value = 777 (Not applicable)."]);
  // Every record has it: the opposite of "= 1" is "≠ 1".
  assert.deepEqual(texts(build(props, [rule]), "packs"), ["When smoker ≠ 1 (Yes), value = 777 (Not applicable)."]);
  // `not` in an `if`, and "not present" reads as "absent".
  const notIn = build(props, [{ if: { not: { required: ["smoker"], properties: { smoker: { const: 1 } } } }, then: { properties: { packs: { const: 777 } } } }], { optional: ["smoker"] });
  assert.equal(notIn.conditionalRules[0].condition, "smoker ≠ 1 (Yes) or smoker is absent");
  const notPresent = build(props, [{ if: { not: { required: ["smoker"] } }, then: { properties: { packs: { const: 777 } } } }], { optional: ["smoker"] });
  assert.equal(notPresent.conditionalRules[0].condition, "smoker is absent");
});

test("a code reads with the variable's own label; a comment names only codes the variable does not label", () => {
  const props = {
    smoker: YES_NO,
    quit_reason: { oneOf: [{ const: 1, title: "Health" }, { const: 777, title: "Refused" }] },
    cigs: { anyOf: [{ type: "integer", minimum: 0, maximum: 100 }, { const: 777 }] }
  };
  const table = build(props, [
    {
      $comment: "Skip pattern: never smoker => quit reason and cigarettes per day are Nonsmoker (777).",
      if: { properties: { smoker: { const: 0 } } },
      then: { properties: { quit_reason: { const: 777 }, cigs: { const: 777 } } }
    }
  ]);
  assert.deepEqual(texts(table, "quit_reason"), ["When smoker = 0 (No), value = 777 (Refused)."], "the label its Valid values show");
  assert.deepEqual(texts(table, "cigs"), ["When smoker = 0 (No), value = 777 (Nonsmoker)."], "the comment's phrase after its verb, for a code without a label");
  assert.deepEqual(
    table.conditionalRules[0].effects.map((e) => [e.variable, e.label]),
    [["quit_reason", "Refused"], ["cigs", "Nonsmoker"]]
  );
});

test("a range tests only numbers and a pattern only strings: other values pass, and a type beside a range is kept when it narrows", () => {
  const props = {
    income: { anyOf: [{ type: "integer", minimum: 0 }, { const: "NA", title: "Not asked" }] },
    weight: { type: "number", minimum: 0 },
    flag: YES_NO
  };
  const table = build(props, [
    { if: { properties: { income: { minimum: 1 } } }, then: { properties: { flag: { const: 1 } } } },
    { if: { properties: { weight: { type: "integer", maximum: 50 } } }, then: { properties: { flag: { const: 0 } } } },
    { if: { properties: { weight: { type: "number", maximum: 50 } } }, then: { properties: { flag: { const: 999 } } } }
  ]);
  assert.deepEqual(
    table.conditionalRules.map((r) => r.condition),
    ["income ≥ 1 or income is a string", "weight is an integer and weight ≤ 50", "weight ≤ 50"]
  );
});

test("keywords the reader cannot put into words are shown as written, and say so", () => {
  const props = { a: YES_NO, b: YES_NO, c: YES_NO };
  const table = build(props, [
    { if: { minProperties: 3 }, then: { properties: { a: { const: 0 } } } },
    { if: { properties: { a: { const: 1 } } }, then: { maxProperties: 5 } },
    { if: { properties: { b: { const: 1 } } }, then: { dependentRequired: { c: ["a"] } } }
  ]);
  assert.deepEqual(table.conditionalRules.map((r) => r.condition), ['the record matches {"minProperties":3}', "a = 1 (Yes)", "b = 1 (Yes) and c is present"]);
  assert.ok(texts(table, "a").includes('When the record matches {"minProperties":3}, value = 0 (No).'));
  assert.ok(texts(table, "a").includes('When a = 1 (Yes), the record must also match {"maxProperties":5}.'));
  assert.ok(texts(table, "a").includes("When b = 1 (Yes) and c is present, a value is required."), "dependentRequired inside a then is a rule");
  assert.ok(table.warnings.some((w) => /maxProperties, minProperties are shown as written/.test(w)));
});

test("a code the variable's own schema rejects is not listed; a warning names the contradiction", () => {
  const props = { flag: YES_NO, score: { type: "integer", minimum: 0, maximum: 100 }, months: { type: "integer" } };
  const table = build(props, [{ if: { properties: { flag: { const: 0 } } }, then: { properties: { score: { const: 777 }, months: { const: 777 } } } }]);
  assert.equal(findRow(table, "score")["Valid values"].length, 0, "0–100 cannot hold 777");
  assert.ok(table.warnings.some((w) => w === "Skip pattern: when flag = 0 (No), score is set to 777, which its own schema does not allow."));
  assert.deepEqual(findRow(table, "months")["Valid values"].map((v) => [v.value, v.kind, v.condition]), [[777, "sentinel", "flag = 0 (No)"]], "any integer can be 777");
});

test("several rules that set one code: their conditions joined by \"or\", a compound one in parentheses", () => {
  const props = { a: YES_NO, b: YES_NO, x: { anyOf: [{ type: "integer", minimum: 0 }, { const: 777, title: "NA" }] } };
  const table = build(props, [
    { if: { properties: { a: { const: 0 } } }, then: { properties: { x: { const: 777 } } } },
    { if: { properties: { a: { const: 1 }, b: { const: 0 } } }, then: { properties: { x: { const: 777 } } } }
  ]);
  const code = findRow(table, "x")["Valid values"].find((v) => v.value === 777);
  assert.equal(code.condition, "a = 0 (No) or (a = 1 (Yes) and b = 0 (No))");
  const vm = buildViewModel(table);
  const row = vm.categories.flatMap((c) => c.rows).find((r) => r.name === "x");
  assert.deepEqual(row.sentinels[0].conditions.map((c) => c.text), ["a = 0 (No)", "a = 1 (Yes) and b = 0 (No)"], "the table shows each on its own line");
});

test("a rule without a condition, a nested rule's comment, and a comment on several lines in a flat cell", async () => {
  const { constraintsCell } = await import("../dist/index.js");
  const props = { a: YES_NO, b: YES_NO };
  const table = build(props, [
    { if: true, then: { properties: { a: { const: 1 } } } },
    {
      $comment: "Outer: asked of consenting adults.",
      if: { properties: { a: { const: 1 } } },
      then: { $comment: "Line one.\nLine two.", if: { properties: { b: { const: 0 } } }, then: { properties: { a: { const: 1 } } } }
    }
  ]);
  assert.ok(texts(table, "a").includes("In every record, value = 1 (Yes)."));
  const nested = table.conditionalRules.find((r) => r.condition === "a = 1 (Yes) and b = 0 (No)");
  assert.equal(nested.description, "Outer: asked of consenting adults. Line one.\nLine two.");
  const cell = constraintsCell(findRow(table, "a")["Constraints"]).split("\n");
  assert.ok(cell.includes("When a = 1 (Yes) and b = 0 (No), value = 1 (Yes). — Note: Outer: asked of consenting adults. Line one. Line two."), cell.join("\n"));
});
