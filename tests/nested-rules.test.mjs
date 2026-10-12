// Skip patterns over nested data: rules that reach into an object's fields or a list's items
// from the record, rules inside a nested object or a list's elements, and rules a value makes
// of itself -- each sentence must say what the schema enforces, including what passes a test
// untested (the fields of a null object, the items of a null list). The nested stress-test
// fixture (golden) has one of each, on real data.

import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, buildViewModel, tableToHtml, tableToXlsx } from "../dist/index.js";
import { findRow } from "./_helpers.mjs";

const POINT = {
  type: ["object", "null"],
  properties: { x: { type: ["number", "null"] }, tier: { type: ["string", "null"], enum: ["bronze", "gold", "platinum", null] } }
};
const PEOPLE = {
  type: ["array", "null"],
  items: {
    type: ["object", "null"],
    properties: { name: { type: ["string", "null"] }, age: { type: ["integer", "null"], minimum: 18 }, langs: { type: ["array", "null"], items: { enum: ["en", "fr"] } } },
    required: ["name", "age", "langs"]
  }
};
const LIST = { type: ["array", "null"], items: { type: ["integer", "null"] } };

/** A one-file table: `properties` on the row object (all required), `rules` in its allOf. */
function build(properties, rules = []) {
  return schemaDocumentsToTable([
    { uri: "https://example.org/t.json", schema: { type: "array", items: { type: "object", properties, required: Object.keys(properties), allOf: rules } } }
  ]);
}
const texts = (table, name) => findRow(table, name)["Constraints"].filter((c) => c.keyword === "conditional" || c.keyword === "if/then").map((c) => c.text);
const conditions = (table) => table.conditionalRules.map((r) => r.condition);

test("a condition on a field inside an object names the field's row, and says a null object passes it", () => {
  const props = { id: { type: "integer" }, point: POINT, words: LIST };
  const then = { properties: { words: { maxItems: 2 } } };
  const table = build(props, [
    // `required` and `properties` test only an object: a null point passes them.
    { if: { properties: { point: { required: ["tier"], properties: { tier: { const: "platinum" } } } } }, then },
    // Unless the rule asks for an object.
    { if: { properties: { point: { type: "object", required: ["tier"], properties: { tier: { const: "gold" } } } } }, then },
    // A field the rule does not require passes when it is absent, as it does when the point is null.
    { if: { properties: { point: { properties: { tier: { const: "bronze" } } } } }, then }
  ]);
  assert.deepEqual(conditions(table), [
    'point.tier = "platinum" or point is null',
    // "point is an object and" goes without saying: a gold tier needs a point.
    'point.tier = "gold"',
    'point.tier = "bronze" or point.tier is absent'
  ]);
  assert.deepEqual(table.conditionalRules[0].triggers, ["point.tier", "point"]);
  assert.deepEqual(table.warnings, []);
});

test("a condition three levels down, and a test of the object itself", () => {
  const deep = { type: ["object", "null"], properties: { l2: { type: "object", properties: { l3: { type: ["object", "null"] } }, required: ["l3"] } } };
  const table = build({ id: { type: "integer" }, deep }, [
    { if: { properties: { deep: { type: "object", required: ["l2"], properties: { l2: { required: ["l3"], properties: { l3: { type: "null" } } } } } } }, then: { properties: { id: { const: 2 } } } }
  ]);
  // `deep.l2` is always an object, so "or deep.l2 is not an object" cannot happen; "deep.l2.l3 is null" needs a deep.l2,
  // and a deep that is an object.
  assert.deepEqual(conditions(table), ["deep.l2.l3 is null"]);
});

