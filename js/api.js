// Quran text from api.readquran.app (the API behind alislam.org's Quran app), cached in
// IndexedDB so a chapter is only ever fetched once per device.
// - getChapter: the Arabic text (Indo-Pak, `ar`).
// - getLayers: translations and word meanings, cached per chapter per layer, separately from
//   the Arabic so turning a translation on or off never refetches the Arabic.
// - getIntro: the chapter introduction.

import { CHAPTERS } from "./quran-data.js";

const API = "https://api.readquran.app";
const BATCH = 10; // alislam's own app requests 10 verses per call
const PARALLEL = 3;
const DB_NAME = "quran";
const STORE = "chapters";
const LAYERS = "layers"; // "<layer>:<ch>" -> {version, verses: {v: value}}; "intro:<ch>" -> intro
const CACHE_VERSION = 1;

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [STORE, LAYERS]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // private mode etc.: work without the cache
  return dbPromise;
}

async function idb(mode, fn, store = STORE) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => resolve(undefined);
  });
}

// POST /chapter/{ch}:{from}-{to} with alislam's flags; returns the raw verse objects, retried
// with backoff. Never cache a short or malformed answer: it would leave verses blank for good,
// so the range must be complete and in order, and each verse must pass `valid`.
// (A text/plain body would avoid the CORS preflight, but the API then ignores the flags —
// checked 2026-10-31 — so the request stays JSON.)
const TIMEOUT_MS = 15000; // a request hanging on a weak signal is abandoned and retried

