// Static file server for the demo, used by `npm run demo:serve`.
//
// This exists instead of `python3 -m http.server` because that server sends no
// Cache-Control and no ETag — only Last-Modified. Browsers then fall back to
// heuristic freshness (RFC 9111 §4.2.2: roughly 10% of the file's age), so a
// rebuilt bundle can keep serving from cache for hours. Firefox does this far
// more eagerly than Chrome, which shows up as "the demo is stale in one browser
// only". Every response here is `no-store`, so a plain reload always refetches.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 8080);

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
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-store, must-revalidate",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Serving demo/ at http://localhost:${PORT} (cache disabled)`);
});

function end(res, code, message) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}
