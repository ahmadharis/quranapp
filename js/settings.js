// Settings, one page: reciter; translations (your list of shown translations — drag a grip to
// reorder, × to remove — an "Add translation" picker, and word meanings); follow words, Nazira
// mode, text size, appearance, install. Also the "⋯" sheet of the player: speed, reciter and
// bookmark.

import { RECITERS } from "./player.js";
import { VERSION, BUILD } from "./version.js";
import { isBookmarked, toggleBookmark } from "./bookmarks.js";
import { TRANSLATIONS, WORD_MEANINGS } from "./api.js";
import { prefs, savePrefs, SPEEDS } from "./prefs.js";
import { $, $$, h, icon } from "./util.js";

const THEME_COLORS = { light: "#F4F4EE", dark: "#161514" }; // --bg of each theme
const tInfo = (id) => TRANSLATIONS.find((t) => t.id === id);

// Radio groups: one tab stop; arrow keys move the choice (WAI-ARIA radio group pattern).
export function syncRadios(group, isChecked) {
  for (const b of group.querySelectorAll('[role="radio"]')) {
    const on = isChecked(b);
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
export function arrowRadios(group) {
  group.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const radios = [...group.querySelectorAll('[role="radio"]')].filter((r) => r.offsetParent);
    const i = radios.indexOf(document.activeElement);
    const next = radios[(i + step + radios.length) % radios.length];
    next.focus();
    next.click();
  });
}

const sw = (on, label, onToggle) => {
  const b = h("button.sw", { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label }, h("span"));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle(b.getAttribute("aria-checked") !== "true");
  });
  return b;
};

// Sheets close on their close button or a tap on the backdrop.
export function closableSheet(sheet) {
  let downOnBackdrop = false;
  sheet.addEventListener("pointerdown", (e) => (downOnBackdrop = e.target === sheet));
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || (e.target === sheet && downOnBackdrop)) sheet.close();
  });
}

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  // The browser's own bar follows a chosen theme too, not only the system one.
  $$('meta[name="theme-color"]').forEach((m, i) => m.setAttribute("content", THEME_COLORS[prefs.theme] ?? Object.values(THEME_COLORS)[i]));
}
export const applyNazira = () => document.documentElement.toggleAttribute("data-nazira", prefs.nazira);
export const applyScale = () => document.documentElement.style.setProperty("--scale", prefs.scale);

