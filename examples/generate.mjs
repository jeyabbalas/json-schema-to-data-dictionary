// Build a data dictionary from the BCRPP fixture and write a standalone HTML page.
// Run after building:  npm run build && node examples/generate.mjs
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { schemaDocumentsToTable, tableToHtml } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "tests", "fixtures", "multiple_schema_2");

function loadDir(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...loadDir(p));
    else if (p.endsWith(".json")) out.push({ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) });
  }
  return out;
}

const table = schemaDocumentsToTable(loadDir(FIXTURE));

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeAttr(table.title ?? "Data dictionary")}</title>
  <style>body { margin: 0; padding: 24px; max-width: 1200px; margin: 0 auto; background: #fafbfc; }</style>
</head>
<body>
${tableToHtml(table)}
</body>
</html>`;

const outPath = join(HERE, "dictionary.html");
writeFileSync(outPath, page, "utf8");

function escapeAttr(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

// Console summary so the run is informative on its own.
const meno = table.rows.find((r) => r["Variable name"] === "meno_age");
console.log(`Wrote ${outPath}`);
console.log(`  title:             ${table.title}`);
console.log(`  categories:        ${table.categories.length} (${table.categories.map((c) => c.title).join(", ")})`);
console.log(`  variables (rows):  ${table.rows.length}`);
console.log(`  skip-pattern rules: ${table.conditionalRules.length}`);
console.log(`  warnings:          ${table.warnings.length}`);
if (meno) {
  console.log(`\n  sample mixed-type row — meno_age:`);
  console.log(`    Data type:   ${meno["Data type"]}`);
  console.log(`    Valid values:`);
  for (const v of meno["Valid values"]) {
    const tag = v.kind === "sentinel" ? "code" : v.kind ?? "value";
    const when = v.condition ? `  (when ${v.condition})` : "";
    console.log(`      [${tag}] ${v.value ?? v.label}${v.label && v.value !== null ? ` — ${v.label}` : ""}${when}`);
  }
  console.log(`    Constraints: ${meno["Constraints"].map((c) => c.text).join(" | ")}`);
}
