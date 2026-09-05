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
      not_on_questionnaire: { const: -2, title: "Not on questionnaire" },
      not_applicable_code: { const: 9 }
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

/**
 * The kind of one value. Keyed on the JSON of the value rather than `===` so string consts,
 * `null` and -0 are addressable, and asserting a single match rather than taking the first --
 * a code surviving twice with contradictory kinds renders in both blocks, and `find` would
 * hide exactly that.
 */
function kindOf(row, value) {
  const key = JSON.stringify(value);
  const hits = row["Valid values"].filter((v) => JSON.stringify(v.value) === key);
  assert.equal(hits.length, 1, `expected exactly one ${key} in ${row["Variable name"]}, got ${hits.length}`);
  return hits[0].kind;
}

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

test("the vocabulary fires on an inline label, with no $ref name to fall back on", () => {
  // The $ref path is easy to pass by accident -- "…/$defs/suppressed" contains "suppress" --
  // so these consts are inline and deliberately unnamed.
  const t = schemaDocumentsToTable(
    table({
      income: { title: "Income band", oneOf: [{ const: 1, title: "Under 20k" }, { const: -999, title: "Suppressed" }] },
      unit: { title: "Unit", oneOf: [{ const: 1, title: "Metric" }, { const: -1, title: "Do not know" }] },
      version: { title: "Version", oneOf: [{ const: 1, title: "Aqua" }, { const: -2, title: "Not on questionnaire" }] }
    })
  );
  assert.equal(kindOf(findRow(t, "income"), -999), "sentinel", "Suppressed");
  assert.equal(kindOf(findRow(t, "unit"), -1), "sentinel", "Do not know");
  assert.equal(kindOf(findRow(t, "version"), -2), "sentinel", "Not on questionnaire");
});

test("a sentinel word inside a longer substantive label does not make it a code", () => {
  // Drawn from BGS R0_MenopauseReason, a 19-level list of reasons periods stopped that
  // carries its real sentinel separately. Six of its levels contain "not known".
  const t = schemaDocumentsToTable(
    table({
      reason: {
        title: "Reason periods stopped",
        oneOf: [
          { const: 1, title: "Natural" },
          { const: 4, title: "Surgery (type not known)" },
          { const: 6, title: "Does not know reason for stopping" },
          { const: 8, title: "Not known: on HRT" },
          { const: 17, title: "Status not known" },
          REF("suppressed")
        ]
      },
      immune: { title: "Immune status", oneOf: [{ const: 1, title: "Immunosuppressed" }, { const: 2, title: "Normal" }] }
    })
  );
  const reason = findRow(t, "reason");
  for (const code of [1, 4, 6, 8, 17]) assert.equal(kindOf(reason, code), "value", `code ${code} is a real category`);
  assert.equal(kindOf(reason, -999), "sentinel", "the variable's actual sentinel still is one");
  assert.equal(kindOf(findRow(t, "immune"), 1), "value", '"Immunosuppressed" is not "suppressed"');
});

