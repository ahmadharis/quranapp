// Read mode: the chapter's text, verse by verse, with optional translations and word meanings.
// Tapping a verse selects it (and moves recitation there if it is playing). While recitation
// plays the reader follows it, pausing for a while after the person scrolls themselves.

import { PART_STARTS, PART_QUARTERS, PART_HALVES, PART_THREE_QUARTERS } from "./quran-data.js";
import { getLayers, TRANSLATIONS } from "./api.js";
import { prefs, savePrefs, shownTranslations } from "./prefs.js";
import { isBookmarked, toggleBookmark, bookmarks } from "./bookmarks.js";
import { $, $$, h, icon, key, verseCount, chapterName, chapterArabic, arDigits, renderArabic, tokens, safeHtml, markFootnotes, reducedMotion } from "./util.js";

// alislam's part, quarter, half and ثلث points.
const MARKERS = new Map();
PART_STARTS.forEach(([ch, v], i) => MARKERS.set(`${ch}:${v}`, { label: `Part ${i + 1}`, ar: `الجزء ${arDigits(i + 1)}`, part: true }));
PART_QUARTERS.forEach(([ch, v]) => MARKERS.set(`${ch}:${v}`, { label: "Quarter", ar: "ربع" }));
PART_HALVES.forEach(([ch, v]) => MARKERS.set(`${ch}:${v}`, { label: "Half", ar: "النصف" }));
PART_THREE_QUARTERS.forEach(([ch, v]) => MARKERS.set(`${ch}:${v}`, { label: "Three quarters", ar: "ثلث" }));

const FOLLOW_PAUSE_MS = 8000;
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);

export const translationInfo = (id) => TRANSLATIONS.find((t) => t.id === id);

// One translation of one verse: its text with footnote buttons, and the notes (hidden until a
// footnote is opened). All API HTML goes through safeHtml.
export function translationBlock(id, value) {
  const info = translationInfo(id);
  const box = h(`div.tr.${info.script}`, { "data-t": id, lang: info.htmlLang, dir: info.script === "urdu" || info.script === "rtl" ? "rtl" : null });
  if (!value) return box;
  const notes = value.notes ?? [];
  const noteBox = h("div.tr-notes", { hidden: true });
  const p = h("p.tr-text");
  p.append(
    safeHtml(markFootnotes(value.text, notes), (ref) => {
      const b = h("button.fn", { type: "button", "aria-expanded": "false", "aria-label": `Note ${ref}`, text: ref });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = b.getAttribute("aria-expanded") !== "true";
        b.setAttribute("aria-expanded", String(open));
        let n = [...noteBox.children].find((c) => c.dataset.ref === ref);
        if (!n) {
          const note = notes.find((x) => x.ref === ref);
          n = h("div.note", { "data-ref": ref }, h("span.note-ref", { text: ref }), h("div.note-body", {}, safeHtml(note?.note ?? "")));
          noteBox.append(n);
        }
        n.hidden = !open;
        noteBox.hidden = ![...noteBox.children].some((c) => !c.hidden);
      });
      return b;
    }),
  );
  // Each block names its translator, as alislam does.
  box.append(p, noteBox, h("p.tr-by", { lang: "en", dir: "ltr", text: info.name }));
  return box;
}

// Word meanings for one verse: each word with its gloss, in reading order.
function meaningsBlock(ar, glosses, lang) {
  const box = h("div.wm-list", { dir: "rtl" });
  if (!glosses) return box;
  tokens(ar).forEach((t, i) => {
    const g = glosses[i];
    if (!g) return;
    box.append(h("span.wm", {}, h("span.ar", { lang: "ar", text: t }), h(`span.g.${lang}`, { lang: lang === "ur" ? "ur" : "en", dir: lang === "ur" ? "rtl" : "ltr", text: g })));
  });
  return box;
}

