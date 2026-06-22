import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");

/** Load a single fixture file as a one-document input array. */
export function loadFile(rel) {
  const p = join(FIXTURES, rel);
  return [{ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) }];
}

/** Load every .json file under a fixture directory (recursively) as document inputs. */
export function loadDir(rel) {
  const dir = join(FIXTURES, rel);
  const out = [];
  (function walk(d) {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".json")) out.push({ uri: pathToFileURL(p).href, name: basename(p), schema: JSON.parse(readFileSync(p, "utf8")) });
    }
  })(dir);
  return out;
}

export function findRow(table, name) {
  return table.rows.find((r) => r["Variable name"] === name);
}

export function noUnresolved(table) {
  return !table.warnings.some((w) => /could not resolve/i.test(w));
}