test("a variable whose only values are codes is not categorical", () => {
  // OFH's is_sparse_coding shape: the coding table documents only the special values.
  const t = schemaDocumentsToTable(
    table({
      sparse: { title: "Days active", oneOf: [REF("dont_know"), REF("suppressed")] },
      coded: { title: "Sex", oneOf: [{ const: 1, title: "Female" }, REF("dont_know"), REF("suppressed")] }
    })
  );
  const sparse = findRow(t, "sparse");
  assert.equal(sparse["Data type"], "integer", "no categories to be categorical about");
  assert.ok(sparse["Valid values"].every((v) => v.kind === "sentinel"));
  assert.match(findRow(t, "coded")["Data type"], /categorical/, "one real category is still categorical");
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
  // Each def declares the kind its *wording* would not produce, so deleting the setup flips
  // both assertions -- otherwise the test passes whether or not the keyword is read at all.
  const defs = structuredClone(DEFS);
  defs.schema.$defs.suppressed["x-value-kind"] = "value";
  defs.schema.$defs.none_of_the_above["x-value-kind"] = "sentinel";
  const docs = table({
    inherited: { title: "Inherited", oneOf: [{ const: 1, title: "Yes" }, REF("suppressed"), REF("none_of_the_above")] },
    overridden: { title: "Overridden", oneOf: [{ const: 1, title: "Yes" }, { ...REF("suppressed"), "x-value-kind": "sentinel" }] }
  });
  const t = schemaDocumentsToTable([defs, ...docs.slice(1)]);
  const inherited = findRow(t, "inherited");
  assert.equal(kindOf(inherited, -999), "value", 'declared "value" beats the word "Suppressed"');
  assert.equal(kindOf(inherited, -7), "sentinel", 'declared "sentinel" beats wording that says otherwise');
  assert.equal(kindOf(findRow(t, "overridden"), -999), "sentinel", "the $ref sibling wins over the referenced default");
});

test("a bare enum or const is classified like the oneOf spelling", () => {
  const t = schemaDocumentsToTable(
    table({
      asEnum: { type: "integer", enum: [1, 2, 999], enumDescriptions: { 1: "Yes", 2: "No", 999: "Missing" } },
      asUnion: { oneOf: [{ const: 1, title: "Yes" }, { const: 2, title: "No" }, { const: 999, title: "Missing" }] }
    })
  );
  for (const name of ["asEnum", "asUnion"]) {
    const row = findRow(t, name);
    assert.equal(kindOf(row, 999), "sentinel", `${name}: 999 is a special code`);
    assert.equal(kindOf(row, 1), "value", `${name}: 1 is a real answer`);
  }
});

test("a $ref is read by its def name, not the file it lives in", () => {
  // A file called common/missing_codes.json must not turn everything reached through it
  // into a special code.
  const defs = structuredClone(DEFS);
  defs.uri = "https://demo.local/common/missing_codes.json";
  defs.name = "missing_codes.json";
  defs.schema.$id = "https://schemas.example/pilot/common/missing_codes.json";
  defs.schema.$defs.yes = { const: 1, title: "Yes" };
  defs.schema.$defs.no = { const: 2, title: "No" };
  const docs = table({
    answer: {
      title: "Answer",
      oneOf: [
        { $ref: "../../common/missing_codes.json#/$defs/yes" },
        { $ref: "../../common/missing_codes.json#/$defs/no" },
        { $ref: "../../common/missing_codes.json#/$defs/suppressed" }
      ]
    }
  });
  const row = findRow(schemaDocumentsToTable([defs, ...docs.slice(1)]), "answer");
  assert.equal(kindOf(row, 1), "value");
  assert.equal(kindOf(row, 2), "value");
  assert.equal(kindOf(row, -999), "sentinel", "the def that really is a code still is one");
});

test("a snake_case def name and a curly apostrophe are read like the prose spelling", () => {
  const t = schemaDocumentsToTable(
    table({
      viaRef: { title: "Via ref", oneOf: [{ const: 1, title: "Yes" }, REF("not_applicable_code")] },
      curly: { title: "Curly", oneOf: [{ const: 1, title: "Yes" }, { const: -1, title: "Don\u2019t know" }] }
    })
  );
  assert.equal(kindOf(findRow(t, "viaRef"), 9), "sentinel", "not_applicable_code reads as 'not applicable'");
  assert.equal(kindOf(findRow(t, "curly"), -1), "sentinel", "U+2019 is an apostrophe");
});

