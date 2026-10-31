// The app's test suite: headless and silent browsers (Chromium with --mute-audio; Playwright's
// WebKit and Firefox force-muted), against a local static server of the repo.
//
//   cd tests
//   npm install                          # once (Playwright); `npx playwright install` for browsers
//   npm test                             # every test
//   node run.mjs navigation layout       # only tests whose name contains one of the words
//
// Tests talk only to the local server, api.readquran.app and files.alislam.cloud. Screenshots
// and logs go to tests/out/. Exits non-zero when any test fails.

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = normalize(join(HERE, ".."));
const OUT = join(HERE, "out");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".txt": "text/plain" };

// A tiny static server: no caching, so every test sees the files as they are.
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || file.includes(`${ROOT}/tests/node_modules`)) throw new Error("outside");
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const filters = process.argv.slice(2);
const files = (await readdir(HERE)).filter((f) => f.endsWith(".test.mjs") && (!filters.length || filters.some((w) => f.includes(w)))).sort();
console.log(`Serving ${ROOT} at ${BASE}; ${files.length} test file(s)\n`);

const results = [];
for (const f of files) {
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, f)], { env: { ...process.env, BASE, OUT }, stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  results.push({ f, ok: code === 0, s: ((Date.now() - t0) / 1000).toFixed(0) });
  console.log("");
}
server.close();

console.log("Summary");
for (const r of results) console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.f}  (${r.s}s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
