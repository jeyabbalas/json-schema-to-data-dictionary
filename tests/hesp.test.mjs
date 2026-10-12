// The HESP household panel (tests/fixtures/hesp): 265 variables whose skip patterns use every
// shape a survey schema reaches for -- `not: { const: -666 }` applicability rules, `anyOf`
// conditions, ranges that exclude the missing codes, an `anyOf` of a range and codes as the
// effect, and an "at least one of these accounts" rule across variables. Each must read as
// exactly what the schema enforces, with the rule's `$comment` beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { schemaDocumentsToTable, buildViewModel, toPlainRows } from "../dist/index.js";
import { loadDir, findRow } from "./_helpers.mjs";

const table = schemaDocumentsToTable(loadDir("hesp"));
const conditionals = (name) => findRow(table, name)["Constraints"].filter((c) => c.keyword === "conditional");
const conditional = (name, prefix) => conditionals(name).find((c) => c.text.startsWith(prefix));
const value = (name, v) => findRow(table, name)["Valid values"].find((x) => x.value === v);

test("HESP: every variable, category and rule, without warnings", () => {
  assert.equal(table.rows.length, 265);
  assert.equal(table.categories.length, 12);
  assert.equal(table.conditionalRules.length, 171);
  assert.deepEqual(table.warnings, []);
});

test("HESP: no rule is reduced to 'constrained' or 'condition holds'", () => {
  for (const row of table.rows) {
    for (const c of row["Constraints"]) {
      assert.doesNotMatch(c.text, /Constrained when|condition holds|is constrained/, `${row["Variable name"]}: ${c.text}`);
    }
  }
  for (const rule of table.conditionalRules) {
    assert.ok(rule.triggers.length > 0, rule.condition);
    for (const effect of rule.effects) assert.ok(effect.text, `${rule.condition} -> ${effect.variable}`);
  }
});

test("HESP: an applicability rule says the value must not be the skip code, with its comment", () => {
  const c = conditional("move_reason", "When moved_since_last_wave = 1");
  assert.equal(c.text, "When moved_since_last_wave = 1 (Yes), value ≠ -666 (Not applicable / structural skip).");
  assert.match(c.comment, /^Applicability: households that moved must provide a substantive or item-missing move reason/);
  assert.equal(c.value, undefined, "an exclusion pins nothing");
  const rule = table.conditionalRules.find((r) => r.condition === "moved_since_last_wave = 1 (Yes)");
  assert.deepEqual(rule.effects[0], {
    variable: "move_reason",
    value: [],
    label: "Not applicable / structural skip",
    kind: "notEquals",
    excluded: [-666],
    text: "value ≠ -666 (Not applicable / structural skip)"
  });
});

test("HESP: an anyOf condition names every alternative", () => {
  const c = conditional("largest_shock_amount", "When income_drop_12m = 1");
  assert.equal(
    c.text,
    "When income_drop_12m = 1 (Yes) or household_job_loss_12m = 1 (Yes) or major_unplanned_expense_12m = 1 (Yes) or disaster_displacement_12m = 1 (Yes), value ≠ -666 (Not applicable / structural skip)."
  );
  assert.deepEqual(c.triggers, ["income_drop_12m", "household_job_loss_12m", "major_unplanned_expense_12m", "disaster_displacement_12m"]);
});

test("HESP: a range condition keeps the codes it excludes", () => {
  const c = conditional("housing_cost_income_ratio", "When total_household_income_annual");
  assert.equal(
    c.text,
    "When total_household_income_annual ≤ 0 and total_household_income_annual ∉ {-666, -777 (Refused), -888 (Don't know / unavailable), -999 (Not collected / processing missing)}, value is one of -666 (Not applicable / structural skip), -999 (Not collected / processing missing)."
  );
  // Either code may be used: neither is the value the rule sets.
  assert.equal(value("housing_cost_income_ratio", -666).condition, undefined);
  assert.equal(value("housing_cost_income_ratio", -999).condition, "derived_data_status = 4 (Derived measures unavailable)");
});

