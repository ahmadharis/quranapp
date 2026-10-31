// Preferences, kept per device in localStorage. Anything stored by an older version, or
// edited by hand, falls back to the default.

import { RECITERS, DEFAULT_RECITER } from "./player.js";
import { TRANSLATIONS, WORD_MEANINGS } from "./api.js";
import { verseCount } from "./util.js";

const PREFS_KEY = "quran.prefs";
export const LAYOUT_GROUPS = ["desk", "laptop", "wide", "ultra"]; // the sizes with the Contents sidebar and Focus (and, from "wide", the side panel)
export const SPEEDS = [0.75, 1, 1.25];

export const validPos = (p) =>
  Number.isInteger(p?.ch) && p.ch >= 1 && p.ch <= 114 && Number.isInteger(p.v) && p.v >= 1 && p.v <= verseCount(p.ch);

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

export const prefs = (() => {
  const defaults = {
    reciter: DEFAULT_RECITER,
    mode: "read",
    theme: "auto",
    scale: 1,
    navTab: "chapters",
    last: { ch: 1, v: 1 },
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
  };
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {}
  const p = { ...defaults, ...(isObj(saved) ? saved : {}) };
  if (!RECITERS.some((r) => r.id === p.reciter)) p.reciter = defaults.reciter;
  if (!["read", "listen"].includes(p.mode)) p.mode = defaults.mode;
  if (!validPos(p.last)) p.last = defaults.last;
  if (!(p.scale >= 0.8 && p.scale <= 1.6)) p.scale = defaults.scale;
  if (!["auto", "light", "dark"].includes(p.theme)) p.theme = defaults.theme;
  if (!["chapters", "parts"].includes(p.navTab)) p.navTab = defaults.navTab;
  if (!isObj(p.chLast)) p.chLast = {};
  for (const [ch, v] of Object.entries(p.chLast)) if (!validPos({ ch: Number(ch), v })) delete p.chLast[ch];
  const t = isObj(p.translations) ? p.translations : {};
  const ids = new Set(TRANSLATIONS.map((x) => x.id));
  // There is no master switch any more: translations are shown when any is selected. A list
  // saved behind the old switch while it was off is cleared, so nothing appears unasked.
  const list = Array.isArray(t.list) ? [...new Set(t.list.filter((id) => ids.has(id)))] : [];
  p.translations = { on: true, list: t.on === false ? [] : list };
  if (!WORD_MEANINGS.some((w) => w.id === p.wordMeanings)) p.wordMeanings = defaults.wordMeanings;
  if (!isObj(p.layout)) p.layout = {};
  for (const g of LAYOUT_GROUPS) {
    const l = isObj(p.layout[g]) ? p.layout[g] : {};
    // Contents is open by default in Read, closed in Listen (recitation only).
    // On laptops (1280–1679) Contents, text and panel don't all fit, so Contents starts closed.
    p.layout[g] = { contents: g === "laptop" ? l.contents === true : l.contents !== false, contentsListen: l.contentsListen === true, panel: l.panel !== false, focus: l.focus === true };
  }
  p.bookmarks = Array.isArray(p.bookmarks) ? p.bookmarks.filter((b) => validPos(b)).map(({ ch, v, at }) => ({ ch, v, at: Number(at) || 0 })) : [];
  if (!(validPos(p.resume) && RECITERS.some((r) => r.id === p.resume.reciter))) p.resume = null;
  p.barCollapsed = p.barCollapsed === true;
  p.nazira = p.nazira === true;
  p.hintSeen = p.hintSeen === true;
  p.focusHintSeen = p.focusHintSeen === true;
  const ins = isObj(p.install) ? p.install : {};
  p.install = { dismissed: Number.isInteger(ins.dismissed) && ins.dismissed >= 0 ? ins.dismissed : 0, until: Number(ins.until) || 0, done: ins.done === true };
  p.repeat = p.repeat === true;
  if (!SPEEDS.includes(p.speed)) p.speed = 1;
  p.followWords = p.followWords !== false;
  return p;
})();

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

// The translations shown, in order.
export const shownTranslations = () => prefs.translations.list;
