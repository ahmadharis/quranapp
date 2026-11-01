// Preferences, kept per device in localStorage under one key that never changes.
//
// An update must never lose the user's settings or data. What an older version stored is
// MIGRATED to the current shape (migrate(), one step per schema change), never reset: a value
// falls back to its default only when it is missing or invalid (edited by hand, or naming a
// reciter or translation that no longer exists). Keys this version doesn't know are kept.
//
// Schema history:
//   1 - every version up to 1.1.0 (no `schema` field stored).
//   2 - 1.1.1: adds `schema`; the shape is otherwise unchanged.
//   3 - 1.2.0: adds `lastAt` (when the last position was set; 0 = unknown), so importing from
//       another device can keep whichever last position is newer.
//   4 - 1.2.1: adds `carControls` ("scrubber" | "classic" | "nobar"; see applyCarControls in
//       app.js). `repeat` now repeats the chapter (it repeated the verse); kept as it is.
// To change the shape: bump SCHEMA and add a step to STEPS that turns the old values into the
// new ones.

import { RECITERS, DEFAULT_RECITER } from "./player.js";
import { TRANSLATIONS, WORD_MEANINGS } from "./api.js";
import { verseCount } from "./util.js";

const PREFS_KEY = "quran.prefs";
export const LAYOUT_GROUPS = ["desk", "laptop", "wide", "ultra"]; // the sizes with the Contents sidebar and Focus (and, from "wide", the side panel)
export const SPEEDS = [0.75, 1, 1.25];

export const validPos = (p) =>
  Number.isInteger(p?.ch) && p.ch >= 1 && p.ch <= 114 && Number.isInteger(p.v) && p.v >= 1 && p.v <= verseCount(p.ch);

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

export const SCHEMA = 4;
// STEPS[n] turns schema-n prefs into schema n+1, in place.
const STEPS = {
  1: (p) => {
    // Early versions kept translations behind an on/off switch; a list saved while it was off was
    // hidden, so it stays hidden (empty) rather than appearing unasked.
    if (isObj(p.translations) && p.translations.on === false) p.translations = { on: true, list: [] };
  },
  2: (p) => {
    if (!(Number.isFinite(p.lastAt) && p.lastAt >= 0)) p.lastAt = 0; // not known before 1.2.0
  },
  3: (p) => {
    if (!["classic", "nobar"].includes(p.carControls)) p.carControls = "scrubber"; // the behavior before 1.2.1
  },
};

// Old stored prefs -> the current schema. Exported for the tests.
export function migrate(saved) {
  const p = isObj(saved) ? { ...saved } : {};
  let n = Number.isInteger(p.schema) && p.schema >= 1 ? p.schema : 1;
  for (; n < SCHEMA; n++) STEPS[n]?.(p);
  p.schema = Math.max(n, SCHEMA); // a newer version's prefs are kept as they are
  return p;
}

// Any stored (or imported) prefs object -> complete, valid prefs of the current schema. Used at
// start and for imports from another device (js/transfer.js), so both get the same checks.
export function normalizePrefs(saved) {
  const defaults = {
    reciter: DEFAULT_RECITER,
    mode: "read",
    theme: "auto",
    scale: 1,
    navTab: "chapters",
    last: { ch: 1, v: 1 },
    lastAt: 0, // when `last` was set (ms); 0 = unknown
    chLast: {}, // chapter -> last verse read there, marked in the navigator's verse grid
    translations: { on: false, list: [] }, // list: shown translations, in order
    wordMeanings: "off",
    layout: {}, // group -> {contents, panel, focus}
    barCollapsed: false,
    repeat: false,
    hintSeen: false, // the first-visit tip was dismissed
    focusHintSeen: false, // "Press F or Esc…" was shown once
    install: { dismissed: 0, until: 0, done: false }, // the install recommendation
    nazira: false, // Nazira mode: Read shows the Arabic only, verses flowing like a printed page
    speed: 1,
    followWords: true, // light each word as it is recited, where word timings exist
    carControls: "scrubber", // lock screen / car: "scrubber", "classic" or "nobar" (app.js, applyCarControls)
  };
  const p = { ...defaults, ...migrate(saved) };
  if (!RECITERS.some((r) => r.id === p.reciter)) p.reciter = defaults.reciter;
  if (!["read", "listen"].includes(p.mode)) p.mode = defaults.mode;
  if (!validPos(p.last)) p.last = defaults.last;
  else p.last = { ch: p.last.ch, v: p.last.v };
  if (!(Number.isFinite(p.lastAt) && p.lastAt >= 0)) p.lastAt = 0;
  p.chLast = isObj(p.chLast) ? { ...p.chLast } : {};
  if (!(p.scale >= 0.8 && p.scale <= 1.6)) p.scale = defaults.scale;
  if (!["auto", "light", "dark"].includes(p.theme)) p.theme = defaults.theme;
  if (!["chapters", "parts"].includes(p.navTab)) p.navTab = defaults.navTab;
  for (const [ch, v] of Object.entries(p.chLast)) if (!validPos({ ch: Number(ch), v })) delete p.chLast[ch];
  const t = isObj(p.translations) ? p.translations : {};
  const ids = new Set(TRANSLATIONS.map((x) => x.id));
  // There is no master switch any more: translations are shown when any is selected.
  const list = Array.isArray(t.list) ? [...new Set(t.list.filter((id) => ids.has(id)))] : [];
  p.translations = { on: true, list };
  if (!WORD_MEANINGS.some((w) => w.id === p.wordMeanings)) p.wordMeanings = defaults.wordMeanings;
  p.layout = isObj(p.layout) ? { ...p.layout } : {};
  for (const g of LAYOUT_GROUPS) {
    const l = isObj(p.layout[g]) ? p.layout[g] : {};
    // Contents is open by default in Read, closed in Listen (recitation only).
    // On laptops (1280–1679) Contents, text and panel don't all fit, so Contents starts closed.
    p.layout[g] = { contents: g === "laptop" ? l.contents === true : l.contents !== false, contentsListen: l.contentsListen === true, panel: l.panel !== false, focus: l.focus === true };
  }
  p.bookmarks = Array.isArray(p.bookmarks) ? p.bookmarks.filter((b) => validPos(b)).map(({ ch, v, at }) => ({ ch, v, at: Number(at) || 0 })) : [];
  if (!(validPos(p.resume) && RECITERS.some((r) => r.id === p.resume.reciter))) p.resume = null;
  else p.resume = { ...p.resume };
  p.barCollapsed = p.barCollapsed === true;
  p.nazira = p.nazira === true;
  p.hintSeen = p.hintSeen === true;
  p.focusHintSeen = p.focusHintSeen === true;
  const ins = isObj(p.install) ? p.install : {};
  p.install = { dismissed: Number.isInteger(ins.dismissed) && ins.dismissed >= 0 ? ins.dismissed : 0, until: Number(ins.until) || 0, done: ins.done === true };
  p.repeat = p.repeat === true;
  if (!SPEEDS.includes(p.speed)) p.speed = 1;
  p.followWords = p.followWords !== false;
  if (!["scrubber", "classic", "nobar"].includes(p.carControls)) p.carControls = defaults.carControls;
  return p;
}

export const prefs = (() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {}
  return normalizePrefs(saved);
})();

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

// Stored by an older version: write the migrated prefs back once, so they carry the schema.
try {
  const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
  if (isObj(stored) && stored.schema !== prefs.schema) savePrefs();
} catch {}

// The translations shown, in order.
export const shownTranslations = () => prefs.translations.list;
