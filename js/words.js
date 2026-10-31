// Word-by-word following of the recitation.
//
// Word timings are generated offline (tools/align/) and published as static files:
// data/words/{reciter}/{ch}.json = {reciter, ch, source, model, verses: {"1": [[startMs, endMs], …]}}
// with one pair per word of the displayed text (see isWord in util.js), in ms from the start
// of that verse's original MP3 — the same reference as player.verseTime(). A chapter or
// reciter without a file simply gets verse-level highlighting.
//
// While recitation plays, a requestAnimationFrame loop reads player.verseTime(), finds the
// current word and marks the verse's words: "said" (already recited), "now" (being recited),
// and the rest as still to come (the verse gets "timed", which dims them) — class changes
// only, no layout work. The loop is
// display only: it stops when the page is hidden (browsers pause animation frames) and audio
// never depends on it.

import { key } from "./util.js";

// Reciters with published timings; others aren't requested (a 404 per chapter is just noise).
// Add a reciter here once tools/align/ has produced its files.
const WORD_RECITERS = new Set(["feroz", "aiman", "rashid", "ashiq", "idir-iken"]);
export const hasWordTimings = (reciter) => WORD_RECITERS.has(reciter);

const loaded = new Map(); // "reciter/ch" -> Map(v -> [[s, e], …]) | null (no file)
const pending = new Map();

function load(reciter, ch) {
  const k = `${reciter}/${ch}`;
  if (!WORD_RECITERS.has(reciter) || loaded.has(k) || pending.has(k)) return;
  const p = fetch(`data/words/${encodeURIComponent(reciter)}/${ch}.json`)
    .then((res) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((j) => {
      loaded.set(k, parse(j, reciter, ch));
    })
    .catch(() => {}) // offline etc.: try again next time it is needed
    .finally(() => pending.delete(k));
  pending.set(k, p);
}

function parse(j, reciter, ch) {
  if (!j || j.reciter !== reciter || Number(j.ch) !== ch || !j.verses || typeof j.verses !== "object") return null;
  const out = new Map();
  for (const [v, list] of Object.entries(j.verses)) {
    if (!Array.isArray(list)) continue;
    const ok = list.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ok) out.set(Number(v), list);
  }
  return out.size ? out : null;
}

export function timingsFor(reciter, ch) {
  return loaded.get(`${reciter}/${ch}`) ?? null;
}

// Index of the word being recited at `ms`, or -1 before the first word. Between two words the
// earlier one stays lit; after the last word, the last one does.
function wordAt(list, ms) {
  let i = -1;
  for (let j = 0; j < list.length && list[j][0] <= ms; j++) i = j;
  return i;
}

export class WordFollower {
  // targets(pos): the elements currently showing verse `pos` (their .w spans get lit).
  // onTick({pos, word, fraction}) runs every frame while playing — for line paging and the
  // "current word" panel. fraction = elapsed share of the verse (0–1).
  constructor(player, { targets, onTick }) {
    this.player = player;
    this.targets = targets;
    this.onTick = onTick;
    this.lit = [];
    this.litKey = "";
    this.raf = 0;
    this.enabled = true;
    player.addEventListener("state", () => this.#sync());
    document.addEventListener("visibilitychange", () => this.#sync());
  }

  // "Follow words" setting: off leaves verse-level highlighting only.
  setEnabled(on) {
    this.enabled = on;
    this.clear();
    this.refresh();
  }

  // The views re-rendered: light the current word again in the new elements.
  refresh() {
    this.litKey = "";
    if (!this.raf) this.#tick(false);
  }

  #sync() {
    const run = this.player.playing && document.visibilityState === "visible";
    if (run && !this.raf) this.raf = requestAnimationFrame(() => this.#frame());
    if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  #frame() {
    this.raf = 0;
    this.#tick(true);
    if (this.player.playing && document.visibilityState === "visible") this.raf = requestAnimationFrame(() => this.#frame());
  }

  #tick(live) {
    const t = this.player.verseTime();
    if (!t) return;
    const pos = { ch: t.ch, v: t.v };
    load(this.player.reciter, t.ch);
    const list = timingsFor(this.player.reciter, t.ch)?.get(t.v);
    const word = list && this.enabled ? wordAt(list, t.ms) : null;
    const span = t.endMs - t.startMs;
    const fraction = span > 0 ? Math.min(Math.max((t.ms - t.startMs) / span, 0), 1) : 0;
    const k = `${key(pos)}/${word}`;
    if (k !== this.litKey) {
      this.litKey = k;
      this.clear(false);
      if (word != null) {
        for (const box of this.targets(pos)) {
          if (!box) continue;
          box.classList.add("timed");
          this.lit.push(box);
          for (const el of box.querySelectorAll(".w")) {
            const i = Number(el.dataset.w);
            el.classList.toggle("said", i < word);
            el.classList.toggle("now", i === word);
          }
        }
      }
    }
    if (live || word != null) this.onTick?.({ pos, word, fraction, hasTimings: !!list });
  }

  // Clear the word marks (e.g. the reader moved to another verse while paused).
  clear(resetKey = true) {
    for (const box of this.lit) {
      box.classList.remove("timed");
      for (const el of box.querySelectorAll(".w.said, .w.now")) el.classList.remove("said", "now");
    }
    this.lit = [];
    if (resetKey) this.litKey = "";
  }
}
