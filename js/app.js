// The app: shared state, routing (#/ch:v), the two modes, the player controls, and the
// lock-screen / car integration. The views live in their own modules and talk through `ctx`:
// ctx.bus events — "position" (the selected/recited verse changed; detail {source, moved}),
// "text" (Arabic arrived; detail {ch, rows}), "mode", "layers" (translation settings
// changed), "layout", "panel", "reciter".

import { Player, RECITERS, nextVerse, prevVerse } from "./player.js";
import { getChapter, TRANSLATIONS } from "./api.js";
import { prefs, savePrefs, shownTranslations } from "./prefs.js";
import { $, $$, key, clamp, verseCount, chapterName, partOf } from "./util.js";
import { WordFollower } from "./words.js";
import { VERSION, BUILD } from "./version.js";
import { loadDurations, chapterTime, locate, clock } from "./durations.js";
import { bookmarks, isBookmarked, toggleBookmark } from "./bookmarks.js";
import { chapterArtwork } from "./artwork.js";
import { initReader } from "./reader.js";
import { initListen } from "./listen.js";
import { initNav } from "./nav.js";
import { initPanel } from "./panel.js";
import { initLayout } from "./layout.js";
import { initInstall } from "./install.js";
import { initSettings, applyTheme, applyScale, applyNazira, syncRadios, arrowRadios } from "./settings.js";

const root = document.documentElement;
const player = new Player();
if (location.hostname === "127.0.0.1" || location.hostname === "localhost") window.quranPlayer = player; // for local debugging
player.reciter = prefs.reciter;

const bus = new EventTarget();
const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
let userMoveUntil = 0; // a person moved recitation: don't treat it as the verse ending
const userMoved = () => (userMoveUntil = Date.now() + 1500);

const ctx = {
  player,
  bus,
  mode: prefs.mode,
  current: { ...prefs.last },
  viewCh: 0, // chapter shown in the reader
  texts: new Map(), // ch -> Map(v -> Arabic)

  // The chapter's Arabic; onRows(rows) as batches arrive (or at once when already here).
  loadText(ch, onRows) {
    const store = (rows) => {
      const map = ctx.texts.get(ch) ?? new Map();
      ctx.texts.set(ch, map);
      for (const { v, ar } of rows) map.set(v, ar);
      onRows?.(rows);
      emit("text", { ch, rows });
    };
    const have = ctx.texts.get(ch);
    if (have?.size === verseCount(ch)) {
      const rows = [...have].map(([v, ar]) => ({ v, ar }));
      return Promise.resolve().then(() => (onRows?.(rows), rows));
    }
    return getChapter(ch, store);
  },

  // A person chose a place (navigator, search, bookmarks, Continue): show it and move
  // recitation there. It gets its own history entry, so Back returns to the previous place.
  goTo(pos, { push = true } = {}) {
    userMoved();
    setCurrent(pos, "user", true, push);
    player.playing ? player.play(pos) : player.cue(pos);
  },
  // A tap on a verse in the text: select it without jumping the view.
  select(pos) {
    userMoved();
    setCurrent(pos, "tap", key(pos) !== key(ctx.current));
    player.playing ? player.play(pos) : player.cue(pos);
  },
  togglePlay() {
    if (player.playing) return player.pause();
    ctx.reader.resetFollow();
    player.play(ctx.current);
  },
  // Previous/next verse. While paused it behaves like going there (the reader shows and
  // scrolls to it, across chapters too); while playing the recitation moves and is followed.
  step(d) {
    userMoved();
    if (player.playing) return d > 0 ? player.next() : player.previous();
    const to = d > 0 ? nextVerse(ctx.current) : prevVerse(ctx.current);
    if (to) ctx.goTo(to, { push: false });
  },
  setReciter: (id) => ctx.settings.pickReciter(id),
  live(msg) {
    const el = $("#live");
    el.textContent = "";
    requestAnimationFrame(() => (el.textContent = msg));
  },
};

