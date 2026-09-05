// Static file server for the demo, used by `npm run demo:serve`.
//
// This exists instead of `python3 -m http.server` because that server sends no
// Cache-Control and no ETag — only Last-Modified. Browsers then fall back to
// heuristic freshness (RFC 9111 §4.2.2: roughly 10% of the file's age), so a
// rebuilt bundle can keep serving from cache for hours. Firefox does this far
// more eagerly than Chrome, which shows up as "the demo is stale in one browser
// only". Every response here is `no-store`, so a plain reload always refetches.
//
// It also sends the cross-origin-isolation headers (COOP + COEP) by default, so
// the embedding worker can run multi-threaded WASM (SharedArrayBuffer). Every
// cross-origin asset the demo loads (jsDelivr, huggingface.co) is fetched in CORS
// mode and served with CORS/CORP headers, so `require-corp` blocks nothing. Set
// COI=0 to reproduce a host without the headers, such as GitHub Pages.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const CROSS_ORIGIN_ISOLATED = process.env.COI !== "0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".jsddvec": "application/octet-stream", // precomputed vector snapshots
};

const COMMON_HEADERS = {
  "Cache-Control": "no-store, must-revalidate",
  ...(CROSS_ORIGIN_ISOLATED
    ? {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      }
    : {}),
};

createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  // normalize() collapses `..`; the sep check keeps requests inside demo/.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  if (rel === ".." || rel.startsWith(".." + sep)) return end(res, 403, "Forbidden");

  let file = join(ROOT, rel);
  let info;
  try {
    info = statSync(file);
    if (info.isDirectory()) {
      file = join(file, "index.html");
      info = statSync(file);
    }
  } catch {
    return end(res, 404, "Not found");
  }

  res.writeHead(200, {
    ...COMMON_HEADERS,
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Serving demo/ at http://localhost:${PORT} (cache disabled)`);
  console.log(
    CROSS_ORIGIN_ISOLATED
      ? "Cross-origin isolation: on (COOP/COEP sent; WASM threads available). Disable with COI=0 to mimic GitHub Pages."
      : "Cross-origin isolation: off (COI=0; like GitHub Pages — WASM runs single-threaded)."
  );
});

function end(res, code, message) {
  res.writeHead(code, { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}
