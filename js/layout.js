// The responsive frame: which panels each screen size gets, their toggles, Focus, and the
// keyboard shortcuts.
//
//   < 600      phone: one column; the navigator is a sheet
//   600–899    tablet portrait: one wider column
//   900–1279   tablet landscape: Contents sidebar + column
//   1280–1679  laptop: reading area + side panel (Contents starts closed: all three don't fit)
//   1680–2239  Contents + reading + side panel
//   ≥ 2240     wider still, up to three translation columns
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

  function apply() {
    group = groupFor(window.innerWidth);
    root.dataset.bp = group;
    const L = prefs.layout[group]; // undefined on phone and tablet portrait
    const read = ctx.mode === "read";
    const focus = !!L?.focus;
    const cKey = read ? "contents" : "contentsListen"; // remembered per mode
    const contents = !!L && L[cKey] && !focus;
    const panelSize = PANEL_GROUPS.has(group) && read;
    const panel = panelSize && L.panel && !focus && ctx.panel.hasContent();
    root.toggleAttribute("data-focus", focus);
    root.toggleAttribute("data-contents", contents);
    root.toggleAttribute("data-panel", panel);
    contentsBtn.hidden = !L || contents; // reopens the sidebar; it has its own button to close
    // At panel sizes the button keeps its place in Listen (hidden, not removed), so the
    // Read | Listen switch doesn't move when the mode changes.
    panelBtn.hidden = !PANEL_GROUPS.has(group);
    panelBtn.classList.toggle("ghost", !panelSize);
    panelBtn.setAttribute("aria-pressed", String(panel));
    panelBtn.disabled = panelSize && !ctx.panel.hasContent() && !focus;
    focusBtn.hidden = !L;
    focusBtn.setAttribute("aria-pressed", String(focus));
    hint.hidden = !focus;
  }

  // what: "contents" (the left sidebar), "panel" (the right one) or "focus" (hide both).
  function toggle(what) {
    const L = prefs.layout[group];
    if (!L) return;
    if (what === "panel" && (!PANEL_GROUPS.has(group) || ctx.mode !== "read")) return;
    const k = what === "contents" && ctx.mode !== "read" ? "contentsListen" : what;
    if (what === "focus") L.focus = !L.focus;
    else if (L.focus) {
      // Leaving Focus by opening a sidebar brings back just that one.
      L.focus = false;
      L[k] = true;
      if (what === "contents") L.panel = false;
      else L.contents = false;
    } else L[k] = !L[k];
    savePrefs();
    const had = document.activeElement;
    apply();
    ctx.bus.dispatchEvent(new Event("layout"));
    // Keep focus somewhere sensible when its button disappears.
    if (had && !had.offsetParent) (what === "contents" && L[k] ? $("#close-contents") : $(what === "contents" ? "#toggle-contents" : "#where"))?.focus();
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
