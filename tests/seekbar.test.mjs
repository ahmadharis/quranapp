// The seekbars: a touch drag (Android emulation, real touch events) shows the time live and
// seeks on release to the verse at that point of the chapter; ⏮ ⏭ change chapters; the
// keyboard moves ±10 s; the page doesn't scroll during the drag.
import { devices } from "playwright";
import { launch, context, open, position, checker, OUT } from "./lib/browsers.mjs";
import { durations, total, locate } from "./lib/durations.mjs";

const t = checker("seekbar and chapter buttons");
const D = durations("rashid");
const b = await launch("chromium");
try {
  const sel = "#player .prog";
  // Read on a phone in landscape has the compact player (the portrait mini bar's line is not a
  // seekbar); Listen in portrait has the expanded one.
  for (const [name, device, mode, hash, ch] of [["Read, compact", "Pixel 7 landscape", "read", "#/36:1", 36], ["Listen, expanded", "Pixel 7", "listen", "#/2:1", 2]]) {
    const ctx = await context(b, { prefs: { reciter: "rashid", mode }, ...devices[device] });
    const { page, errors } = await open(ctx, hash);
    await page.evaluate(() => window.quranPlayer.play());
    await page.waitForTimeout(3000);
    const box = await page.locator(sel).boundingBox();
    const y = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(page);
    const scroll0 = await page.evaluate(() => scrollY);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width * 0.1, y }] });
    const labels = [];
    for (const f of [0.3, 0.5]) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width * f, y }] });
      await page.waitForTimeout(150);
      labels.push(await page.evaluate(() => document.querySelector("#player [data-pel]").textContent));
    }
    const during = await position(page);
    await page.screenshot({ path: `${OUT}/seekbar-${mode}-dragging.png` });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(3000);
    const after = await position(page);
    const want = locate(D, ch, total(D, ch) * 0.5).v;
    const [a, bb] = after.split(":").map(Number);
    t.check(a === ch && Math.abs(bb - want) <= 1, `${name}: drag to 50% → ${after}, expected ${ch}:${want}`);
    t.check(labels[0] !== labels[1] && !during.endsWith(`:${want}`), `${name}: label didn't update live, or it seeked before release (${labels.join(" → ")}, ${during})`);
    t.check(Math.abs((await page.evaluate(() => scrollY)) - scroll0) < 200, `${name}: page scrolled during the drag`);
    await page.locator("#player [data-next]").tap();
    await page.waitForTimeout(2000);
    t.check((await position(page)) === `${ch + 1}:1`, `${name}: ⏭ → ${await position(page)}`);
    t.check(!errors.length, `${name}: console errors ${errors.join(" | ")}`);
    t.note(`${name}: ${labels.join(" → ")}, landed on ${after}`);
    await ctx.close();
  }
  // Keyboard: → = +10 s.
  const ctx = await context(b, { prefs: { reciter: "rashid", mode: "listen" } });
  const { page } = await open(ctx, "#/36:1");
  await page.evaluate(() => window.quranPlayer.play());
  await page.waitForTimeout(3000);
  await page.focus(sel);
  const a0 = Number(await page.getAttribute(sel, "aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1500);
  const a1 = Number(await page.getAttribute(sel, "aria-valuenow"));
  t.check(a1 - a0 >= 9 && a1 - a0 <= 13, `keyboard → moved ${a1 - a0} s`);
  t.note(`keyboard: ${a0} → ${a1} s (${await page.getAttribute(sel, "aria-valuetext")})`);
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