test("a requirement on a field inside an object is that field's, and required within the object", () => {
  const table = build({ id: { type: "integer" }, point: POINT }, [
    { if: { properties: { id: { const: 10 } } }, then: { properties: { point: { required: ["x"], properties: { tier: { const: "gold" } } } } } }
  ]);
  assert.deepEqual(texts(table, "point.x"), ["When id = 10, value must be present if point is an object (may be null)."]);
  assert.deepEqual(findRow(table, "point.x")["Constraints"].find((c) => c.keyword === "conditional").references, ["point"], "the object is named, and linked");
  assert.deepEqual(texts(table, "point.tier"), ['When id = 10, value = "gold" or absent.']);
  const effects = table.conditionalRules[0].effects;
  assert.deepEqual(
    effects.map(({ variable, kind, required, within, orAbsent }) => ({ variable, kind, required, within, orAbsent })),
    [
      { variable: "point.tier", kind: "equals", required: undefined, within: undefined, orAbsent: true },
      { variable: "point.x", kind: "required", required: true, within: "point", orAbsent: undefined }
    ]
  );
  // The code the rule sets carries its condition; since the field may also be absent, the sentence stays too.
  assert.equal(findRow(table, "point.tier")["Valid values"].find((v) => v.value === "gold").condition, "id = 10");
  const tier = buildViewModel(table).categories[0].rows.find((r) => r.name === "point.tier");
  assert.equal(tier.constraints.find((c) => c.text.startsWith("When id = 10")).onValues, false);
});

test("an item of a list of objects: contains, minContains and items", () => {
  const props = { id: { type: "integer" }, people: PEOPLE, words: LIST };
  const then = { properties: { words: { maxItems: 2 } } };
  const table = build(props, [
    { if: { properties: { people: { contains: { required: ["age"], properties: { age: { minimum: 65 } } } } } }, then },
    { if: { properties: { people: { type: "array", contains: { type: "object", required: ["age"], properties: { age: { type: "integer", minimum: 70 } } }, minContains: 2 } } }, then },
    { if: { properties: { people: { items: { properties: { langs: { maxItems: 0 } } } } } }, then }
  ]);
  assert.deepEqual(conditions(table), [
    // A null person passes `required` and `properties`; a null age passes `minimum`; a null list passes `contains`.
    "people has an item where (people[].age ≥ 65 or people[].age is null or item is null) or people is null",
    // Two items with an age of 70 or more: a list, objects, and integers -- the integer ages being the numbers.
    "people has at least 2 items where people[].age ≥ 70",
    "people has only items where (people[].langs has no items or people[].langs is null or people[].langs is absent) or people is null"
  ]);
  assert.deepEqual(table.conditionalRules[0].triggers, ["people", "people[].age"], "the item itself is the list's");
});

test("sizes, distinct items, and the items of a list of values", () => {
  const props = { id: { type: "integer" }, words: LIST, ids: LIST, langs: { type: ["array", "null"], items: { enum: ["en", "fr"], enumDescriptions: ["English", "French"] } }, map: { type: ["object", "null"], additionalProperties: { type: "integer" } } };
  const table = build(props, [
    { if: { properties: { words: { minItems: 2 } } }, then: { properties: { ids: { uniqueItems: true } } } },
    { if: { properties: { langs: { contains: { const: "en" } } } }, then: { properties: { map: { maxProperties: 0 } } } },
    { if: { properties: { id: { minimum: 12 } } }, then: { properties: { words: { maxItems: 4, items: { maximum: 999 } }, langs: { items: { const: "fr" } } } } }
  ]);
  assert.deepEqual(conditions(table), ["words has at least 2 items or words is null", 'langs includes "en" (English) or langs is null', "id ≥ 12"]);
  assert.deepEqual(texts(table, "ids"), ["When words has at least 2 items or words is null, value has no repeated items or value is null."]);
  assert.deepEqual(texts(table, "map"), ['When langs includes "en" (English) or langs is null, value has no properties or value is null.']);
  // A null item passes `maximum`.
  assert.deepEqual(texts(table, "words"), ["When id ≥ 12, (value has at most 4 items and value has only items where (item ≤ 999 or item is null)) or value is null."]);
  assert.deepEqual(texts(table, "langs"), ['When id ≥ 12, value has only items where item = "fr" (French) or value is null.']);
  assert.deepEqual(table.warnings, []);
});

