// Gapless joins: each reciter from 1:1 for 20 s; a Web Audio tap (Chromium, muted output)
// measures digital silence. No silence longer than 70 ms may sit at a verse join.
import { launch, context, open, checker } from "./lib/browsers.mjs";

const t = checker("gapless joins (5 reciters)");
const b = await launch("chromium");
try {
  await Promise.all(
    ["rashid", "feroz", "aiman", "ashiq", "idir-iken"].map(async (reciter) => {
      const ctx = await context(b, { prefs: { reciter } });
      const { page, errors } = await open(ctx, "#/1:1");
      const r = await page.evaluate(async () => {
        const pl = window.quranPlayer, a = pl.audio;
        const ac = new AudioContext();
        await ac.resume();
        const src = ac.createMediaElementSource(a);
        const proc = ac.createScriptProcessor(1024, 1, 1);
        const runs = [];
        let run = 0, at = 0;
        proc.onaudioprocess = (e) => {
          const x = e.inputBuffer.getChannelData(0), sr = e.inputBuffer.sampleRate, ct = a.currentTime;
          for (let i = 0; i < x.length; i++) {
            if (Math.abs(x[i]) < 1e-5) { if (!run) at = ct + i / sr; run++; }
            else { if (run > sr * 0.005 && !a.paused && at > 0.4) runs.push([at, (run / sr) * 1000]); run = 0; }
          }
        };
        src.connect(proc);
        proc.connect(ac.destination);
        pl.play();
        await new Promise((res) => setTimeout(res, 20000));
        pl.pause();
        return { runs, joins: pl.backend.segments.map((s) => s.start).slice(1), backend: pl.backend.constructor.name };
      });
      const atJoins = r.runs.filter(([s]) => r.joins.some((j) => Math.abs(s - j) < 0.25));
      const worst = atJoins.reduce((m, [, ms]) => Math.max(m, ms), 0);
      t.check(r.joins.length >= 2, `${reciter}: only ${r.joins.length} joins reached`);
      t.check(worst <= 70, `${reciter}: ${worst.toFixed(0)} ms of silence at a join`);
      t.check(!errors.length, `${reciter}: console errors ${errors.join(" | ")}`);
      t.note(`${reciter}: ${r.backend}, ${r.joins.length} joins, longest silence at a join ${worst.toFixed(0)} ms`);
      await ctx.close();
    }),
  );
} finally {
  await b.close();
}
t.finish();
