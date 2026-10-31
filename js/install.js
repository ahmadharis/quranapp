// Recommending installation, on phones and tablets that aren't running the installed app.
// - Android / Chromium: the browser's beforeinstallprompt is kept and our own banner offers
//   "Install" (which shows the browser's prompt).
// - Safari on iPhone/iPad (no install event): the same banner explains "Share, then Add to
//   Home Screen". Inside other apps' browsers (Instagram, Facebook…) it says to open the page
//   in Safari first.
// Not nagging: it appears only after the person has engaged (first recitation, or about 20 s
// of reading), never together with the first-visit tip; "Not now" hides it for 14 days, and
// after three of those it stops. Settings keeps an "Install app" row for later.

import { prefs, savePrefs } from "./prefs.js";
import { $, h, icon } from "./util.js";

const SNOOZE_MS = 14 * 24 * 3600 * 1000;
const READ_DELAY_MS = 20000;

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const ua = navigator.userAgent;
const iOS = /iP(hone|ad|od)/.test(ua) || (ua.includes("Mac") && navigator.maxTouchPoints > 1);
const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|LinkedInApp|Snapchat|GSA\//.test(ua);
const iOSSafari = iOS && !inAppBrowser && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
const handheld = () => matchMedia("(pointer: coarse)").matches || window.innerWidth < 1024;

export function initInstall(ctx) {
  let deferred = null; // the kept beforeinstallprompt
  let banner = null;
  let engaged = false;

  const st = prefs.install;
  const blocked = () => st.done || st.dismissed >= 3 || Date.now() < st.until;
  const installable = () => !standalone() && !st.done && (deferred || iOS);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    ctx.bus.dispatchEvent(new Event("installable"));
    maybeShow();
  });
  window.addEventListener("appinstalled", () => {
    st.done = true;
    savePrefs();
    hide();
    ctx.bus.dispatchEvent(new Event("installable"));
  });

  function build() {
    const text = iOS
      ? inAppBrowser || !iOSSafari
        ? h("span.ib-s", { text: "Open this page in Safari to install it." })
        : h("span.ib-s", {}, "Tap Share ", h("span.share", { "aria-label": "(the Share button)", text: "⎋" }), " then “Add to Home Screen”.")
      : h("span.ib-s", { text: "Keeps playing with the screen off, works offline" });
    const actions = h("div.ib-actions");
    if (!iOS && deferred) actions.append(h("button.ib-go", { type: "button", text: "Install", onclick: install }));
    actions.append(h("button.ib-no", { type: "button", text: "Not now", onclick: dismiss }));
    return h(
      "section.install",
      { "aria-label": "Install the app", "aria-live": "polite" },
      h("img", { src: "icons/icon-192.png", alt: "", width: "44", height: "44" }),
      h("div.ib-tx", {}, h("b", { text: "Install Holy Quran" }), text),
      actions,
    );
  }

  function show(force = false) {
    if (banner || standalone() || (!force && (blocked() || !engaged || !handheld()))) return;
    if (!force && $(".first-hint")) return; // never together with the first-visit tip
    if (!iOS && !deferred) return;
    banner = build();
    document.body.append(banner);
  }
  function hide() {
    banner?.remove();
    banner = null;
  }
  const maybeShow = () => show(false);

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice.catch(() => null);
    deferred = null;
    hide();
    if (choice?.outcome === "accepted") {
      st.done = true;
      savePrefs();
    }
    ctx.bus.dispatchEvent(new Event("installable"));
  }
  function dismiss() {
    st.dismissed += 1;
    st.until = Date.now() + SNOOZE_MS;
    savePrefs();
    hide();
    ctx.live("Install hidden. You can install later from Settings.");
  }

  // Engagement: the first recitation, or a while spent reading.
  const engage = () => {
    if (engaged) return;
    engaged = true;
    maybeShow();
  };
  ctx.player.addEventListener("state", () => ctx.player.playing && engage());
  setTimeout(engage, READ_DELAY_MS);
  // Queued behind the first-visit tip: try again once it's gone.
  setInterval(() => engaged && !banner && maybeShow(), 5000);

  return {
    installable,
    // From Settings: install now (Android) or show the instructions (iOS), even if snoozed.
    open() {
      if (deferred) return install();
      hide();
      show(true);
      banner?.querySelector("button")?.focus();
    },
  };
}
