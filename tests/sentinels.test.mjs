// Classifying a coded value as a substantive answer or a missing/NA code.
//
// The shapes here are drawn from the CD3 cohort packages, which express every coded variable
// as a `oneOf`/`anyOf` of titled `const` branches plus `$ref`s into a shared `common/defs.json`
// -- and which use negative codes for both kinds, so the code alone tells you nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable } from "../dist/index.js";
import { findRow } from "./_helpers.mjs";

const DEFS = {
  uri: "https://demo.local/common/defs.json",
  name: "defs.json",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.example/pilot/common/defs.json",
    $defs: {
      dont_know: { const: -1, title: "Do not know", description: "Adopted verbatim from the source's coding tables." },
      none_of_the_above: {
        const: -7,
        title: "None of the above",
        description:
          "The participant actively selected 'none of the listed options apply'. This is a substantive response, not a missingness sentinel."
      },
      suppressed: { const: -999, title: "Suppressed" },
      not_on_questionnaire: { const: -2, title: "Not on questionnaire" }
    }
  }
};

/** A table schema whose single category holds `properties`. */
function table(properties) {
  return [
    DEFS,
    {
      uri: "https://demo.local/t/categories/vars.json",
      name: "vars.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://schemas.example/pilot/t/categories/vars.json",
        type: "object",
        title: "Vars",
        properties,
        required: Object.keys(properties)
      }
    },
    {
      uri: "https://demo.local/t/t.schema.json",
      name: "t.schema.json",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://schemas.example/pilot/t/t.schema.json",
        title: "Pilot table",
        type: "array",
        items: { type: "object", allOf: [{ $ref: "categories/vars.json" }], unevaluatedProperties: false }
      }
    }
  ];
}

const REF = (name) => ({ $ref: `../../common/defs.json#/$defs/${name}` });
const kindOf = (row, value) => row["Valid values"].find((v) => v.value === value)?.kind;

test('"Do not know" is a sentinel however it is spelled', () => {
  const t = schemaDocumentsToTable(
    table({
      spelled_out: { title: "Spelled out", oneOf: [{ const: 1, title: "Yes" }, REF("dont_know")] },
      apostrophe: { title: "Apostrophe", oneOf: [{ const: 1, title: "Yes" }, { const: -1, title: "Don't know" }] },
      contracted: { title: "Contracted", oneOf: [{ const: 1, title: "Yes" }, { const: -1, title: "Dont know" }] }
    })
  );
  assert.deepEqual(t.warnings, []);
  for (const name of ["spelled_out", "apostrophe", "contracted"]) {
    assert.equal(kindOf(findRow(t, name), -1), "sentinel", `${name}: -1 is a special code`);
  }
});

test("a description that merely mentions missingness does not make the value a sentinel", () => {
  const t = schemaDocumentsToTable(
    table({
      housing: {
        title: "Do you have any of the following in your home?",
        oneOf: [{ const: 1, title: "A gas hob" }, REF("none_of_the_above"), REF("dont_know")]
      }
    })
  );
  const row = findRow(t, "housing");
  assert.equal(kindOf(row, -7), "value", "'None of the above' is a real answer");
  assert.equal(kindOf(row, -1), "sentinel", "'Do not know' is not");
});

test('"Suppressed" is a sentinel on the strength of its label alone', () => {
  const t = schemaDocumentsToTable(
    table({ income: { title: "Income band", oneOf: [{ const: 1, title: "Under 20k" }, REF("suppressed")] } })
  );
  assert.equal(kindOf(findRow(t, "income"), -999), "sentinel");
});

test("the same code is classified the same way in a mixed union and a pure categorical one", () => {
  const t = schemaDocumentsToTable(
    table({
      pure: { title: "Pure categorical", oneOf: [{ const: 1, title: "Yes" }, { const: 2, title: "No" }, REF("not_on_questionnaire")] },
      mixed: { title: "Numeric plus codes", anyOf: [{ type: "integer", minimum: 0, maximum: 60 }, REF("not_on_questionnaire")] }
    })
  );
  const pure = kindOf(findRow(t, "pure"), -2);
  const mixed = kindOf(findRow(t, "mixed"), -2);
  assert.equal(pure, "sentinel");
  assert.equal(mixed, pure, "a numeric branch alongside the code does not change what the code means");
});

