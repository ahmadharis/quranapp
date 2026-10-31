// Runs before first paint (a classic script in <head>, so the CSP needs no inline script):
// applies the saved theme and mode so the page doesn't flash the wrong one.
try {
  const p = JSON.parse(localStorage.getItem("quran.prefs") || "{}");
  if (p.theme === "light" || p.theme === "dark") document.documentElement.dataset.theme = p.theme;
  document.documentElement.dataset.mode = p.mode === "listen" ? "listen" : "read";
  if (p.nazira === true) document.documentElement.setAttribute("data-nazira", "");
} catch {}
