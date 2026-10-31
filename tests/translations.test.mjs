// Translations in Settings: add through the picker (its rows never move; added ones go last),
// remove with ×, reorder by keyboard and by drag; the order shows under each verse and persists.
import { launch, context, open, checker, OUT } from "./lib/browsers.mjs";

const t = checker("translations settings");
const list = (p) => p.evaluate(() => [...document.querySelectorAll("#settings-main .showing .r")].map((r) => r.dataset.id));
const under = (p) => p.evaluate(() => [...document.querySelectorAll('.verse[data-v="2"] .v-tr > .tr')].map((x) => x.dataset.t));
const b = await launch("chromium");
try {
  const ctx = await context(b, { prefs: { translations: { on: true, list: [] } } });
  const { page, errors } = await open(ctx, "#/1:1");
  await page.click("#open-settings");
  t.check(await page.isVisible("#settings-main .empty-row"), "no empty state");
  await page.click("#settings-main .add-tr");
  const before = await page.evaluate(() => [...document.querySelectorAll(".pick")].map((x) => x.dataset.id).join());
  for (const id of ["en", "ur", "sc"]) await page.click(`.pick[data-id="${id}"]`);
  t.check(before === (await page.evaluate(() => [...document.querySelectorAll(".pick")].map((x) => x.dataset.id).join())), "picker rows moved");
  await page.screenshot({ path: `${OUT}/translations-picker.png` });
  await page.click(".sheet-head .done");
  t.check(JSON.stringify(await list(page)) === '["en","ur","sc"]', `after adding: ${await list(page)}`);
  await page.click('#settings-main .showing .r[data-id="ur"] .rm');
  t.check(JSON.stringify(await list(page)) === '["en","sc"]', `after removing ur: ${await list(page)}`);
  await page.focus('#settings-main .showing .r[data-id="sc"] .grip');
  await page.keyboard.press("Space"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space");
  t.check(JSON.stringify(await list(page)) === '["sc","en"]', `after keyboard reorder: ${await list(page)}`);
  t.check(/position 1 of 2/.test(await page.textContent("#live")), "no live announcement");
  const g = await page.locator('#settings-main .showing .r[data-id="en"] .grip').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 70, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(300);
  t.check(JSON.stringify(await list(page)) === '["en","sc"]', `after drag: ${await list(page)}`);
  await page.screenshot({ path: `${OUT}/translations-settings.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  t.check(JSON.stringify(await under(page)) === '["en","sc"]', `under the verses: ${await under(page)}`);
  await page.reload(); await page.waitForSelector(".verse:not(.loading)"); await page.waitForTimeout(2500);
  t.check(JSON.stringify(await under(page)) === '["en","sc"]', `after reload: ${await under(page)}`);
  t.check(!errors.length, `console errors ${errors.join(" | ")}`);
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
