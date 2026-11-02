// Small helpers shared by the views: DOM shortcuts, Quran structure lookups, the word
// tokenizer for the Arabic text, and a sanitiser for HTML that comes from the API.

import { CHAPTERS, PART_STARTS } from "./quran-data.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const key = ({ ch, v }) => `${ch}:${v}`;
export const verseCount = (ch) => CHAPTERS[ch - 1][3];
export const chapterName = (ch) => CHAPTERS[ch - 1][1];
export const chapterArabic = (ch) => CHAPTERS[ch - 1][2];
// Urdu-style digits, matching the Indo-Pak script of the text.
export const arDigits = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
export const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

// Creates an element: h("button.ib#play", {type: "button", "aria-label": "Play"}, child, …).
export function h(tag, attrs = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const r of rest) r[0] === "." ? el.classList.add(r.slice(1)) : (el.id = r.slice(1));
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// An icon from the sprite in index.html.
export function icon(id, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

// ---------- parts (alislam's part starts) ----------

// alislam's rule: a verse is in the last part whose start is at or before it.
export function partOf({ ch, v }) {
  let n = 1;
  PART_STARTS.forEach(([pc, pv], i) => {
    if (ch > pc || (ch === pc && v >= pv)) n = i + 1;
  });
  return n;
}

// The parts a chapter spans: [first, last].
export function chapterParts(ch) {
  return [partOf({ ch, v: 1 }), partOf({ ch, v: verseCount(ch) })];
}

export function partsLabel(ch) {
  const [a, b] = chapterParts(ch);
  return a === b ? `Part ${a}` : `Parts ${a} to ${b}`;
}

// ---------- words of the Arabic text ----------

// A word is a whitespace token of the displayed `ar` text with at least one Arabic letter;
// tokens made only of pause marks, ruku signs or the verse-end ornament are not words. The
// word timings (data/words/…) have one entry per word in this sense.
const ARABIC_LETTER = /[ء-يٮ-ۓەۺ-ۼ]/;
export const isWord = (token) => ARABIC_LETTER.test(token);

export function tokens(ar) {
  return ar.split(/\s+/).filter(Boolean);
}

// The first n words of a verse (plus any marks between them), for short previews.
export function openingWords(ar, n = 4) {
  const out = [];
  let words = 0;
  for (const t of tokens(ar)) {
    if (words >= n) break;
    if (isWord(t)) words++;
    out.push(t);
  }
  return out.join(" ");
}

// Fills `el` with the verse as one span per token. Words get class "w" and data-w (their
// index among words) so the recitation can highlight them; other tokens get class "orn". The
// last word and the ornaments after it are kept together on one line.
export function renderArabic(el, ar) {
  const list = tokens(ar);
  let lastWord = -1;
  list.forEach((t, i) => isWord(t) && (lastWord = i));
  const frag = document.createDocumentFragment();
  const tail = lastWord >= 0 && lastWord < list.length - 1 ? h("span.nw") : null;
  let w = 0;
  list.forEach((t, i) => {
    const span = document.createElement("span");
    span.textContent = t;
    if (isWord(t)) {
      span.className = "w";
      span.dataset.w = w++;
    } else span.className = "orn";
    const target = tail && i >= lastWord ? tail : frag;
    if (i > 0) (i === lastWord ? frag : target).append(" ");
    if (target === tail && i === lastWord) frag.append(tail);
    target.append(span);
  });
  el.replaceChildren(frag);
  return w; // number of words
}

// ---------- HTML from the API ----------

// API fields (translation text, notes, chapter introductions) carry a little HTML. It is
// rebuilt here from an allowlist of plain formatting tags; everything else keeps only its
// text. Nothing from the API is ever assigned to innerHTML. `marker(ref)` builds an element
// for each footnote marker placed in the text by markFootnotes().
const ALLOWED = new Set(["P", "I", "EM", "B", "STRONG", "BR", "SUP", "SUB", "UL", "OL", "LI", "H3", "H4", "BLOCKQUOTE"]);
const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "SVG", "MATH"]);
const FN_OPEN = "";
const FN_CLOSE = "";
const FN_RE = new RegExp(`${FN_OPEN}([^${FN_CLOSE}]*)${FN_CLOSE}`, "g");

