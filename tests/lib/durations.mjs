// data/durations helpers for expectations (the same data the app uses).
import { readFileSync } from "node:fs";
export const durations = (reciter) => JSON.parse(readFileSync(new URL(`../../data/durations/${reciter}.json`, import.meta.url), "utf8")).chapters;
export const total = (d, ch) => d[ch].reduce((a, x) => a + x, 0);
export const before = (d, ch, v) => d[ch].slice(0, v - 1).reduce((a, x) => a + x, 0);
export function locate(d, ch, ms) {
  let acc = 0;
  for (let i = 0; i < d[ch].length; i++) {
    if (acc + d[ch][i] > ms) return { v: i + 1, ms: ms - acc };
    acc += d[ch][i];
  }
  return { v: d[ch].length, ms: 0 };
}
