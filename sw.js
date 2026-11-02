// Service worker: lets the installed app open offline, and never mixes two versions.
// - The app shell (page, CSS, JS, manifest, ManzoorNaskh, icons) is one versioned snapshot:
//   precached on install straight from the network ({cache: "reload"}, past the HTTP cache)
//   and served cache-first — the page and its modules always come from the same deploy. The
//   cache name carries the commit (stamped in by the Pages workflow); a new deploy installs a
//   new snapshot in the background, which the next visit uses.
// - Fonts and icons fetched later (the 13.8 MB Urdu font only once Urdu is shown): cache first.
// - Word timings (data/words/…), verse durations (data/durations/…) and anything else:
//   network first, cached copy offline.
// - Local development (the unstamped development cache): network first for everything, so
//   edits show at once while offline still works.
// - Quran text is cached by the app itself (IndexedDB). Recitation audio streams from
//   files.alislam.cloud and is not intercepted.

// The deploy replaces "quran-dev" with "quran-<commit>"; the version in the name means a
// version bump always starts a fresh cache.
const CACHE = "quran-dev-v1.3.0";
const NETWORK_TIMEOUT_MS = 3000;
const SHELL = [
  "./",
  "index.html",
  "css/app.css",
  "js/boot.js",
  "js/app.js",
  "js/version.js",
  "js/install.js",
  "js/durations.js",
  "js/bookmarks.js",
  "js/transfer.js",
  "js/swipe.js",
  "js/qr.js",
  "js/api.js",
  "js/artwork.js",
  "js/layout.js",
  "js/listen.js",
  "js/nav.js",
  "js/panel.js",
  "js/prefs.js",
  "js/reader.js",
  "js/settings.js",
  "js/util.js",
  "js/words.js",
  "js/mp3.js",
  "js/player.js",
  "js/quran-data.js",
  "manifest.webmanifest",
  "assets/fonts/ManzoorNaskh.ttf",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];
const IMMUTABLE = /\/(assets|icons)\//;
const DEV = CACHE.startsWith("quran-" + "dev"); // split so the deploy stamp leaves it alone
const shellUrls = new Set(SHELL.map((u) => new URL(u, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(
          SHELL.map(async (u) => {
            const res = await fetch(new Request(u, { cache: "reload" }));
            if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
            await c.put(u, res);
          }),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const shell = req.mode === "navigate" || shellUrls.has(url.origin + url.pathname);
  if (DEV) return event.respondWith(networkFirst(event, req));
  if (shell) {
    const key = req.mode === "navigate" ? "index.html" : req; // every page is the app page
    event.respondWith(caches.match(key, { ignoreSearch: true }).then((hit) => hit || networkFirst(event, req)));
    return;
  }
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetchAndKeep(event, req)));
    return;
  }
  event.respondWith(networkFirst(event, req));
});

function fetchAndKeep(event, req) {
  return fetch(req).then((res) => {
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
    }
    return res;
  });
}

// Network, falling back to the cached copy (after NETWORK_TIMEOUT_MS on a weak signal). A page
// navigation falls back to the cached app page.
async function networkFirst(event, req) {
  const cached = async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("index.html") : undefined);
  const network = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "index.html" : req, copy)));
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    return (await cached()) || (await network);
  } catch {
    return (await cached()) || Response.error();
  }
}