function setCurrent(pos, source, moved, push = false) {
  ctx.current = { ch: pos.ch, v: pos.v };
  prefs.last = ctx.current;
  prefs.chLast[pos.ch] = pos.v;
  savePrefs();
  setHash(pos, push);
  emit("position", { source, moved });
}

// ---------- routing: #/2 or #/2:255 ----------
function parseHash() {
  const m = location.hash.match(/^#\/(\d{1,3})(?::(\d{1,3}))?$/);
  if (!m) return null;
  const ch = Number(m[1]);
  if (ch < 1 || ch > 114) return null;
  return { ch, v: clamp(Number(m[2] || 1), 1, verseCount(ch)) };
}
// Recitation moving on replaces the entry; a person's navigation pushes a new one.
function setHash(pos, push = false) {
  const h = `#/${key(pos)}`;
  if (location.hash !== h) push ? history.pushState(null, "", h) : history.replaceState(null, "", h);
}
// A link followed while recitation plays shows that place without moving the recitation (the
// Now playing card leads back); otherwise it moves there.
window.addEventListener("hashchange", () => {
  const pos = parseHash();
  if (!pos || key(pos) === key(ctx.current)) return;
  if (!player.playing) return ctx.goTo(pos);
  if (ctx.mode === "read") ctx.reader.view(pos);
  setHash(ctx.current);
});

// ---------- views ----------
ctx.panel = initPanel(ctx); // first: its controls are wired with the others below
ctx.reader = initReader(ctx);
ctx.listen = initListen(ctx);
ctx.nav = initNav(ctx);
ctx.install = initInstall(ctx);
ctx.settings = initSettings(ctx);
ctx.follower = new WordFollower(player, {
  targets: (pos) => [...ctx.reader.targets(pos), ...ctx.listen.targets(pos)],
  onTick: (info) => {
    ctx.listen.onTick(info);
    ctx.panel.onTick(info);
    ctx.reader.onTick(info);
    if (key(info.pos) === key(ctx.current)) renderProgress(info.fraction);
  },
});
ctx.follower.enabled = prefs.followWords;
ctx.layout = initLayout(ctx);

// ---------- modes ----------
const modeGroups = $$(".modes");
function setMode(mode) {
  ctx.mode = mode;
  prefs.mode = mode;
  savePrefs();
  root.dataset.mode = mode;
  for (const g of modeGroups) syncRadios(g, (b) => b.dataset.mode === mode);
  $("#reader").hidden = mode !== "read";
  placePlayer();
  emit("mode");
  ctx.follower.refresh();
}
// ---------- the player: one component, three arrangements ----------
// mini (phone, Read: one row; tapping the info opens Listen), compact (Read from 600px, and
// phone landscape Listen: a docked bar, the seekbar under the transport), expanded (Listen:
// Now Playing under the Arabic). The same elements in the same order every time; CSS places
// them, always with ▶ on the player's center line.
const playerEl = $("#player");
const landscape = matchMedia("(max-height: 499px) and (min-width: 640px)");
function placePlayer() {
  const variant = ctx.mode === "listen" ? (landscape.matches ? "compact" : "expanded") : window.innerWidth < 600 ? "mini" : "compact";
  if (playerEl.dataset.variant !== variant) {
    playerEl.dataset.variant = variant;
    for (const v of ["mini", "compact", "expanded"]) playerEl.classList.toggle(v, v === variant);
  }
}
window.addEventListener("resize", placePlayer);
landscape.addEventListener("change", placePlayer);
// The info area: on the mini bar it opens Now Playing (Listen); elsewhere, the navigator.
$("[data-info]", playerEl).addEventListener("click", () => {
  if (playerEl.dataset.variant === "mini") setMode("listen");
  else ctx.nav.open();
});
// Repeat this verse: a toggle in the transport row.
const repeatBtn = $("#qp-repeat");
const renderRepeat = () => repeatBtn.setAttribute("aria-pressed", String(prefs.repeat));
repeatBtn.addEventListener("click", () => {
  prefs.repeat = !prefs.repeat;
  savePrefs();
  renderRepeat();
  ctx.live(prefs.repeat ? "Repeating this verse." : "Repeat off.");
});
renderRepeat();
// The chapter card as the player's thumbnail.
const artImg = $(".qp-art", playerEl);
let artFor = 0;
function renderArt() {
  const ch = ctx.current.ch;
  if (artFor === ch) return;
  artFor = ch;
  chapterArtwork(ch).then(
    (list) => {
      if (ctx.current.ch !== ch || !list.length) return;
      artImg.src = list[0].src; // the 96px card
      artImg.hidden = false;
    },
    () => {},
  );
}

for (const g of modeGroups) {
  arrowRadios(g);
  for (const b of $$("[role=radio]", g)) b.addEventListener("click", () => b.dataset.mode !== ctx.mode && setMode(b.dataset.mode));
}

// ---------- player controls ----------
for (const b of $$("[data-play]")) b.addEventListener("click", () => ctx.togglePlay());
// ⏮ ⏭ work like a music player's, on every player: the chapter is the track.
for (const b of $$("[data-prev]")) b.addEventListener("click", () => ctx.chapterStep(-1));
for (const b of $$("[data-next]")) b.addEventListener("click", () => ctx.chapterStep(1));
// The seekbars, like a normal player's: drag the thumb (mouse or touch) — the time label
// follows live, and the seek happens on release; a tap or click seeks at once. Keyboard: a
// slider, ←/→ ∓/±10 s, Page Down/Up ∓/±60 s, Home/End the chapter's start/end.
let scrubbing = null; // {bar, f} while a bar is being dragged
function showScrub(bar, f) {
  const ct = chapterTime(player.reciter, ctx.current.ch, 1, 0);
  const pct = `${f * 100}%`;
  bar.firstChild.style.width = pct;
  const d = bar.querySelector(".d");
  if (d) d.style.left = pct;
  if (ct) for (const el of $$("[data-pel]")) el.textContent = clock(f * ct.duration);
}
for (const bar of $$("[data-seek]")) {
  const fAt = (x) => {
    const r = bar.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1);
  };
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      bar.setPointerCapture(e.pointerId); // keep the drag even off the bar
    } catch {}
    scrubbing = { bar, f: fAt(e.clientX) };
    bar.classList.add("dragging");
    showScrub(bar, scrubbing.f);
  });
  bar.addEventListener("pointermove", (e) => {
    if (scrubbing?.bar !== bar) return;
    scrubbing.f = fAt(e.clientX);
    showScrub(bar, scrubbing.f);
  });
  const release = (e) => {
    if (scrubbing?.bar !== bar) return;
    const f = e.type === "pointercancel" ? null : scrubbing.f;
    scrubbing = null;
    bar.classList.remove("dragging");
    if (f != null) seekChapterFraction(f);
    else renderProgress();
  };
  bar.addEventListener("pointerup", release);
  bar.addEventListener("pointercancel", release);
  bar.tabIndex = 0;
  bar.addEventListener("keydown", (e) => {
    const ct = nowInChapter();
    if (!ct) {
      // No durations yet: verse steps.
      const { ch, v } = ctx.current;
      const n = verseCount(ch);
      const to = { ArrowLeft: v - 1, ArrowDown: v - 1, ArrowRight: v + 1, ArrowUp: v + 1, PageDown: v - 10, PageUp: v + 10, Home: 1, End: n }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (clamp(to, 1, n) !== v) ctx.goTo({ ch, v: clamp(to, 1, n) }, { push: false });
      return;
    }
    const step = { ArrowLeft: -10000, ArrowDown: -10000, ArrowRight: 10000, ArrowUp: 10000, PageDown: -60000, PageUp: 60000 }[e.key];
    const to = e.key === "Home" ? 0 : e.key === "End" ? ct.duration - 1 : step != null ? ct.position + step : null;
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    seekChapterFraction(clamp(to / ct.duration, 0, 1));
  });
}
const reciterName = () => RECITERS.find((r) => r.id === player.reciter)?.name ?? "";