test("a position of a list is tested only where the list is that long", () => {
  const props = { id: { type: "integer" }, days: { type: ["array", "null"], items: { type: "string" } } };
  const then = { properties: { id: { const: 9 } } };
  const table = build(props, [
    { if: { properties: { days: { prefixItems: [{ const: "0001-01-01" }] } } }, then },
    { if: { properties: { days: { type: "array", minItems: 1, prefixItems: [{ const: "0001-01-01" }] } } }, then }
  ]);
  assert.deepEqual(conditions(table), ['days[0] = "0001-01-01" or days[0] is absent', 'days[0] = "0001-01-01"']);
});

test("the opposite of a range, of a variable that is only ever a number, is the range it leaves", () => {
  const table = build({ id: { type: "integer" }, label: { type: ["string", "null"] } }, [
    { if: { properties: { id: { minimum: 12 } } }, then: { properties: { label: { type: "string" } } }, else: { properties: { label: { pattern: "^showcase:" } } } }
  ]);
  assert.deepEqual(conditions(table), ["id ≥ 12", "id < 12"]);
  assert.deepEqual(texts(table, "label"), ["When id ≥ 12, value is a string.", "When id < 12, value matches ^showcase: or value is null."]);
});

test("a rule inside an object or a list's items says nothing of a null object, unless it constrains the object itself", () => {
  const point = { ...POINT, if: { required: ["tier"], properties: { tier: { const: "platinum" } } }, then: { required: ["x"] } };
  const strict = { ...POINT, if: { required: ["tier"], properties: { tier: { const: "platinum" } } }, then: { type: "object" } };
  const people = { ...PEOPLE, items: { ...PEOPLE.items, if: { required: ["name"], properties: { name: { const: null } } }, then: { properties: { age: { const: null } } } } };
  const table = build({ point, strict, people });
  // A platinum tier needs a point: "if point is an object" goes without saying.
  assert.deepEqual(texts(table, "point.x"), ['When point.tier = "platinum", value must be present (may be null).']);
  // The name and the age are the same person's.
  assert.deepEqual(texts(table, "people[].age"), ["When people[].name = null in the same item, value = null."]);
  // `required` and `properties` pass a null `strict`, so the `if` holds and the `then` rules the null out.
  assert.deepEqual(texts(table, "strict"), ['When strict.tier = "platinum" or strict is null, value is an object.']);
  assert.ok(!findRow(table, "point")["Constraints"].some((c) => c.keyword === "if/then"), "the rule is read: no 'Has a conditional sub-rule' note");
});

test("a rule a value makes of itself is one of its constraints, wherever the value is", () => {
  const table = build({
    score: { type: ["number", "null"], if: { minimum: 0.5 }, then: { $comment: "Halves and quarters.", multipleOf: 0.25 } },
    counts: { type: ["array", "null"], items: { type: ["integer", "null"], if: { minimum: 1000 }, then: { minimum: 9007199254740990 } } },
    map: { type: ["object", "null"], additionalProperties: { type: ["integer", "null"], if: { maximum: 9 }, then: { minimum: 1 } }, if: { minProperties: 4 }, then: { minProperties: 6 } },
    word: { anyOf: [{ type: "integer" }, { type: "string" }], if: { type: "string" }, then: { minLength: 1 }, else: { minimum: 0 } },
    shifty: { oneOf: [{ type: "integer", if: { minimum: 100 }, then: { multipleOf: 2 } }, { type: "string" }] },
    half: { anyOf: [{ type: "integer", if: { minimum: 100 }, then: { multipleOf: 2 } }, { type: "number", maximum: 0.5 }] }
  });
  const score = findRow(table, "score")["Constraints"].find((c) => c.keyword === "if/then");
  assert.equal(score.text, "When value ≥ 0.5, value is a multiple of 0.25.", "a null passes both sides: the rule says nothing of it");
  assert.equal(score.comment, "Halves and quarters.");
  assert.deepEqual(texts(table, "counts"), ["Each item: When value ≥ 1000, value ≥ 9007199254740990."]);
  assert.deepEqual(texts(table, "map.*"), ["When value ≤ 9, value ≥ 1."]);
  assert.deepEqual(texts(table, "map"), ["When value has at least 4 properties, value has at least 6 properties."], "once: no skip pattern for it too");
  // Only an integer fails "value is a string", so only an integer is held to the `else`.
  assert.deepEqual(texts(table, "word"), ["When value is a string, value has at least 1 character; otherwise, value ≥ 0."]);
  // "≥ 100" is about numbers, and the integers are this value's only numbers ...
  assert.deepEqual(texts(table, "shifty"), ["When value ≥ 100, value is a multiple of 2."]);
  // ... unlike a value that can be any number.
  assert.deepEqual(texts(table, "half"), ["When value is an integer and value ≥ 100, value is a multiple of 2."]);
  assert.deepEqual(table.conditionalRules, []);
});

