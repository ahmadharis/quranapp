// An update never loses the user's settings or data.
// 1. Preferences exactly as 1.1.0 stores them (no `schema` field) and as 1.1.1 stores them
//    (schema 2), with a non-default value everywhere plus bookmarks and a resume point, are
//    loaded by this version: every value and bookmark is unchanged, and the stored prefs gain
//    only the current `schema` and `lastAt` (0: not known before 1.2.0).
// 2. A service-worker update (cache v1 -> v2, served by a small server of its own) leaves
//    localStorage and IndexedDB intact.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, context, open, waitFor, checker } from "./lib/browsers.mjs";

const t = checker("prefs-migration");
const ROOT = normalize(fileURLToPath(new URL("..", import.meta.url)));

// The 1.1.0 shape: every key prefs.js stored in 1.1.0, none at its default.
const future = Date.now() + 30 * 864e5;
const OLD = {
  reciter: "aiman",
  mode: "listen",
  theme: "dark",
  scale: 1.3,
  navTab: "parts",
  last: { ch: 18, v: 10 },
  chLast: { 2: 255, 18: 10, 36: 5 },
  translations: { on: true, list: ["zk", "fr"] },
  wordMeanings: "words-en",
  layout: {
    desk: { contents: false, contentsListen: true, panel: false, focus: true },
    laptop: { contents: true, contentsListen: true, panel: false, focus: false },
    wide: { contents: false, contentsListen: false, panel: false, focus: true },
    ultra: { contents: false, contentsListen: true, panel: true, focus: true },
  },
  barCollapsed: true,
  repeat: true,
  hintSeen: true,
  focusHintSeen: true,
  install: { dismissed: 2, until: future, done: false },
  nazira: true,
  speed: 1.25,
  followWords: false,
  bookmarks: [
    { ch: 36, v: 5, at: 1761900000000 },
    { ch: 2, v: 255, at: 1761800000000 },
    { ch: 1, v: 1, at: 1761700000000 },
  ],
  resume: { ch: 18, v: 10, reciter: "aiman" },
};

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("quran.prefs")));
const live = (page) => page.evaluate(async () => JSON.parse(JSON.stringify((await import("./js/prefs.js")).prefs)));
const sameAsOld = (label, got) => {
  for (const [k, want] of Object.entries(OLD)) t.check(JSON.stringify(got?.[k]) === JSON.stringify(want), `${label}: ${k} is ${JSON.stringify(got?.[k])}, expected ${JSON.stringify(want)}`);
};

const b = await launch("chromium");
try {
  // 1. Loading 1.1.0 prefs.
  for (const [from, seed, viewport] of [["1.1.0", OLD, { width: 402, height: 874 }], ["1.1.1", { ...OLD, schema: 2 }, { width: 1920, height: 1080 }]]) {
    const ctx = await context(b, { prefs: seed, viewport, colorScheme: "light" });
    const { page, errors } = await open(ctx, "");
    await page.waitForTimeout(800);
    const label = `from ${from} at ${viewport.width}px`;
    const SCHEMA = await page.evaluate(async () => (await import("./js/prefs.js")).SCHEMA);
    sameAsOld(`${label} in memory`, await live(page));
    const s = await stored(page);
    sameAsOld(`${label} stored`, s);
    t.check(SCHEMA >= 3 && s?.schema === SCHEMA, `${label}: stored schema ${s?.schema}, expected ${SCHEMA}`);
    t.check(s?.lastAt === 0, `${label}: lastAt ${s?.lastAt}, expected 0`);
    const extra = Object.keys(s ?? {}).filter((k) => !(k in OLD) && k !== "schema" && k !== "lastAt");
    t.check(!extra.length, `${label}: unexpected stored keys ${extra}`);
    const ui = await page.evaluate(() => ({
      hash: location.hash,
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      nazira: document.documentElement.hasAttribute("data-nazira"),
      repeat: document.querySelector("#qp-repeat")?.getAttribute("aria-pressed"),
    }));
    t.check(ui.hash === "#/18:10" && ui.theme === "dark" && ui.mode === "listen" && ui.nazira && ui.repeat === "true", `${label}: page shows ${JSON.stringify(ui)}`);
    t.check(!errors.length, `${label}: console errors ${errors.join(" | ")}`);
    // Migrating twice changes nothing (current-schema prefs load as they are).
    await page.reload();
    await page.waitForSelector(".verse:not(.loading)", { state: "attached" });
    await page.waitForTimeout(600);
    sameAsOld(`${label} after a second load`, await stored(page));
    await ctx.close();
  }

  // 2. A service-worker update from cache v1 to v2.
  let cacheName = "quran-dev-migration-v1";
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT) || file.includes(join(ROOT, "tests"))) throw new Error("outside");
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      let body = await readFile(file);
      if (path === "/sw.js") body = body.toString().replace(/const CACHE = "[^"]+";/, `const CACHE = "${cacheName}";`);
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ctx = await context(b, { prefs: OLD });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(`${base}/#/36:1`);
    await page.waitForSelector(".verse:not(.loading)", { state: "attached" });
    await waitFor(page, async () => (await caches.keys()).includes("quran-dev-migration-v1") && !!navigator.serviceWorker.controller, 30000);
    await page.evaluate(async () => (await import("./js/bookmarks.js")).toggleBookmark({ ch: 36, v: 12 }));
    const snap = () =>
      page.evaluate(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open("quran");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const keys = async (store) => new Promise((res) => {
          const r = db.transaction(store).objectStore(store).getAllKeys();
          r.onsuccess = () => res(r.result.map(String).sort());
        });
        const out = { prefs: localStorage.getItem("quran.prefs"), chapters: await keys("chapters"), layers: await keys("layers"), caches: await caches.keys() };
        db.close();
        return out;
      });
    const before = await snap();
    t.check(before.chapters.includes("36"), `IndexedDB holds chapter 36 before the update: ${before.chapters}`);
    cacheName = "quran-dev-migration-v2";
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await waitFor(page, async () => (await caches.keys()).join() === "quran-dev-migration-v2", 30000);
    await page.waitForTimeout(1500); // the app reloads itself when an update lands while stopped
    await page.waitForSelector(".verse:not(.loading)", { state: "attached" });
    const after = await snap();
    t.check(JSON.stringify(after.caches) === '["quran-dev-migration-v2"]', `caches after the update: ${after.caches}`);
    t.check(after.prefs === before.prefs, `localStorage changed across the update:\n    ${before.prefs}\n    ${after.prefs}`);
    t.check(before.chapters.every((k) => after.chapters.includes(k)) && before.layers.every((k) => after.layers.includes(k)), `IndexedDB lost entries: ${before.chapters}/${before.layers} -> ${after.chapters}/${after.layers}`);
    t.check(JSON.parse(after.prefs).bookmarks.some((x) => x.ch === 36 && x.v === 12), "the bookmark added before the update survives");
    t.note(`update ${before.caches} -> ${after.caches}; IndexedDB ${after.chapters.length} chapter(s), ${after.layers.length} layer entr(ies) kept`);
    await ctx.close();
  } finally {
    server.close();
  }
} finally {
  await b.close();
}
t.finish();