// ---------- the chapter as one track ----------
// The progress bars, the time shown and the lock screen/car all follow the whole chapter: the
// verses' file lengths (data/durations) laid end to end. Until those are loaded, by verse.
player.timeline = (seg, ms) => chapterTime(player.reciter, seg.ch, seg.v, ms);
const loadTimeline = () => loadDurations(player.reciter).then(() => renderProgress());
loadTimeline();
bus.addEventListener("reciter", loadTimeline);

// Where the chapter is now: {duration, position} in ms, or null.
function nowInChapter() {
  const { ch, v } = ctx.current;
  const vt = player.verseTime();
  const ms = vt && vt.ch === ch && vt.v === v ? vt.ms : 0;
  return chapterTime(player.reciter, ch, v, ms);
}

// Go to a point of the current chapter: the verse there, and the moment inside it when that
// verse is already loaded. Without durations: the verse at that share of the verses.
function seekChapterFraction(f) {
  const { ch } = ctx.current;
  const ct = chapterTime(player.reciter, ch, 1, 0);
  const at = ct ? locate(player.reciter, ch, f * ct.duration) : null;
  const n = verseCount(ch);
  const pos = { ch, v: at ? at.v : clamp(Math.floor(f * n) + 1, 1, n) };
  userMoved();
  if (player.started) {
    player.seekTo(pos, at ? at.ms : 0); // exact moment when that verse is loaded
    if (!player.playing && ctx.mode === "read") ctx.reader.showChapter(pos.ch, pos.v);
  } else ctx.goTo(pos, { push: false });
}