test("a rule that sets a value to null, and what the Skip logic panel and sheet add to a value", () => {
  const people = { ...PEOPLE, items: { ...PEOPLE.items, if: { required: ["name"], properties: { name: { const: null } } }, then: { properties: { langs: { const: null } } } } };
  const table = build({ id: { type: "integer" }, label: { type: ["string", "null"] }, point: POINT, people }, [
    { if: { properties: { id: { const: 0 } } }, then: { properties: { label: { const: null } } } },
    { if: { properties: { id: { const: 10 } } }, then: { properties: { point: { required: ["tier"], properties: { tier: { const: "gold" } } } } } },
    { if: { properties: { id: { const: 11 } } }, then: { properties: { point: { properties: { tier: { const: "bronze" } } } } } }
  ]);
  assert.deepEqual(table.warnings, [], "null is a value the list allows, whatever codes its items have");
  assert.equal(table.conditionalRules[0].effects[0].value, null);
  const groups = buildViewModel(table).rules.map((r) => r.groups.map((g) => [g.values.join(), g.qualifier ?? ""]));
  assert.deepEqual(groups, [[["null", ""]], [["gold", "(required if point is an object)"]], [["bronze", "or absent"]], [["null", ""]]]);
  const html = tableToHtml(table);
  // The object named in the qualifier links to its row.
  assert.match(html, /<span class="dd-rule-qual">\(required if <button type="button" class="dd-ref" data-dd-goto="point" title="Go to point">point<\/button> is an object\)<\/span>/);
  assert.match(html, /<span class="dd-rule-qual">or absent<\/span>/);
  assert.ok(tableToXlsx(table, { compress: false }).length > 0);
});

test("tests that cannot hold together read with 'or'; one rule about one list leaves out what passes both sides", () => {
  const table = build({ id: { type: "integer" }, label: { type: ["string", "null"] }, shifty: { type: ["integer", "boolean", "string", "null"] }, ids: LIST }, [
    { if: { oneOf: [{ properties: { shifty: { type: "integer" } } }, { properties: { shifty: { type: "boolean" } } }] }, then: { properties: { label: { type: "string" } } } },
    // A number and an integer can be the same value: "exactly one of" stays.
    { if: { oneOf: [{ properties: { shifty: { type: "integer" } } }, { properties: { shifty: { type: "number" } } }] }, then: { properties: { label: { type: "string" } } } },
    { if: { oneOf: [{ properties: { id: { const: 1 } } }, { properties: { id: { enum: [2, 3] } } }] }, then: { properties: { label: { type: "string" } } } },
    // A null list passes "at least 2 items" and "no repeated items" alike: the rule says nothing of it.
    { if: { properties: { ids: { minItems: 2 } } }, then: { properties: { ids: { uniqueItems: true } } } }
  ]);
  assert.deepEqual(conditions(table), [
    "shifty is an integer or true or false",
    "exactly one of: shifty is an integer; shifty is a number",
    "id = 1 or id ∈ {2, 3}",
    "ids has at least 2 items"
  ]);
  assert.deepEqual(texts(table, "ids"), ["When ids has at least 2 items, value has no repeated items."]);
});