async function postRange(ch, from, to, flags, valid = () => true, attempt = 0) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/chapter/${ch}:${from}-${to}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ f: 1, hover: 0, ...flags }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const complete = Array.isArray(rows) && rows.length === to - from + 1 && rows.every((r, i) => Number(r?.v) === from + i && valid(r));
    if (!complete) throw new Error(`Incomplete response for ${ch}:${from}-${to}`);
    return rows;
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    return postRange(ch, from, to, flags, valid, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRange(ch, from, to) {
  const rows = await postRange(ch, from, to, {}, (r) => typeof r.ar === "string" && r.ar);
  return rows.map((r) => ({ v: Number(r.v), ar: r.ar }));
}

function ranges(ch) {
  const total = CHAPTERS[ch - 1][3];
  const out = [];
  for (let a = 1; a <= total; a += BATCH) out.push([a, Math.min(a + BATCH - 1, total)]);
  return out;
}

// Runs fn over the ranges, PARALLEL at a time.
async function eachRange(list, fn) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) await fn(list[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
}

// A cached record is used only if it is whole: every verse, in order, with its Arabic.
// Anything else (an older or damaged record) is fetched again.
function validChapter(ch, verses) {
  const n = CHAPTERS[ch - 1][3];
  return Array.isArray(verses) && verses.length === n && verses.every((r, i) => r?.v === i + 1 && typeof r.ar === "string" && r.ar.length > 0);
}
function validLayer(ch, verses) {
  if (!verses || typeof verses !== "object") return false;
  const n = CHAPTERS[ch - 1][3];
  for (let v = 1; v <= n; v++) if (!(String(v) in verses)) return false;
  return Object.keys(verses).length === n;
}

const inflight = new Map();

// Resolves with the full chapter [{v, ar}]. onBatch(verses) fires as batches arrive, in any
// order, so the first screen can render before the whole chapter has loaded.
export function getChapter(ch, onBatch) {
  if (inflight.has(ch)) {
    const p = inflight.get(ch);
    if (onBatch) p.then(onBatch, () => {});
    return p;
  }
  const p = (async () => {
    const cached = await idb("readonly", (s) => s.get(ch));
    if (cached?.version === CACHE_VERSION && validChapter(ch, cached.verses)) {
      onBatch?.(cached.verses);
      return cached.verses;
    }
    const verses = [];
    await eachRange(ranges(ch), async ([a, b]) => {
      const rows = await fetchRange(ch, a, b);
      verses.push(...rows);
      onBatch?.(rows);
    });
    verses.sort((x, y) => x.v - y.v);
    idb("readwrite", (s) => s.put({ version: CACHE_VERSION, fetchedAt: Date.now(), verses }, ch));
    navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict the cached text
    return verses;
  })();
  inflight.set(ch, p);
  p.catch(() => inflight.delete(ch));
  return p;
}

// ---------- translations and word meanings ----------

// alislam's translations and commentaries, named as alislam's app names them (its list of
// title + detail). The verse field and the request flag both carry the id. Fields are either a
// plain string or {text, notes:[{ref, note}]} (checked live 2026-10-30).
export const TRANSLATIONS = [
  { id: "en", name: "Maulawi Sher Ali", lang: "English", script: "latin" },
  { id: "zk", name: "Muhammad Zafrulla Khan", lang: "English", script: "latin" },
  { id: "sc", name: "Short Commentary", lang: "English, with notes", script: "latin" },
  { id: "v5", name: "Five Volume Commentary", lang: "English, with notes", script: "latin" },
  { id: "ur", name: "Hazrat Mirza Tahir Ahmad rh", lang: "Urdu", script: "urdu" },
  { id: "ts", name: "Tafseer-e-Saghir", lang: "Urdu, with short commentary", script: "urdu" },
  { id: "fr", name: "Français", lang: "French", script: "latin", more: true },
  { id: "es", name: "Español", lang: "Spanish", script: "latin", more: true },
  { id: "de", name: "Deutsch", lang: "German", script: "latin", more: true },
  { id: "it", name: "Italiano", lang: "Italian", script: "latin", more: true },
  { id: "my", name: "Myanmar", lang: "Burmese", script: "other", htmlLang: "my", more: true },
  { id: "bn", name: "Bangla", lang: "Bengali", script: "other", htmlLang: "bn", more: true },
  { id: "cn", name: "Chinese", lang: "With Short Commentary", script: "other", htmlLang: "zh", more: true },
  { id: "nw", name: "Norwegian", lang: "Short Commentary", script: "latin", htmlLang: "no", more: true },
  { id: "sv", name: "Swedish", lang: "Svenska", script: "latin", more: true },
  { id: "he", name: "עברית", lang: "Hebrew", script: "rtl", htmlLang: "he", more: true },
];
const HTML_LANG = { en: "en", zk: "en", sc: "en", v5: "en", ur: "ur", ts: "ur", fr: "fr", es: "es", de: "de", it: "it", sv: "sv" };
for (const t of TRANSLATIONS) t.htmlLang ??= HTML_LANG[t.id];

// Word meanings: `words[].t`, one gloss per space-separated word of `ar` (the last entry, for
// the verse-end ornament, is empty). Its language follows the `hover` value of the request:
// 0 = English (Maulawi Sher Ali), 1 = Urdu (Hazrat Mir Muhammad Ishaq ra) — alislam's labels.
const readGlosses = (x) => (Array.isArray(x) ? x.map((w) => (typeof w?.t === "string" && w.t.trim() ? w.t : null)) : null);
const WORD_LAYERS = {
  "words-en": { field: "words", hover: 0, read: readGlosses },
  "words-ur": { field: "words", hover: 1, read: readGlosses },
};
export const WORD_MEANINGS = [
  { id: "off", label: "Off" },
  { id: "words-en", label: "English", by: "Maulawi Sher Ali" },
  { id: "words-ur", label: "Urdu", by: "Hazrat Mir Muhammad Ishaq ra" },
];

function readTranslation(x) {
  if (typeof x === "string") return { text: x, notes: [] };
  if (x && typeof x === "object" && typeof x.text === "string") {
    const notes = Array.isArray(x.notes)
      ? x.notes.filter((n) => n && n.ref != null && typeof n.note === "string").map((n) => ({ ref: String(n.ref), note: n.note }))
      : [];
    return { text: x.text, notes };
  }
  return null; // missing for this verse
}

function layerSpec(id) {
  if (WORD_LAYERS[id]) return WORD_LAYERS[id];
  if (TRANSLATIONS.some((t) => t.id === id)) return { field: id, flag: id, read: readTranslation };
  return null;
}

const layerMem = new Map(); // "<id>:<ch>" -> Map(v -> value)
const layerInflight = new Map(); // "<id>:<ch>" -> Promise<Map>

// Resolves with Map(id -> Map(v -> value)) for the requested layers of one chapter. Layers not
// cached yet are fetched together (one request per batch of 10 verses, all flags at once).
// onBatch(id, Map(v -> value)) fires as each batch arrives, for every requested layer.
export async function getLayers(ch, ids, onBatch) {
  ids = ids.filter(layerSpec);
  const out = new Map();
  const missing = [];
  const waits = [];
  for (const id of ids) {
    const k = `${id}:${ch}`;
    if (layerMem.has(k)) {
      out.set(id, layerMem.get(k));
      onBatch?.(id, layerMem.get(k));
    } else if (layerInflight.has(k)) {
      waits.push(layerInflight.get(k).then((m) => (out.set(id, m), onBatch?.(id, m))));
    } else missing.push(id);
  }
  if (missing.length) {
    const load = loadLayers(ch, missing, onBatch);
    for (const id of missing) {
      const k = `${id}:${ch}`;
      const p = load.then((all) => all.get(id));
      layerInflight.set(k, p);
      p.then(
        () => layerInflight.delete(k),
        () => layerInflight.delete(k),
      );
    }
    waits.push(load.then((all) => all.forEach((m, id) => out.set(id, m))));
  }
  await Promise.all(waits);
  return out;
}

// From the device cache where possible, otherwise from the API.
async function loadLayers(ch, ids, onBatch) {
  const all = new Map();
  const toFetch = [];
  await Promise.all(
    ids.map(async (id) => {
      const k = `${id}:${ch}`;
      const hit = await idb("readonly", (s) => s.get(k), LAYERS);
      if (hit?.version === CACHE_VERSION && validLayer(ch, hit.verses)) {
        const m = new Map(Object.entries(hit.verses).map(([v, x]) => [Number(v), x]));
        layerMem.set(k, m);
        all.set(id, m);
        onBatch?.(id, m);
      } else toFetch.push(id);
    }),
  );
  // One run per `hover` value: the same field carries a different language for each.
  const hovers = [...new Set(toFetch.map((id) => layerSpec(id).hover ?? 0))];
  await Promise.all(
    hovers.map(async (hover) => {
      const group = toFetch.filter((id) => (layerSpec(id).hover ?? 0) === hover);
      const maps = await fetchLayers(ch, group, hover, onBatch);
      maps.forEach((m, id) => all.set(id, m));
    }),
  );
  return all;
}

async function fetchLayers(ch, ids, hover, onBatch) {
  const specs = ids.map((id) => [id, layerSpec(id)]);
  const flags = { hover };
  for (const [, s] of specs) if (s.flag) flags[s.flag] = true;
  const maps = new Map(ids.map((id) => [id, new Map()]));
  await eachRange(ranges(ch), async ([a, b]) => {
    const rows = await postRange(ch, a, b, flags);
    for (const [id, s] of specs) {
      const batch = new Map();
      for (const r of rows) batch.set(Number(r.v), s.read(r[s.field]));
      batch.forEach((x, v) => maps.get(id).set(v, x));
      onBatch?.(id, batch);
    }
  });
  for (const [id, m] of maps) {
    layerMem.set(`${id}:${ch}`, m);
    idb("readwrite", (s) => s.put({ version: CACHE_VERSION, fetchedAt: Date.now(), verses: Object.fromEntries(m) }, `${id}:${ch}`), LAYERS);
  }
  return maps;
}

// GET /chapter/intro/{ch} -> {intro_en, intro_ur, ...} (HTML), cached. Null when unavailable.
const introMem = new Map();
export function getIntro(ch) {
  if (introMem.has(ch)) return introMem.get(ch);
  const p = (async () => {
    const k = `intro:${ch}`;
    const hit = await idb("readonly", (s) => s.get(k), LAYERS);
    if (hit?.version === CACHE_VERSION && hit.intro) return hit.intro;
    const res = await fetch(`${API}/chapter/intro/${ch}`, { signal: AbortSignal.timeout?.(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const intro = { en: typeof j?.intro_en === "string" ? j.intro_en : "", ur: typeof j?.intro_ur === "string" ? j.intro_ur : "" };
    if (!intro.en && !intro.ur) throw new Error("Empty introduction");
    idb("readwrite", (s) => s.put({ version: CACHE_VERSION, intro }, k), LAYERS);
    return intro;
  })();
  introMem.set(ch, p);
  p.catch(() => introMem.delete(ch));
  return p;
}