export function safeHtml(html, marker) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html"); // inert: nothing runs or loads
  const frag = document.createDocumentFragment();
  const text = (s, dst) => {
    if (!marker || !s.includes(FN_OPEN)) return dst.append(s);
    let at = 0;
    for (const m of s.matchAll(FN_RE)) {
      dst.append(s.slice(at, m.index), marker(m[1]));
      at = m.index + m[0].length;
    }
    dst.append(s.slice(at));
  };
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) text(n.data, dst);
      else if (n.nodeType !== Node.ELEMENT_NODE || DROP.has(n.tagName)) continue;
      else if (ALLOWED.has(n.tagName)) {
        const e = document.createElement(n.tagName.toLowerCase());
        walk(n, e);
        dst.append(e);
      } else if (n.tagName === "SPAN" && n.classList.contains("quranic")) {
        // alislam marks Quranic Arabic inside Urdu/English notes this way.
        const e = h("span.ar-inline", { lang: "ar", dir: "rtl" });
        walk(n, e);
        dst.append(e);
      } else walk(n, dst);
    }
  };
  walk(doc.body, frag);
  return frag;
}

// Footnote markers in translation text: "[a]", "[157]", "[8A]", "[✛]". Markers with a note are
// replaced by private-use delimiters (turned into buttons by safeHtml); markers that look like
// footnotes but have no note are dropped; other bracketed text (e.g. in the Hebrew) stays.
const FOOTNOTE_LIKE = /^(\d{1,4}[A-Za-z]?|[a-z]|[✛✲*])$/;
export function markFootnotes(textHtml, notes) {
  const refs = new Set(notes.map((n) => n.ref));
  return textHtml.replace(/\[([^\[\]\s<>]{1,6})\]/g, (m, ref) => {
    if (refs.has(ref)) return `${FN_OPEN}${ref}${FN_CLOSE}`;
    return FOOTNOTE_LIKE.test(ref) ? "" : m;
  });
}

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// ---------- turning to another chapter ----------
// A short, direction-aware entrance for the chapter that just replaced the one on screen. The
// Quran reads right to left, so the next chapter comes in from the left (the page moves right,
// as when turning a mushaf's page, and as the swipe does) and the previous one from the right.
// kind: "slide" (a neighbour chosen by the person) or "fade" (recitation running on, a far
// jump). It runs after the DOM has already changed, on transform and opacity only, so it
// never delays the audio, the scroll to the verse or the word highlighting, and never moves
// the layout. Reduced motion: a slide becomes the plain fade.
const TURN_PX = 28;
export function pageTurn(el, kind, d = 1) {
  if (!el || !kind || typeof el.animate !== "function") return null;
  el.getAnimations?.().forEach((a) => a.id === "turn" && a.cancel());
  const slide = kind === "slide" && !reducedMotion.matches;
  const frames = slide
    ? [{ opacity: 0, transform: `translateX(${d > 0 ? -TURN_PX : TURN_PX}px)` }, { opacity: 1, transform: "none" }]
    : [{ opacity: 0.25 }, { opacity: 1 }];
  const anim = el.animate(frames, { duration: slide ? 260 : 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
  anim.id = "turn";
  return anim;
}
// Which turn a change of chapter gets. A hint ({to, kind, d}) set just before the change by
// whatever caused it (swipe, ⏮/⏭, "Continue to …", recitation) wins while it is fresh;
// otherwise a neighbouring chapter slides and a far one fades.
let turnHint = null;
export function hintTurn(to, kind, d) {
  turnHint = { to, kind, d, at: Date.now() };
}
export function turnFor(from, to) {
  if (!from || from === to) return null;
  const hint = turnHint;
  turnHint = null;
  if (hint && hint.to === to && Date.now() - hint.at < 1500) return { kind: hint.kind, d: hint.d ?? Math.sign(to - from) };
  return { kind: Math.abs(to - from) === 1 ? "slide" : "fade", d: Math.sign(to - from) };
}
