// Golden-output regression: the projection (see `projectTable`) of every fixture that ships
// with the library, compared to the files under fixtures/golden/. The scalar-only fixtures
// (BCRPP, the clinical trial) must not change at all when the extractor changes; the others
// document exactly what nested support added. Regenerate deliberately with
//   UPDATE_GOLDEN=1 node --test tests/golden.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schemaDocumentsToTable } from "../dist/index.js";
import { FIXTURES, loadDir, loadFile, projectTable } from "./_helpers.mjs";

const GOLDEN = join(FIXTURES, "golden");
const REPO = join(FIXTURES, "..", "..");

const SETS = {
  bcrpp: () => loadDir("multiple_schema_2"),
  "clinical-trial": () => loadDir("multiple_schema_1"),
  covid: () => loadFile("single_schema/covid-patient-dataset.json"),
  "format-showcase": () => loadFile("single_schema/format-showcase-dataset.json"),
  longitudinal: () => loadFile("single_schema/longitudinal-cohort-dataset.json")
};

/** The projection as text, with the checkout's file:// prefix replaced so the files are portable. */
function render(docs) {
  const json = JSON.stringify(projectTable(schemaDocumentsToTable(docs)), null, 1);
  return `${json.replaceAll(REPO, "<repo>")}\n`;
}

for (const [key, load] of Object.entries(SETS)) {
  test(`golden: ${key} output is unchanged`, () => {
    const file = join(GOLDEN, `${key}.json`);
    const actual = render(load());
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(file, actual);
      return;
    }
    const expected = readFileSync(file, "utf8");
    if (actual === expected) return;
    const a = expected.split("\n");
    const b = actual.split("\n");
    let line = 0;
    while (line < a.length && a[line] === b[line]) line += 1;
    assert.fail(
      `${key} differs from ${file} at line ${line + 1}:\n  expected: ${a[line]}\n  actual:   ${b[line]}\n` +
        "If the change is intended, regenerate with UPDATE_GOLDEN=1 node --test tests/golden.test.mjs"
    );
  });
}
