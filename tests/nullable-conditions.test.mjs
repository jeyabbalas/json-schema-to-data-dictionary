import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable } from "../dist/index.js";

const missing = { const: null, title: "Missing (blank cell)", "x-value-kind": "sentinel" };
const codes = [{ const: "151488193", title: "10 or less" }, { const: "132232896", title: "100 or more" }];

function build(answer, value = null) {
  return schemaDocumentsToTable([
    { uri: "https://example.org/common/defs.json", schema: { $defs: { missing } } },
    {
      uri: "https://example.org/module3/categories/cigarettes.json",
      schema: { type: "object", properties: { answer }, required: ["answer"] }
    },
    {
      uri: "https://example.org/module3/module3.schema.json",
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: { used: { enum: ["0", "1"] } },
          required: ["used"],
          allOf: [
            { $ref: "categories/cigarettes.json" },
            {
              if: { required: ["used"], properties: { used: { const: "0" } } },
              then: { properties: { answer: { const: value } } }
            }
          ]
        }
      }
    }
  ]);
}

// A titled null branch is listed among the special codes (issue #3), and the skip pattern that
// sets it says so on that code; an untitled null only makes the field nullable.
for (const [name, answer, titled] of [
  ["oneOf with inline null", { oneOf: [...codes, missing] }, true],
  ["anyOf with inline null", { anyOf: [...codes, missing] }, true],
  ["oneOf with a shared null definition", { oneOf: [...codes, { $ref: "../../common/defs.json#/$defs/missing" }] }, true],
  ["oneOf with a null type", { oneOf: [...codes, { type: "null" }] }, false],
  ["enum containing null", { enum: ["151488193", "132232896", null] }, false],
  ["nullable type and enum", { type: ["string", "null"], enum: ["151488193", "132232896", null] }, false]
]) {
  test(`a skip pattern may set a nullable categorical field to null: ${name}`, () => {
    const table = build(answer);
    assert.deepEqual(table.warnings, []);
    const row = table.rows.find((r) => r["Variable name"] === "answer");
    assert.match(row["Data type"], /nullable/);
    assert.ok(row["Constraints"].some((c) => c.keyword === "conditional" && c.value === null && /value = null/.test(c.text)));
    const values = row["Valid values"];
    assert.deepEqual(values.map((v) => v.value), titled ? ["151488193", "132232896", null] : ["151488193", "132232896"]);
    if (titled) {
      const code = values[2];
      assert.equal(code.kind, "sentinel");
      assert.equal(code.label, "Missing (blank cell)");
      assert.match(code.condition, /used = "0"/);
    }
  });
}

test("a skip pattern setting a non-nullable categorical field to null still warns", () => {
  const table = build({ oneOf: codes });
  assert.equal(table.warnings.length, 1);
  assert.match(table.warnings[0], /answer is set to null, which its own schema does not allow/);
});

test("nullability does not allow other unlisted categorical values", () => {
  const table = build({ oneOf: [...codes, missing] }, "invalid");
  assert.equal(table.warnings.length, 1);
  assert.match(table.warnings[0], /answer is set to "invalid", which its own schema does not allow/);
});
