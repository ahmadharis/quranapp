// Move to another device.
// 1. js/qr.js: Reed–Solomon against the ISO/IEC 18004 worked example ("01234567", 1-M), the
//    format and version information against the standard's tables, codeword and module counts,
//    capacity limits, function patterns and format/version bits read back from the matrix,
//    deterministic output, and (where Chromium has BarcodeDetector) a real decode of codes of
//    several versions with every mask.
// 2. Round trip: export -> link -> a fresh browser imports it with Replace (every value equal)
//    and with Merge (bookmarks joined, incoming settings, newer last position); Cancel changes
//    nothing; the paste box rejects junk; the backup file round trip; a payload too large for a
//    QR code falls back to link and file; no network request carries the payload, and export
//    makes none at all.
// 3. Encode/decode in WebKit and Firefox too (nothing is played).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launch, context, open, waitFor, checker, BASE, OUT } from "./lib/browsers.mjs";
import { encodeQR, rsEcc, formatBits, versionBits, dataCodewords, totalCodewords, alignmentPositions, MAX_BYTES } from "../js/qr.js";

const t = checker("transfer");

// ---------- 1. the QR encoder ----------
const hex = (a) => a.map((x) => x.toString(16).padStart(2, "0")).join("");
// ISO/IEC 18004 Annex I: "01234567", version 1-M: data codewords and their 10 EC codewords.
const isoData = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
t.check(hex(rsEcc(isoData, 10)) === "a524d4c1ed36c787 2c55".replace(" ", ""), `RS: ${hex(rsEcc(isoData, 10))}`);
// Format information, level M, masks 0–7 (the standard's table).
const FORMAT_M = ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"];
for (let m = 0; m < 8; m++) t.check(formatBits(m).toString(2).padStart(15, "0") === FORMAT_M[m], `format bits, mask ${m}: ${formatBits(m).toString(2)}`);
for (const [v, want] of [[7, 0x07c94], [8, 0x085bc], [21, 0x15683], [40, 0x28c69]]) t.check(versionBits(v) === want, `version ${v} bits: ${versionBits(v).toString(16)}`);
// Codewords (total, data at M) and alignment centers from the standard's tables.
for (const [v, total, data] of [[1, 26, 16], [2, 44, 28], [5, 134, 86], [10, 346, 216], [20, 1085, 669], [40, 3706, 2334]]) t.check(totalCodewords(v) === total && dataCodewords(v) === data, `version ${v}: ${totalCodewords(v)}/${dataCodewords(v)} codewords, expected ${total}/${data}`);
for (const [v, want] of [[2, "6,18"], [7, "6,22,38"], [32, "6,34,60,86,112,138"], [40, "6,30,58,86,114,142,170"]]) t.check(alignmentPositions(v).join() === want, `version ${v} alignment ${alignmentPositions(v)}`);
// Capacity (byte mode, M): 14 bytes fit version 1, 15 need version 2; 2331 fit version 40.
t.check(encodeQR("a".repeat(14)).version === 1 && encodeQR("a".repeat(15)).version === 2, "version 1 capacity");
t.check(MAX_BYTES === 2331 && encodeQR("a".repeat(2331))?.version === 40 && encodeQR("a".repeat(2332)) === null, "version 40 capacity / too long -> null");
// Read back from the matrix: size, finders, timing, dark module, both format copies, version info.
for (const text of ["Quran 2:255", "https://example.test/#import=" + "x".repeat(200), "y".repeat(1200)]) {
  const q = encodeQR(text);
  const s = q.size;
  const d = (x, y) => (q.dark(x, y) ? 1 : 0);
  let ok = s === q.version * 4 + 17;
  for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) for (let i = -3; i <= 3; i++) ok &&= d(cx + i, cy - 3) === 1 && d(cx - 3, cy + i) === 1 && d(cx, cy) === 1;
  for (let i = 8; i < s - 8; i++) ok &&= d(i, 6) === (i % 2 === 0 ? 1 : 0) && d(6, i) === (i % 2 === 0 ? 1 : 0);
  ok &&= d(8, s - 8) === 1;
  let f1 = 0, f2 = 0;
  const c1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  c1.forEach(([x, y], i) => (f1 |= d(x, y) << i));
  for (let i = 0; i < 8; i++) f2 |= d(s - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= d(8, s - 15 + i) << i;
  t.check(ok, `"${text.slice(0, 12)}…": function patterns wrong`);
  t.check(f1 === formatBits(q.mask) && f2 === formatBits(q.mask), `"${text.slice(0, 12)}…": format bits read back ${f1.toString(2)} / ${f2.toString(2)}`);
  if (q.version >= 7) {
    let vb = 0;
    for (let i = 0; i < 18; i++) vb |= d(s - 11 + (i % 3), Math.floor(i / 3)) << i;
    t.check(vb === versionBits(q.version), `version ${q.version} info read back ${vb.toString(16)}`);
  }
}
// Deterministic: the same text always gives the same symbol (hashes recorded from this encoder,
// whose output decodes below).
const sha = (q) => createHash("sha256").update(q.m).digest("hex").slice(0, 16);
for (const [text, v, m, hash] of [["https://example.test/#import=zAbc", 3, 7, "020eb9177f0b1e28"], ["Quran 2:255", 1, 5, "0da5d3df11895bcb"], ["a".repeat(500), 17, 1, "7b6d9a8de5559ff2"]]) {
  const q = encodeQR(text);
  t.check(q.version === v && q.mask === m && sha(q) === hash && sha(encodeQR(text)) === hash, `deterministic "${text.slice(0, 12)}…": v${q.version} m${q.mask} ${sha(q)}`);
}

