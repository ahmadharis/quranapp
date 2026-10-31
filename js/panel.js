// The side panel from 1280px (Read mode only): the meaning of the word being recited (when
// word timings and meanings exist) and the chapter introduction from GET /chapter/intro/{ch}.
// Each section shows only when it has something to show; the player stays in the bottom dock.

import { getIntro, getLayers } from "./api.js";
import { hasWordTimings } from "./words.js";
import { prefs } from "./prefs.js";
import { $, h, key, verseCount, chapterName, partsLabel, tokens, isWord, safeHtml } from "./util.js";

export function initPanel(ctx) {
  const side = $("#side");
  const { player } = ctx;
  let introFor = 0;
  let introOk = false;
  let glossFor = "";
  let glosses = null; // Map(v -> [gloss per token])
  let wordShown = "";

  // Current word
  const cw = h("section.sp-sec.cw", { hidden: true, "aria-labelledby": "cw-h" }, h("h2#cw-h", { text: "Current word" }), h("div.cw-card", {}, h("span.ar.cw-ar", { lang: "ar", dir: "rtl" }), h("span.cw-g")), h("p.by"));
  // About this chapter
  const about = h(
    "section.sp-sec.about",
    { hidden: true, "aria-labelledby": "ab-h" },
    h("h2#ab-h", { text: "About this chapter" }),
    h("dl.facts"),
    h("div.intro", { lang: "en" }),
    h("button.link.more-intro", { type: "button", "aria-expanded": "false", text: "Read more" }),
  );
  side.append(cw, about);
  $(".more-intro", about).addEventListener("click", (e) => {
    const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
    e.currentTarget.setAttribute("aria-expanded", String(open));
    e.currentTarget.textContent = open ? "Show less" : "Read more";
    about.classList.toggle("open", open);
  });

  const wanted = () => ["laptop", "wide", "ultra"].includes(document.documentElement.dataset.bp) && ctx.mode === "read";

  function renderAbout() {
    const ch = ctx.current.ch;
    if (!wanted() || introFor === ch) return;
    introFor = ch;
    introOk = false;
    about.hidden = true;
    const facts = $(".facts", about);
    const n = verseCount(ch);
    facts.replaceChildren(
      h("dt", { text: "Chapter" }),
      h("dd", { text: `${ch}, ${chapterName(ch)}` }),
      h("dt", { text: "Verses" }),
      h("dd", { text: ch === 9 ? String(n) : `${n}, counting the Bismillah` }),
      h("dt", { text: "Parts" }),
      h("dd", { text: partsLabel(ch).replace(/^Parts? /, "") }),
    );
    getIntro(ch).then(
      (intro) => {
        if (introFor !== ch) return;
        $(".intro", about).replaceChildren(safeHtml(intro.en));
        about.classList.remove("open");
        const btn = $(".more-intro", about);
        btn.setAttribute("aria-expanded", "false");
        btn.textContent = "Read more";
        introOk = true;
        about.hidden = false;
        requestAnimationFrame(() => (btn.hidden = $(".intro", about).scrollHeight <= $(".intro", about).clientHeight + 4));
        ctx.bus.dispatchEvent(new Event("panel"));
      },
      () => {
        if (introFor === ch) introFor = 0; // try again later
        ctx.bus.dispatchEvent(new Event("panel"));
      },
    );
  }

  // The word lens: gloss for the word being recited, in the chosen word-meaning language
  // (English when word meanings are off).
  function glossLayer() {
    return prefs.wordMeanings === "words-ur" ? "words-ur" : "words-en";
  }
  function loadGlosses() {
    const ch = ctx.current.ch;
    const k = `${glossLayer()}:${ch}`;
    // Only when it can be used: the panel is showing and this reciter has word timings.
    const showing = document.documentElement.hasAttribute("data-panel");
    if (!wanted() || !showing || !hasWordTimings(ctx.player.reciter) || glossFor === k) return;
    glossFor = k;
    glosses = null;
    getLayers(ch, [glossLayer()]).then(
      (m) => glossFor === k && (glosses = m.get(glossLayer())),
      () => glossFor === k && (glossFor = ""),
    );
  }

  function onTick({ pos, word }) {
    if (!wanted()) return;
    const ar = ctx.texts.get(pos.ch)?.get(pos.v);
    if (word == null || word < 0 || !ar || key(pos) !== key(ctx.current)) return;
    const k = `${key(pos)}/${word}/${glossLayer()}`;
    if (k === wordShown) return;
    // Token index of word number `word`.
    const toks = tokens(ar);
    let w = -1;
    const ti = toks.findIndex((t) => isWord(t) && ++w === word);
    const gloss = glosses?.get(pos.v)?.[ti];
    if (!gloss) return;
    wordShown = k;
    $(".cw-ar", cw).textContent = toks[ti];
    const g = $(".cw-g", cw);
    g.textContent = gloss;
    const ur = glossLayer() === "words-ur";
    g.lang = ur ? "ur" : "en";
    g.dir = ur ? "rtl" : "ltr";
    g.classList.toggle("urdu", ur);
    $(".by", cw).textContent = ur ? "Word meaning: Hazrat Mir Muhammad Ishaq ra" : "Word meaning: Maulawi Sher Ali";
    if (cw.hidden) {
      cw.hidden = false;
      ctx.bus.dispatchEvent(new Event("panel"));
    }
  }

  function refresh() {
    renderAbout();
    loadGlosses();
  }
  ctx.bus.addEventListener("position", (e) => {
    if (e.detail.moved !== false) {
      cw.hidden = true;
      wordShown = "";
    }
    refresh();
  });
  ctx.bus.addEventListener("layout", refresh);
  // The panel just appeared (its layout runs after this listener): load what it needs.
  ctx.bus.addEventListener("panel", () => requestAnimationFrame(loadGlosses));
  ctx.bus.addEventListener("reciter", () => {
    glossFor = "";
    loadGlosses();
  });
  ctx.bus.addEventListener("layers", () => {
    glossFor = "";
    wordShown = "";
    loadGlosses();
  });

  return {
    onTick,
    hasContent: () => !cw.hidden || introOk,
    refresh,
  };
}
