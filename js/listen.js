// Listen mode: only the Arabic and the player.
//
// Portrait and large screens: the recited verse large, about 40% from the top, with the
// verses before and after it faint. Phone landscape (height < 500, width ≥ 640): exactly one
// line of Arabic over a big player. A verse longer than one line is never cut: it pages
// through its lines one at a time, crossfading, following the recitation — by the word
// timings when there are any, otherwise by how much of the verse has been heard.

import { prevVerse, nextVerse } from "./player.js";
import { $, $$, h, key, renderArabic, tokens, isWord, chapterArabic } from "./util.js";

export const landscapeQuery = matchMedia("(max-height: 499px) and (min-width: 640px)");

export function initListen(ctx) {
  const view = $("#listen");
  const stage = $("#stage");
  const nowEl = $("#stage-now");
  const box = $("#line-box");
  const [lineA, lineB] = $$(".lt", box);
  const dots = $("#line-dots");
  const full = $("#line-full");
  const msg = h("p.listen-msg", { role: "alert", hidden: true });
  view.prepend(msg);

  let shown = ""; // verse key on the stage
  let lines = []; // [{from, to, weight}] token ranges of the current verse, in landscape
  let lineToks = [];
  let lineWords = []; // per line: [firstWord, lastWord]
  let lineIndex = -1;
  let lineFor = "";
  let manualLine = false; // the person paged by hand while paused

  const textOf = (pos) => (pos ? ctx.texts.get(pos.ch)?.get(pos.v) ?? "" : "");
  const isLandscape = () => landscapeQuery.matches;

  function render() {
    if (ctx.mode !== "listen") return;
    const pos = ctx.current;
    const prev = prevVerse(pos);
    const next = nextVerse(pos);
    msg.hidden = true;
    for (const p of [prev, pos, next]) {
      if (p && !ctx.texts.get(p.ch)?.has(p.v)) {
        ctx.loadText(p.ch).then(
          () => key(ctx.current) === key(pos) && render(),
          () => {
            if (p.ch !== pos.ch || key(ctx.current) !== key(pos) || !msg.hidden) return;
            msg.replaceChildren(h("span", { text: "Couldn't load this chapter. Check your connection." }), h("br"), h("button", { type: "button", text: "Try again", onclick: render }));
            msg.hidden = false;
            ctx.live("Couldn't load this chapter. Check your connection.");
          },
        );
      }
    }
    const ar = textOf(pos);
    // At a chapter's first verse, the chapter's name stands where the previous verse would be.
    const prevEl = $("#stage-prev");
    const first = pos.v === 1;
    prevEl.classList.toggle("ttl-ar", first);
    prevEl.textContent = first ? chapterArabic(pos.ch) : textOf(prev);
    $("#stage-next").textContent = textOf(next);
    const k = `${key(pos)}|${ar.length}`;
    if (k !== shown) {
      shown = k;
      if (ar) renderArabic(nowEl, ar);
      else nowEl.textContent = "";
      nowEl.classList.toggle("loading", !ar);
      stage.scrollTop = 0;
    }
    layoutLines(true);
    ctx.follower.refresh();
  }

  // ---------- landscape: one line at a time ----------

  // Splits the verse into lines that fit the width, measured in the line's own font.
  function layoutLines(force = false) {
    if (!isLandscape() || ctx.mode !== "listen") return;
    const ar = textOf(ctx.current);
    const k = `${key(ctx.current)}|${ar.length}|${box.clientWidth}|${getComputedStyle(lineA).fontSize}`;
    if (!force && k === lineFor) return;
    lineFor = k;
    full.textContent = ar;
    lineToks = tokens(ar);
    lines = [];
    lineWords = [];
    lineIndex = -1;
    manualLine = false;
    if (!ar) {
      lineA.textContent = lineB.textContent = "";
      dots.hidden = true;
      return;
    }
    // Measure every token once (the last word and its ornaments as one unit, as rendered).
    const probe = h("p.ar.lt.probe", { lang: "ar", dir: "rtl" });
    box.append(probe);
    renderArabic(probe, ar);
    const space = (() => {
      const s = h("span", { text: " " });
      probe.append(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    })();
    const units = []; // [{from, to, width}]
    let i = 0;
    for (const node of probe.children) {
      const n = node.classList.contains("nw") ? node.querySelectorAll(":scope > span").length : 1;
      units.push({ from: i, to: i + n, width: node.getBoundingClientRect().width });
      i += n;
    }
    probe.remove();
    const max = box.clientWidth - 8;
    let cur = null;
    for (const u of units) {
      if (cur && cur.width + space + u.width <= max) {
        cur.to = u.to;
        cur.width += space + u.width;
      } else {
        if (cur) lines.push(cur);
        cur = { from: u.from, to: u.to, width: u.width };
      }
    }
    if (cur) lines.push(cur);
    // Word index ranges per line, and each line's share of the verse (by letters).
    let w = 0;
    let total = 0;
    for (const l of lines) {
      const first = w;
      let letters = 0;
      for (let t = l.from; t < l.to; t++) {
        if (isWord(lineToks[t])) w++;
        letters += lineToks[t].length;
      }
      lineWords.push([first, w - 1]);
      l.weight = letters;
      total += letters;
    }
    let acc = 0;
    for (const l of lines) {
      l.start = acc / total;
      acc += l.weight;
    }
    dots.hidden = lines.length < 2;
    const dd = $(".dd", dots);
    dd.replaceChildren(...(lines.length <= 12 ? lines.map(() => h("i")) : []));
    showLine(0, false);
  }

  function showLine(n, fade = true) {
    if (n === lineIndex || !lines[n]) return;
    lineIndex = n;
    const { from, to } = lines[n];
    const on = lineA.classList.contains("on") ? lineA : lineB;
    const off = on === lineA ? lineB : lineA;
    const target = fade ? off : on;
    // Render the slice with global word numbers so the highlight finds its word.
    target.replaceChildren();
    let w = lineWords[n][0];
    for (let t = from; t < to; t++) {
      const tok = lineToks[t];
      const s = h(isWord(tok) ? "span.w" : "span.orn", { text: tok });
      if (isWord(tok)) s.dataset.w = w++;
      if (t > from) target.append(" ");
      target.append(s);
    }
    if (fade) {
      off.classList.add("on");
      on.classList.remove("on");
    }
    $$(".dd i", dots).forEach((d, i) => d.classList.toggle("on", i === n));
    $(".lbl", dots).textContent = `Line ${n + 1} of ${lines.length}`;
    ctx.follower.refresh();
  }

  // From the word follower, every frame while reciting.
  function onTick({ pos, word, fraction, hasTimings }) {
    if (ctx.mode !== "listen" || key(pos) !== key(ctx.current)) return;
    if (isLandscape() && lines.length > 1) {
      manualLine = false;
      let n = 0;
      if (hasTimings && word != null) {
        if (word >= 0) n = Math.max(0, lineWords.findIndex(([a, b]) => word >= a && word <= b));
      } else {
        for (let i = 0; i < lines.length; i++) if (fraction >= lines[i].start) n = i;
      }
      showLine(n);
    } else if (!isLandscape() && word != null && word >= 0 && stage.scrollHeight > stage.clientHeight + 4) {
      // A long verse on the stage: keep the recited word in view.
      const el = nowEl.querySelector(`.w[data-w="${word}"]`);
      if (el && el !== onTick.last) {
        onTick.last = el;
        const r = el.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        if (r.top < s.top + 20 || r.bottom > s.bottom - 20) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  // Paused, a tap on the line shows the next one.
  box.addEventListener("click", () => {
    if (ctx.player.playing || lines.length < 2) return;
    manualLine = true;
    showLine((lineIndex + 1) % lines.length);
  });

  // Tapping the faint verse before or after moves there.
  $("#stage-prev").addEventListener("click", () => {
    if (ctx.current.v === 1) return; // the chapter title
    const p = prevVerse(ctx.current);
    if (p) ctx.select(p);
  });
  $("#stage-next").addEventListener("click", () => {
    const p = nextVerse(ctx.current);
    if (p) ctx.select(p);
  });

  // The stage sits above the player, whatever the player's height.
  const lplayer = $("#lplayer");
  new ResizeObserver(() => {
    const r = lplayer.getBoundingClientRect();
    document.documentElement.style.setProperty("--lp-h", lplayer.hidden ? "0px" : `${Math.max(0, window.innerHeight - r.top)}px`);
  }).observe(lplayer);
  window.addEventListener("online", () => !msg.hidden && render());

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layoutLines(), 120);
  });
  landscapeQuery.addEventListener("change", () => {
    document.documentElement.toggleAttribute("data-landscape", landscapeQuery.matches);
    render();
  });
  document.documentElement.toggleAttribute("data-landscape", landscapeQuery.matches);
  document.fonts?.ready.then(() => layoutLines(true));

  ctx.bus.addEventListener("position", () => render());
  ctx.bus.addEventListener("mode", () => {
    view.hidden = ctx.mode !== "listen";
    shown = "";
    lineFor = "";
    render();
  });
  ctx.bus.addEventListener("text", (e) => {
    const { ch } = e.detail;
    const near = [prevVerse(ctx.current), ctx.current, nextVerse(ctx.current)].some((p) => p?.ch === ch);
    if (near) render();
  });

  return {
    onTick,
    targets: (pos) => {
      if (ctx.mode !== "listen" || key(pos) !== key(ctx.current)) return [];
      return isLandscape() ? [lineA.classList.contains("on") ? lineA : lineB] : [nowEl];
    },
    get manual() {
      return manualLine;
    },
  };
}