test("HESP: a range-or-codes effect is spelled out, and a pinned measured value is not made a code", () => {
  assert.equal(
    conditional("months_housing_arrears", "When housing_payment_arrears_12m = 1").text,
    "When housing_payment_arrears_12m = 1 (Yes), 1 ≤ value ≤ 12 or value is one of -777 (Refused), -888 (Don't know / unavailable), -999 (Not collected / processing missing)."
  );
  assert.equal(value("months_housing_arrears", 0), undefined, "0 months is a measured value, not a special code");
  assert.ok(conditional("months_housing_arrears", "When housing_payment_arrears_12m = 0 (No), value = 0."));
  for (const [name, values] of [["mortgage_count", [0, 1, 2]], ["credit_card_count", [0]], ["overdraft_fees_12m", [0]]]) {
    for (const v of values) assert.equal(value(name, v), undefined, `${name} = ${v} is not invented as a code`);
  }
});

test("HESP: a rule across variables ('at least one account') reaches each of them", () => {
  for (const name of ["checking_owned", "savings_owned", "prepaid_account_owned", "money_market_cd_owned"]) {
    const c = conditional(name, "When banked_status = 1");
    assert.equal(
      c.text,
      "When banked_status = 1 (Banked and not underbanked), at least one of these holds: checking_owned = 1 (Yes); savings_owned = 1 (Yes); prepaid_account_owned = 1 (Yes); money_market_cd_owned = 1 (Yes)."
    );
    assert.equal(c.references.length, 3, "the other three are named");
    assert.match(c.comment, /^Banking classification: banked households own an account/);
  }
});

test("HESP: a code set by one rule and allowed by others is badged only where it is set", () => {
  const vm = buildViewModel(table);
  const row = vm.categories.flatMap((c) => c.rows).find((r) => r.name === "child_school_status1");
  const code = (display) => [...row.values, ...row.sentinels].find((v) => v.display === display);
  assert.deepEqual(code("1").conditions.map((c) => c.text), ["0 ≤ child_age1 ≤ 2"]);
  assert.deepEqual(code("6").conditions, [], "allowed at 3–17, set by nothing");
  assert.deepEqual(code("-777").conditions, []);
  const allowed = row.constraints.filter((c) => c.text.startsWith("When 3 ≤ child_age1 ≤ 4") || c.text.startsWith("When 5 ≤ child_age1 ≤ 17"));
  assert.equal(allowed.length, 2);
  assert.ok(allowed.every((c) => !c.onValues), "the allowed sets stay constraints");
});

test("HESP: values, types and descriptions", () => {
  assert.equal(value("primary_shock_type", 1).kind, "value", "'Income decline' is a shock, not a refusal");
  const id = findRow(table, "split_origin_household_id");
  assert.equal(id["Data type"], "string + coded values");
  assert.equal(id["Valid values"][0].kind, "measurement");
  assert.equal(id["Valid values"][0].label, "matches ^HH[0-9]{8}$");
  assert.ok(conditional("split_origin_household_id", 'When panel_membership_status = 3 (Split-off household), value ≠ "NA"'));
  assert.ok(findRow(table, "net_worth")["Constraints"].some((c) => c.text === "Measured value is never -666, -777, -888 or -999"));
  assert.ok(!findRow(table, "move_in_year")["Constraints"].some((c) => c.keyword === "not"), "1900–2100 already excludes the year codes");
  assert.match(findRow(table, "cross_section_weight")["Description"], /^Cross-sectional household weight\n/, "the variable's own title first");
});

test("HESP: comments of the dataset and its categories are kept apart from their descriptions", () => {
  assert.match(table.comment, /^Standard JSON Schema cannot enforce uniqueness of record_id/);
  const composition = table.categories.find((c) => c.title === "HESP CORE - Household composition");
  assert.match(composition.comment, /^Soft checks: adult_count \+ child_count should equal household_size/);
  assert.doesNotMatch(composition.description, /Soft checks/);
  const rules = table.conditionalRules.filter((r) => r.description);
  assert.equal(rules.length, 171, "every rule keeps its $comment");
});

test("HESP: the flat export keeps one constraint per line, with the rule's comment", () => {
  const plain = toPlainRows(table).find((r) => r["Variable name"] === "move_reason");
  const lines = plain["Constraints"].split("\n");
  assert.equal(lines[0], "Required");
  assert.match(lines[3], /^When moved_since_last_wave = 1 \(Yes\), value ≠ -666 \(Not applicable \/ structural skip\)\. — Note: Applicability:/);
  assert.match(plain["Valid values"], /\nSpecial codes:\n-666 = Not applicable \/ structural skip \[when /);
});
