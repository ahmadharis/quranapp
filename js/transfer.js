// Move to another device: everything that is the user's (all preferences with their schema,
// bookmarks, the last place read per chapter, the last position) as one payload.
// - Send: a QR code of the transfer link (js/qr.js), Copy link / Share…, and a backup file.
// - Receive: a link with #import= opened anywhere in the app, a pasted link or code, or a
//   backup file; a confirmation shows what comes in and offers Merge, Replace or Cancel.
// The payload travels only in the URL fragment (#import=…), which browsers never send to a
// server, and nothing here makes a network request.
//
// Code: "z" + base64url(deflate-raw(JSON)), or "j" + base64url(JSON) where the browser has no
// CompressionStream. The view lives at #/transfer; Back or Esc returns to Settings.

import { prefs, savePrefs, normalizePrefs } from "./prefs.js";
import { VERSION } from "./version.js";
import { encodeQR, qrSvg } from "./qr.js";
import { $, h, icon, key, chapterName } from "./util.js";

const APP = "quran";
const FORMAT = 1;
const MAX_JSON = 4 * 1024 * 1024; // a code never inflates past this (a broken or hostile one)
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// ---------- the payload ----------
export function buildPayload(p = prefs) {
  return { app: APP, format: FORMAT, version: VERSION, created: Date.now(), prefs: JSON.parse(JSON.stringify(p)) };
}

// A payload from a link, code or file -> {incoming (validated, current schema), version, created}.
export function readPayload(obj) {
  if (!isObj(obj) || obj.app !== APP || !isObj(obj.prefs) || !(Number(obj.format) >= 1)) throw new Error("not a transfer payload");
  return { incoming: normalizePrefs(JSON.parse(JSON.stringify(obj.prefs))), version: String(obj.version ?? "?").slice(0, 20), created: Number(obj.created) || 0 };
}

const b64url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
async function pipe(bytes, stream) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_JSON) {
      reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

export async function encodeCode(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream === "function") return "z" + b64url(await pipe(json, new CompressionStream("deflate-raw")));
  return "j" + b64url(json);
}