export function initReader(ctx) {
  const { player } = ctx;
  const reader = $("#reader");
  const topbar = $("#topbar");
  const chip = $("#follow-chip");
  let lastUserScroll = 0;
  let layerRun = 0;

  const verseEl = (v) => reader.querySelector(`.verse[data-v="${v}"]`);

  function legend(ids) {
    const box = h("div.legend");
    if (!ids.length) return box;
    box.append(
      h(
        "div.lg-tr",
        {},
        ids.map((id) => {
          const t = translationInfo(id);
          return h("p", {}, h("b", { text: t.name }), " ", h("span", { text: t.lang }));
        }),
      ),
    );
    return box;
  }

  function setTrAttrs() {
    const n = shownTranslations().length;
    document.documentElement.toggleAttribute("data-tr", n > 0);
    document.documentElement.dataset.trc = String(Math.min(n, 3));
  }

  function showChapter(ch, focusV) {
    if (ch === ctx.viewCh) {
      markCurrent();
      scrollToVerse(focusV, "auto");
      return;
    }
    ctx.viewCh = ch;
    const count = verseCount(ch);
    const frag = document.createDocumentFragment();
    const head = h("header.chapter-head", {}, h("h1.sura.ar", { lang: "ar", dir: "rtl", text: chapterArabic(ch) }), h("p.sr-only", { text: `${chapterName(ch)}, chapter ${ch}, ${count} verses` }));
    head.append(legend(shownTranslations()));
    frag.append(head);

    for (let v = 1; v <= count; v++) {
      const mk = ch === 1 && v === 1 ? null : MARKERS.get(`${ch}:${v}`); // the Quran's opening needs no "Part 1"
      if (mk) frag.append(h(`div.marker${mk.part ? ".part" : ""}`, {}, h("span", { text: mk.label }), h("span.ar", { lang: "ar", dir: "rtl", text: mk.ar })));
      const art = h("article.verse.loading", { "data-v": v, tabindex: "-1", "aria-label": `Verse ${v}` });
      if (v === 1 && ch !== 9) art.classList.add("bismillah");
      art.append(h("div.v-ar.ar", { lang: "ar", dir: "rtl" }), h("div.v-tr"), h("div.v-wm"));
      frag.append(art);
    }
    if (ch < 114) {
      frag.append(h("div.chapter-end", {}, h("button.next-chapter", { type: "button", text: `Continue to ${chapterName(ch + 1)}`, onclick: () => ctx.goTo({ ch: ch + 1, v: 1 }) })));
    }
    bar.hidden = true;
    barArt = null;
    reader.replaceChildren(frag);
    if (!prefs.hintSeen) head.before(firstHint());
    setTrAttrs();
    window.scrollTo({ top: 0 });
    markCurrent();
    loadText(ch, focusV);
    loadLayers(ch);
  }

  function fill(ch, rows) {
    if (ch !== ctx.viewCh) return;
    for (const { v, ar } of rows) {
      const art = verseEl(v);
      if (art?.classList.contains("loading")) {
        renderArabic($(".v-ar", art), ar);
        art.classList.remove("loading");
      }
    }
    ctx.follower.refresh();
  }

  function loadText(ch, focusV) {
    const loadStarted = Date.now();
    let scrolled = false;
    if (focusV > 1) scrollToVerse(focusV, "auto"); // placeholders hold the layout meanwhile
    ctx
      .loadText(ch, (rows) => {
        fill(ch, rows);
        if (!scrolled && ch === ctx.viewCh && focusV > 1 && ctx.texts.get(ch)?.has(focusV)) {
          scrolled = true;
          scrollToVerse(focusV, "auto");
        }
      })
      .then(() => {
        // Verses above the target may have filled in after it and pushed it down.
        if (ch === ctx.viewCh && focusV > 1 && lastUserScroll < loadStarted) scrollToVerse(focusV, "auto");
      })
      .catch(() => {
        if (ch !== ctx.viewCh || $(".load-error", reader)) return;
        const retry = () => {
          ctx.viewCh = 0;
          showChapter(ch, focusV);
        };
        const box = h("div.load-error", { role: "alert" }, h("p", { text: "Couldn't load this chapter. Check your connection." }), h("button", { type: "button", text: "Try again", onclick: retry }));
        box.retry = retry;
        $(".chapter-head", reader).after(box);
        ctx.live("Couldn't load this chapter. Check your connection.");
      });
  }

  // Translations and word meanings for the chapter on screen. Re-run when settings change.
  function loadLayers(ch) {
    const run = ++layerRun;
    const ids = prefs.nazira ? [] : shownTranslations();
    const wm = prefs.wordMeanings;
    // Placeholders in the chosen order, filled as batches arrive.
    // Blocks already on screen are kept and reordered, so switching one translation on or off
    // never blanks the others.
    for (const art of $$(".verse", reader)) {
      const box = $(".v-tr", art);
      const have = new Map([...box.children].filter((el) => !el.classList.contains("failed")).map((el) => [el.dataset.t, el]));
      box.replaceChildren(...ids.map((id) => have.get(id) ?? h(`div.tr.${translationInfo(id).script}.pending`, { "data-t": id })));
      if (wm === "off" || prefs.nazira) $(".v-wm", art).replaceChildren();
    }
    // Nazira mode shows the Arabic only: nothing to fetch (the settings stay as they are).
    const want = prefs.nazira ? [] : (wm === "off" ? ids : [...ids, wm]).filter((id) => id === wm || $$(`.v-tr .pending[data-t="${id}"]`, reader).length);
    if (!want.length) return;
    const glossCache = new Map();
    const paint = (id, batch) => {
      if (run !== layerRun || ch !== ctx.viewCh) return;
      for (const [v, value] of batch) {
        const art = verseEl(v);
        if (!art) continue;
        if (id === wm) {
          const ar = ctx.texts.get(ch)?.get(v);
          if (ar) $(".v-wm", art).replaceChildren(meaningsBlock(ar, value, wm === "words-ur" ? "ur" : "en"));
          else glossCache.set(v, value);
          continue;
        }
        const old = $(`.v-tr [data-t="${id}"]`, art);
        if (old) old.replaceWith(translationBlock(id, value));
      }
    };
    getLayers(ch, want, paint).catch(() => {
      if (run !== layerRun || ch !== ctx.viewCh) return;
      for (const el of $$(".tr.pending", reader)) {
        el.classList.remove("pending");
        el.classList.add("failed");
        el.textContent = "This translation couldn't be loaded. It will appear when you're back online.";
      }
    });
    // Glosses that arrived before their verse's Arabic.
    ctx.bus.addEventListener("text", function late(e) {
      if (run !== layerRun) return ctx.bus.removeEventListener("text", late);
      if (e.detail.ch !== ch) return;
      for (const { v, ar } of e.detail.rows) {
        if (glossCache.has(v)) {
          $(".v-wm", verseEl(v))?.replaceChildren(meaningsBlock(ar, glossCache.get(v), wm === "words-ur" ? "ur" : "en"));
          glossCache.delete(v);
        }
      }
    });
  }

  function refreshLayers() {
    if (!ctx.viewCh) return;
    setTrAttrs();
    $(".legend", reader)?.replaceWith(legend(shownTranslations()));
    loadLayers(ctx.viewCh);
  }

  // The area between the top bar and the player.
  function viewport() {
    const dock = document.documentElement.hasAttribute("data-started") && !prefs.barCollapsed ? 96 : 84;
    return { top: topbar.getBoundingClientRect().bottom, bottom: window.innerHeight - dock };
  }

  function scrollToVerse(v, behavior = "smooth") {
    const el = verseEl(v);
    if (!el || ctx.mode !== "read") return;
    if (reducedMotion.matches) behavior = "auto";
    if (v === 1) return window.scrollTo({ top: 0, behavior });
    const r = el.getBoundingClientRect();
    const { top, bottom } = viewport();
    // A little above center; a verse taller than the space starts just under the top bar.
    const offset = Math.max(top + 8, top + (bottom - top - r.height) / 2.4);
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top - offset), behavior });
  }

  function markCurrent() {
    for (const el of $$(".verse.current", reader)) {
      el.classList.remove("current");
      el.removeAttribute("aria-current");
    }
    if (ctx.current.ch !== ctx.viewCh) return setRover(verseEl(1));
    const el = verseEl(ctx.current.v);
    el?.classList.add("current");
    el?.setAttribute("aria-current", "true");
    if (!document.activeElement?.classList?.contains("verse")) setRover(el);
  }

  // Keyboard: the verses are one tab stop (the selected verse); ↑/↓ or ←/→ move between them,
  // Home/End to the ends, Enter opens the verse's menu.
  let rover = null;
  function setRover(el) {
    if (!el || el === rover) return;
    if (rover) rover.tabIndex = -1;
    rover = el;
    rover.tabIndex = 0;
  }

  // While recitation plays, a tap only picks a verse (and shows its menu); the menu's Play moves
  // the recitation there.
  function pick(art) {
    const pos = { ch: ctx.viewCh, v: Number(art.dataset.v) };
    for (const el of $$(".verse.picked", reader)) el.classList.remove("picked");
    if (player.playing) {
      if (key(pos) !== key(ctx.current)) art.classList.add("picked");
    } else ctx.select(pos);
    setRover(art);
    if (!prefs.hintSeen) dismissHint();
  }

  // First visit: one line on how it works, shown once.
  function firstHint() {
    return h(
      "div.first-hint",
      { role: "note" },
      h("p", { text: "Tap a verse to play from it · Listen shows recitation only" }),
      h("button.ib", { type: "button", "aria-label": "Dismiss tip", onclick: dismissHint }, icon("i-close")),
    );
  }
  function dismissHint() {
    prefs.hintSeen = true;
    savePrefs();
    $(".first-hint", reader)?.remove();
  }

  // ---------- the verse bar: Play, Bookmark, Copy ----------
  // Tapping (or long-pressing) a verse selects it and shows one small bar under it, which
  // hides again when the page scrolls.
  const barPlay = h("button.vb-btn", { type: "button" }, icon("i-play"), h("span"));
  const barMark = h("button.vb-btn.mark", { type: "button" }, icon("i-bookmark-o"), h("span"));
  const barCopy = h("button.vb-btn", { type: "button" }, icon("i-copy"), h("span", { text: "Copy" }));
  const bar = h("div.vbar", { role: "toolbar", "aria-label": "Verse actions", hidden: true }, barPlay, barMark, barCopy);
  let barAt = 0;
  let barArt = null; // the verse the bar belongs to
  const barPos = () => ({ ch: ctx.viewCh, v: Number(barArt?.dataset.v) });

  function renderBar() {
    if (bar.hidden) return;
    const pos = barPos();
    const playingHere = player.playing && key(pos) === key(ctx.current);
    barPlay.querySelector("use").setAttribute("href", playingHere ? "#i-pause" : "#i-play");
    barPlay.lastChild.textContent = playingHere ? "Pause" : "Play";
    const on = isBookmarked(pos);
    barMark.classList.toggle("on", on);
    barMark.setAttribute("aria-pressed", String(on));
    barMark.querySelector("use").setAttribute("href", on ? "#i-bookmark" : "#i-bookmark-o");
    barMark.lastChild.textContent = on ? "Bookmarked" : "Bookmark";
  }
  // In Nazira mode the verses flow inline, so the bar floats under the tapped line instead of
  // breaking the text.
  function showBar(art, anchor) {
    if (barArt === art && !bar.hidden) return;
    barArt = art;
    if (prefs.nazira) {
      reader.append(bar);
      bar.classList.add("floating");
      const rects = [...(anchor ?? art).getClientRects()];
      const r = rects[rects.length - 1] ?? art.getBoundingClientRect();
      const box = reader.getBoundingClientRect();
      bar.style.top = `${r.bottom - box.top + 4}px`;
      bar.hidden = false;
      const w = bar.offsetWidth;
      bar.style.left = `${Math.max(0, Math.min(box.width - w, r.left + r.width / 2 - box.left - w / 2))}px`;
    } else {
      bar.classList.remove("floating");
      bar.style.top = bar.style.left = "";
      art.append(bar);
    }
    bar.hidden = false;
    barAt = window.scrollY;
    renderBar();
  }
  const hideBar = () => (bar.hidden = true);
  barPlay.addEventListener("click", () => {
    const pos = barPos();
    if (player.playing && key(pos) === key(ctx.current)) return player.pause();
    if (key(pos) !== key(ctx.current)) ctx.select(pos);
    if (!player.playing) ctx.togglePlay();
  });
  barMark.addEventListener("click", () => {
    const pos = barPos();
    const on = toggleBookmark(pos);
    ctx.live(on ? `Bookmarked ${chapterName(pos.ch)} ${key(pos)}.` : "Bookmark removed.");
  });
  barCopy.addEventListener("click", async () => {
    const pos = barPos();
    const art = barArt;
    const parts = [ctx.texts.get(pos.ch)?.get(pos.v) ?? ""];
    for (const tr of $$(".v-tr .tr", art)) {
      const p = $(".tr-text", tr)?.cloneNode(true);
      if (!p) continue;
      for (const fn of $$(".fn", p)) fn.remove(); // footnote buttons
      parts.push(p.textContent.replace(/\s+/g, " ").trim());
    }
    parts.push(`${chapterName(pos.ch)} ${key(pos)}`);
    try {
      await navigator.clipboard.writeText(parts.filter(Boolean).join("\n\n"));
      ctx.live("Verse copied.");
      barCopy.lastChild.textContent = "Copied";
      setTimeout(() => (barCopy.lastChild.textContent = "Copy"), 1500);
    } catch {
      ctx.live("Couldn't copy. Select the text instead.");
    }
  });
  window.addEventListener("scroll", () => !bar.hidden && Math.abs(window.scrollY - barAt) > 60 && hideBar(), { passive: true });
  player.addEventListener("state", renderBar);
  bookmarks.addEventListener("change", renderBar);
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      const art = barArt;
      hideBar();
      art?.focus();
    }
  });

  reader.addEventListener("click", (e) => {
    const art = e.target.closest(".verse");
    if (!art || art.classList.contains("loading") || e.target.closest("button, a")) return;
    if (String(window.getSelection?.() ?? "").length > 0) return; // selecting text, not choosing a verse
    pick(art);
    showBar(art, e.target.closest(".w, .orn"));
  });
  reader.addEventListener("contextmenu", (e) => {
    const art = e.target.closest(".verse");
    if (!art || art.classList.contains("loading")) return;
    pick(art);
    showBar(art);
  });
  reader.addEventListener("keydown", (e) => {
    const art = e.target.classList?.contains("verse") ? e.target : null;
    if (!art) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(art);
      showBar(art);
      barPlay.focus();
      return;
    }
    const all = $$(".verse:not(.loading)", reader);
    const i = all.indexOf(art);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined || i < 0) return;
    e.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    setRover(next);
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  });

  // Following the recitation.
  for (const ev of ["wheel", "touchmove"]) window.addEventListener(ev, () => (lastUserScroll = Date.now()), { passive: true });
  window.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key) && !e.target.closest("input, select, textarea, dialog, [role=listbox], [role=slider]")) lastUserScroll = Date.now();
  });
  chip.addEventListener("click", () => backToRecited());

  function backToRecited() {
    lastUserScroll = 0;
    chip.hidden = true;
    if (ctx.current.ch !== ctx.viewCh) showChapter(ctx.current.ch, ctx.current.v);
    scrollToVerse(ctx.current.v);
  }

  // Is the recited verse on screen? The "Back to the recited verse" chip shows when it isn't
  // (checked as the page scrolls, not only when the verse changes).
  function updateChip() {
    if (ctx.mode !== "read" || !player.playing) return (chip.hidden = true);
    const r = ctx.current.ch === ctx.viewCh ? verseEl(ctx.current.v)?.getBoundingClientRect() : null;
    const { top, bottom } = viewport();
    chip.hidden = !!r && r.bottom > top && r.top < bottom;
  }
  let chipFrame = 0;
  window.addEventListener("scroll", () => (chipFrame ||= requestAnimationFrame(() => ((chipFrame = 0), updateChip()))), { passive: true });
  player.addEventListener("state", updateChip);

  // Back online: load what failed.
  window.addEventListener("online", () => {
    $(".load-error", reader)?.retry?.();
    if ($(".tr.failed", reader)) loadLayers(ctx.viewCh);
  });

  // Show a place without moving the recitation (a link followed while it plays).
  function view(pos) {
    lastUserScroll = Date.now();
    showChapter(pos.ch, pos.v);
    updateChip();
  }

  function follow() {
    if (ctx.mode !== "read" || !player.playing) return;
    if (Date.now() - lastUserScroll < FOLLOW_PAUSE_MS) {
      const r = verseEl(ctx.current.v)?.getBoundingClientRect();
      const { top, bottom } = viewport();
      chip.hidden = ctx.current.ch === ctx.viewCh && !!r && r.bottom > top && r.top < bottom;
      return;
    }
    chip.hidden = true;
    if (ctx.current.ch !== ctx.viewCh) showChapter(ctx.current.ch, ctx.current.v);
    else scrollToVerse(ctx.current.v);
  }

  // Nazira mode: a verse can run over many lines, so keep the recited line itself in view.
  let lastLit = null;
  function onTick({ pos, word }) {
    if (!prefs.nazira || ctx.mode !== "read" || pos.ch !== ctx.viewCh || word == null || word < 0) return;
    if (Date.now() - lastUserScroll < FOLLOW_PAUSE_MS) return;
    const el = verseEl(pos.v)?.querySelector(`.w[data-w="${word}"]`);
    if (!el || el === lastLit) return;
    lastLit = el;
    const r = el.getBoundingClientRect();
    const { top, bottom } = viewport();
    if (r.top < top + 8 || r.bottom > bottom - 8) {
      const y = window.scrollY + r.top - top - (bottom - top) / 3;
      window.scrollTo({ top: Math.max(0, y), behavior: reducedMotion.matches ? "auto" : "smooth" });
    }
  }

  ctx.bus.addEventListener("position", (e) => {
    const { source, moved } = e.detail;
    if (source === "user") {
      if (ctx.mode === "read") showChapter(ctx.current.ch, ctx.current.v);
      return;
    }
    markCurrent();
    if (source === "player" && moved) follow();
  });
  ctx.bus.addEventListener("layers", refreshLayers);
  ctx.bus.addEventListener("mode", () => {
    chip.hidden = true;
    if (ctx.mode !== "read") return;
    if (ctx.current.ch !== ctx.viewCh) showChapter(ctx.current.ch, ctx.current.v);
    else markCurrent();
    requestAnimationFrame(() => scrollToVerse(ctx.current.v, "auto"));
  });
  return {
    showChapter,
    view,
    backToRecited,
    onTick,
    resetFollow: () => (lastUserScroll = 0),
    targets: (pos) => {
      const art = pos.ch === ctx.viewCh && ctx.mode === "read" ? verseEl(pos.v) : null;
      return art ? [$(".v-ar", art)] : [];
    },
  };
}
