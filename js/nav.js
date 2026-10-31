// Finding a place. One picker, the same in Read and Listen: a search field (name, number,
// "2:255", "part 3"), a Chapters | Parts switch, and two columns — the chapter list and, on the
// right edge, the verse numbers of the selected chapter, which fill as soon as a chapter is
// tapped. Tapping a verse number (or a part) goes there.
//
// The picker appears in two places: the "Go to" sheet (phones, or when the sidebar is closed)
// and the left "Contents" sidebar on larger screens, which also has "Continue listening" and
// Bookmarks. Each place has its own copy of the picker.

import { CHAPTERS, PART_STARTS } from "./quran-data.js";
import { RECITERS } from "./player.js";
import { prefs, savePrefs } from "./prefs.js";
import { bookmarks } from "./bookmarks.js";
import { $, $$, h, icon, clamp, verseCount, chapterName, arDigits, partOf } from "./util.js";

const simplify = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const TABS = ["chapters", "parts"];
let pickerCount = 0;

// ---------- the picker ----------

// Scrolls `box` so `item` sits in its middle (rects, so any positioned ancestor is fine).
function center(box, item) {
  requestAnimationFrame(() => {
    const b = box.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (!b.height) return; // not on screen yet
    box.scrollTop += r.top - b.top - (b.height - r.height) / 2;
  });
}

