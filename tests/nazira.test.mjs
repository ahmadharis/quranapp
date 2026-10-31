// Nazira mode: Arabic flows as one page; translations are hidden (not switched off) and come
// back when it's turned off; the setting persists.
import { launch, context, open, checker } from "./lib/browsers.mjs";

const t = checker("Nazira mode");
const visibleTr = (p) => p.evaluate(() => [...document.querySelectorAll(".v-tr .tr")].filter((e) => e.offsetParent && e.textContent.trim()).length);
const b = await launch("chromium");
try {
  const ctx = await context(b, { prefs: { translations: { on: true, list: ["en", "ur"] } } });
  const { page, errors } = await open(ctx, "#/1:1");
  await page.waitForTimeout(2000);
  const before = await visibleTr(page);
  await page.click("#open-settings"); await page.click('[aria-label="Nazira mode"]'); await page.keyboard.press("Escape"); await page.waitForTimeout(800);
  const on = { attr: await page.evaluate(() => document.documentElement.hasAttribute("data-nazira")), tr: await visibleTr(page), display: await page.evaluate(() => getComputedStyle(document.querySelector('.verse[data-v="3"]')).display) };
  await page.reload(); await page.waitForSelector(".verse:not(.loading)"); await page.waitForTimeout(1500);
  const persisted = await page.evaluate(() => document.documentElement.hasAttribute("data-nazira"));
  await page.click("#open-settings"); await page.click('[aria-label="Nazira mode"]'); await page.keyboard.press("Escape"); await page.waitForTimeout(2500);
  const after = await visibleTr(page);
  t.check(before > 0 && on.attr && on.tr === 0 && on.display === "inline", `on: ${JSON.stringify(on)} (before ${before})`);
  t.check(persisted, "not persisted after reload");
  t.check(after === before, `translations after turning it off: ${after}, before ${before}`);
  t.check(!errors.length, `console errors ${errors.join(" | ")}`);
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
