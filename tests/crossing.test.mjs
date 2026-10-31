// Continuous recitation crosses from 1:7 into Al-Baqarah 2:1; the reader follows.
import { launch, context, open, checker } from "./lib/browsers.mjs";

const t = checker("chapter crossing 1:7 → 2:1");
const b = await launch("chromium");
try {
  const ctx = await context(b, { prefs: { reciter: "rashid" } });
  const { page, errors } = await open(ctx, "#/1:7");
  const r = await page.evaluate(async () => {
    const seen = [];
    window.quranPlayer.addEventListener("verse", (e) => seen.push(`${e.detail.ch}:${e.detail.v}`));
    window.quranPlayer.play();
    await new Promise((res) => setTimeout(res, 20000));
    window.quranPlayer.pause();
    return { seen: [...new Set(seen)], hash: location.hash, title: document.querySelector("#where-t").textContent, chapterInReader: document.querySelectorAll(".verse").length };
  });
  t.check(r.seen.includes("1:7") && r.seen.includes("2:1"), `verses ${r.seen.join(" ")}`);
  t.check(r.hash.startsWith("#/2:") && r.title === "Al-Baqarah" && r.chapterInReader === 287, `after crossing: ${r.hash}, "${r.title}", ${r.chapterInReader} verses shown`);
  t.check(!errors.length, `console errors ${errors.join(" | ")}`);
  t.note(`verses: ${r.seen.join(" ")}`);
} finally {
  await b.close();
}
t.finish();