test('"type": "null" sets a value as "const": null does; an if\'s comment explains its then, not its else', () => {
  const schema = {
    type: "array",
    $defs: { late: { $comment: "The late rows.", properties: { id: { minimum: 12 } } } },
    items: {
      type: "object",
      properties: { id: { type: "integer" }, label: { type: ["string", "null"] }, point: POINT },
      required: ["id", "label", "point"],
      allOf: [
        { if: { properties: { id: { const: 0 } } }, then: { properties: { label: { const: null }, point: { type: "null" } } } },
        { $comment: "Late and early rows differ.", if: { $ref: "#/$defs/late" }, then: { properties: { label: { type: "string" } } }, else: { properties: { label: { pattern: "^early" } } } }
      ]
    }
  };
  const table = schemaDocumentsToTable([{ uri: "https://example.org/t.json", schema }]);
  assert.deepEqual(table.conditionalRules[0].effects.map((e) => [e.variable, e.kind, e.value, e.text]), [
    ["label", "equals", null, "value = null"],
    ["point", "equals", null, "value = null"]
  ]);
  assert.deepEqual(buildViewModel(table).rules[0].groups.map((g) => g.variables), [["label", "point"]], "one group: both are set to null");
  assert.deepEqual(table.conditionalRules.slice(1).map((r) => [r.condition, r.description]), [
    ["id ≥ 12", "Late and early rows differ. The late rows."],
    ["id < 12", "Late and early rows differ."]
  ]);
});

test("dependentRequired names every field it requires, links them, and says when they are one item's", () => {
  const visit = { type: "object", properties: { glucose: { type: "number" }, fasting: { type: "integer" }, note: { type: "string" } }, dependentRequired: { glucose: ["fasting", "note"] } };
  const table = build({ id: { type: "integer" }, visits: { type: "array", items: visit }, point: { ...POINT, dependentRequired: { tier: ["x"] } } });
  const constraint = (name, start) => findRow(table, name)["Constraints"].find((c) => c.text.startsWith(start));
  const glucose = constraint("visits[].glucose", "When");
  assert.equal(glucose.text, "When visits[].glucose is present, visits[].fasting and visits[].note are also required in the same item.");
  assert.deepEqual(glucose.references, ["visits[].fasting", "visits[].note"]);
  assert.equal(constraint("visits[].note", "Required").text, "Required when visits[].glucose is present in the same item.");
  // One point per record: no item to name.
  assert.equal(constraint("point.tier", "When").text, "When point.tier is present, point.x is also required.");
  const html = tableToHtml(table);
  assert.match(html, /<button type="button" class="dd-ref" data-dd-goto="visits\[\]\.note"/, "a required field is a link to its row");
});

test("the Skips chip counts the other variables a variable's answers set; the Skip logic sheet quotes what it sets", () => {
  const table = build({ id: { type: "integer" }, ids: LIST, tier: { type: ["string", "null"] }, label: { type: ["string", "null"] } }, [
    { if: { properties: { ids: { minItems: 2 } } }, then: { properties: { ids: { uniqueItems: true } } } },
    { if: { properties: { ids: { minItems: 3 } } }, then: { properties: { label: { const: "4" }, id: { const: 4 } } } },
    { if: { properties: { id: { const: 10 } } }, then: { properties: { tier: { const: "gold" } } } }
  ]);
  const html = tableToHtml(table);
  assert.match(html, /title="Answers to ids set 2 other variables \(skip patterns\)"[^>]*><svg[^]*?<span>Skips 2<\/span>/, "ids bounds itself; it sets label and id");
  const groups = buildViewModel(table).rules.flatMap((r) => r.groups.map((g) => g.literals));
  assert.deepEqual(groups, [[], ['"4"'], ["4"], ['"gold"']], 'the code "4" and the number 4 read apart');
  // The sheet's Then column: about "value", never a leading "=".
  const xml = new TextDecoder().decode(tableToXlsx(table, { compress: false }));
  assert.match(xml, /<t xml:space="preserve">value = <\/t><\/r><r><rPr><b\/><sz val="11"\/><rFont val="Consolas"\/><\/rPr><t xml:space="preserve">&quot;gold&quot;<\/t>/, 'Then: value = "gold", the code in bold');
  assert.ok(!/<t(?: xml:space="preserve")?>= /.test(xml), "no Then cell starts with =");
});

