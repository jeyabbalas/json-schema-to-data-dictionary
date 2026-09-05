// Root detection: people hand the tool a whole folder, so the input mixes the table schema
// with the components it $refs, example data files and sometimes several tables.

import test from "node:test";
import assert from "node:assert/strict";
import { findSchemaRoots, schemaDocumentsToTable } from "../dist/index.js";
import { loadDir } from "./_helpers.mjs";

const BCRPP = loadDir("multiple_schema_2");

/** The same documents under a synthetic base, optionally nested `prefix` directories deep. */
function rebase(docs, prefix = "") {
  return docs.map((d) => {
    const rel = d.uri.slice(d.uri.indexOf("multiple_schema_2/") + "multiple_schema_2/".length);
    return { ...d, uri: `https://demo.local/${prefix}${rel}` };
  });
}

/** A plain data file (an array of records) that happens to sit next to the schemas. */
const EXAMPLE_ROWS = { uri: "file:///schemas/examples/toy_valid.json", name: "toy_valid.json", schema: [{ id: "A" }, { id: "B" }] };
/** A ledger: an object with no schema keywords at all. */
const LEDGER = {
  uri: "file:///schemas/examples/ledger.json",
  name: "ledger.json",
  schema: { $comment: "ground truth for toy_invalid.json", rowIndexBase: 0, violations: [{ row: 0, column: "id" }] }
};

test("ranks the array-of-records schema first and marks the $ref'd ones as components", () => {
  const roots = findSchemaRoots(BCRPP);
  const best = roots[0];
  assert.ok(best, "a candidate was found");
  assert.match(best.uri, /core\.schema\.json$/);
  assert.equal(best.arrayLike, true);
  assert.equal(best.referenced, false);
  assert.ok(best.variableCount > 40, `variableCount: ${best.variableCount}`);

  const categories = roots.filter((c) => /categories\//.test(c.uri));
  assert.equal(categories.length, 11);
  assert.ok(categories.every((c) => c.referenced), "every category schema is referenced by the root");
  assert.equal(roots.filter((c) => c.arrayLike && !c.referenced).length, 1, "exactly one table root");
});

test("data files are not candidates and never become the root", () => {
  const withData = [EXAMPLE_ROWS, LEDGER, ...BCRPP];
  const roots = findSchemaRoots(withData);
  assert.ok(!roots.some((c) => /toy_valid|ledger/.test(c.uri)), `data files ranked: ${roots.map((c) => c.uri).join(", ")}`);

  const table = schemaDocumentsToTable(withData);
  assert.equal(table.title, "BCRPP - CORE table");
  assert.ok(table.rows.length > 40);
});

test("the choice does not depend on document order", () => {
  const orders = [BCRPP, [...BCRPP].reverse(), [...BCRPP].slice(5).concat(BCRPP.slice(0, 5))];
  const titles = orders.map((docs) => schemaDocumentsToTable(docs).title);
  assert.deepEqual(titles, ["BCRPP - CORE table", "BCRPP - CORE table", "BCRPP - CORE table"]);
});

test("extra leading directories change nothing (a folder dropped from further up)", () => {
  const flat = schemaDocumentsToTable(rebase(BCRPP));
  const deep = schemaDocumentsToTable(rebase(BCRPP, "some/repository/json_schema/"));
  assert.equal(deep.title, flat.title);
  assert.equal(deep.rows.length, flat.rows.length);
  assert.deepEqual(deep.warnings, flat.warnings);
  assert.equal(
    findSchemaRoots(rebase(BCRPP, "some/repository/json_schema/"))[0].uri,
    "https://demo.local/some/repository/json_schema/core.schema.json"
  );
});

test("several table roots: the largest wins, the rest are reported and selectable", () => {
  const other = {
    uri: "file:///schemas/lite/lite.schema.json",
    name: "lite.schema.json",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "A smaller table",
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, age: { type: "integer" } } }
    }
  };
  const docs = [other, ...BCRPP];
  const tables = findSchemaRoots(docs).filter((c) => c.arrayLike && !c.referenced);
  assert.equal(tables.length, 2);
  assert.match(tables[0].uri, /core\.schema\.json$/);
  assert.equal(tables[1].variableCount, 2);

  const table = schemaDocumentsToTable(docs);
  assert.equal(table.title, "BCRPP - CORE table");
  assert.ok(
    table.warnings.some((w) => /2 documents look like a table root/.test(w)),
    `warnings: ${table.warnings.join(" | ")}`
  );

  const pinned = schemaDocumentsToTable(docs, { rootIndex: tables[1].index });
  assert.equal(pinned.title, "A smaller table");
  assert.equal(pinned.rows.length, 2);
});

test("no schema-like document: the first input is still used", () => {
  const table = schemaDocumentsToTable([LEDGER]);
  assert.equal(findSchemaRoots([LEDGER]).length, 0);
  assert.equal(table.rows.length, 0);
  assert.equal(findSchemaRoots([]).length, 0);
});
