// Now-playing artwork for the lock screen and car: one card per chapter, drawn on a canvas —
// lapis ground, gold frame, the eight-pointed star, the chapter's Arabic name in ManzoorNaskh,
// "Chapter N" and the parts it spans. Small sizes show just the name and number. Drawn once per
// chapter (after the font has loaded) and kept as blob URLs; it never changes between verses.

import { chapterArabic, partsLabel } from "./util.js";

const SIZES = [96, 256, 512];
const LAPIS = "#1F3A68";
const GOLD = "#D9B45A";
const GOLD_TEXT = "#E6C77A";
const NAME = "#F4EDDD";
const SUB = "#C9D3E6";
const UI_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif`;

const cache = new Map(); // ch -> Promise<[{src, sizes, type}]>

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}

// Two overlapping squares, the figure of Quran illumination.
function star(g, cx, cy, r) {
  g.save();
  g.translate(cx, cy);
  for (const a of [0, Math.PI / 4]) {
    g.rotate(a);
    roundRect(g, -r * 0.72, -r * 0.72, r * 1.44, r * 1.44, r * 0.12);
    g.fill();
  }
  g.restore();
}

// Shrinks the font until the text fits the width.
function fit(g, text, font, size, max) {
  let s = size;
  g.font = font(s);
  while (s > 8 && g.measureText(text).width > max) g.font = font((s *= 0.92));
  return s;
}

function draw(ch, s) {
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  const small = s < 160;
  g.fillStyle = LAPIS;
  g.fillRect(0, 0, s, s); // square: the system rounds the corners itself
  const inset = Math.round(s * 0.06);
  g.strokeStyle = GOLD;
  g.lineWidth = Math.max(1.5, s * 0.008);
  roundRect(g, inset, inset, s - 2 * inset, s - 2 * inset, s * 0.06);
  g.stroke();

  g.fillStyle = GOLD;
  star(g, s / 2, s * (small ? 0.2 : 0.25), s * (small ? 0.06 : 0.05));

  g.textAlign = "center";
  g.textBaseline = "middle";
  g.direction = "rtl";
  g.fillStyle = NAME;
  const name = chapterArabic(ch);
  fit(g, name, (z) => `${z}px ManzoorNaskh`, s * (small ? 0.26 : 0.2), s * 0.76);
  g.fillText(name, s / 2, s * (small ? 0.52 : 0.5));

  g.direction = "ltr";
  g.fillStyle = GOLD_TEXT;
  if (small) {
    g.font = `700 ${Math.max(11, Math.round(s * 0.14))}px ${UI_FONT}`;
    g.fillText(String(ch), s / 2, s * 0.8);
  } else {
    g.font = `700 ${Math.round(s * 0.068)}px ${UI_FONT}`;
    g.fillText(`Chapter ${ch}`, s / 2, s * 0.72);
    g.fillStyle = SUB;
    g.font = `500 ${Math.round(s * 0.05)}px ${UI_FONT}`;
    g.fillText(partsLabel(ch), s / 2, s * 0.8);
  }
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
}

// Resolves with Media Session artwork entries for the chapter.
export function chapterArtwork(ch) {
  if (cache.has(ch)) {
    const hit = cache.get(ch);
    cache.delete(ch); // most recently used last
    cache.set(ch, hit);
    return hit;
  }
  const p = (async () => {
    try {
      await document.fonts.load("40px ManzoorNaskh", chapterArabic(ch));
    } catch {}
    const out = [];
    for (const s of SIZES) {
      const blob = await draw(ch, s);
      if (blob) out.push({ src: URL.createObjectURL(blob), sizes: `${s}x${s}`, type: "image/png" });
    }
    return out;
  })();
  cache.set(ch, p);
  p.catch(() => cache.delete(ch));
  // Keep the last few chapters only.
  while (cache.size > 6) {
    const [old, op] = cache.entries().next().value;
    cache.delete(old);
    op.then((list) => list.forEach((a) => URL.revokeObjectURL(a.src)), () => {});
  }
  return p;
}