test("allOf does not decide the property's kind, and its order does not matter", () => {
  const base = (kind) => ({ "x-value-kind": kind, type: "integer" });
  const one = schemaDocumentsToTable(
    table({ v: { title: "V", allOf: [base("sentinel"), base("value")], oneOf: [{ const: 1, title: "Yes" }] } })
  );
  const other = schemaDocumentsToTable(
    table({ v: { title: "V", allOf: [base("value"), base("sentinel")], oneOf: [{ const: 1, title: "Yes" }] } })
  );
  assert.equal(kindOf(findRow(one, "v"), 1), kindOf(findRow(other, "v"), 1), "allOf is unordered; the answer must be too");
  assert.equal(kindOf(findRow(one, "v"), 1), "value", "a shared base does not retag the property's own values");
});

test("grouping branches into a nested union keeps their declared kinds", () => {
  const flat = schemaDocumentsToTable(
    table({ v: { title: "V", oneOf: [{ const: 888, title: "Every day", "x-value-kind": "value" }, { const: 1, title: "Never" }] } })
  );
  const nested = schemaDocumentsToTable(
    table({ v: { title: "V", oneOf: [{ oneOf: [{ const: 888, title: "Every day", "x-value-kind": "value" }] }, { const: 1, title: "Never" }] } })
  );
  assert.equal(kindOf(findRow(flat, "v"), 888), "value", "888 is a conventional code the author overrode");
  assert.equal(kindOf(findRow(nested, "v"), 888), "value", "nesting must not reverse the declaration");
});

test("a sentinel word inside a clinical or educational term is not a code", () => {
  const t = schemaDocumentsToTable(
    table({
      therapy: {
        title: "Therapy",
        oneOf: [{ const: 1, title: "Ovarian suppression" }, { const: 2, title: "Bone marrow suppression" }, { const: 3, title: "Suppressed" }]
      },
      status: {
        title: "Status",
        oneOf: [{ const: 1, title: "Not in formal education, employment or training" }, { const: 2, title: "Employed" }]
      },
      analyte: { title: "Analyte", oneOf: [{ const: 1, title: "Sodium (Na)" }, { const: 2, title: "N/A" }] }
    })
  );
  const therapy = findRow(t, "therapy");
  assert.equal(kindOf(therapy, 1), "value", "ovarian suppression is a treatment");
  assert.equal(kindOf(therapy, 2), "value", "bone marrow suppression is a finding");
  assert.equal(kindOf(therapy, 3), "sentinel", '"Suppressed" on its own still is a code');
  assert.equal(kindOf(findRow(t, "status"), 1), "value", "NEET is an answer, not a missing form");
  assert.equal(kindOf(findRow(t, "analyte"), 1), "value", "sodium is not N/A");
  assert.equal(kindOf(findRow(t, "analyte"), 2), "sentinel");
});

test("a code in the title and the meaning in the description is still classified", () => {
  const t = schemaDocumentsToTable(
    table({
      v: { title: "V", oneOf: [{ const: 1, title: "Yes" }, { const: -3, title: "-3", description: "Not applicable to this participant." }] },
      w: {
        title: "W",
        oneOf: [
          { const: 1, title: "None of the above", description: "A substantive response, not a missingness sentinel." },
          { const: -3, title: "Prefer not to answer" }
        ]
      }
    })
  );
  assert.equal(kindOf(findRow(t, "v"), -3), "sentinel", "a bare code for a title leaves only the description to read");
  assert.equal(kindOf(findRow(t, "w"), 1), "value", "but a real label means the prose is not consulted");
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

test("x-value-kind never surfaces as metadata, at row, category or table level", () => {
  const docs = table({ flag: { title: "Flag", oneOf: [{ const: 1, title: "Yes" }, REF("dont_know")] } });
  docs[1].schema["x-value-kind"] = "sentinel";
  docs[1].schema["x-variable-group"] = "kept";
  docs[2].schema["x-value-kind"] = "value";
  const t = schemaDocumentsToTable(docs);
  const seen = JSON.stringify([t.additionalInformation, t.categories.map((c) => c.additionalInformation)]);
  assert.doesNotMatch(seen, /x-value-kind/, "consumed by the analyzer, not shown as dataset metadata");
  assert.match(seen, /x-variable-group/, "other x-* keywords still come through");
});
