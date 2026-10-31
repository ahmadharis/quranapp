// The chapter as one track. alislam serves one MP3 per verse; to show (and seek) a chapter as
// a single timeline, data/durations/{reciter}.json gives each verse's original file length:
// {reciter, unit: "ms", chapters: {"1": [ms per verse, …], …}} (0 = no file for that verse).
// Times are in the verses' own file time — the same domain as player.verseTime().ms — so a
// position is: the lengths of the earlier verses + the time inside the current one.

const loaded = new Map(); // reciter -> {ch -> {list, starts, total}} | null
const pending = new Map();

function parse(j, reciter) {
  if (!j || j.reciter !== reciter || j.unit !== "ms" || !j.chapters || typeof j.chapters !== "object") return null;
  const out = new Map();
  for (const [ch, list] of Object.entries(j.chapters)) {
    if (!Array.isArray(list) || !list.every((x) => Number.isFinite(x) && x >= 0)) continue;
    const starts = [];
    let t = 0;
    for (const ms of list) {
      starts.push(t);
      t += ms;
    }
    out.set(Number(ch), { list, starts, total: t });
  }
  return out.size ? out : null;
}

// Starts loading a reciter's file (once); resolves when it is there (or failed).
export function loadDurations(reciter) {
  if (loaded.has(reciter)) return Promise.resolve(loaded.get(reciter));
  if (pending.has(reciter)) return pending.get(reciter);
  const p = fetch(`data/durations/${encodeURIComponent(reciter)}.json`)
    .then((res) => (res.ok ? res.json() : null))
    .then((j) => {
      const d = parse(j, reciter);
      loaded.set(reciter, d);
      return d;
    })
    .catch(() => null) // offline: try again next time
    .finally(() => pending.delete(reciter));
  pending.set(reciter, p);
  return p;
}

const chapter = (reciter, ch) => loaded.get(reciter)?.get(ch) ?? null;

// {duration, position} of a chapter in ms, for a moment inside verse v (ms = file time), or
// null when the durations aren't loaded.
export function chapterTime(reciter, ch, v, ms) {
  const c = chapter(reciter, ch);
  if (!c || !(c.total > 0) || v < 1 || v > c.list.length) return null;
  return { duration: c.total, position: c.starts[v - 1] + Math.min(Math.max(ms, 0), c.list[v - 1]) };
}

// The verse (and the time inside it) at a chapter position in ms; null if not loaded.
export function locate(reciter, ch, positionMs) {
  const c = chapter(reciter, ch);
  if (!c || !(c.total > 0)) return null;
  const t = Math.min(Math.max(positionMs, 0), c.total - 1);
  let v = c.list.length;
  for (let i = 0; i < c.list.length; i++) {
    if (t < c.starts[i] + c.list[i]) {
      v = i + 1;
      break;
    }
  }
  while (v < c.list.length && c.list[v - 1] === 0) v++; // a verse without audio: the next one
  return { v, ms: t - c.starts[v - 1] };
}

// m:ss, or h:mm:ss for long chapters.
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
