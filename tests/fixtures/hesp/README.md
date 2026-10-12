# HESP fixture

The JSON Schema of the hypothetical *Household Economic Security Panel* (HESP) CORE table: one
array element is one household at one interview wave, 265 variables in 12 category schemas
(`core/categories/`), shared codes in `common/defs.json`, and 171 skip-pattern and consistency
rules in `core/core.schema.json` — `not: { const: -666 }` applicability rules, `anyOf` conditions,
ranges that exclude the missing codes, and an "at least one account" rule across variables.

Copied from [jeyabbalas/quac](https://github.com/jeyabbalas/quac/tree/c405ad93fab6337a64d4e9aa476d907ed168614a/tests/fixtures/hesp/json_schema)
at commit `c405ad9` (schema files only).