// Previous/next chapter: previous restarts the chapter when more than 3 s in, as music players
// do. The same for the in-app ⏮ ⏭, the lock screen and the car.
ctx.chapterStep = (d) => {
  const { ch } = ctx.current;
  if (d < 0) {
    const ct = nowInChapter();
    const inMs = ct ? ct.position : ctx.current.v > 1 ? Infinity : 0;
    if (inMs > 3000) {
      userMoved();
      if (player.started) player.seekTo({ ch, v: 1 }, 0);
      else ctx.goTo({ ch, v: 1 }, { push: false });
      if (!player.playing && ctx.mode === "read") ctx.reader.showChapter(ch, 1);
      return;
    }
  }
  const to = ch + (d < 0 ? -1 : 1);
  if (to < 1 || to > 114) return;
  userMoved();
  ctx.goTo({ ch: to, v: 1 }, { push: false });
};

function renderProgress(fraction = 0) {
  const { ch, v } = ctx.current;
  const n = verseCount(ch);
  const ct = nowInChapter();
  const pct = `${clamp(ct ? (ct.position / ct.duration) * 100 : ((v - 1 + fraction) / n) * 100, 0, 100)}%`;
  if (scrubbing) return; // the drag shows its own position
  for (const el of $$("[data-pel]")) el.textContent = ct ? clock(ct.position) : "";
  for (const el of $$("[data-ptot]")) el.textContent = ct ? clock(ct.duration) : "";
  for (const bar of $$("[data-seek]")) {
    if (ct) {
      const now = Math.round(ct.position / 1000);
      if (bar.getAttribute("aria-valuenow") !== String(now) || bar.getAttribute("aria-valuemin") !== "0" || !bar.getAttribute("aria-valuetext")?.startsWith(`Verse ${v} `)) {
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", Math.round(ct.duration / 1000));
        bar.setAttribute("aria-valuenow", now);
        bar.setAttribute("aria-valuetext", `Verse ${v} of ${n}, ${clock(ct.position)} of ${clock(ct.duration)}`);
      }
    } else {
      bar.setAttribute("aria-valuemin", "1");
      bar.setAttribute("aria-valuemax", n);
      bar.setAttribute("aria-valuenow", v);
      bar.setAttribute("aria-valuetext", `Verse ${v} of ${n}`);
    }
  }
  for (const bar of $$("[data-prog]")) {
    bar.firstChild.style.width = pct;
    const d = bar.querySelector(".d");
    if (d) d.style.left = pct;
  }
  // The play button's ring shows the same chapter progress as the seekbar.
  root.style.setProperty("--ring", pct);
}

