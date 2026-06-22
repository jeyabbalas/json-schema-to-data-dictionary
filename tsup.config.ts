import { defineConfig } from "tsup";

export default defineConfig([
  // Library build: ESM + type declarations for bundler-based consumers.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    outDir: "dist"
  },
  // Browser build: a single self-contained global bundle for drop-in <script> use.
  // Produces dist/json-schema-data-dictionary.global.js (referenced by the "./browser" export).
  {
    entry: { "json-schema-data-dictionary": "src/index.ts" },
    format: ["iife"],
    globalName: "JsonSchemaDataDictionary",
    sourcemap: true,
    minify: true,
    target: "es2020",
    platform: "browser",
    outDir: "dist"
  }
]);
