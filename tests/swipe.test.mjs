// Swiping sideways on a touch screen changes chapter, in Read and Listen: right → next,
// left → previous (right-to-left, as a mushaf). Vertical scrolls, slow drags, swipes on the
// player and swipes past chapter 114 change nothing.
import { launch, context, open, checker } from "./lib/browsers.mjs";

const t = checker("swipe");
const b = await launch("chromium");

// A real touch gesture through the browser's input pipeline.
async function swipe(page, cdp, { x0, y0, x1, y1, ms = 200 }) {
  const steps = 8;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms / steps);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(700);
  return page.evaluate(() => location.hash);
}

try {
  for (const mode of ["read", "listen"]) {
    const ctx = await context(b, { prefs: { mode }, hasTouch: true, isMobile: true });
    const { page, errors } = await open(ctx, "#/2:1");
    const cdp = await ctx.newCDPSession(page);
    const y = 400;
    t.check((await swipe(page, cdp, { x0: 100, y0: y, x1: 300, y1: y + 20 })) === "#/3:1", `${mode}: swipe right → chapter 3`);
    t.check((await swipe(page, cdp, { x0: 300, y0: y, x1: 100, y1: y })) === "#/2:1", `${mode}: swipe left → chapter 2`);
    t.check((await swipe(page, cdp, { x0: 200, y0: 600, x1: 260, y1: 300 })) === "#/2:1", `${mode}: vertical scroll keeps chapter 2`);
    t.check((await swipe(page, cdp, { x0: 100, y0: y, x1: 300, y1: y, ms: 1200 })) === "#/2:1", `${mode}: slow drag keeps chapter 2`);
    const qp = await page.locator("#player").boundingBox();
    t.check((await swipe(page, cdp, { x0: 100, y0: qp.y + 10, x1: 300, y1: qp.y + 10 })) === "#/2:1", `${mode}: swipe on the player keeps chapter 2`);
    await page.evaluate(() => (location.hash = "#/114:1"));
    await page.waitForTimeout(1500);
    t.check((await swipe(page, cdp, { x0: 100, y0: y, x1: 300, y1: y })) === "#/114:1", `${mode}: no chapter after 114`);
    t.check(!errors.length, `${mode}: console errors ${errors.join(" | ")}`);
    await ctx.close();
  }
} finally {
  await b.close();
}
t.finish();