test("a substantive code in a mixed union stays a value", () => {
  const t = schemaDocumentsToTable(
    table({
      tenure: {
        title: "How long at this address?",
        anyOf: [{ type: "integer", minimum: 0, maximum: 100 }, { const: -10, title: "Less than a year" }, REF("dont_know")]
      }
    })
  );
  const row = findRow(t, "tenure");
  assert.match(row["Data type"], /integer \+ coded values/);
  assert.equal(kindOf(row, -10), "value", "'Less than a year' is an answer, not a missing code");
  assert.equal(kindOf(row, -1), "sentinel");
  assert.ok(row["Constraints"].some((c) => /0/.test(c.text) && /100/.test(c.text)), "the range is still a constraint");
});

test("x-value-kind overrides the guess in both directions", () => {
  const t = schemaDocumentsToTable(
    table({
      forced_value: { title: "Forced value", oneOf: [{ const: 1, title: "Yes" }, { const: 888, title: "Missing", "x-value-kind": "value" }] },
      forced_sentinel: { title: "Forced sentinel", oneOf: [{ const: 1, title: "Yes" }, { const: 4, title: "It varies", "x-value-kind": "sentinel" }] }
    })
  );
  assert.equal(kindOf(findRow(t, "forced_value"), 888), "value", "beats both the wordlist and the 888 convention");
  assert.equal(kindOf(findRow(t, "forced_sentinel"), 4), "sentinel");
});

test("x-value-kind is read through a $ref, and a sibling overrides the referenced default", () => {
  const defs = structuredClone(DEFS);
  defs.schema.$defs.none_of_the_above["x-value-kind"] = "value";
  defs.schema.$defs.dont_know["x-value-kind"] = "sentinel";
  const docs = table({
    inherited: { title: "Inherited", oneOf: [{ const: 1, title: "Yes" }, REF("none_of_the_above"), REF("dont_know")] },
    overridden: { title: "Overridden", oneOf: [{ const: 1, title: "Yes" }, { ...REF("dont_know"), "x-value-kind": "value" }] }
  });
  const t = schemaDocumentsToTable([defs, ...docs.slice(1)]);
  const inherited = findRow(t, "inherited");
  assert.equal(kindOf(inherited, -7), "value");
  assert.equal(kindOf(inherited, -1), "sentinel");
  assert.equal(kindOf(findRow(t, "overridden"), -1), "value", "the $ref sibling wins over the referenced default");
});

test("a property-level x-value-kind is the default for its branches", () => {
  const t = schemaDocumentsToTable(
    table({
      codes: {
        title: "All codes are special",
        "x-value-kind": "sentinel",
        oneOf: [{ const: 1, title: "Alpha" }, { const: 2, title: "Beta" }, { const: 3, title: "Gamma", "x-value-kind": "value" }]
      }
    })
  );
  const row = findRow(t, "codes");
  assert.equal(kindOf(row, 1), "sentinel");
  assert.equal(kindOf(row, 2), "sentinel");
  assert.equal(kindOf(row, 3), "value", "a branch declares its own kind over the property default");
});

test("x-value-kind applies to a bare enum and never leaks into Additional information", () => {
  const t = schemaDocumentsToTable(
    table({
      flags: { title: "Flags", type: "integer", enum: [7, 8], "x-value-kind": "sentinel", "x-derivation": "kept" }
    })
  );
  const row = findRow(t, "flags");
  assert.equal(kindOf(row, 7), "sentinel");
  assert.equal(kindOf(row, 8), "sentinel");
  assert.deepEqual(row["Additional information"], { "x-derivation": "kept" });
});