function createPicker(ctx, { onPick }) {
  const id = `pk${++pickerCount}`;
  const search = h("input.search-input", {
    type: "search",
    placeholder: "Name, number, 36:58, part 3",
    autocomplete: "off",
    enterkeyhint: "go",
    "aria-label": "Search: a chapter name or number, a verse like 2:255, a part like part 3, or a verse number in the selected chapter",
    "aria-describedby": `${id}-hint`,
  });
  // Under the search field: a short note, or up to two suggestions (Enter takes the first).
  const hint = h("div.hint", { id: `${id}-hint`, "aria-live": "polite" });
  const tabs = h("div.segmented.tabs", { role: "tablist", "aria-label": "List" });
  tabs.append(...TABS.map((t) => h("button", { role: "tab", type: "button", id: `${id}-tab-${t}`, "aria-controls": `${id}-${t}`, "data-tab": t, text: t === "chapters" ? "Chapters" : "Parts" })));
  const chList = h("ol.cl", { id: `${id}-chapters`, role: "tabpanel", "aria-labelledby": `${id}-tab-chapters` });
  const ptList = h("ol.cl.parts", { id: `${id}-parts`, role: "tabpanel", "aria-labelledby": `${id}-tab-parts`, hidden: true });
  const vHead = h("p.vh", { text: "Verse", "aria-hidden": "true" });
  const vList = h("div.vl", { role: "group" });
  const vCol = h("div.vcol", {}, vHead, vList);
  const two = h("div.two", {}, h("div.ccol", {}, chList, ptList), vCol);
  const el = h("div.picker", {}, h("label.search", {}, icon("i-search"), search), hint, tabs, two);

  let sel = ctx.current.ch; // the selected chapter (its verses fill the right column)
  let target = 0; // a verse picked out by typing in the search field
  let action = null; // what Enter does
  const setRows = (rows) => {
    hint.replaceChildren(...rows.map((r, i) => h(`button.sug${i ? "" : ".first"}`, { type: "button", text: r.label, onclick: r.go })));
    action = rows[0]?.go ?? null;
  };

  // Chapter rows.
  chList.append(
    ...CHAPTERS.map(([ch, name, ar, count]) =>
      h(
        "li",
        { "data-ch": ch },
        h(
          "button.ch2",
          { type: "button", tabindex: "-1", "aria-label": `${ch}. ${name}, ${count} verses`, onclick: () => selectChapter(ch, true) },
          h("span.k", { text: ch }),
          h("span.nm", {}, h("span.t", {}, name, h("span.here", { "aria-hidden": "true" })), h("span.s", { text: `${count} verses` })),
          h("span.ar", { lang: "ar", dir: "rtl", text: ar, "aria-hidden": "true" }),
        ),
      ),
    ),
  );
  // Part rows: number, where it starts, الجزء with Urdu digits. A tap goes to its start.
  ptList.append(
    ...PART_STARTS.map(([ch, v], i) =>
      h(
        "li",
        { "data-part": i + 1 },
        h(
          "button.ch2",
          { type: "button", tabindex: "-1", "aria-label": `Part ${i + 1}, starts at ${chapterName(ch)} ${ch}:${v}`, onclick: () => onPick({ ch, v }) },
          h("span.k", { text: i + 1 }),
          h("span.nm", {}, h("span.t", { text: `${chapterName(ch)} ${ch}:${v}` })),
          h("span.ar", { lang: "ar", dir: "rtl", text: `الجزء ${arDigits(i + 1)}`, "aria-hidden": "true" }),
        ),
      ),
    ),
  );

  function fillVerses() {
    const n = verseCount(sel);
    vList.setAttribute("aria-label", `Verses of ${chapterName(sel)}`);
    const here = ctx.current.ch === sel ? ctx.current.v : 0;
    const frag = document.createDocumentFragment();
    for (let v = 1; v <= n; v++) {
      const b = h("button.vn", { type: "button", "data-v": v, tabindex: "-1", "aria-label": `${chapterName(sel)} ${sel}:${v}`, text: v });
      if (v === here) {
        b.classList.add("cur");
        b.setAttribute("aria-current", "true");
      }
      frag.append(b);
    }
    vList.replaceChildren(frag);
    const start = target || here || 1;
    vList.children[start - 1].tabIndex = 0;
    if (target) vList.children[target - 1].classList.add("hit");
    scrollVerse(start);
  }
  function scrollVerse(v) {
    const b = vList.children[v - 1];
    if (!b) return;
    center(vCol, b);
  }

  function selectChapter(ch, user = false) {
    sel = ch;
    if (user) {
      target = 0;
      if (/^\d+$/.test(search.value.trim())) renderSearch(); // re-aim the typed verse
    }
    for (const b of $$(".ch2.sel", chList)) {
      b.classList.remove("sel");
      b.removeAttribute("aria-pressed");
    }
    const row = $(`[data-ch="${ch}"] .ch2`, chList);
    row?.classList.add("sel");
    row?.setAttribute("aria-pressed", "true");
    rove(chList, row);
    fillVerses();
    if (user) vList.querySelector("[tabindex='0']")?.focus({ preventScroll: true });
  }

  function markHere() {
    for (const li of $$("li.here-ch", chList)) li.classList.remove("here-ch");
    $(`[data-ch="${ctx.current.ch}"]`, chList)?.classList.add("here-ch");
    for (const b of $$(".ch2.sel", ptList)) b.classList.remove("sel");
    const part = $(`[data-part="${partOf(ctx.current)}"] .ch2`, ptList);
    part?.classList.add("sel");
    rove(ptList, part);
  }

  // Each list is one tab stop (its selected row); arrow keys move within it.
  function rove(list, row) {
    if (!row) return;
    for (const b of $$(".ch2[tabindex='0']", list)) b.tabIndex = -1;
    row.tabIndex = 0;
  }

  function scrollList() {
    const list = prefs.navTab === "parts" ? ptList : chList;
    const li = prefs.navTab === "parts" ? $(".ch2.sel", ptList)?.parentElement : $(`[data-ch="${sel}"]`, chList);
    if (li) center(list.parentElement, li);
  }

  function selectTab(tab, focus = false) {
    if (prefs.navTab !== tab) {
      prefs.navTab = tab;
      savePrefs();
    }
    for (const b of $$("[role=tab]", tabs)) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    chList.hidden = tab !== "chapters";
    ptList.hidden = tab !== "parts";
    vCol.hidden = tab !== "chapters";
    two.classList.toggle("one", tab !== "chapters");
    scrollList();
  }
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[role=tab]");
    if (b) selectTab(b.dataset.tab);
  });
  tabs.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(prefs.navTab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    selectTab(TABS[(to + TABS.length) % TABS.length], true);
  });

  // Search. "2:255" picks the chapter and verse; "part 3" a part; digits alone a verse of the
  // selected chapter (or, past its end, a chapter number); words filter the chapters.
  function renderSearch() {
    const q = search.value.trim();
    action = null;
    hint.textContent = "";
    for (const li of chList.children) li.hidden = false;
    for (const b of $$(".vn.hit", vList)) b.classList.remove("hit");
    target = 0;
    if (!q) return;
    const ref = q.match(/^(\d{1,3})\s*[:.]\s*(\d{1,3})$/);
    const part = q.match(/^(?:part|juz|para|p)\s*(\d{1,2})$/i);
    if (ref) {
      const ch = Number(ref[1]);
      if (ch < 1 || ch > 114) return void (hint.textContent = "There are 114 chapters.");
      const v = clamp(Number(ref[2]), 1, verseCount(ch));
      selectTab("chapters");
      target = v;
      selectChapter(ch);
      scrollList();
      setRows([{ label: `Go to ${chapterName(ch)} ${ch}:${v}`, go: () => onPick({ ch, v }) }]);
    } else if (part) {
      const n = Number(part[1]);
      if (n < 1 || n > 30) return void (hint.textContent = "There are 30 parts.");
      const [ch, v] = PART_STARTS[n - 1];
      selectTab("parts");
      for (const b of $$(".ch2.sel", ptList)) b.classList.remove("sel");
      $(`[data-part="${n}"] .ch2`, ptList)?.classList.add("sel");
      scrollList();
      setRows([{ label: `Part ${n} · starts at ${chapterName(ch)} ${ch}:${v}`, go: () => onPick({ ch, v }) }]);
    } else if (/^\d{1,3}$/.test(q)) {
      // A bare number: chapter n first, then verse n of the selected chapter.
      const n = Number(q);
      const rows = [];
      selectTab("chapters");
      if (n >= 1 && n <= 114) {
        rows.push({ label: `Chapter ${n} · ${chapterName(n)}`, go: () => onPick({ ch: n, v: 1 }) });
        const li = $(`[data-ch="${n}"]`, chList);
        if (li) center(chList.parentElement, li);
      }
      if (n >= 1 && n <= verseCount(sel)) {
        target = n;
        const b = vList.children[n - 1];
        b?.classList.add("hit");
        for (const x of vList.children) x.tabIndex = -1;
        if (b) b.tabIndex = 0;
        scrollVerse(n);
        rows.push({ label: `Verse ${n} in ${chapterName(sel)}`, go: () => onPick({ ch: sel, v: n }) });
      }
      if (rows.length) setRows(rows);
      else hint.textContent = "No chapter or verse with that number.";
    } else {
      const sq = simplify(q);
      selectTab("chapters");
      let first = 0;
      for (const li of chList.children) {
        const ch = Number(li.dataset.ch);
        li.hidden = !simplify(chapterName(ch)).includes(sq);
        if (!li.hidden && !first) first = ch;
      }
      if (first) {
        selectChapter(first);
        action = () => onPick({ ch: first, v: 1 });
      }
      hint.textContent = first ? "" : "No chapter matches. Try a number from 1 to 114 or a name like Yasin.";
    }
  }
  search.addEventListener("input", renderSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      action?.();
    }
  });

  // The verse column: tap goes; ↑/↓ move, Home/End, Enter goes.
  vList.addEventListener("click", (e) => {
    const b = e.target.closest(".vn");
    if (b) onPick({ ch: sel, v: Number(b.dataset.v) });
  });
  vList.addEventListener("keydown", (e) => {
    const b = e.target.closest(".vn");
    if (!b) return;
    const i = Number(b.dataset.v) - 1;
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + 10, PageUp: i - 10, Home: 0, End: vList.children.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = vList.children[clamp(to, 0, vList.children.length - 1)];
    b.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  // ←/→ between the two columns.
  chList.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" && e.target.closest(".ch2")) {
      e.preventDefault();
      vList.querySelector("[tabindex='0']")?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = $$("li:not([hidden]) .ch2", chList);
      const i = rows.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      const to = rows[clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)];
      rove(chList, to);
      to.focus();
    }
  });
  vList.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      $(`[data-ch="${sel}"] .ch2`, chList)?.focus();
    }
  });
  ptList.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = $$(".ch2", ptList);
    const i = rows.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    const to = rows[clamp(i + (e.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)];
    rove(ptList, to);
    to.focus();
  });

  // Back to the place being read, with the search cleared.
  function reset() {
    search.value = "";
    renderSearch();
    markHere();
    selectTab(prefs.navTab);
    selectChapter(ctx.current.ch);
    scrollList();
  }
  function sync() {
    markHere();
    if (!search.value.trim()) {
      if (sel === ctx.current.ch) fillVerses();
      else selectChapter(ctx.current.ch);
      scrollList();
    }
  }

  return {
    el,
    reset,
    sync,
    focusSearch: () => search.focus(),
    focusCurrent: () => (prefs.navTab === "parts" ? $(".ch2.sel", ptList) : $(`[data-ch="${sel}"] .ch2`, chList))?.focus({ preventScroll: true }),
  };
}

