// Bookmarks: verses saved on this device (prefs, localStorage), newest first.

import { prefs, savePrefs } from "./prefs.js";

export const bookmarks = new EventTarget(); // "change"

export const isBookmarked = ({ ch, v }) => prefs.bookmarks.some((b) => b.ch === ch && b.v === v);

// Adds or removes the verse; returns true when it is now bookmarked.
export function toggleBookmark({ ch, v }) {
  const on = !isBookmarked({ ch, v });
  if (on) prefs.bookmarks.unshift({ ch, v, at: Date.now() });
  else prefs.bookmarks = prefs.bookmarks.filter((b) => !(b.ch === ch && b.v === v));
  savePrefs();
  bookmarks.dispatchEvent(new Event("change"));
  return on;
}
