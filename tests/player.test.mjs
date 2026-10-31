// The one player component, in every variant (mini: phone Read; compact: Read from 600 px and
// phone landscape; expanded: Listen): ▶ exactly centered in the player; the controls in the same
// left-to-right order everywhere; no old player markup; no loading ring while playing; ⏮ ⏭
// change chapter; tapping the mini bar's title opens Listen; the repeat toggle works.
import { launch, context, open, waitFor, position, checker, OUT } from "./lib/browsers.mjs";

const t = checker("player");
const SIZES = [["402", { width: 402, height: 874 }], ["852x393", { width: 852, height: 393 }], ["1440", { width: 1440, height: 900 }], ["1920", { width: 1920, height: 1080 }]];
const WANT = { read: { "402": "mini", "852x393": "compact", "1440": "compact", "1920": "compact" }, listen: { "402": "expanded", "852x393": "compact", "1440": "expanded", "1920": "expanded" } };

const geometry = (page) =>
  page.evaluate(() => {
    const q = document.querySelector("#player");
    const r = q.getBoundingClientRect();
    const pp = q.querySelector(".pp").getBoundingClientRect();
    const shown = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
    const order = [["repeat", "#qp-repeat"], ["prev", "[data-prev]"], ["play", "[data-play]"], ["next", "[data-next]"], ["more", "[data-more]"]]
      .map(([n, s]) => [n, q.querySelector(s)])
      .filter(([, el]) => shown(el))
      .sort((a, b) => a[1].getBoundingClientRect().left - b[1].getBoundingClientRect().left)
      .map(([n]) => n);
    return {
      variant: q.dataset.variant,
      playerC: (r.left + r.right) / 2,
      playC: (pp.left + pp.right) / 2,
      order,
      players: document.querySelectorAll(".qp, #pill, #slim, #lplayer, .playdock, .vprog").length,
      ring: getComputedStyle(q.querySelector(".pp"), "::before").display,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });

const b = await launch("chromium");
try {
  for (const mode of ["read", "listen"]) {
    for (const [size, viewport] of SIZES) {
      const ctx = await context(b, { prefs: { mode, reciter: "rashid" }, viewport });
      const { page, errors } = await open(ctx, "#/36:20");
      await page.evaluate(() => window.quranPlayer.play());
      await waitFor(page, () => window.quranPlayer.playing && !window.quranPlayer.buffering, 25000).catch(() => {});
      await page.waitForTimeout(500);
      const g = await geometry(page);
      const name = `${mode}/${size}`;
      t.check(g.variant === WANT[mode][size], `${name}: variant ${g.variant}, expected ${WANT[mode][size]}`);
      t.check(Math.abs(g.playC - g.playerC) <= 1, `${name}: ▶ center ${g.playC.toFixed(1)}, player center ${g.playerC.toFixed(1)}`);
      const want = g.variant === "mini" ? "prev,play,next,more" : "repeat,prev,play,next,more";
      t.check(g.order.join() === want, `${name}: controls ${g.order}, expected ${want}`);
      t.check(g.players === 1, `${name}: ${g.players} player elements (old markup left?)`);
      t.check(g.ring === "none", `${name}: loading ring shown while playing (${g.ring})`);
      t.check(g.overflow <= 0, `${name}: page scrolls sideways by ${g.overflow}px`);
      // ⏭ then ⏮: chapter 37, then back to 36 (from 37:1 at once, so it is the previous chapter).
      await page.click("#player [data-next]");
      await page.waitForTimeout(1200);
      const next = await position(page);
      await page.click("#player [data-prev]");
      await page.waitForTimeout(1200);
      const prev = await position(page);
      t.check(next === "37:1" && prev === "36:1", `${name}: ⏭ → ${next}, ⏮ → ${prev}`);
      t.check(!errors.length, `${name}: console errors ${errors.join(" | ")}`);
      await page.screenshot({ path: `${OUT}/player-${mode}-${size}.png` });
      t.note(`${name}: ${g.variant}, ▶ off center by ${(g.playC - g.playerC).toFixed(2)} px`);
      await page.evaluate(() => window.quranPlayer.pause());
      await ctx.close();
    }
  }

  // The mini bar: tapping the title opens Listen. The repeat toggle (compact player).
  const ctx = await context(b, { prefs: { mode: "read", reciter: "rashid" } });
  const { page, errors } = await open(ctx, "#/36:1");
  await page.click("#player [data-info]");
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode, variant: document.querySelector("#player").dataset.variant }));
  t.check(after.mode === "listen" && after.variant === "expanded", `mini bar tap: ${JSON.stringify(after)}`);
  const rep = async () => page.evaluate(async () => ({ pressed: document.querySelector("#qp-repeat").getAttribute("aria-pressed"), pref: (await import("./js/prefs.js")).prefs.repeat }));
  const r0 = await rep();
  await page.click("#qp-repeat");
  const r1 = await rep();
  await page.click("#qp-repeat");
  const r2 = await rep();
  t.check(r0.pressed === "false" && !r0.pref && r1.pressed === "true" && r1.pref && r2.pressed === "false" && !r2.pref, `repeat toggle: ${JSON.stringify([r0, r1, r2])}`);
  t.check(!errors.length, `mini/repeat: console errors ${errors.join(" | ")}`);
  await ctx.close();
} finally {
  await b.close();
}
t.finish();
