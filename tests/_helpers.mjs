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

/**
 * A table `times` larger than `table`: every copy suffixes the variable names and the
 * category ids/titles (copy 0 keeps the originals). Each cloned row object is shared between
 * `rows` and its category, as buildViewModel identifies rows by object identity.
 */
export function cloneTable(table, times) {
  const rows = [];
  const categories = [];
  for (let t = 0; t < times; t += 1) {
    const suffix = t === 0 ? "" : `_${t}`;
    const clones = new Map(table.rows.map((row) => [row, { ...row, "Variable name": row["Variable name"] + suffix }]));
    const clone = (row) => clones.get(row) ?? { ...row, "Variable name": row["Variable name"] + suffix };
    rows.push(...clones.values());
    for (const cat of table.categories) {
      categories.push({ ...cat, id: cat.id + suffix, title: suffix ? `${cat.title} ${t}` : cat.title, rows: cat.rows.map(clone) });
    }
  }
  return { ...table, rows, categories };
}
