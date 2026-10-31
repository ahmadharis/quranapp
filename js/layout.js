// The responsive frame: which panels each screen size gets, their toggles, Focus, and the
// keyboard shortcuts.
//
//   < 600      phone: one column; the navigator is a sheet
//   600–899    tablet portrait: one wider column
//   900–1279   tablet landscape: Contents (280px) docked left + the text
//   1280–1679  laptop: Contents (280) or the info panel (300), one at a time
//   1680–2239  Contents (300) + text + info panel (320), both allowed
//   ≥ 2240     Contents (320) + text + info panel (360); translations side by side
//
// Contents (the navigator, Continue listening, Bookmarks) is the same in Read and Listen; the
// side panel shows in Read only. The player always stays in the bottom dock. Whether each
// sidebar is open, and Focus, are remembered per device for each size group.

import { prefs, savePrefs } from "./prefs.js";
import { $ } from "./util.js";

const GROUPS = [
  ["ultra", 2240],
  ["wide", 1680],
  ["laptop", 1280],
  ["desk", 900],
  ["tablet", 600],
  ["phone", 0],
];
const groupFor = (w) => GROUPS.find(([, min]) => w >= min)[0];
const PANEL_GROUPS = new Set(["laptop", "wide", "ultra"]); // the right panel, from 1280px

export function initLayout(ctx) {
  const root = document.documentElement;
  const contentsBtn = $("#toggle-contents");
  const panelBtn = $("#toggle-panel");
  const focusBtn = $("#toggle-focus");
  const hint = $("#focus-hint");
  let group = "";
  let hintShowing = false;

  function apply() {
    group = groupFor(window.innerWidth);
    root.dataset.bp = group;
    const L = prefs.layout[group]; // undefined on phone and tablet portrait
    const read = ctx.mode === "read";
    const focus = !!L?.focus;
    const cKey = read ? "contents" : "contentsListen"; // remembered per mode
    // 1280–1679: one sidebar at a time (the panel wins if an older saved state has both).
    if (group === "laptop" && read && L.contents && L.panel) L.contents = false;
    const contents = !!L && L[cKey] && !focus;
    const panelSize = PANEL_GROUPS.has(group) && read;
    const panel = panelSize && L.panel && !focus && ctx.panel.hasContent();
    root.toggleAttribute("data-focus", focus);
    root.toggleAttribute("data-contents", contents);
    root.toggleAttribute("data-panel", panel);
    // Mirrored edge toggles: Contents first in the header, the side panel last; each shows
    // where its sidebar exists at this size, pressed while open.
    contentsBtn.hidden = !L;
    contentsBtn.setAttribute("aria-pressed", String(contents));
    // The panel's toggle is the last header item at the sizes that have the panel; in Listen
    // it stays in place, disabled, so nothing shifts.
    panelBtn.hidden = !PANEL_GROUPS.has(group);
    panelBtn.disabled = PANEL_GROUPS.has(group) && !read;
    panelBtn.setAttribute("aria-pressed", String(panel));
    focusBtn.hidden = !L;
    focusBtn.setAttribute("aria-pressed", String(focus));
    hint.hidden = !(focus && hintShowing);
  }

  // what: "contents" (the left sidebar), "panel" (the right one) or "focus" (hide both).
  function toggle(what) {
    const L = prefs.layout[group];
    if (!L) return;
    if (what === "panel" && (!PANEL_GROUPS.has(group) || ctx.mode !== "read")) return;
    const k = what === "contents" && ctx.mode !== "read" ? "contentsListen" : what;
    if (what === "focus") {
      L.focus = !L.focus;
      // "Press F or Esc to bring panels back": the first time only, for a few seconds.
      if (L.focus && !prefs.focusHintSeen) {
        prefs.focusHintSeen = true;
        hintShowing = true;
        setTimeout(() => ((hintShowing = false), apply()), 6000);
      }
    }
    else if (L.focus) {
      // Leaving Focus by opening a sidebar brings back just that one.
      L.focus = false;
      L[k] = true;
      if (what === "contents") L.panel = false;
      else L.contents = false;
    } else L[k] = !L[k];
    // 1280–1679 has room for one sidebar: opening one closes the other ("]" swaps them).
    if (group === "laptop" && L[k]) {
      if (what === "panel") L.contents = L.contentsListen = false;
      if (what === "contents" && ctx.mode === "read") L.panel = false;
    }
    savePrefs();
    const had = document.activeElement;
    apply();
    ctx.bus.dispatchEvent(new Event("layout"));
    // Keep focus somewhere sensible when its button disappears.
    if (had && !had.offsetParent) $("#where")?.focus();
    ctx.live(
      what === "focus"
        ? L.focus
          ? "Focus on. Press F or Escape to bring the sidebars back."
          : "Focus off."
        : `${what === "contents" ? "Contents" : "Side panel"} ${L[k] ? "shown" : "hidden"}.`,
    );
  }
  contentsBtn.addEventListener("click", () => toggle("contents"));
  panelBtn.addEventListener("click", () => toggle("panel"));
  focusBtn.addEventListener("click", () => toggle("focus"));

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const before = group;
      apply();
      if (before !== group) ctx.bus.dispatchEvent(new Event("layout"));
    }, 80);
  });
  ctx.bus.addEventListener("mode", apply);
  ctx.bus.addEventListener("panel", apply);

  // ---------- keyboard ----------
  // Space play/pause · ←/→ verse · / go to · [ contents · ] side panel · F focus · Esc
  // leaves Focus. Not while typing, inside a dialog, or on a control that uses the key.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.("input, select, textarea, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const onControl = t.closest?.("button, a, [role=slider], [role=listbox], [role=tab], [role=radio], .verse");
    switch (e.key) {
      case " ":
        if (onControl) return;
        e.preventDefault();
        ctx.togglePlay();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (t.closest?.("[role=slider], [role=tablist], [role=radiogroup], [role=listbox], .verse, .vl, .cl")) return;
        e.preventDefault();
        e.key === "ArrowRight" ? ctx.step(1) : ctx.step(-1);
        break;
      case "/":
        e.preventDefault();
        ctx.nav.focusSearch();
        break;
      case "?":
        e.preventDefault();
        ctx.showKeys();
        break;
      case "[":
        toggle("contents");
        break;
      case "]":
        toggle("panel");
        break;
      case "f":
      case "F":
        toggle("focus");
        break;
      case "Escape":
        if (root.hasAttribute("data-focus")) toggle("focus");
        break;
    }
  });

  return { apply, toggle, get group() { return group; } };
}