function renderNow() {
  const { ch, v } = ctx.current;
  const n = verseCount(ch);
  $("#where-t").textContent = chapterName(ch);
  $("#where-s").replaceChildren(`Chapter ${ch}, Part ${partOf(ctx.current)}`, translationKey());
  document.title = `${chapterName(ch)} ${ch}:${v} — Holy Quran`;
  // The player's label: the chapter, then "Verse 18 of 84 · reciter" (short on narrow bars).
  for (const el of $$("[data-now-name]")) el.textContent = chapterName(ch);
  for (const el of $$("[data-now-sub]")) el.textContent = `Verse ${v} of ${n} · ${reciterName()}`;
  for (const el of $$("[data-now-short]")) el.textContent = `${v}/${n} · ${reciterName()}`;
  $("[data-info]", playerEl).setAttribute("aria-label", `${chapterName(ch)}, verse ${v} of ${n}, ${reciterName()}. ${playerEl.dataset.variant === "mini" ? "Open Now Playing" : "Go to another verse"}`);
  renderArt();
  for (const b of $$("[data-prev]")) b.disabled = ch === 1 && v === 1;
  for (const b of $$("[data-next]")) b.disabled = ch === 114;
  renderProgress(0);
  renderTransport();
}

// The header's key to the translation colors: " · ■ Sher Ali ■ Mirza Tahir Ahmad".
function translationKey() {
  const ids = prefs.nazira ? [] : shownTranslations().slice(0, 3);
  const key = document.createElement("span");
  key.className = "tkey";
  if (!ids.length) return key;
  key.append(" ·");
  for (const id of ids) {
    const i = document.createElement("i");
    i.setAttribute("aria-hidden", "true");
    key.append(i, TRANSLATIONS.find((t) => t.id === id).short);
  }
  return key;
}
bus.addEventListener("layers", () => renderNow());

function renderTransport() {
  const playing = player.playing;
  const started = playing || player.started;
  root.toggleAttribute("data-playing", playing && !player.buffering && !audioError);
  root.toggleAttribute("data-buffering", playing && player.buffering);
  root.toggleAttribute("data-started", started);
  for (const u of $$("[data-play-use]")) u.setAttribute("href", playing ? "#i-pause" : "#i-play");
  for (const b of $$("[data-play]")) b.setAttribute("aria-label", playing ? "Pause" : "Play");
}

player.addEventListener("state", renderTransport);

// ---------- when recitation can't be heard ----------
// The player keeps retrying by itself (it must survive a car's patchy signal with the screen
// off), but the screen says truthfully when nothing is audible: after a while buffering —
// sooner when offline — it shows "Recitation unavailable" with Try again. Back online, it
// restarts on its own. Display only: audio never waits on these timers.
let audioError = false;
let stallTimer = 0;
function setAudioError(on) {
  if (on === audioError) return;
  audioError = on;
  root.toggleAttribute("data-audio-error", on);
  for (const el of $$("[data-perr]")) el.hidden = !on;
  if (on) ctx.live("Recitation unavailable. Check your connection, then try again.");
  renderTransport();
}
function watchAudio() {
  clearTimeout(stallTimer);
  if (player.playing && player.buffering) {
    if (player.loadError || !navigator.onLine) return setAudioError(true); // a fetch failed: say so now
    stallTimer = setTimeout(() => setAudioError(true), 15000);
  } else setAudioError(false); // audible again, or paused
}
function retryAudio() {
  setAudioError(false);
  player.pause();
  player.cue(ctx.current); // a fresh stream from the current verse
  player.play(ctx.current);
}
player.addEventListener("state", watchAudio);
for (const b of $$("[data-retry]")) b.addEventListener("click", retryAudio);
window.addEventListener("online", () => audioError && retryAudio());
window.addEventListener("offline", () => watchAudio());
bus.addEventListener("position", renderNow);
bus.addEventListener("reciter", renderNow);