// A transfer link, its fragment, or the bare code -> the payload object.
export async function decodeCode(text) {
  let code = String(text ?? "").trim();
  const at = code.indexOf("import=");
  if (at >= 0) code = code.slice(at + 7);
  code = code.replace(/[\s&].*$/s, "");
  if (!/^[zj][A-Za-z0-9_-]+$/.test(code)) throw new Error("not a transfer code");
  let bytes = unb64url(code.slice(1));
  if (code[0] === "z") {
    if (typeof DecompressionStream !== "function") throw new Error("this browser can't read compressed codes");
    bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const linkFor = (code) => `${location.href.split("#")[0]}#import=${code}`;

// Merge: bookmarks joined by verse (the later-saved copy kept), incoming settings win, the
// newer last position kept. Replace: the incoming prefs as they are. Either way this device's
// install-banner state stays (whether this browser installed the app is about this device).
export function mergePrefs(local, incoming, mode) {
  const device = { install: local.install };
  if (mode === "replace") return normalizePrefs({ ...incoming, ...device });
  const marks = new Map();
  for (const b of [...local.bookmarks, ...incoming.bookmarks]) {
    const have = marks.get(key(b));
    if (!have || b.at > have.at) marks.set(key(b), b);
  }
  const newer = incoming.lastAt > local.lastAt;
  return normalizePrefs({
    ...local,
    ...incoming,
    ...device,
    bookmarks: [...marks.values()].sort((a, b) => b.at - a.at),
    chLast: { ...local.chLast, ...incoming.chLast },
    last: newer ? incoming.last : local.last,
    lastAt: Math.max(local.lastAt, incoming.lastAt),
    resume: newer ? incoming.resume : local.resume,
  });
}

export function toast(text) {
  const t = h("p.toast", { role: "status", text });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown date");
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---------- the view and the confirmation ----------
export function initTransfer(ctx) {
  const view = $("#transfer-sheet");
  const confirmSheet = $("#import-sheet");

  // Send
  const qrBox = h("div.qr-tile");
  const qrNote = h("p.tr-note");
  const sendStep = h("p.tr-step");
  const linkField = h("input.tr-link", { type: "text", readonly: true, "aria-label": "Transfer link", spellcheck: "false" });
  const copyBtn = h("button.tr-btn.primary", { type: "button", onclick: copyLink }, icon("i-copy"), h("span", { text: "Copy link" }));
  const shareBtn = h("button.tr-btn", { type: "button", hidden: !navigator.share, onclick: shareLink }, h("span", { text: "Share…" }));
  const fileBtn = h("button.tr-btn", { type: "button", onclick: downloadFile }, h("span", { text: "Download backup file" }));
  // Receive
  const paste = h("textarea.tr-paste", { rows: "3", placeholder: "Paste a transfer link or code", "aria-label": "Transfer link or code", spellcheck: "false", autocapitalize: "off" });
  const pasteBtn = h("button.tr-btn.primary", { type: "button", onclick: () => importText(paste.value) }, h("span", { text: "Import" }));
  const fileInput = h("input", { type: "file", accept: ".json,application/json,text/plain", hidden: true, onchange: openFile });
  const openBtn = h("button.tr-btn", { type: "button", onclick: () => fileInput.click() }, h("span", { text: "Open backup file…" }));
  const errorLine = h("p.tr-error", { role: "alert" });

  view.append(
    h(
      "div.tr-wrap",
      {},
      h(
        "div.sheet-head",
        {},
        h("button.back", { type: "button", onclick: back }, icon("i-back"), h("span.sr-only", { text: "Back to settings" })),
        h("h2#transfer-title", { text: "Move to another device" }),
      ),
      h("p.tr-intro", { text: "Your settings, bookmarks and places read, on another phone or computer. Everything travels inside the link or file itself; nothing is uploaded." }),
      h("h3.tr-h", { text: "Send" }),
      h("div.grpd.pad.tr-send", {}, sendStep, qrBox, qrNote, linkField, h("div.tr-row", {}, copyBtn, shareBtn), h("div.tr-row", {}, fileBtn)),
      h("h3.tr-h", { text: "Receive" }),
      h("div.grpd.pad.tr-recv", {}, h("p.tr-step", { text: "Opened a transfer link here? It is offered at once. Or paste a link or code, or open a backup file." }), paste, h("div.tr-row", {}, pasteBtn, openBtn), errorLine, fileInput),
    ),
  );

  let link = "";
  let payload = null;
  async function renderSend() {
    payload = buildPayload();
    link = linkFor(await encodeCode(payload));
    linkField.value = link;
    const qr = encodeQR(link);
    if (qr) {
      qrBox.innerHTML = qrSvg(qr, { label: "QR code of the transfer link" });
      qrBox.hidden = false;
      qrNote.textContent = "";
      qrNote.hidden = true;
    } else {
      qrBox.textContent = "";
      qrBox.hidden = true;
      qrNote.textContent = "Too much to fit in a QR code. Copy the link, or download the backup file, and open it on the other device.";
      qrNote.hidden = false;
    }
    sendStep.textContent = qr ? "On the other device, scan this code with the camera, or open the link there." : "Open this link on the other device, or the backup file.";
    view.dataset.qr = qr ? `v${qr.version}` : "none";
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied");
    } catch {
      linkField.focus();
      linkField.select();
      toast("Press Ctrl+C or ⌘C to copy");
    }
  }
  function shareLink() {
    navigator.share?.({ title: "Quran: my settings and bookmarks", url: link }).catch(() => {});
  }
  function downloadFile() {
    const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `quran-backup-${stamp()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function openFile() {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > MAX_JSON) return showError("That file is too large to be a backup.");
    const text = await f.text();
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return importText(text); // a saved link or code
    }
    offer(obj);
  }
  async function importText(text) {
    try {
      offer(await decodeCode(text));
    } catch {
      showError("That isn't a transfer link or code.");
    }
  }
  function showError(msg) {
    errorLine.textContent = msg;
  }

  // ---------- open / close (#/transfer) ----------
  function open() {
    errorLine.textContent = "";
    paste.value = "";
    if (location.hash !== "#/transfer") history.pushState({ transfer: true }, "", "#/transfer");
    if (!view.open) view.showModal();
    view.scrollTop = 0;
    renderSend();
    $(".back", view).focus();
  }
  function close() {
    if (view.open) view.close();
  }
  function back() {
    if (history.state?.transfer) history.back(); // hashchange closes the view
    else {
      history.replaceState(null, "", `#/${key(ctx.current)}`);
      close();
      ctx.settings.openSettings();
    }
  }
  view.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!confirmSheet.open) back();
  });
  window.addEventListener("hashchange", () => {
    if (location.hash === "#/transfer") return open();
    if (location.hash.startsWith("#import=")) {
      const code = location.hash.slice(8);
      history.replaceState(null, "", `#/${key(ctx.current)}`);
      return importCode(code);
    }
    if (view.open) {
      close();
      ctx.settings.openSettings();
    }
  });

  // ---------- the confirmation ----------
  let pending = null;
  const summary = h("p.imp-summary");
  const impError = h("p.tr-error", { role: "alert" });
  const mergeBtn = h("button.tr-btn.primary", { type: "button", "data-import": "merge", onclick: () => apply("merge") }, h("span", { text: "Merge" }));
  const replaceBtn = h("button.tr-btn", { type: "button", "data-import": "replace", onclick: () => apply("replace") }, h("span", { text: "Replace" }));
  const cancelBtn = h("button.tr-btn", { type: "button", "data-import": "cancel", onclick: () => confirmSheet.close() }, h("span", { text: "Cancel" }));
  const choices = h("div.imp-choices", {}, mergeBtn, replaceBtn, cancelBtn);
  confirmSheet.append(
    h("div.sheet-head", {}, h("h2#import-title", { text: "Import from another device" })),
    summary,
    h("ul.imp-help", {}, h("li", {}, h("b", { text: "Merge" }), " keeps your bookmarks and adds these, takes these settings, and keeps the newer last position."), h("li", {}, h("b", { text: "Replace" }), " makes this device exactly like the other one.")),
    impError,
    choices,
  );
  confirmSheet.addEventListener("close", () => (pending = null));

  function offer(obj) {
    let r;
    try {
      r = readPayload(obj);
    } catch {
      return showFailure("That isn't a transfer from this app.");
    }
    pending = r;
    const { incoming, version, created } = r;
    const last = incoming.last;
    summary.textContent = [plural(incoming.bookmarks.length, "bookmark"), "your settings", `last position ${chapterName(last.ch)} ${key(last)}`, `from version ${version}, created ${when(created)}`].join(" · ");
    impError.textContent = "";
    choices.hidden = false;
    if (!confirmSheet.open) confirmSheet.showModal();
    mergeBtn.focus();
  }
  function showFailure(msg) {
    pending = null;
    summary.textContent = "";
    impError.textContent = msg;
    choices.hidden = false;
    mergeBtn.hidden = replaceBtn.hidden = true;
    if (!confirmSheet.open) confirmSheet.showModal();
    cancelBtn.focus();
    confirmSheet.addEventListener("close", () => (mergeBtn.hidden = replaceBtn.hidden = false), { once: true });
  }
  async function importCode(code) {
    try {
      offer(await decodeCode(code));
    } catch {
      showFailure("This transfer link can't be read. It may have been cut short when it was copied.");
    }
  }
  function apply(mode) {
    if (!pending) return;
    const next = mergePrefs(prefs, pending.incoming, mode);
    for (const k of Object.keys(prefs)) delete prefs[k];
    Object.assign(prefs, next);
    savePrefs();
    ctx.player.pause?.();
    try {
      sessionStorage.setItem("quran.imported", mode);
    } catch {}
    // Start again from the imported prefs (theme, mode, reciter, translations, position…).
    history.replaceState(null, "", location.href.split("#")[0]);
    location.reload();
  }

  // After an import reload: say so, once.
  try {
    if (sessionStorage.getItem("quran.imported")) {
      sessionStorage.removeItem("quran.imported");
      toast("Imported");
    }
  } catch {}

  return { open, importCode, offer };
}
