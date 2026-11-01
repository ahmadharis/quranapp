// Car controls, three experiments (?car=… or Settings > Car controls), all with previous/next
// chapter, play/pause/stop and one track per chapter:
// - scrubber (Standard): seekable stream, seek-to and chapter position state.
// - classic (Previous/next + progress): live stream on Chromium (MSE duration Infinity, so
//   Chrome adds no ±10 s actions of its own), seek-to and position state kept.
// - nobar (Previous/next only): live stream, no seek-to, no position state.
// - progress (Previous/next + progress, fixed): seekable stream, position state, no seek-to.
// In every mode the in-app seekbar (keyboard, drag, far drag), ⏭ and chapter crossing work, and
// the car's previous/next track (and seek-to where offered) land correctly.
import { launch, context, open, position, waitFor, checker, OUT } from "./lib/browsers.mjs";
import { durations, total, before, locate } from "./lib/durations.mjs";
import { CHAPTERS } from "../js/quran-data.js";

const t = checker("car controls");
const D = durations("rashid");
const [CH36, CH37] = [CHAPTERS[35][1], CHAPTERS[36][1]];
const SPY = () => {
  window.__h = {};
  window.__meta = [];
  window.__ps = 0; // setPositionState calls with a state
  window.__psClear = 0; // ... and without (clears it)
  const ms = navigator.mediaSession;
  const sah = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (a, fn) => ((window.__h[a] = fn), sah(a, fn));
  const sps = ms.setPositionState?.bind(ms);
  ms.setPositionState = (...s) => (s.length && s[0] ? window.__ps++ : window.__psClear++, sps?.(...s));
  let m = null;
  Object.defineProperty(ms, "metadata", { get: () => m, set: (v) => ((m = v), window.__meta.push(`${v?.title}|${v?.artist}|${v?.album}`)), configurable: true });
};
const handlers = (page) => page.evaluate(() => Object.keys(window.__h).filter((k) => window.__h[k]).sort().join(","));
const state = (page) => page.evaluate(() => ({ ps: window.__ps, clear: window.__psClear, duration: window.quranPlayer.audio.duration, backend: window.quranPlayer.backend.constructor.name, search: location.search, stored: JSON.parse(localStorage.getItem("quran.prefs")).carControls }));

