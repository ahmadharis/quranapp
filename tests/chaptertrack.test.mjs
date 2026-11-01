// One track per chapter on the lock screen / car (Media Session): metadata changes only when
// the chapter does; the position runs over the whole chapter (its duration = the sum of the
// verses' file lengths); the handlers are play/pause/stop, previous/next track (chapter) and
// seek-to — no ±seek; previous restarts the chapter after 3 s; Repeat loops the chapter.
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
  // Repeat chapter: the chapter's last verse is followed by its verse 1, never the next chapter;
  // the metadata stays (same track) and the position starts again from 0. Mid-Quran (1:7 →
  // 1:1, where the stream has 2:1 queued) and at the very end (114:7 → 114:1; alislam counts the
  // Bismillah as verse 1).
  for (const [from, ch, last] of [["1:6", 1, 7], ["114:5", 114, 7]]) {
    const ctx = await context(b, { prefs: { reciter: "rashid", repeat: true } });
    await ctx.addInitScript(SPY);
    const { page, errors } = await open(ctx, `#/${from}`);
    t.check((await page.getAttribute("#qp-repeat", "aria-label")) === "Repeat chapter" && (await page.getAttribute("#qp-repeat", "aria-pressed")) === "true", "repeat toggle label/state");
    await page.evaluate(() => {
      window.__seen = [];
      window.__meta.length = 0;
      window.quranPlayer.addEventListener("verse", (e) => window.__seen.push(`${e.detail.ch}:${e.detail.v}`));
      window.quranPlayer.play();
    });
    const ps = [];
    for (let i = 0; i < 200; i++) {
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ seen: window.__seen.join(), d: window.__last && Math.round(window.__last.duration * 1000), p: window.__last && Math.round(window.__last.position * 1000), ch: window.quranPlayer.position.ch }));
      ps.push(r);
      if (r.seen.includes(`${ch}:${last},${ch}:1,${ch}:2`)) break;
    }
    const end = ps.at(-1);
    t.check(end.seen.includes(`${ch}:${last},${ch}:1`), `repeat ${from}: verses ${end.seen}`);
    t.check(ps.every((r) => r.ch === ch) && !end.seen.split(",").some((k) => !k.startsWith(`${ch}:`)), `repeat ${from}: left chapter ${ch} (${end.seen})`);
    const meta = await page.evaluate(() => window.__meta);
    t.check(meta.every((m) => m.startsWith(`${ch === 1 ? "Al-Fatihah" : "An-Nas"}|`)), `repeat ${from}: metadata changed ${JSON.stringify(meta)}`);
    t.check(ps.filter((r) => r.d).every((r) => r.d === total(D, ch)), `repeat ${from}: duration changed`);
    const loop = ps.findIndex((r) => r.seen.includes(`${ch}:${last},${ch}:1`));
    t.check(loop >= 0 && ps.slice(loop).some((r) => r.p !== null && r.p < 3000), `repeat ${from}: position didn't restart near 0`);
    t.check(!errors.length, `repeat ${from}: console errors ${errors.join(" | ")}`);
    t.note(`repeat chapter ${from}: ${end.seen}`);
    await page.evaluate(() => window.quranPlayer.pause());
    await ctx.close();
  }
} finally {
  await b.close();
}
t.finish();