test("a position in a list is its list's row's: a rule that reads it or sets it shows there, and names it", () => {
  const days = { type: ["array", "null"], items: { type: "string" } };
  const parts = { type: ["array", "null"], items: { type: ["object", "null"], properties: { k: { type: ["string", "null"] } } } };
  const grid = { type: "array", items: { type: "array", items: { type: "integer" } } };
  const table = build({ id: { type: "integer" }, days, parts, grid }, [
    { if: { properties: { days: { type: "array", minItems: 1, prefixItems: [{ const: "0001-01-01" }] } } }, then: { properties: { id: { const: 9 } } } },
    { if: { properties: { grid: { prefixItems: [{ prefixItems: [{ const: 5 }] }] } } }, then: { properties: { id: { const: 3 } } } },
    { if: { properties: { id: { const: 9 } } }, then: { properties: { days: { prefixItems: [{ const: "0001-01-01" }] }, parts: { prefixItems: [{ properties: { k: { const: "w" } } }] } } } }
  ]);
  // By row name: days[0] is one of days's items, which have no row; grid[0][0] one of grid[]'s.
  assert.deepEqual(table.conditionalRules.map((r) => r.triggers), [["days"], ["grid[]"], ["id"]]);
  assert.deepEqual(table.conditionalRules[2].effects.map((e) => [e.variable, e.text]), [
    ["days[0]", 'value = "0001-01-01" or absent'],
    ["parts[0].k", 'value = "w" or absent']
  ]);
  // On the list's row "value" would be the list: the sentence names the position.
  assert.deepEqual(texts(table, "days"), ['When id = 9, days[0] = "0001-01-01" or absent.']);
  assert.deepEqual(texts(table, "parts[].k"), ['When id = 9, parts[0].k = "w" or absent.']);
  assert.deepEqual(findRow(table, "parts[].k")["Valid values"], [], "the first item's code is not every item's");
  const html = tableToHtml(table);
  assert.match(html, /<button type="button" class="dd-ref" data-dd-goto="days" title="Go to days">days\[0\]<\/button>/, "a position links to its list's row");
  assert.match(html, /<button type="button" class="dd-ref" data-dd-goto="grid\[\]" title="Go to grid\[\]">grid\[0\]\[0\]<\/button>/);
  assert.match(html, /<code class="dd-ref-self">days\[0\]<\/code> = &quot;0001-01-01&quot; or absent/, "on its own row, named and not linked");
  assert.match(html, /title="Answers to days set 1 other variable \(skip patterns\)"/, "days's first item sets id");
  assert.match(html, /title="Answers to id set 2 other variables \(skip patterns\)"/, "id sets days and parts[].k");
});

