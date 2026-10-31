// Silent, headless browsers for the tests, and small helpers they share.
//
// - Chromium runs with --mute-audio.
// - WebKit and Firefox have no such switch: every context gets an init script that forces
//   all media to volume 0 before any page script runs, and tests that play audio there call
//   assertSilent(). Playwright's WebKit is a test engine, never the real Safari app.

import { chromium, webkit, firefox } from "playwright";
import { mkdirSync } from "node:fs";

export const BASE = process.env.BASE || "http://localhost:8766";
export const OUT = process.env.OUT || new URL("../out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const MUTE = () => {
  const P = HTMLMediaElement.prototype;
  const play = P.play;
  P.play = function () {
    this.muted = true;
    this.volume = 0;
    return play.call(this);
  };
  Object.defineProperty(P, "muted", { get() { return true; }, set() {}, configurable: true });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) AC.prototype.resume = function () { return Promise.resolve(); };
};

export async function launch(kind = "chromium") {
  if (kind === "webkit") return webkit.launch({ headless: true });
  if (kind === "firefox") return firefox.launch({ headless: true, firefoxUserPrefs: { "media.volume_scale": "0.0", "media.autoplay.default": 0 } });
  return chromium.launch({ headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
}

// A context (muted) with saved preferences seeded once; bypassCSP only for Chromium, where
// Playwright's own waitForFunction would otherwise be blocked by the app's CSP.
export async function context(browser, { prefs = {}, csp = false, ...opts } = {}) {
  const kind = browser.browserType().name();
  const ctx = await browser.newContext({ bypassCSP: kind === "chromium" && !csp, viewport: { width: 402, height: 874 }, ...opts });
  await ctx.addInitScript(MUTE);
  await ctx.addInitScript((pr) => {
    if (!sessionStorage.getItem("__seeded")) {
      localStorage.setItem("quran.prefs", JSON.stringify({ hintSeen: true, ...pr }));
      sessionStorage.setItem("__seeded", "1");
    }
  }, prefs);
  return ctx;
}

// A page with error collection, opened at a hash, once the text has loaded.
export async function open(ctx, hash = "#/1:1") {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${BASE}/${hash}`);
  await page.waitForSelector(".verse:not(.loading)", { state: "attached", timeout: 30000 });
  await page.waitForTimeout(1200);
  return { page, errors };
}

// Every media element on the page plays at volume 0.
export async function assertSilent(page) {
  const r = await page.evaluate(() => [...document.querySelectorAll("audio,video")].concat(window.quranPlayer ? [window.quranPlayer.audio] : []).map((a) => ({ muted: a.muted, volume: a.volume })));
  if (!r.every((x) => x.volume === 0)) throw new Error(`not silent: ${JSON.stringify(r)}`);
}

// Polls in the page (works under the app's CSP in every engine, unlike waitForFunction).
export async function waitFor(page, fn, timeout = 20000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${String(fn).slice(0, 80)}`);
}

export const position = (page) => page.evaluate(() => `${window.quranPlayer.position.ch}:${window.quranPlayer.position.v}`);

// Collects checks; finish() prints the result line for run.mjs and sets the exit code.
export function checker(name) {
  const fails = [];
  const notes = [];
  return {
    check(cond, msg) {
      if (!cond) fails.push(msg);
      return !!cond;
    },
    note(msg) {
      notes.push(msg);
    },
    finish() {
      for (const n of notes) console.log(`  · ${n}`);
      for (const f of fails) console.log(`  ✗ ${f}`);
      console.log(fails.length ? `FAIL ${name} (${fails.length})` : `PASS ${name}`);
      process.exitCode = fails.length ? 1 : 0;
    },
  };
}