// ---------- bookmarks list ----------

function bookmarkList(ctx, onPick) {
  const list = h("ul.bml");
  function render() {
    list.replaceChildren(
      ...(prefs.bookmarks.length
        ? prefs.bookmarks.map((b) =>
            h(
              "li",
              {},
              h("button.bm", { type: "button", onclick: () => onPick({ ch: b.ch, v: b.v }) }, icon("i-bookmark"), h("b", { text: chapterName(b.ch) }), h("span", { text: `${b.ch}:${b.v}` })),
            ),
          )
        : [h("li.empty", { text: "Bookmark a verse from its menu to find it here." })]),
    );
  }
  render();
  bookmarks.addEventListener("change", render);
  return list;
}

// ---------- the sheet and the sidebar ----------

export function initNav(ctx) {
  const sheet = $("#nav-sheet");
  const side = $("#contents");
  let opener = null;

  const choose = (pos) => {
    if (sheet.open) sheet.close();
    ctx.goTo(pos);
  };

  // The sheet: "Go to", the picker, and a Bookmarks row that opens the list.
  const sheetPicker = createPicker(ctx, { onPick: choose });
  const bmCount = h("span.n");
  const bmRow = h("button.bmrow", { type: "button" }, icon("i-bookmark"), h("b", { text: "Bookmarks" }), bmCount, icon("i-right", "ch"));
  const main = h(
    "section.nav-step",
    { "aria-labelledby": "nav-title" },
    h("div.nav-head", {}, h("h2.nav-title#nav-title", { text: "Go to" }), h("button.ib", { type: "button", "aria-label": "Close", onclick: () => sheet.close() }, icon("i-close"))),
    sheetPicker.el,
    bmRow,
  );
  const bmBack = h("button.ib.back", { type: "button", "aria-label": "Back to Go to" }, icon("i-back"));
  const bmView = h(
    "section.nav-step.bm-view",
    { "aria-labelledby": "bm-title", hidden: true },
    h("div.nav-head", {}, bmBack, h("h2.nav-title#bm-title", { text: "Bookmarks" }), h("button.ib", { type: "button", "aria-label": "Close", onclick: () => sheet.close() }, icon("i-close"))),
    h("div.bm-scroll", {}, bookmarkList(ctx, choose)),
  );
  sheet.append(main, bmView);
  const showBookmarks = (on) => {
    main.hidden = on;
    bmView.hidden = !on;
    (on ? bmBack : bmRow).focus();
  };
  bmRow.addEventListener("click", () => showBookmarks(true));
  bmBack.addEventListener("click", () => showBookmarks(false));
  const renderCount = () => (bmCount.textContent = prefs.bookmarks.length || "");
  renderCount();
  bookmarks.addEventListener("change", renderCount);

  // The sidebar: Contents, Continue listening, the picker, Bookmarks.
  const sidePicker = createPicker(ctx, { onPick: (pos) => ctx.goTo(pos) });
  const cont = h(
    "div.cont",
    { hidden: true },
    h("div.tx", {}, h("small", { text: "Continue listening" }), h("b"), h("span")),
    h("button.go", { type: "button" }, (() => {
      const s = icon("i-play");
      s.firstChild.setAttribute("data-cont-use", "");
      return s;
    })()),
  );
  const bmCountSide = h("span");
  side.append(
    h(
      "div.sbh",
      {},
      h("h2", { text: "Contents" }),
    ),
    cont,
    sidePicker.el,
    h("section.bms", { "aria-labelledby": "bms-h" }, h("h3#bms-h", {}, "Bookmarks", bmCountSide), bookmarkList(ctx, (pos) => ctx.goTo(pos))),
  );
  const renderSideCount = () => (bmCountSide.textContent = prefs.bookmarks.length || "");
  renderSideCount();
  bookmarks.addEventListener("change", renderSideCount);

  // Continue listening: where recitation last was — which may differ from what is on screen.
  function renderCont() {
    const r = prefs.resume;
    const playing = ctx.player.playing;
    cont.hidden = !r;
    if (!r) return;
    $("b", cont).textContent = `${chapterName(r.ch)} ${r.ch}:${r.v}`;
    $("span", cont).textContent = RECITERS.find((x) => x.id === r.reciter)?.name ?? "";
    $("small", cont).textContent = playing ? "Now playing" : "Continue listening";
    $("[data-cont-use]", cont).setAttribute("href", playing ? "#i-pause" : "#i-play");
    $(".go", cont).setAttribute("aria-label", playing ? "Pause" : `Continue listening at ${chapterName(r.ch)} ${r.ch}:${r.v}`);
  }
  $(".go", cont).addEventListener("click", () => {
    const r = prefs.resume;
    if (ctx.player.playing) return ctx.player.pause();
    if (!r) return;
    if (r.reciter !== ctx.player.reciter) ctx.setReciter(r.reciter);
    ctx.goTo({ ch: r.ch, v: r.v });
    ctx.togglePlay();
  });
  ctx.player.addEventListener("state", renderCont);
  ctx.bus.addEventListener("resume", renderCont);
  renderCont();

  // ---------- opening ----------
  function open({ focusSearch = false } = {}) {
    // With the sidebar showing, "go to" means its search field.
    if (document.documentElement.hasAttribute("data-contents")) {
      sidePicker.focusSearch();
      return;
    }
    if (sheet.open) return;
    opener = document.activeElement;
    main.hidden = false;
    bmView.hidden = true;
    sheetPicker.reset();
    sheet.showModal();
    if (focusSearch) sheetPicker.focusSearch();
    else sheetPicker.focusCurrent();
  }
  sheet.addEventListener("close", () => {
    const o = opener;
    opener = null;
    if (o?.isConnected) requestAnimationFrame(() => o.focus({ preventScroll: true }));
  });
  let downOnBackdrop = false;
  sheet.addEventListener("pointerdown", (e) => (downOnBackdrop = e.target === sheet));
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet && downOnBackdrop) sheet.close();
  });

  for (const b of $$("[data-open-nav]")) b.addEventListener("click", () => open());
  ctx.bus.addEventListener("position", () => sidePicker.sync());
  ctx.bus.addEventListener("layout", () => {
    if (document.documentElement.hasAttribute("data-contents") && sheet.open) sheet.close();
  });
  sidePicker.reset();

  return { open, focusSearch: () => open({ focusSearch: true }) };
}
