// Playback starts and advances in Chromium, WebKit and Firefox — silently — with no console
// errors and no Content-Security-Policy violations (the real policy is enforced here).
import { launch, context, open, assertSilent, waitFor, checker } from "./lib/browsers.mjs";

const t = checker("playback (chromium, webkit, firefox)");
for (const kind of ["chromium", "webkit", "firefox"]) {
  const b = await launch(kind);
  try {
    for (const reciter of ["rashid", "feroz"]) {
      const ctx = await context(b, { prefs: { reciter }, csp: true });
      const { page, errors } = await open(ctx, "#/1:1");
      const csp = [];
      page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
      await page.click("#pill");
      await waitFor(page, () => window.quranPlayer.audio.currentTime > 0.3, 25000).catch(() => {});
      await assertSilent(page);
      const t1 = await page.evaluate(() => window.quranPlayer.audio.currentTime);
      await page.waitForTimeout(2000);
      const s = await page.evaluate(() => ({ t: window.quranPlayer.audio.currentTime, rs: window.quranPlayer.audio.readyState, backend: window.quranPlayer.backend.constructor.name }));
      await page.evaluate(() => window.quranPlayer.pause());
      t.check(s.rs >= 3 && s.t > t1 + 1, `${kind}/${reciter}: not advancing (t ${t1.toFixed(1)} → ${s.t.toFixed(1)}, readyState ${s.rs})`);
      t.check(!errors.length, `${kind}/${reciter}: console errors ${errors.join(" | ")}`);
      t.check(!csp.length, `${kind}/${reciter}: CSP violations ${csp.join(" | ")}`);
      t.note(`${kind}/${reciter}: ${s.backend}, ${s.t.toFixed(1)} s played`);
      await ctx.close();
    }
  } finally {
    await b.close();
  }
}
t.finish();