export function initSettings(ctx) {
  const { player } = ctx;
  const sheet = $("#settings-sheet");
  const more = $("#more-sheet");
  closableSheet(sheet);
  closableSheet(more);

  // ---------- main view ----------
  const reciterList = h("div.choices", { role: "radiogroup", "aria-labelledby": "reciter-legend" });
  const reciterButtons = (list) =>
    list.append(
      ...RECITERS.map((r) =>
        h("button", { type: "button", role: "radio", "data-reciter": r.id, onclick: () => pickReciter(r.id) }, h("span", { text: r.name }), icon("i-check", "tick")),
      ),
    );
  reciterButtons(reciterList);
  arrowRadios(reciterList);

  const size = h("input#text-size", { type: "range", min: "0.8", max: "1.6", step: "0.1", "aria-label": "Text size" });
  size.addEventListener("input", () => {
    prefs.scale = Number(size.value);
    applyScale();
    savePrefs();
  });
  const themes = h("div.seg", { role: "radiogroup", "aria-label": "Theme" });
  for (const [v, label] of [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]) {
    themes.append(
      h("button", {
        type: "button",
        role: "radio",
        "data-theme-value": v,
        text: label,
        onclick: () => {
          prefs.theme = v;
          savePrefs();
          applyTheme();
          renderMain();
        },
      }),
    );
  }
  arrowRadios(themes);
  const followRow = h("div.r", {}, h("span.nm", {}, h("b", { text: "Follow words" })));
  const followSw = sw(prefs.followWords, "Follow words", (on) => {
    prefs.followWords = on;
    savePrefs();
    followSw.setAttribute("aria-checked", String(on));
    ctx.follower.setEnabled(on);
  });
  followRow.append(followSw);
  // Nazira mode, as alislam's app names it: a distraction-free page of Arabic.
  const naziraRow = h("div.r", { title: "Arabic only, verses flowing together like a printed page" }, h("span.nm", {}, h("b", { text: "Nazira mode" })));
  function renderNazira() {
    naziraRow.querySelector(".sw")?.remove();
    naziraRow.append(
      sw(prefs.nazira, "Nazira mode", (on) => {
        prefs.nazira = on;
        savePrefs();
        applyNazira();
        renderNazira();
        $(".sw", naziraRow).focus();
        ctx.bus.dispatchEvent(new Event("layers")); // translations: hidden or back
      }),
    );
  }
  // Install app: for anyone who dismissed the banner (shown only while installable).
  const installRow = h("button.r.nav-row.install-row", { type: "button", hidden: true, onclick: () => (sheet.close(), ctx.install.open()) }, h("span.nm", {}, h("b", { text: "Install app" })), icon("i-right", "ch"));
  const renderInstall = () => (installRow.hidden = !ctx.install?.installable());
  ctx.bus.addEventListener("installable", renderInstall);

  // ---------- translations (a section of Settings) ----------
  const live = $("#live");
  // Your list: only the translations shown, in display order (drag to reorder, × to remove).
  // "Add translation" opens a picker of all of them; adding puts one at the end of the list.
  const showingGrp = h("div.showing");
  const emptyNote = h("div.r.empty-row", {}, h("span.nm", { text: "No translations" }));
  const addBtn = h("button.r.add-tr", { type: "button", onclick: () => showView("add") }, icon("i-plus"), h("span", { text: "Add translation" }));
  const pickerGroups = h("div.tr-picker");
  // Word meanings: one Off / English / Urdu control.
  const wmSeg = h("div.seg", { role: "radiogroup", "aria-label": "Word meanings language" });
  for (const w of WORD_MEANINGS) {
    wmSeg.append(h("button", { type: "button", role: "radio", "data-wm": w.id, title: w.by ?? "", text: w.label, onclick: () => pickWm(w.id) }));
  }
  arrowRadios(wmSeg);
  // Reciter: one row showing the choice; the list opens as its own view.
  const reciterValue = h("span.nm");
  const reciterRow = h("button.r.nav-row.reciter-row", { type: "button", "aria-label": "Reciter", onclick: () => showView("reciter") }, reciterValue, icon("i-right", "ch"));

  const mainView = h(
    "div.view#settings-main",
    {},
    h("div.sheet-head", {}, h("h2#settings-title", { text: "Settings" }), h("button.ib", { type: "button", "data-close": true, "aria-label": "Close" }, icon("i-close"))),
    h("p.sec#reciter-legend", { text: "Reciter" }),
    h("div.grpd", {}, reciterRow),
    h("p.sec#tr-cap", { text: "Translations" }),
    h("div.grpd.trgrp", {}, showingGrp, emptyNote, addBtn, h("span.sr-only#grip-help", { text: "To reorder, drag the handle, or press Space on it, move with the arrow keys, and press Space again." })),
    h("p.sec#wm-cap", { text: "Word meanings" }),
    h("div.grpd", {}, h("div.r", {}, h("span.nm", { text: "Language" }), wmSeg)),
    h("p.sec", { text: "Reading" }),
    h(
      "div.grpd",
      {},
      followRow,
      naziraRow,
      h(
        "div.r.size-row",
        {},
        h("div.size-line", {}, h("span.a-sm", { "aria-hidden": "true", text: "A" }), size, h("span.a-lg", { "aria-hidden": "true", text: "A" })),
        h("p.size-sample.ar", { lang: "ar", dir: "rtl", text: "بِسۡمِ اللّٰہِ الرَّحۡمٰنِ الرَّحِیۡمِ" }),
      ),
    ),
    h("p.sec", { text: "Appearance" }),
    h("div.grpd", {}, h("div.r", {}, h("span.nm", { text: "Theme" }), themes)),
    h("div.grpd.install-grp", {}, installRow),
    h("p.credit", {}, "Text, translations and recitation from ", h("a", { href: "https://www.alislam.org/quran/app/", target: "_blank", rel: "noopener", text: "alislam.org" }), "."),
    h("p.version", { text: `Version ${VERSION} · build ${BUILD}` }),
  );

  // The picker: every translation, grouped; a tap adds or removes one, nothing moves.
  const addView = h(
    "div.view#settings-add",
    { hidden: true },
    h(
      "div.sheet-head",
      {},
      h("button.back", { type: "button", onclick: () => showView("main") }, icon("i-back"), h("span.sr-only", { text: "Back to settings" })),
      h("h2", { text: "Add translation" }),
      h("button.done", { type: "button", text: "Done", onclick: () => showView("main") }),
    ),
    pickerGroups,
  );
  const reciterView = h(
    "div.view#settings-reciter",
    { hidden: true },
    h(
      "div.sheet-head",
      {},
      h("button.back", { type: "button", onclick: () => showView("main") }, icon("i-back"), h("span.sr-only", { text: "Back to settings" })),
      h("h2", { text: "Reciter" }),
      h("button.done", { type: "button", text: "Done", onclick: () => showView("main") }),
    ),
    h("div.grpd", {}, reciterList),
  );
  sheet.append(mainView, addView, reciterView);

  let cameFrom = "main";
  function showView(name) {
    mainView.hidden = name !== "main";
    addView.hidden = name !== "add";
    reciterView.hidden = name !== "reciter";
    sheet.scrollTop = 0;
    if (name === "add") renderPicker();
    else renderMain();
    // Back from a sub-view, focus returns to the row that opened it.
    if (name === "add") $(".pick", addView)?.focus();
    else if (name === "reciter") $('[aria-checked="true"]', reciterList)?.focus();
    else if (cameFrom === "add") addBtn.focus();
    else if (cameFrom === "reciter") reciterRow.focus();
    cameFrom = name;
  }

  const GROUPS = [
    ["English", (t) => !t.more && t.script === "latin"],
    ["Urdu", (t) => !t.more && t.script === "urdu"],
    ["More languages", (t) => t.more],
  ];
  function renderPicker() {
    const on = new Set(prefs.translations.list);
    pickerGroups.replaceChildren(
      ...GROUPS.flatMap(([label, test]) => [
        h("p.cap", { text: label }),
        h(
          "div.grpd",
          { role: "group", "aria-label": label },
          TRANSLATIONS.filter(test).map((t) =>
            h(
              "button.r.pick",
              { type: "button", "data-id": t.id, "aria-pressed": String(on.has(t.id)), onclick: () => togglePick(t.id) },
              h("span.nm", {}, h("b", { text: t.name }), h("span", { text: t.lang })),
              icon("i-check", "tick"),
            ),
          ),
        ),
      ]),
    );
  }
  // Toggling in the picker only changes that row's ✓; the list order is kept (a new one goes
  // to the end).
  function togglePick(id) {
    const list = prefs.translations.list;
    const was = list.includes(id);
    if (was) list.splice(list.indexOf(id), 1);
    else list.push(id);
    changed();
    const b = $(`.pick[data-id="${id}"]`, addView);
    b.setAttribute("aria-pressed", String(!was));
    live.textContent = `${tInfo(id).name}, ${was ? "removed" : `added, position ${list.length} of ${list.length}`}.`;
  }

  function changed() {
    savePrefs();
    ctx.bus.dispatchEvent(new Event("layers"));
  }

  function remove(id) {
    const list = prefs.translations.list;
    const i = list.indexOf(id);
    if (i < 0) return;
    list.splice(i, 1);
    changed();
    renderTranslations();
    live.textContent = `${tInfo(id).name}, removed.`;
    // Keep focus in the list: the row that took its place, else Add.
    ($$(".r .grip", showingGrp)[Math.min(i, list.length - 1)] ?? addBtn).focus();
  }

  function trRowEl(id) {
    const t = tInfo(id);
    const pos = prefs.translations.list.indexOf(id) + 1;
    const grip = h("button.grip", { type: "button", "aria-label": `Reorder ${t.name}, position ${pos} of ${prefs.translations.list.length}`, "aria-describedby": "grip-help" }, icon("i-grip"));
    const row = h(
      "div.r.indent",
      { "data-id": id },
      grip,
      h("span.nm", {}, h("b", { text: t.name }), h("span", { text: t.lang })),
      h("button.rm", { type: "button", "aria-label": `Remove ${t.name}`, onclick: () => remove(id) }, icon("i-close")),
    );
    dragRow(row, grip, id);
    return row;
  }

  // Translations are shown when any is switched on; there is no master switch.
  let rendering = false; // re-rendering moves focus: grips ignore the blur that causes
  function renderTranslations() {
    rendering = true;
    try {
      renderTranslationsNow();
    } finally {
      rendering = false;
    }
  }
  function renderTranslationsNow() {
    const { list } = prefs.translations;
    emptyNote.hidden = !!list.length;
    showingGrp.hidden = !list.length;
    showingGrp.replaceChildren(...list.map((id) => trRowEl(id)));
    syncRadios(wmSeg, (b) => b.dataset.wm === prefs.wordMeanings);
  }

  function pickWm(id) {
    if (prefs.wordMeanings === id) return;
    prefs.wordMeanings = id;
    changed();
    syncRadios(wmSeg, (b) => b.dataset.wm === id);
  }

  // Reordering "Showing". Pointer: drag the grip — the row lifts and a slot shows where it will
  // land. Keyboard: the grip is a button — Space picks up, ↑/↓ move, Space drops, Esc cancels.
  // Swiping a row sideways (touch) switches it off.
  function move(id, to) {
    const list = prefs.translations.list;
    const from = list.indexOf(id);
    to = Math.max(0, Math.min(list.length - 1, to));
    if (from < 0 || from === to) return false;
    list.splice(from, 1);
    list.splice(to, 0, id);
    return true;
  }
  const announce = (id, verb) => {
    const list = prefs.translations.list;
    live.textContent = `${tInfo(id).name}, ${verb} position ${list.indexOf(id) + 1} of ${list.length}.`;
  };

  let held = null; // keyboard pick-up: {id, start}
  function dragRow(row, grip, id) {
    grip.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (held?.id === id) {
          held = null;
          changed();
          renderTranslations();
          refocus(id);
          announce(id, "dropped at");
        } else {
          held = { id, start: prefs.translations.list.indexOf(id) };
          row.classList.add("lift");
          grip.setAttribute("aria-pressed", "true");
          announce(id, "picked up at");
        }
      } else if (held?.id === id && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        if (move(id, prefs.translations.list.indexOf(id) + (e.key === "ArrowUp" ? -1 : 1))) {
          renderTranslations();
          const g = refocus(id);
          g?.closest(".r").classList.add("lift");
          g?.setAttribute("aria-pressed", "true");
          announce(id, "moved to");
        }
      } else if (held?.id === id && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        move(id, held.start);
        held = null;
        renderTranslations();
        refocus(id);
        announce(id, "back at");
      }
    });
    // Focus leaving the grip drops a held row — but not the blur caused by re-rendering, and
    // only once focus has settled elsewhere.
    grip.addEventListener("blur", () => {
      if (rendering || held?.id !== id) return;
      setTimeout(() => {
        if (held?.id !== id || document.activeElement?.closest?.(`.r[data-id="${id}"]`)) return;
        held = null;
        changed();
        renderTranslations();
      });
    });

    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const rows = $$(".r", showingGrp);
      const rects = rows.map((r) => r.getBoundingClientRect());
      const start = rows.indexOf(row);
      const y0 = e.clientY;
      const slot = h("div.slot", { style: `height:${rects[start].height}px` });
      row.classList.add("lift", "dragging");
      row.style.width = `${rects[start].width}px`;
      row.style.top = `${rects[start].top - showingGrp.getBoundingClientRect().top}px`;
      row.after(slot);
      let target = start;
      const onMove = (ev) => {
        const dy = ev.clientY - y0;
        row.style.transform = `translateY(${dy}px) scale(1.02)`;
        const mid = rects[start].top + rects[start].height / 2 + dy;
        target = rects.filter((r, i) => i !== start && mid > r.top + r.height / 2).length;
        const others = rows.filter((r) => r !== row);
        others[target] ? others[target].before(slot) : showingGrp.append(slot);
        const firstName = tInfo(prefs.translations.list.filter((x) => x !== id)[0] ?? id).name;
        live.textContent = target === 0 ? `Drop to show ${tInfo(id).name} first.` : `Drop to show it after ${firstName}.`;
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        const moved = move(id, target);
        if (moved) changed();
        renderTranslations();
        refocus(id);
        if (moved) announce(id, "moved to");
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    });

    // Swipe away (touch only, so a mouse can still select text).
    let sx = null;
    row.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || e.target.closest(".grip, .rm")) return;
      sx = e.clientX;
    });
    row.addEventListener("pointermove", (e) => {
      if (sx == null) return;
      const dx = e.clientX - sx;
      if (Math.abs(dx) > 8) row.style.transform = `translateX(${dx}px)`;
      row.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 240));
    });
    const swipeEnd = (e) => {
      if (sx == null) return;
      const dx = e.clientX - sx;
      sx = null;
      row.style.transform = row.style.opacity = "";
      if (dx < -100) remove(id); // swipe left
    };
    row.addEventListener("pointerup", swipeEnd);
    row.addEventListener("pointercancel", () => ((sx = null), (row.style.transform = row.style.opacity = "")));
  }
  const refocus = (id) => {
    const g = $(`.r[data-id="${id}"] .grip`, showingGrp);
    g?.focus();
    return g;
  };

  // ---------- reciter, text size, appearance ----------
  function pickReciter(id) {
    player.setReciter(id);
    prefs.reciter = id;
    savePrefs();
    renderMain();
    renderMore();
    ctx.bus.dispatchEvent(new Event("reciter"));
  }

  function renderMain() {
    renderInstall();
    renderNazira();
    syncRadios(reciterList, (b) => b.dataset.reciter === player.reciter);
    reciterValue.textContent = RECITERS.find((r) => r.id === player.reciter)?.name ?? "";
    size.value = prefs.scale;
    syncRadios(themes, (b) => b.dataset.themeValue === prefs.theme);
    renderTranslations();
  }

  function openSettings(view = "main") {
    showView(view);
    if (!sheet.open) sheet.showModal();
    showView(view);
  }
  $("#open-settings").addEventListener("click", () => openSettings());
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !addView.hidden) {
      e.preventDefault();
      showView("main");
    } else if (e.key === "Escape" && !reciterView.hidden) {
      e.preventDefault();
      showView("main");
    } else if (e.key === "Escape" && held) {
      e.preventDefault(); // the grip or the menu handles it; the sheet stays open
    }
  });

  // ---------- the "⋯" sheet ----------
  const moreReciters = h("div.choices", { role: "radiogroup", "aria-label": "Reciter" });
  reciterButtons(moreReciters);
  arrowRadios(moreReciters);
  // The verse being recited: bookmark it (on narrow bars the player has no room for the icon).
  const bookmarkRow = h("div.r.bm-row", {}, h("span.nm", {}, h("b", { text: "Bookmark this verse" }), h("span.bm-ref")));
  const speeds = h("div.segmented", { role: "radiogroup", "aria-label": "Speed" });
  for (const s of SPEEDS) {
    speeds.append(h("button", { type: "button", role: "radio", "data-speed": s, text: `${s}×`, onclick: () => setSpeed(s) }));
  }
  arrowRadios(speeds);
  more.append(
    h("div.sheet-head", {}, h("h2#more-title", { text: "Recitation" }), h("button.ib", { type: "button", "data-close": true, "aria-label": "Close" }, icon("i-close"))),
    h("div.grpd", {}, bookmarkRow),
    h("p.cap", { text: "Speed" }),
    speeds,
    h("p.cap", { text: "Reciter" }),
    h("div.grpd", {}, moreReciters),
    h("button.r.nav-row.all", {
      type: "button",
      onclick: () => {
        more.close();
        openSettings();
      },
    }, h("span.nm", {}, h("b", { text: "All settings" })), icon("i-right", "ch")),
  );

  function setSpeed(s) {
    prefs.speed = s;
    savePrefs();
    applySpeed();
    renderMore();
  }
  function applySpeed() {
    // The element resets playbackRate to the default whenever its source changes.
    player.audio.defaultPlaybackRate = prefs.speed;
    player.audio.playbackRate = prefs.speed;
  }
  function renderMore() {
    syncRadios(moreReciters, (b) => b.dataset.reciter === player.reciter);
    syncRadios(speeds, (b) => Number(b.dataset.speed) === prefs.speed);
    const pos = ctx.current;
    $(".bm-ref", bookmarkRow).textContent = `${pos.ch}:${pos.v}`;
    bookmarkRow.querySelector(".sw")?.remove();
    bookmarkRow.append(
      sw(isBookmarked(pos), `Bookmark ${pos.ch}:${pos.v}`, () => {
        toggleBookmark(ctx.current);
        renderMore();
        $(".sw", bookmarkRow).focus();
      }),
    );
  }
  function openMore() {
    renderMore();
    more.showModal();
  }
  for (const b of $$("[data-more]")) b.addEventListener("click", openMore);

  applySpeed();
  renderMain();
  return { openSettings, openMore, renderMain, pickReciter };
}