const b = await launch("chromium");
const BASE_H = "nexttrack,pause,play,previoustrack,stop";
const WANT = {
  scrubber: { handlers: "nexttrack,pause,play,previoustrack,seekto,stop", ps: true, live: false },
  classic: { handlers: "nexttrack,pause,play,previoustrack,seekto,stop", ps: true, live: true },
  nobar: { handlers: BASE_H, ps: false, live: true },
  progress: { handlers: BASE_H, ps: true, live: false }, // chapter progress, no seek-to
};
try {
  for (const [mode, want] of Object.entries(WANT)) {
    // Seeded with another mode, so the link has to switch it.
    const ctx = await context(b, { prefs: { reciter: "rashid", mode: "listen", carControls: mode === "scrubber" ? "nobar" : "scrubber" }, viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(SPY);
    const { page, errors } = await open(ctx, `?car=${mode}#/36:1`);
    await page.evaluate(() => {
      window.__meta.length = 0;
      window.__ps = 0;
      window.quranPlayer.play();
    });
    await page.waitForTimeout(4000);
    const s = await state(page);
    const h = await handlers(page);
    t.check(s.search === "" && s.stored === mode, `${mode}: address "${s.search}", saved ${s.stored}`);
    t.check(h === want.handlers, `${mode}: handlers ${h}`);
    t.check(want.ps ? s.ps > 0 : s.ps === 0 && s.clear >= 1, `${mode}: position state set ${s.ps} time(s), cleared ${s.clear}`);
    t.check(s.backend === "StreamBackend" && (want.live ? s.duration === Infinity : Number.isFinite(s.duration)), `${mode}: ${s.backend} duration ${s.duration}`);
    // In-app: keyboard +10 s, a drag to 50 %, a far drag to 92 % (a rebuild).
    const sel = "#player .prog";
    await page.focus(sel);
    const a0 = Number(await page.getAttribute(sel, "aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    const a1 = Number(await page.getAttribute(sel, "aria-valuenow"));
    t.check(a1 - a0 >= 9 && a1 - a0 <= 13, `${mode}: keyboard → moved ${a1 - a0} s`);
    for (const f of [0.5, 0.92]) {
      const box = await page.locator(sel).boundingBox();
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * 0.2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (f - 0.1), y, { steps: 4 });
      await page.mouse.move(box.x + box.width * f, y, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(3500);
      const [ch, v] = (await position(page)).split(":").map(Number);
      const w = locate(D, 36, total(D, 36) * f).v;
      t.check(ch === 36 && Math.abs(v - w) <= 1 && (await page.evaluate(() => window.quranPlayer.playing)), `${mode}: drag to ${f * 100}% → 36:${v}, expected 36:${w}, playing`);
    }
    // The car's scrubber, where offered: the middle of 36:10.
    if (want.handlers.includes("seekto")) {
      await page.evaluate((x) => window.__h.seekto({ action: "seekto", seekTime: x }), (before(D, 36, 10) + D[36][9] / 2) / 1000);
      await page.waitForTimeout(2500);
      t.check((await position(page)) === "36:10", `${mode}: car seek-to → ${await position(page)}`);
    }
    // In-app ⏭, then the car's previous/next track.
    await page.click("#player [data-next]");
    await page.waitForTimeout(2000);
    const inApp = await position(page);
    await page.evaluate(() => window.__h.previoustrack());
    await page.waitForTimeout(2000);
    const prev = await position(page);
    await page.evaluate(() => window.__h.nexttrack());
    await page.waitForTimeout(2000);
    t.check(inApp === "37:1" && prev === "36:1" && (await position(page)) === "37:1", `${mode}: ⏭ ${inApp}, previous track ${prev}, next track ${await position(page)}`);
    const s2 = await state(page);
    t.check(want.live ? s2.duration === Infinity : Number.isFinite(s2.duration), `${mode}: duration after rebuilds ${s2.duration}`);
    t.check(want.ps || s2.ps === 0, `${mode}: position state set after seeking`);
    const meta = await page.evaluate(() => window.__meta);
    // Per chapter only: 37, 36, 37 (a chapter's card arriving may re-send the same chapter).
    const tracks = meta.filter((m, i) => i === 0 || m.split("|")[0] !== meta[i - 1].split("|")[0]);
    t.check(tracks.join() === [CH37, CH36, CH37].map((c) => `${c}|Mishary Rashid AlAfasy|Holy Quran`).join() && meta.length <= 6, `${mode}: metadata ${JSON.stringify(meta)}`);
    t.check(!errors.length, `${mode}: console errors ${errors.join(" | ")}`);
    await page.screenshot({ path: `${OUT}/carcontrols-${mode}.png` });
    await ctx.close();
  }

  // Chapter crossing 1:7 → 2:1 with the live stream: one metadata change, to Al-Baqarah.
  for (const mode of ["classic", "nobar"]) {
    const ctx = await context(b, { prefs: { reciter: "rashid", carControls: mode } });
    await ctx.addInitScript(SPY);
    const { page, errors } = await open(ctx, "#/1:7");
    await page.evaluate(() => {
      window.__meta.length = 0;
      window.quranPlayer.play();
    });
    await waitFor(page, () => window.quranPlayer.position.ch === 2, 25000).catch(() => {});
    await page.waitForTimeout(1500);
    const meta = await page.evaluate(() => window.__meta);
    const r = await page.evaluate(() => ({ hash: location.hash, d: window.quranPlayer.audio.duration }));
    t.check(r.hash.startsWith("#/2:") && r.d === Infinity, `${mode} crossing: ${r.hash}, duration ${r.d}`);
    t.check(meta.length === 1 && meta[0] === "Al-Baqarah|Mishary Rashid AlAfasy|Holy Quran", `${mode} crossing metadata: ${JSON.stringify(meta)}`);
    t.check(!errors.length, `${mode} crossing: console errors ${errors.join(" | ")}`);
    await ctx.close();
  }

  // Settings > Car controls: the three choices, switching live.
  {
    const ctx = await context(b, { prefs: { reciter: "rashid" } });
    await ctx.addInitScript(SPY);
    const { page } = await open(ctx, "#/36:1");
    t.check((await state(page)).stored === "scrubber" || (await page.evaluate(async () => (await import("./js/prefs.js")).prefs.carControls)) === "scrubber", "default is not scrubber");
    await page.evaluate(() => window.quranPlayer.play());
    await page.waitForTimeout(3000);
    await page.click("#open-settings");
    const labels = await page.$$eval(".car-choices [role=radio] b", (els) => els.map((e) => e.textContent).join(" | "));
    t.check(labels === "Previous/next + progress (fixed) | Previous/next + progress | Previous/next only | Standard", `Settings labels: ${labels}`);
    await page.click('[data-car="nobar"]');
    await page.waitForTimeout(1500);
    const n = await state(page);
    t.check(n.stored === "nobar" && !(await handlers(page)).includes("seekto") && n.duration === Infinity && n.clear >= 1, `Settings → nobar: ${JSON.stringify(n)}`);
    await page.click('[data-car="scrubber"]');
    await page.evaluate(() => (window.__ps = 0));
    await page.waitForTimeout(2000);
    const sc = await state(page);
    t.check(sc.stored === "scrubber" && (await handlers(page)).includes("seekto") && Number.isFinite(sc.duration) && sc.ps > 0, `Settings → scrubber: ${JSON.stringify(sc)}`);
    await ctx.close();
  }
} finally {
  await b.close();
}
t.finish();
