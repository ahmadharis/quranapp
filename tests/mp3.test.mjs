// js/mp3.js on real verse files: frames found, tags skipped, and the frame count agrees with
// data/durations (frames × samples per frame / rate). No browser.
import { readFile } from "node:fs/promises";
import { checker } from "./lib/browsers.mjs";
import { extractFrames, id3v2Size } from "../js/mp3.js";

const t = checker("mp3 parser");
const url = (r, ch, v) => `https://files.alislam.cloud/audio/tilawat/${r}/${String(ch).padStart(3, "0")}-${String(v).padStart(3, "0")}-AR.mp3`;
for (const [reciter, ch, v] of [["rashid", 1, 1], ["feroz", 112, 2], ["aiman", 1, 2]]) {
  const buf = await (await fetch(url(reciter, ch, v))).arrayBuffer();
  const tag = id3v2Size(new Uint8Array(buf));
  const f = extractFrames(buf);
  t.check(f.frames > 10 && f.sampleRate >= 22050, `${reciter} ${ch}:${v}: ${f.frames} frames at ${f.sampleRate} Hz`);
  t.check(f.bytes.length < buf.byteLength - tag + 1, `${reciter} ${ch}:${v}: frames include the tag`);
  t.check(f.duration > 0.5 && f.skipStart >= 0 && f.skipEnd >= 0, `${reciter} ${ch}:${v}: duration/trim`);
  const d = JSON.parse(await readFile(new URL(`../data/durations/${reciter}.json`, import.meta.url), "utf8")).chapters[ch][v - 1];
  const ms = Math.round((f.frames * f.samplesPerFrame * 1000) / f.sampleRate); // the Info frame, if any, is within the tolerance
  t.check(Math.abs(ms - d) <= 60, `${reciter} ${ch}:${v}: ${ms} ms from frames vs ${d} ms in data/durations`);
  t.note(`${reciter} ${ch}:${v}: ${f.frames} frames, tag ${tag} bytes, ${ms} ms (durations: ${d})`);
}
t.finish();