// ---------- 2. in the app ----------
const DAY = 864e5;
const A_PREFS = {
  schema: 3, reciter: "aiman", mode: "listen", theme: "dark", scale: 1.2, navTab: "parts",
  last: { ch: 18, v: 10 }, lastAt: Date.now() - DAY, chLast: { 2: 255, 18: 10 },
  translations: { on: true, list: ["zk", "fr"] }, wordMeanings: "words-en",
  layout: { desk: { contents: false, contentsListen: true, panel: false, focus: true } },
  barCollapsed: true, repeat: true, hintSeen: true, focusHintSeen: true,
  install: { dismissed: 1, until: 0, done: false }, nazira: true, speed: 1.25, followWords: false,
  bookmarks: [{ ch: 36, v: 5, at: Date.now() - 2 * DAY }, { ch: 2, v: 255, at: Date.now() - 5 * DAY }],
  resume: { ch: 18, v: 10, reciter: "aiman" },
};
const B_PREFS = {
  schema: 3, hintSeen: true, theme: "light", reciter: "rashid", last: { ch: 1, v: 3 }, lastAt: Date.now() - 3 * DAY, chLast: { 1: 3, 112: 2 },
  install: { dismissed: 2, until: 123, done: true },
  bookmarks: [{ ch: 1, v: 1, at: Date.now() - 4 * DAY }, { ch: 2, v: 255, at: Date.now() - DAY }],
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("quran.prefs")));
const without = (p, ...keys) => Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function exportLink(b, prefs) {
  const ctx = await context(b, { prefs });
  const { page, errors } = await open(ctx, "");
  const reqs = [];
  page.on("request", (r) => reqs.push(r.url()));
  await page.click("#open-settings");
  await page.click(".transfer-row");
  await waitFor(page, () => document.querySelector(".tr-link")?.value.includes("#import="));
  const link = await page.inputValue(".tr-link");
  const qr = await page.getAttribute("#transfer-sheet", "data-qr");
  const hash = await page.evaluate(() => location.hash);
  const a = await stored(page);
  return { ctx, page, errors, link, qr, hash, a, reqs };
}
// Opens the link in a fresh browser with `prefs`, answers the confirmation, returns its prefs.
async function importLink(b, link, prefs, choice) {
  const ctx = await context(b, { prefs });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const leaks = [];
  const code = link.split("#import=")[1];
  page.on("request", (r) => (r.url().includes(code.slice(0, 24)) || (r.postData() ?? "").includes(code.slice(0, 24))) && leaks.push(r.url()));
  await page.goto(link);
  await page.waitForSelector("#import-sheet[open]");
  const summary = await page.textContent(".imp-summary");
  const hashDuring = await page.evaluate(() => location.hash);
  await page.click(`[data-import="${choice}"]`);
  if (choice !== "cancel") await page.waitForSelector(".toast:text('Imported')");
  else await page.waitForTimeout(400);
  const after = { prefs: await stored(page), hash: await page.evaluate(() => location.hash), summary, hashDuring, leaks, errors };
  await ctx.close();
  return after;
}

