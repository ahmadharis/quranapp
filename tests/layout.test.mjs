// Wide screens: Contents docked at the left edge, the info panel at the right, the player over
// the middle only; the toggles never move; one sidebar at a time at 1280–1679; the choices
// (and Focus) survive a reload and a new browser context with the same storage.
import { launch, context, open, checker, OUT } from "./lib/browsers.mjs";

const t = checker("docked layout");
const grp = (w) => (w >= 2240 ? "ultra" : w >= 1680 ? "wide" : w >= 1280 ? "laptop" : "desk");
const geo = (p) => p.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e || getComputedStyle(e).display === "none" || e.hidden) return null; const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.right)]; };
  return { vw: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, top: r("#topbar"), contents: r("#contents"), side: r("#side"), dock: r("#slim") ?? r("#pill"), tc: r("#toggle-contents"), tp: r("#toggle-panel"), dc: document.documentElement.hasAttribute("data-contents"), dp: document.documentElement.hasAttribute("data-panel"), focus: document.documentElement.hasAttribute("data-focus") };
});
const b = await launch("chromium");
try {
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    for (const [st, c, pn] of [["both", true, true], ["left", true, false], ["right", false, true], ["none", false, false]]) {
      const ctx = await context(b, { prefs: { translations: { on: true, list: ["en"] }, layout: { [grp(w)]: { contents: c, panel: pn } } }, viewport: { width: w, height: h } });
      const { page, errors } = await open(ctx, "#/2:3");
      await page.waitForTimeout(1500);
      const g = await geo(page);
      const name = `${w}/${st}`;
      t.check(g.overflow <= 0, `${name}: horizontal overflow ${g.overflow}`);
      t.check(g.top[0] === 0 && g.top[1] === w, `${name}: header ${g.top}`);
      if (g.contents) t.check(g.contents[0] === 0, `${name}: Contents not at the left edge`);
      if (g.side) t.check(g.side[1] === w, `${name}: panel not at the right edge`);
      const L = g.contents ? g.contents[1] : 0, R = g.side ? w - g.side[0] : 0;
      t.check(Math.abs(g.dock[0] - (L + 24)) <= 1 && Math.abs(g.dock[1] - (w - R - 24)) <= 1, `${name}: player ${g.dock} not over the middle ${L}..${w - R}`);
      if (grp(w) === "laptop") t.check(!(g.dc && g.dp), `${name}: two sidebars at 1280–1679`);
      await page.click('#topbar [data-mode="listen"]'); await page.waitForTimeout(250);
      const gl = await geo(page);
      t.check(gl.tc[0] === g.tc[0] && gl.tp?.[0] === g.tp?.[0], `${name}: toggles moved between Read and Listen`);
      if (st === "both") await page.screenshot({ path: `${OUT}/layout-${w}-listen.png` });
      t.check(!errors.length, `${name}: console errors ${errors.join(" | ")}`);
      await ctx.close();
    }
    // Persistence: toggle, Focus, reload, and come back in a new context with the same storage.
    const ctx = await context(b, { viewport: { width: w, height: h } });
    const { page } = await open(ctx, "#/36:5");
    await page.waitForTimeout(1500);
    await page.keyboard.press("["); await page.waitForTimeout(150);
    const set = await geo(page);
    await page.keyboard.press("f"); await page.waitForTimeout(150);
    await page.reload(); await page.waitForSelector(".verse:not(.loading)"); await page.waitForTimeout(1200);
    const afterReload = await geo(page);
    const storage = await ctx.storageState();
    await ctx.close();
    const ctx2 = await b.newContext({ viewport: { width: w, height: h }, storageState: storage, bypassCSP: true });
    const p2 = await ctx2.newPage(); await p2.goto(process.env.BASE + "/"); await p2.waitForSelector(".verse:not(.loading)"); await p2.waitForTimeout(1200);
    const back = await geo(p2);
    await p2.keyboard.press("Escape"); await p2.waitForTimeout(200);
    const unfocused = await geo(p2);
    t.check(afterReload.focus && back.focus && !back.dc && !back.dp, `${w}: Focus not restored (${JSON.stringify({ r: afterReload.focus, b: back.focus })})`);
    t.check(unfocused.dc === set.dc && unfocused.dp === set.dp, `${w}: sidebars after leaving Focus ${unfocused.dc}/${unfocused.dp}, set ${set.dc}/${set.dp}`);
    await ctx2.close();
  }
} finally {
  await b.close();
}
t.finish();
