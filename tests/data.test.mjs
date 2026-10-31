// Data integrity: every published word-timing and verse-duration file is well formed and
// matches the chapter list (js/quran-data.js). No browser.
import { readdir, readFile } from "node:fs/promises";
import { checker } from "./lib/browsers.mjs";
import { CHAPTERS } from "../js/quran-data.js";

const t = checker("data integrity");
const DATA = new URL("../data/", import.meta.url);
const count = (ch) => CHAPTERS[ch - 1][3];

// data/durations/{reciter}.json = {reciter, unit: "ms", chapters: {"1": [ms per verse]}}
for (const f of (await readdir(new URL("durations/", DATA))).filter((x) => x.endsWith(".json"))) {
  const reciter = f.replace(/\.json$/, "");
  const j = JSON.parse(await readFile(new URL(`durations/${f}`, DATA), "utf8"));
  t.check(j.reciter === reciter && j.unit === "ms", `durations/${f}: header`);
  const chs = Object.keys(j.chapters ?? {});
  t.check(chs.length === 114, `durations/${f}: ${chs.length} chapters`);
  let zero = 0;
  for (const ch of chs) {
    const list = j.chapters[ch];
    if (!t.check(Array.isArray(list) && list.length === count(Number(ch)), `durations/${f} ch ${ch}: ${list?.length} verses, expected ${count(Number(ch))}`)) continue;
    t.check(list.every((x) => Number.isInteger(x) && x >= 0 && x < 600000), `durations/${f} ch ${ch}: bad values`);
    zero += list.filter((x) => x === 0).length;
  }
  t.note(`durations/${f}: 114 chapters${zero ? `, ${zero} verse(s) without audio` : ""}`);
}

// data/words/{reciter}/{ch}.json = {reciter, ch, verses: {"1": [[startMs, endMs], …]}}
for (const reciter of await readdir(new URL("words/", DATA))) {
  const files = (await readdir(new URL(`words/${reciter}/`, DATA)).catch(() => [])).filter((x) => x.endsWith(".json"));
  let pairs = 0;
  for (const f of files) {
    const ch = Number(f.replace(/\.json$/, ""));
    const j = JSON.parse(await readFile(new URL(`words/${reciter}/${f}`, DATA), "utf8"));
    t.check(j.reciter === reciter && j.ch === ch, `words/${reciter}/${f}: header`);
    for (const [v, list] of Object.entries(j.verses ?? {})) {
      const n = Number(v);
      t.check(n >= 1 && n <= count(ch), `words/${reciter}/${f}: verse ${v} out of range`);
      const ok = Array.isArray(list) && list.every((p, i) => Array.isArray(p) && p.length === 2 && p[0] <= p[1] && (i === 0 || p[0] >= list[i - 1][0]));
      t.check(ok, `words/${reciter}/${f} verse ${v}: pairs not [start, end] in order`);
      pairs += list?.length ?? 0;
    }
  }
  t.note(`words/${reciter}: ${files.length} chapter file(s), ${pairs} word timings`);
}
t.finish();
