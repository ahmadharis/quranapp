// Word meanings: each verse becomes a grid of cells, one per WORD (util.js isWord), with the
// gloss under it (English and Urdu); following the recitation lights cells in turn.
import { launch, context, open, checker, OUT } from "./lib/browsers.mjs";

const t = checker("word grid");
const grid = (p, vs) => p.evaluate((vs) => vs.map((v) => {
  const a = document.querySelector(`.verse[data-v="${v}"]`);
  return { v, cells: a.querySelectorAll(".wgrid .cell.w").length, glossed: [...a.querySelectorAll(".wgrid .cell.w .g")].filter((g) => g.textContent.trim()).length, words: a.querySelectorAll(".v-ar .w").length };
}), vs);
const b = await launch("chromium");
try {
  for (const [wm, hash, vs] of [["words-en", "#/1:1", [1, 2, 3, 4, 5, 6, 7]], ["words-ur", "#/1:1", [1, 2, 3, 4, 5, 6, 7]], ["words-en", "#/2:255", [255]], ["words-ur", "#/2:255", [255]]]) {
    const ctx = await context(b, { prefs: { wordMeanings: wm } });
    const { page, errors } = await open(ctx, hash);
    await page.waitForTimeout(2000);
    for (const r of await grid(page, vs)) {
      t.check(r.cells === r.words && r.cells > 0, `${wm} ${hash.slice(2, 3)}:${r.v}: ${r.cells} cells for ${r.words} words`);
      t.check(r.glossed === r.cells, `${wm} verse ${r.v}: ${r.glossed}/${r.cells} cells have a gloss`);
    }
    t.check(!errors.length, `${wm}: console errors ${errors.join(" | ")}`);
    await ctx.close();
  }
  const ctx = await context(b, { prefs: { wordMeanings: "words-en", reciter: "feroz" } });
  const { page } = await open(ctx, "#/1:1");
  await page.evaluate(() => window.quranPlayer.play());
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const c = await page.evaluate(() => { const x = document.querySelector(".wgrid .cell.w.now"); return x ? `${x.closest(".verse").dataset.v}.${x.dataset.w}` : null; });
    if (c) seen.add(c);
  }
  await page.screenshot({ path: `${OUT}/wordgrid-following.png` });
  t.check(seen.size >= 3, `cells lit while reciting: ${[...seen].join(" ")}`);
  t.note(`following lit ${[...seen].join(" ")}`);
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
