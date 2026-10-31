// Settings: reciter, text size, appearance, and Translations (a sub-view:
// "Showing" — reorder by dragging a grip — "Available", and word meanings). Also the "⋯"
// sheet of the player: reciter, repeat and speed.

import { RECITERS } from "./player.js";
import { TRANSLATIONS, WORD_MEANINGS } from "./api.js";
import { prefs, savePrefs, SPEEDS } from "./prefs.js";
import { $, $$, h, icon } from "./util.js";

const THEME_COLORS = { light: "#F2F4F1", dark: "#111219" }; // --bg of each theme
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
  const themes = h("div.segmented", { role: "radiogroup", "aria-label": "Appearance" });
  for (const [v, label] of [["auto", "Automatic"], ["light", "Light"], ["dark", "Dark"]]) {
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
  const followRow = h("div.r", {}, h("span.nm", {}, h("b", { text: "Follow words" }), h("span", { text: "Lights each word as it is recited, in Read and Listen" })));
  const followSw = sw(prefs.followWords, "Follow words", (on) => {
    prefs.followWords = on;
    savePrefs();
    followSw.setAttribute("aria-checked", String(on));
    ctx.follower.setEnabled(on);
  });
  followRow.append(followSw);
  // Nazira mode, as alislam's app names it: a distraction-free page of Arabic.
  const naziraRow = h("div.r", {}, h("span.nm", {}, h("b", { text: "Nazira mode" }), h("span", { text: "Arabic only, verses flowing together like a printed page" })));
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
  const trRow = h("button.r.nav-row", { type: "button", onclick: () => showView("translations") }, h("span.nm", {}, h("b", { text: "Translations" }), h("span#tr-summary")), icon("i-right", "ch"));

  const mainView = h(
    "div.view#settings-main",
    {},
    h("div.sheet-head", {}, h("h2#settings-title", { text: "Settings" }), h("button.ib", { type: "button", "data-close": true, "aria-label": "Close" }, icon("i-close"))),
    h("div.grpd", {}, naziraRow, trRow, followRow),
    h("p.cap#reciter-legend", { text: "Reciter" }),
    h("div.grpd", {}, reciterList),
    h("p.cap", { text: "Text size" }),
    h("div.grpd.pad", {}, size, h("p.size-sample.ar", { lang: "ar", dir: "rtl", text: "بِسۡمِ اللّٰہِ الرَّحۡمٰنِ الرَّحِیۡمِ" })),
    h("p.cap", { text: "Appearance" }),
    themes,
    h("p.credit", {}, "Text, translations and recitation from ", h("a", { href: "https://www.alislam.org/quran/app/", target: "_blank", rel: "noopener", text: "alislam.org" }), "."),
  );

  // ---------- translations view ----------
  const live = $("#live");
  const showingGrp = h("div.grpd.showing");
  const showingFoot = h("p.foot");
  const availGrp = h("div.grpd");
  const wmValue = h("span.val");
  const wmMenu = h("div.menu", { role: "menu", hidden: true, "aria-label": "Word meanings" });
  const wmBtn = h("button.r", { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, h("span.nm", {}, h("b", { text: "Word meanings" }), h("span#wm-by")), wmValue, icon("i-updown", "ch"));
  let moreOpen = false;

  const trView = h(
    "div.view#settings-tr",
    { hidden: true },
    h(
      "div.sheet-head",
      {},
      h("button.back", { type: "button", onclick: () => showView("main") }, icon("i-back"), h("span.sr-only", { text: "Back to settings" })),
      h("h2", { text: "Translations" }),
      h("button.ib", { type: "button", "data-close": true, "aria-label": "Close" }, icon("i-close")),
    ),
    h("p.foot.intro", { text: "Shown under each verse in Read, labeled with the translator. Off when none is switched on." }),
    h("p.cap#showing-cap", { text: "Showing" }),
    showingGrp,
    showingFoot,
    h("p.cap", { text: "Available" }),
    availGrp,
    h("div.grpd.wm-row", {}, wmBtn, wmMenu),
  );
  sheet.append(mainView, trView);

  function showView(name) {
    mainView.hidden = name !== "main";
    trView.hidden = name !== "translations";
    sheet.scrollTop = 0;
    if (name === "translations") renderTranslations();
    else renderMain();
    $(name === "main" ? ".nav-row" : ".back", name === "main" ? mainView : trView)?.focus();
  }

  function changed() {
    savePrefs();
    ctx.bus.dispatchEvent(new Event("layers"));
  }

  function setOn(id, on) {
    const list = prefs.translations.list;
    const i = list.indexOf(id);
    if (on && i < 0) list.push(id);
    if (!on && i >= 0) list.splice(i, 1);
    changed();
    renderTranslations();
    live.textContent = `${tInfo(id).name}, ${on ? "shown" : "hidden"}.`;
  }

  function trRowEl(id, showing) {
    const t = tInfo(id);
    const row = h("div.r", { "data-id": id }, h("span.nm", {}, h("b", { text: t.name }), h("span", { text: t.lang })), sw(showing, `${t.name}, ${t.lang}`, (on) => setOn(id, on)));
    if (showing) {
      const pos = prefs.translations.list.indexOf(id) + 1;
      const grip = h("button.grip", { type: "button", "aria-label": `Reorder ${t.name}, position ${pos} of ${prefs.translations.list.length}`, "aria-describedby": "grip-help" }, icon("i-grip"));
      row.classList.add("indent");
      row.prepend(grip);
      dragRow(row, grip, id);
    }
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
    showingGrp.hidden = !list.length;
    $("#showing-cap", trView).hidden = !list.length;
    showingGrp.replaceChildren(...list.map((id) => trRowEl(id, true)));
    showingFoot.hidden = !list.length;
    showingFoot.replaceChildren(h("span#grip-help", { text: list.length > 1 ? "Drag to change the order." : "Switch on more than one to choose their order." }));
    const avail = TRANSLATIONS.filter((t) => !list.includes(t.id));
    const main = avail.filter((t) => !t.more);
    const extra = avail.filter((t) => t.more);
    const rows = main.map((t) => trRowEl(t.id, false));
    if (extra.length) {
      const moreBtn = h(
        "button.r",
        { type: "button", "aria-expanded": String(moreOpen), onclick: () => ((moreOpen = !moreOpen), renderTranslations()) },
        h("span.nm", {}, h("b", { text: "More languages" })),
        h("span.val", { text: extra.length }),
        icon(moreOpen ? "i-chevron" : "i-right", "ch"),
      );
      rows.push(moreBtn);
      if (moreOpen) rows.push(...extra.map((t) => trRowEl(t.id, false)));
    }
    availGrp.replaceChildren(...rows);
    const wm = WORD_MEANINGS.find((w) => w.id === prefs.wordMeanings);
    wmValue.textContent = wm.label;
    $("#wm-by", trView).textContent = wm.by ?? "";
    wmMenu.replaceChildren(
      ...WORD_MEANINGS.map((w) =>
        h(
          "button",
          { type: "button", role: "menuitemradio", "aria-checked": String(w.id === prefs.wordMeanings), onclick: () => pickWm(w.id) },
          h("span", {}, h("span", { text: w.label }), w.by ? h("small", { text: w.by }) : null),
          w.id === prefs.wordMeanings ? icon("i-check") : null,
        ),
      ),
    );
  }

  function pickWm(id) {
    prefs.wordMeanings = id;
    closeWm();
    changed();
    renderTranslations();
    wmBtn.focus();
  }
  const closeWm = () => {
    wmMenu.hidden = true;
    wmBtn.setAttribute("aria-expanded", "false");
  };
  wmBtn.addEventListener("click", () => {
    const open = wmMenu.hidden;
    wmMenu.hidden = !open;
    wmBtn.setAttribute("aria-expanded", String(open));
    if (open) ($('[aria-checked="true"]', wmMenu) ?? wmMenu.firstChild)?.focus();
  });
  wmMenu.addEventListener("keydown", (e) => {
    const items = $$("[role=menuitemradio]", wmMenu);
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeWm();
      wmBtn.focus();
    }
  });

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
        showingFoot.firstChild.textContent = target === 0 ? `Drop to show ${tInfo(id).lang.split(",")[0]} first.` : `Drop to show it after ${firstName}.`;
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
      if (e.pointerType !== "touch" || e.target.closest(".grip, .sw")) return;
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
      if (Math.abs(dx) > 100) setOn(id, false);
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
    renderNazira();
    syncRadios(reciterList, (b) => b.dataset.reciter === player.reciter);
    size.value = prefs.scale;
    syncRadios(themes, (b) => b.dataset.themeValue === prefs.theme);
    const shown = prefs.translations.list.map((id) => tInfo(id).name);
    $("#tr-summary", mainView).textContent = shown.length ? shown.join(", ") : "Off";
  }

  function openSettings(view = "main") {
    showView(view);
    if (!sheet.open) sheet.showModal();
    showView(view);
  }
  $("#open-settings").addEventListener("click", () => openSettings());
  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !trView.hidden && wmMenu.hidden && !held) {
      e.preventDefault();
      showView("main");
    }
  });

  // ---------- the "⋯" sheet ----------
  const moreReciters = h("div.choices", { role: "radiogroup", "aria-label": "Reciter" });
  reciterButtons(moreReciters);
  arrowRadios(moreReciters);
  const repeatRow = h("div.r", {}, h("span.nm", {}, h("b", { text: "Repeat this verse" }), h("span", { text: "Plays the verse again until you move on" })));
  const speeds = h("div.segmented", { role: "radiogroup", "aria-label": "Speed" });
  for (const s of SPEEDS) {
    speeds.append(h("button", { type: "button", role: "radio", "data-speed": s, text: `${s}×`, onclick: () => setSpeed(s) }));
  }
  arrowRadios(speeds);
  more.append(
    h("div.sheet-head", {}, h("h2#more-title", { text: "Recitation" }), h("button.ib", { type: "button", "data-close": true, "aria-label": "Close" }, icon("i-close"))),
    h("div.grpd", {}, repeatRow),
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
    repeatRow.querySelector(".sw")?.remove();
    repeatRow.append(
      sw(prefs.repeat, "Repeat this verse", (on) => {
        prefs.repeat = on;
        savePrefs();
        renderMore();
        $(".sw", repeatRow).focus();
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
