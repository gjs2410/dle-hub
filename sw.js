// DLE Hub service worker — offline app shell.
// Strategy: network-first for same-origin (so code/data updates are picked up as
// soon as you're online), falling back to the cache when offline.
const CACHE = "dle-hub-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./games.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only manage same-origin requests. Cross-origin (cdn thumbnails, favicons)
  // pass straight through to the network — they simply won't work offline.
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) =>
          cached || (req.mode === "navigate" ? caches.match("./index.html") : undefined)
        )
      )
  );
});
