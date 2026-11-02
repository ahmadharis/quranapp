// Paused, then frozen in the background (as Chrome on Android does after a few minutes): the
// place is saved, and once the page is back, the lock-screen details are sent again and Play
// carries on from the paused verse. Headless Chromium doesn't freeze a visible page, so the
// page's freeze/resume events are sent by the test around a CDP freeze of the page.
import { launch, context, open, position, checker } from "./lib/browsers.mjs";

const t = checker("freeze");
const b = await launch("chromium");
try {
  const ctx = await context(b, { prefs: { reciter: "rashid" } });
  await ctx.addInitScript(() => {
    window.__meta = 0;
    const ms = navigator.mediaSession;
    let m = null;
    Object.defineProperty(ms, "metadata", { get: () => m, set: (v) => ((m = v), window.__meta++), configurable: true });
  });
  const { page, errors } = await open(ctx, "#/36:1");
  const cdp = await ctx.newCDPSession(page);
  await page.evaluate(() => window.quranPlayer.play());
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.quranPlayer.pause());
  const paused = await position(page);
  const t0 = await page.evaluate(() => window.quranPlayer.audio.currentTime);
  const meta0 = await page.evaluate(() => window.__meta);

  await page.evaluate(() => {
    localStorage.removeItem("quran.prefs");
    document.dispatchEvent(new Event("freeze"));
  });
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await page.waitForTimeout(1500);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await page.evaluate(() => document.dispatchEvent(new Event("resume")));
  await page.waitForTimeout(500);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("quran.prefs")).last);
  t.check(`${saved.ch}:${saved.v}` === paused, `saved place ${saved.ch}:${saved.v}, paused at ${paused}`);
  t.check((await page.evaluate(() => window.__meta)) > meta0, "lock-screen details not sent again after the freeze");
  t.check((await page.evaluate(() => navigator.mediaSession.playbackState)) === "paused", "playback state not paused");

  await page.evaluate(() => window.quranPlayer.play());
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => ({ t: window.quranPlayer.audio.currentTime, playing: window.quranPlayer.playing }));
  t.check(r.playing && r.t > t0 + 1.5, `Play after the freeze: ${t0.toFixed(1)} → ${r.t.toFixed(1)} s, playing ${r.playing}`);
  t.check((await position(page)).startsWith("36:"), `position after Play ${await position(page)}`);
  t.check(!errors.length, `console errors ${errors.join(" | ")}`);
  await page.evaluate(() => window.quranPlayer.pause());
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