// The recited verse changed (or a cue was confirmed).
// Repeat: when a verse ends by itself, the player goes back to its start.
player.shouldRepeat = (from, to) => prefs.repeat && Date.now() > userMoveUntil && key(to) === key(nextVerse(from) ?? {});
player.addEventListener("verse", (e) => {
  const pos = e.detail;
  const moved = key(pos) !== key(ctx.current);
  if (moved || !player.playing) ctx.follower.clear();
  setCurrent(pos, "player", moved);
  // Where listening is, for "Continue listening".
  if (player.playing) {
    prefs.resume = { ...pos, reciter: player.reciter };
    savePrefs();
    emit("resume");
  }
  // Have the next chapter's text ready before recitation reaches it.
  if (pos.ch < 114 && pos.v > verseCount(pos.ch) * 0.8) ctx.loadText(pos.ch + 1).catch(() => {});
});

// Listen: bookmark the verse being recited.
const lpBookmark = $("#qp-bookmark");
function renderBookmark() {
  const on = isBookmarked(ctx.current);
  lpBookmark.setAttribute("aria-pressed", String(on));
  lpBookmark.setAttribute("aria-label", on ? `Remove bookmark, verse ${ctx.current.v}` : `Bookmark verse ${ctx.current.v}`);
  lpBookmark.querySelector("use").setAttribute("href", on ? "#i-bookmark" : "#i-bookmark-o");
}
lpBookmark.addEventListener("click", () => {
  const on = toggleBookmark(ctx.current);
  ctx.live(on ? `Bookmarked ${chapterName(ctx.current.ch)} ${key(ctx.current)}.` : "Bookmark removed.");
});
bus.addEventListener("position", renderBookmark);
bookmarks.addEventListener("change", renderBookmark);

// ---------- lock screen and car ----------
const artwork = new Map(); // ch -> artwork list, once drawn
// One track per chapter: the details change only with the chapter (or reciter), never per
// verse — the player leaves the metadata alone when they are the same.
player.describe = ({ ch }, reciter) => ({
  title: chapterName(ch),
  artist: reciter,
  album: "Holy Quran",
  artwork: artwork.get(ch) || [192, 512].map((s) => ({ src: new URL(`icons/icon-${s}.png`, location.href).href, sizes: `${s}x${s}`, type: "image/png" })),
});
// The chapter card is drawn before it's needed — the next chapter's while recitation nears
// the end of this one — so crossing into a chapter changes the metadata exactly once.
function prepareArtwork(ch) {
  if (ch < 1 || ch > 114 || artwork.has(ch) || !("mediaSession" in navigator)) return;
  artwork.set(ch, null); // being drawn
  chapterArtwork(ch).then(
    (list) => {
      if (!list.length) return artwork.delete(ch);
      artwork.set(ch, list);
      for (const k of artwork.keys()) if (k !== ch && k !== ctx.current.ch && k !== ctx.current.ch + 1) artwork.delete(k);
      if (ctx.current.ch === ch) player.refreshMetadata();
    },
    () => artwork.delete(ch),
  );
}
bus.addEventListener("position", () => {
  const { ch, v } = ctx.current;
  prepareArtwork(ch);
  if (v > verseCount(ch) * 0.8 || verseCount(ch) - v < 3) prepareArtwork(ch + 1);
});
if ("mediaSession" in navigator) {
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {}
  };
  // Track buttons move by chapter (the track), as the in-app ⏮ ⏭ do.
  set("nexttrack", () => ctx.chapterStep(1));
  set("previoustrack", () => ctx.chapterStep(-1));
  // Scrubbing the lock-screen/car bar: that point of the chapter.
  set("seekto", (d) => {
    const ct = nowInChapter();
    if (ct && Number.isFinite(d?.seekTime)) seekChapterFraction(clamp((d.seekTime * 1000) / ct.duration, 0, 1));
  });
  // No ±seek buttons anywhere: the controls are previous/next chapter and the seekbar.
  set("seekforward", null);
  set("seekbackward", null);
}

// How the person is interacting: a tap or click hides focus rings that a keyboard shows.
window.addEventListener("pointerdown", () => root.setAttribute("data-pointer", ""), { capture: true, passive: true });
window.addEventListener("keydown", (e) => !e.metaKey && !e.ctrlKey && root.removeAttribute("data-pointer"), { capture: true });

