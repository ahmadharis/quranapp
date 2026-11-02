// Lock screen and car controls (Media Session): previous/next chapter, play/pause/stop, the
// chapter's progress and seek-to, one track per chapter. The in-app seekbar (keyboard, drag,
// far drag), ⏭ and the car's previous/next track and seek-to land correctly. Old ?car=… links
// only lose the parameter, and Settings has no car controls any more.
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
const WANT = { standard: { handlers: "nexttrack,pause,play,previoustrack,seekto,stop", ps: true, live: false } };
try {
  for (const [mode, want] of Object.entries(WANT)) {
    // Seeded with an experiment of 1.2.1–1.3.x and opened from an old link: both are gone.
    const ctx = await context(b, { prefs: { reciter: "rashid", mode: "listen", schema: 4, carControls: "nobar" }, viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(SPY);
    const { page, errors } = await open(ctx, `?car=nobar#/36:1`);
    await page.evaluate(() => {
      window.__meta.length = 0;
      window.__ps = 0;
      window.quranPlayer.play();
    });
    await page.waitForTimeout(4000);
    const s = await state(page);
    const h = await handlers(page);
    t.check(s.search === "" && s.stored === undefined, `${mode}: address "${s.search}", saved ${s.stored}`);
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

  // Settings: no car controls.
  {
    const ctx = await context(b, { prefs: { reciter: "rashid" } });
    const { page } = await open(ctx, "#/36:1");
    await page.click("#open-settings");
    await page.waitForTimeout(400);
    t.check(!(await page.$(".car-choices, #car-cap")), "Settings still shows car controls");
    await ctx.close();
  }
} finally {
  await b.close();
}
t.finish();