test("a requirement leaves out the values its condition rules out; one that a value be there says whether null will do", () => {
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: { v: { type: ["number", "string", "null"] }, people: PEOPLE, n: { type: ["integer", "null"] }, m: { type: "integer" }, point: POINT },
      required: ["v", "people", "point"],
      allOf: [
        { if: { properties: { v: { type: "number" } } }, then: { properties: { v: { minimum: 0 } } } },
        {
          if: { properties: { people: { type: "array", contains: { type: "object", required: ["age"], properties: { age: { type: "integer", minimum: 70 } } }, minContains: 2 } } },
          then: { properties: { people: { maxItems: 2 } } }
        },
        { if: { properties: { v: { const: 1 } } }, then: { required: ["n", "m"], properties: { point: { required: ["tier"], properties: { tier: { enum: ["bronze", "gold"] } } } } } }
      ]
    }
  };
  const table = schemaDocumentsToTable([{ uri: "https://example.org/t.json", schema }]);
  // A number is not a string or null, and two people make a list.
  assert.deepEqual(texts(table, "v"), ["When v is a number, value ≥ 0."]);
  assert.deepEqual(texts(table, "people"), ["When people has at least 2 items where people[].age ≥ 70, value has at most 2 items."]);
  assert.deepEqual(texts(table, "n"), ["When v = 1, value must be present (may be null)."]);
  assert.deepEqual(texts(table, "m"), ["When v = 1, value must be present."]);
  assert.deepEqual(texts(table, "point.tier"), ['When v = 1, value is one of "bronze", "gold" (required if point is an object).']);
  // "(required if point is an object)" is no code's label: its object links to its row, on the row and in the panel.
  const html = tableToHtml(table);
  const linked = '\\(required if <button type="button" class="dd-ref" data-dd-goto="point" title="Go to point">point<\\/button> is an object\\)';
  assert.match(html, new RegExp(`&quot;gold&quot; ${linked}\\.`), "on the row");
  assert.match(html, new RegExp(`<span class="dd-rule-qual">${linked}</span>`), "in the panel");
});

test("a position is one of its list's items: a test that lets a null item through says so", () => {
  const d = { type: ["array", "null"], items: { type: ["integer", "null"] } };
  const ps = { type: ["array", "null"], items: { type: ["object", "null"], properties: { age: { type: ["integer", "null"] } } } };
  const table = build({ id: { type: "integer" }, d, ps }, [
    { if: { properties: { d: { prefixItems: [{ minimum: 70 }] } } }, then: { properties: { id: { const: 0 } } } },
    { if: { properties: { ps: { prefixItems: [{ properties: { age: { minimum: 70 } } }] } } }, then: { properties: { id: { const: 0 } } } },
    { if: { properties: { id: { const: 1 } } }, then: { properties: { ps: { prefixItems: [{ properties: { age: { minimum: 70 } } }] } } } }
  ]);
  assert.deepEqual(conditions(table).slice(0, 2), ["d[0] ≥ 70 or d[0] is null or d[0] is absent", "ps[0].age ≥ 70 or ps[0].age is null or ps[0].age is absent"]);
  assert.deepEqual(texts(table, "ps[].age"), ["When id = 1, ps[0].age ≥ 70 or ps[0].age is null or absent."]);
});

test("items beside prefixItems are the items after those positions", () => {
  const s = { type: ["array", "null"], items: { type: ["string", "null"] } };
  const ps = { type: ["array", "null"], items: { type: ["object", "null"], properties: { age: { type: ["integer", "null"] } } } };
  const set = (list) => ({ if: { properties: { id: { const: 1 } } }, then: { properties: list } });
  const table = build({ id: { type: "integer" }, s, ps }, [
    set({ s: { prefixItems: [{ const: "x" }], items: { const: "y" } } }),
    set({ s: { prefixItems: [{ const: "x" }], items: false } }),
    set({ ps: { prefixItems: [{ properties: { age: { const: 1 } } }], items: { properties: { age: { minimum: 0 } } } } }),
    { if: { properties: { s: { type: "array", prefixItems: [{ const: "x" }], items: { const: "y" } } } }, then: { properties: { id: { const: 4 } } } }
  ]);
  assert.deepEqual(texts(table, "s"), [
    'When id = 1, value has only items where item = "y" from value[1] on or value is null.',
    'When id = 1, s[0] = "x" or absent.',
    "When id = 1, value has at most 1 item or value is null."
  ]);
  // Items with fields: not every item's age, so a sentence about the list, on the list and the field.
  const after = "When id = 1, ps has only items where (ps[].age ≥ 0 or ps[].age is null or ps[].age is absent) from ps[1] on or ps is null.";
  assert.deepEqual(texts(table, "ps"), [after]);
  assert.deepEqual(texts(table, "ps[].age"), [after, "When id = 1, ps[0].age = 1 or absent."]);
  assert.equal(conditions(table).at(-1), 's has only items where item = "y" from s[1] on and (s[0] = "x" or s[0] is absent)');
});