// ---------- keyboard shortcuts sheet ----------
const keysSheet = $("#keys-sheet");
keysSheet.append(Object.assign(document.createElement("p"), { className: "version", textContent: `Version ${VERSION} · build ${BUILD}` }));
ctx.showKeys = () => keysSheet.showModal();
keysSheet.addEventListener("click", (e) => {
  if (e.target === keysSheet || e.target.closest("[data-close]")) keysSheet.close();
});

// A divider under the top bar once the text scrolls beneath it; in Focus the bar comes back
// when the mouse moves or the page scrolls up.
let lastY = 0;
let revealTimer = 0;
const reveal = () => {
  root.setAttribute("data-reveal", "");
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => root.removeAttribute("data-reveal"), 2500);
};
window.addEventListener(
  "scroll",
  () => {
    root.toggleAttribute("data-scrolled", window.scrollY > 4);
    if (window.scrollY < lastY - 4) reveal();
    lastY = window.scrollY;
  },
  { passive: true },
);
window.addEventListener("mousemove", () => root.hasAttribute("data-focus") && reveal(), { passive: true });

// ---------- start ----------
applyTheme();
applyScale();
applyNazira();
ctx.current = { ...(parseHash() ?? prefs.last) };
setHash(ctx.current);
setMode(prefs.mode);
ctx.reader.showChapter(ctx.current.ch, ctx.current.v);
player.cue(ctx.current);
renderNow();
renderBookmark();
ctx.layout.apply();

// ---------- updates ----------
// A new deploy installs its service worker in the background (sw.js: skipWaiting + claim).
// The page then reloads into it — but recitation never breaks for it: only when nothing is
// playing (or buffering, or between chunks), and after something was played in this session,
// only once it has been paused for 2 minutes, or the app goes to the background or is
// reopened while paused, or recitation has reached its end. Never while a sheet or dialog is
// open or a row is being dragged. One reload per update; afterwards a quiet toast says so.
const localDev = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const UPDATE_AFTER_PAUSE_MS = 2 * 60 * 1000;
let updateWaiting = false;
let updating = false;
let everPlayed = false;
let pausedSince = 0;

function updateIsSafe(reason) {
  if (!updateWaiting || updating) return false;
  if (player.playing || player.buffering || player.backend?.switching) return false;
  if (document.querySelector("dialog[open], .r.dragging, .grip[aria-pressed='true']")) return false;
  if (!everPlayed) return true;
  if (reason === "hidden" || reason === "visible" || reason === "ended") return true;
  return pausedSince > 0 && Date.now() - pausedSince >= UPDATE_AFTER_PAUSE_MS;
}
function applyUpdate(reason) {
  if (!updateIsSafe(reason)) return;
  updating = true;
  try {
    sessionStorage.setItem("quran.updated", "1");
  } catch {}
  location.reload();
}
player.addEventListener("state", () => {
  if (player.playing) {
    everPlayed = true;
    pausedSince = 0;
  } else if (everPlayed && !pausedSince) pausedSince = Date.now();
});
player.audio.addEventListener("ended", () => setTimeout(() => !player.playing && applyUpdate("ended"), 500));
document.addEventListener("visibilitychange", () => applyUpdate(document.visibilityState === "visible" ? "visible" : "hidden"));
// While an update waits: look again now and then (a sheet closed, the 2 minutes passed).
setInterval(() => updateWaiting && applyUpdate("timer"), 15000);

if ("serviceWorker" in navigator && (location.protocol === "https:" || localDev)) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(
    (reg) => {
      const check = () => reg.update().catch(() => {});
      check();
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
      setInterval(check, 60 * 60 * 1000);
    },
    () => {},
  );
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // the first install taking control is not an update
    updateWaiting = true;
    applyUpdate("controllerchange");
  });
}

// After an update reload: "Updated to version x.y.z" (the newly loaded code's), once, quietly.
try {
  if (sessionStorage.getItem("quran.updated")) {
    sessionStorage.removeItem("quran.updated");
    const toast = document.createElement("p");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.textContent = `Updated to version ${VERSION}`;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3200);
  }
} catch {}
