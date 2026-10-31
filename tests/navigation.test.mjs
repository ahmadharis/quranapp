// The navigator (sheet on phone, Contents sidebar on laptop), in Read and Listen: search 2:255,
// Parts → 30 (its start from js/quran-data.js), Al-Kahf → verse 10, chapter 36 → verse 1.
import { launch, context, open, checker } from "./lib/browsers.mjs";
import { PART_STARTS } from "../js/quran-data.js";

const t = checker("navigation");
const part30 = `#/${PART_STARTS[29][0]}:${PART_STARTS[29][1]}`;
const b = await launch("chromium");
try {
  for (const mode of ["read", "listen"]) {
    for (const [size, viewport] of [["phone", { width: 402, height: 874 }], ["laptop", { width: 1920, height: 1080 }]]) {
      const flows = {
        "search 2:255": [async (p, s) => { await p.fill(`${s} .search-input`, "2:255"); await p.keyboard.press("Enter"); }, "#/2:255"],
        "part 30": [async (p, s) => { await p.click(`${s} [role=tab][data-tab="parts"]`); await p.click(`${s} [data-part="30"] .ch2`); }, part30],
        "Al-Kahf → 10": [async (p, s) => { await p.click(`${s} [data-ch="18"] .ch2`); await p.click(`${s} .vn[data-v="10"]`); }, "#/18:10"],
        "chapter 36 → 1": [async (p, s) => { await p.click(`${s} [data-ch="36"] .ch2`); await p.click(`${s} .vn[data-v="1"]`); }, "#/36:1"],
      };
      for (const [name, [act, want]] of Object.entries(flows)) {
        const ctx = await context(b, { prefs: { mode, layout: { wide: { contents: true, panel: true } } }, viewport });
        const { page, errors } = await open(ctx, "#/1:1");
        await page.click("#where");
        await page.waitForTimeout(250);
        const scope = (await page.evaluate(() => document.documentElement.hasAttribute("data-contents"))) ? "#contents" : "#nav-sheet";
        await act(page, scope);
        await page.waitForTimeout(700);
        const hash = await page.evaluate(() => location.hash);
        t.check(hash === want, `${mode}/${size}/${name}: ${hash}, expected ${want}`);
        t.check(!errors.length, `${mode}/${size}/${name}: console errors ${errors.join(" | ")}`);
        await ctx.close();
      }
    }
  }
  t.note(`part 30 starts at ${part30.slice(2)} (alislam)`);
} finally {
  await b.close();
}
t.finish();
