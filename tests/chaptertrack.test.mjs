// One track per chapter on the lock screen / car (Media Session): metadata changes only when
// the chapter does; the position runs over the whole chapter (its duration = the sum of the
// verses' file lengths); the handlers are play/pause/stop, previous/next track (chapter) and
// seek-to — no ±seek; previous restarts the chapter after 3 s; repeat keeps the chapter length.
import { launch, context, open, position, checker } from "./lib/browsers.mjs";
import { durations, total, before } from "./lib/durations.mjs";

const t = checker("chapter track (Media Session)");
const D = durations("rashid");
const SPY = () => {
  window.__h = {}; window.__meta = []; window.__last = null;
  const ms = navigator.mediaSession;
  const sah = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (a, fn) => { window.__h[a] = fn; return sah(a, fn); };
  const sps = ms.setPositionState?.bind(ms);
  ms.setPositionState = (s) => { window.__last = s; return sps?.(s); };
  let m = null;
  Object.defineProperty(ms, "metadata", { get: () => m, set: (v) => { m = v; window.__meta.push(`${v?.title}|${v?.album}`); }, configurable: true });
};
const b = await launch("chromium");
try {
  {
    const ctx = await context(b, { prefs: { reciter: "rashid" } });
    await ctx.addInitScript(SPY);
    const { page, errors } = await open(ctx, "#/1:6");
    await page.evaluate(() => { window.__meta.length = 0; window.quranPlayer.play(); });
    const samples = [];
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(250);
      samples.push(await page.evaluate(() => ({ ch: window.quranPlayer.position.ch, d: window.__last && Math.round(window.__last.duration * 1000), p: window.__last && Math.round(window.__last.position * 1000) })));
    }
    const c1 = samples.filter((s) => s.ch === 1 && s.d), c2 = samples.filter((s) => s.ch === 2 && s.d);
    const meta = await page.evaluate(() => window.__meta);
    t.check(c2.length > 0, "didn't reach chapter 2 in 22 s");
    t.check(meta.length === 1 && meta[0] === "Al-Baqarah|Holy Quran", `metadata sets during play: ${JSON.stringify(meta)}`);
    t.check(c1.every((s) => s.d === total(D, 1)) && c2.every((s) => s.d === total(D, 2)), `durations ${[...new Set(c1.concat(c2).map((s) => s.d))]} vs ${total(D, 1)}, ${total(D, 2)}`);
    t.check(c1.every((s, i) => i === 0 || s.p >= c1[i - 1].p - 50), "position went backwards within chapter 1");
    t.check(c1[0]?.p >= before(D, 1, 6) - 100 && c2[0]?.p < 2000, `positions ${c1[0]?.p} (1:6 starts at ${before(D, 1, 6)}), ${c2[0]?.p} after crossing`);
    const handlers = await page.evaluate(() => Object.keys(window.__h).filter((k) => window.__h[k]).sort().join(","));
    t.check(handlers === "nexttrack,pause,play,previoustrack,seekto,stop", `handlers: ${handlers}`);
    t.check(!errors.length, `console errors ${errors.join(" | ")}`);
    await ctx.close();
  }
  {
    const ctx = await context(b, { prefs: { reciter: "rashid" } });
    await ctx.addInitScript(SPY);
    const { page } = await open(ctx, "#/36:5");
    await page.evaluate(() => window.quranPlayer.play());
    await page.waitForTimeout(4000);
    const seekTo = (before(D, 36, 10) + D[36][9] / 2) / 1000;
    await page.evaluate((s) => window.__h.seekto({ action: "seekto", seekTime: s }), seekTo);
    await page.waitForTimeout(2000);
    const afterSeek = await position(page);
    await page.evaluate(() => window.__h.previoustrack()); await page.waitForTimeout(2000);
    const prev1 = await position(page);
    await page.evaluate(() => window.__h.previoustrack()); await page.waitForTimeout(2000);
    const prev2 = await position(page);
    await page.evaluate(() => window.__h.nexttrack()); await page.waitForTimeout(2000);
    const next = await position(page);
    t.check(afterSeek === "36:10", `seek-to the middle of 36:10 → ${afterSeek}`);
    t.check(prev1 === "36:1" && prev2 === "35:1" && next === "36:1", `previous ×2, next: ${prev1}, ${prev2}, ${next}`);
    await ctx.close();
  }
  {
    const ctx = await context(b, { prefs: { reciter: "rashid", repeat: true } });
    await ctx.addInitScript(SPY);
    const { page } = await open(ctx, "#/1:2");
    await page.evaluate(() => window.quranPlayer.play());
    const ps = [];
    for (let i = 0; i < 50; i++) { await page.waitForTimeout(300); ps.push(await page.evaluate(() => window.__last && [Math.round(window.__last.duration * 1000), Math.round(window.__last.position * 1000)])); }
    const ok = ps.filter(Boolean);
    t.check(ok.every(([d]) => d === total(D, 1)), "repeat changed the duration");
    t.check(ok.every(([, p]) => p >= before(D, 1, 2) - 10 && p <= before(D, 1, 3) + 10), "repeat left the verse's range");
    t.note(`repeat: position stayed in 1:2 (${before(D, 1, 2)}–${before(D, 1, 3)} ms) for 15 s`);
    await ctx.close();
  }
} finally {
  await b.close();
}
t.finish();