const b = await launch("chromium");
try {
  // Export.
  const ex = await exportLink(b, A_PREFS);
  t.check(ex.hash === "#/transfer", `transfer view at ${ex.hash}`);
  t.check(/^v\d+$/.test(ex.qr), `QR shown: ${ex.qr}`);
  t.check(ex.reqs.length === 0, `export made network requests: ${ex.reqs.join(", ")}`);
  t.check(ex.link.startsWith(`${BASE}/#import=z`), `link ${ex.link.slice(0, 60)}`);
  await ex.page.screenshot({ path: `${OUT}/transfer-view.png` });
  // The QR on the page decodes to the link (where BarcodeDetector exists).
  const scanned = await ex.page.evaluate(async () => {
    if (!("BarcodeDetector" in window)) return null;
    const svg = document.querySelector(".qr-tile svg");
    const img = new Image();
    img.src = "data:image/svg+xml," + encodeURIComponent(svg.outerHTML);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 900;
    c.getContext("2d").drawImage(img, 0, 0, 900, 900);
    return (await new BarcodeDetector({ formats: ["qr_code"] }).detect(c))[0]?.rawValue ?? "";
  });
  if (scanned === null) t.note("BarcodeDetector not available: QR decode skipped");
  else t.check(scanned === ex.link, `the QR on the page decodes to ${scanned.slice(0, 50)}…`);
  // Codes of several versions, every mask, decode to their text.
  const decodes = await ex.page.evaluate(async () => {
    if (!("BarcodeDetector" in window)) return null;
    const { encodeQR, qrSvg } = await import("./js/qr.js");
    const det = new BarcodeDetector({ formats: ["qr_code"] });
    const bad = [];
    let n = 0;
    for (const len of [5, 60, 300, 1000, 2300]) {
      for (let mask = 0; mask < 8; mask++) {
        if (len > 300 && mask % 3) continue; // large ones: a few masks are enough
        const text = `https://example.test/#import=z${"Qr-_9a".repeat(400)}`.slice(0, len);
        const q = encodeQR(text, { mask });
        const img = new Image();
        img.src = "data:image/svg+xml," + encodeURIComponent(qrSvg(q));
        await img.decode();
        const c = document.createElement("canvas");
        c.width = c.height = (q.size + 8) * 6;
        const g = c.getContext("2d");
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, c.width, c.height);
        const got = (await det.detect(c))[0]?.rawValue;
        n++;
        if (got !== text) bad.push(`v${q.version}/m${mask}`);
      }
    }
    return { n, bad };
  });
  if (decodes) t.check(!decodes.bad.length, `QR decode failures: ${decodes.bad}`);
  if (decodes) t.note(`${decodes.n} QR codes (versions 1–40 range, all masks) decoded by the browser`);

  // Replace: every value equal to the sender's, except this device's install state.
  const rep = await importLink(b, ex.link, B_PREFS, "replace");
  t.check(rep.hashDuring !== "" && !rep.hashDuring.includes("import"), `#import left in the address: ${rep.hashDuring}`);
  t.check(/2 bookmarks · your settings · last position Al-Kahf 18:10 · from version \d+\.\d+\.\d+, created /.test(rep.summary), `summary: ${rep.summary}`);
  t.check(same(without(rep.prefs, "install"), without(ex.a, "install")), `replace: prefs differ\n    sent ${JSON.stringify(without(ex.a, "install"))}\n    got  ${JSON.stringify(without(rep.prefs, "install"))}`);
  t.check(same(rep.prefs.install, { dismissed: 2, until: 123, done: true }), `replace: this device's install state ${JSON.stringify(rep.prefs.install)}`);
  t.check(rep.hash === "#/18:10", `replace: opens at ${rep.hash}`);
  t.check(!rep.leaks.length && !rep.errors.length, `replace: payload in requests ${rep.leaks} / errors ${rep.errors}`);

  // Merge: bookmarks joined (2:255 keeps the later copy), settings from the sender, the newer
  // last position (the sender's, a day old, beats B's three days).
  const mer = await importLink(b, ex.link, B_PREFS, "merge");
  const marks = mer.prefs.bookmarks.map((x) => `${x.ch}:${x.v}`).join();
  t.check(marks === "2:255,36:5,1:1", `merge: bookmarks ${marks}`);
  t.check(mer.prefs.bookmarks[0].at === B_PREFS.bookmarks[1].at, "merge: the later copy of 2:255 kept");
  t.check(mer.prefs.theme === "dark" && mer.prefs.reciter === "aiman" && mer.prefs.speed === 1.25 && mer.prefs.nazira === true && same(mer.prefs.translations.list, ["zk", "fr"]), "merge: incoming settings win");
  t.check(same(mer.prefs.last, { ch: 18, v: 10 }) && same(mer.prefs.chLast, { 1: 3, 2: 255, 18: 10, 112: 2 }), `merge: last ${JSON.stringify(mer.prefs.last)}, chLast ${JSON.stringify(mer.prefs.chLast)}`);
  // ... and a receiver whose last position is newer keeps its own.
  const mer2 = await importLink(b, ex.link, { ...B_PREFS, lastAt: Date.now() }, "merge");
  t.check(same(mer2.prefs.last, { ch: 1, v: 3 }) && mer2.hash === "#/1:3", `merge, receiver newer: last ${JSON.stringify(mer2.prefs.last)} at ${mer2.hash}`);
  // Cancel: nothing changes.
  const can = await importLink(b, ex.link, B_PREFS, "cancel");
  t.check(can.prefs.theme === "light" && can.prefs.bookmarks.length === 2 && !can.hash.includes("import"), `cancel changed something: ${JSON.stringify(can.prefs).slice(0, 80)} ${can.hash}`);

  // The backup file: download, then open it in a fresh browser.
  const [dl] = await Promise.all([ex.page.waitForEvent("download"), ex.page.click(".tr-send .tr-btn:has-text('Download backup file')")]);
  const d = new Date();
  const fname = `quran-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  t.check(dl.suggestedFilename() === fname, `file name ${dl.suggestedFilename()}`);
  const filePath = `${OUT}/${fname}`;
  await dl.saveAs(filePath);
  const file = JSON.parse(await readFile(filePath, "utf8"));
  t.check(file.app === "quran" && file.format === 1 && /^\d+\.\d+\.\d+$/.test(file.version) && file.created > 0 && file.prefs.schema >= 3, `file payload ${JSON.stringify(without(file, "prefs"))}`);
  {
    const ctx = await context(b, { prefs: B_PREFS });
    const { page } = await open(ctx, "#/transfer");
    const reqs = [];
    page.on("request", (r) => reqs.push(r.url()));
    // Junk in the paste box is refused.
    await page.fill(".tr-paste", "hello there");
    await page.click(".tr-recv .tr-btn:has-text('Import')");
    t.check((await page.textContent(".tr-recv .tr-error")).includes("isn't a transfer"), "paste box: junk not refused");
    await page.setInputFiles(".tr-recv input[type=file]", filePath);
    await page.waitForSelector("#import-sheet[open]");
    t.check(reqs.length === 0, `file import made requests before applying: ${reqs}`);
    await page.click('[data-import="replace"]');
    await page.waitForSelector(".toast:text('Imported')");
    const got = await stored(page);
    t.check(same(without(got, "install"), without(ex.a, "install")), "file: prefs differ after Replace");
    await ctx.close();
  }
  // The raw code pasted (no link) works as well.
  {
    const ctx = await context(b, { prefs: B_PREFS });
    const { page } = await open(ctx, "#/transfer");
    await page.fill(".tr-paste", ex.link.split("#import=")[1]);
    await page.click(".tr-recv .tr-btn:has-text('Import')");
    await page.waitForSelector("#import-sheet[open]");
    t.check((await page.textContent(".imp-summary")).startsWith("2 bookmarks"), "pasted code: no confirmation");
    // Esc on the view (after closing the confirmation) returns to Settings.
    await page.click('[data-import="cancel"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({ s: document.querySelector("#settings-sheet").open, tv: document.querySelector("#transfer-sheet").open, h: location.hash }));
    t.check(st.s && !st.tv && st.h !== "#/transfer", `Esc from the view: ${JSON.stringify(st)}`);
    await ctx.close();
  }
  await ex.ctx.close();

  // Too large for a QR code: the view says so; the link still carries everything.
  const many = [];
  for (let ch = 2; ch <= 9; ch++) for (let v = 1; v <= Math.min(200, [0, 7, 286, 200, 176, 120, 165, 206, 75, 129][ch]); v++) many.push({ ch, v, at: 1700000000000 + Math.floor(Math.random() * 1e11) });
  const big = await exportLink(b, { ...A_PREFS, bookmarks: many });
  t.check(big.qr === "none" && (await big.page.isVisible(".tr-note")) && (await big.page.textContent(".tr-note")).includes("Too much"), `oversized: QR ${big.qr}`);
  t.check(big.errors.length === 0, `oversized: errors ${big.errors}`);
  await big.page.screenshot({ path: `${OUT}/transfer-oversized.png` });
  const bigRep = await importLink(b, big.link, B_PREFS, "replace");
  t.check(bigRep.prefs.bookmarks.length === many.length, `oversized link: ${bigRep.prefs.bookmarks.length} of ${many.length} bookmarks`);
  t.note(`normal link ${ex.link.length} chars (QR ${ex.qr}); oversized ${big.link.length} chars, ${many.length} bookmarks`);
  await big.ctx.close();
} finally {
  await b.close();
}

// ---------- 3. WebKit and Firefox: the code round trip ----------
for (const kind of ["webkit", "firefox"]) {
  const b2 = await launch(kind);
  try {
    const ctx = await context(b2, { prefs: A_PREFS });
    const { page } = await open(ctx, "");
    const r = await page.evaluate(async () => {
      const m = await import("./js/transfer.js");
      const p = m.buildPayload();
      const back = await m.decodeCode(m.linkFor(await m.encodeCode(p)));
      return JSON.stringify(back) === JSON.stringify(p) && JSON.stringify(m.readPayload(back).incoming) === JSON.stringify(p.prefs);
    });
    t.check(r, `${kind}: encode/decode round trip`);
    await ctx.close();
  } finally {
    await b2.close();
  }
}
t.finish();
