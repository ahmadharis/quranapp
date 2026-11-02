// Swipe sideways on the page (touch screens) to change chapter. The Quran is read right to
// left, so, as when turning a page of a mushaf, swiping right brings the next chapter and
// swiping left the previous one.

const MIN_DX = 70; // px the finger travels sideways
const SLOPE = 1.8; // sideways at least this many times its vertical travel
const MAX_MS = 700; // a flick, not a slow drag
const EDGE = 24; // px at the screen edges left to the system's back/forward gestures
// Places where a sideways drag already means something else.
const IGNORE = "input, textarea, select, button, a, [role=slider], .qp, .qp-seek, dialog, .contents, .side, .follow-chip";

export function initSwipe(ctx, area) {
  let start = null;
  area.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      start =
        e.touches.length === 1 && t.clientX > EDGE && t.clientX < innerWidth - EDGE && !e.target.closest(IGNORE)
          ? { x: t.clientX, y: t.clientY, at: e.timeStamp }
          : null;
    },
    { passive: true },
  );
  area.addEventListener("touchmove", (e) => e.touches.length > 1 && (start = null), { passive: true });
  area.addEventListener(
    "touchend",
    (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = e.timeStamp - start.at < MAX_MS;
      start = null;
      if (!quick || Math.abs(dx) < MIN_DX || Math.abs(dx) < SLOPE * Math.abs(dy)) return;
      if (document.querySelector("dialog[open]") || !getSelection().isCollapsed) return;
      ctx.swipeChapter(dx > 0 ? 1 : -1);
    },
    { passive: true },
  );
  area.addEventListener("touchcancel", () => (start = null), { passive: true });
}
