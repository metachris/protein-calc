/* Service worker — exists so the app can be installed to a phone's home screen
   and still open with no network.

   The app is one HTML file, so the strategy is deliberately small:

     navigations  -> network first, cache the fresh copy, fall back to the cached
                     page offline. An edit to index.html therefore lands on the
                     next launch; there is no cache version to remember to bump.
     same-origin  -> cache first (icons, manifest), refreshed in the background.
     cross-origin -> not touched at all. The USDA lookup must never be served
                     from cache, and its responses are already saved to
                     localStorage by the page itself.  */

const CACHE = "protein-calc-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 cannot fail the whole install.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => { }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // USDA API and anything else: straight to the network

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then(hit => hit || caches.match("./")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => {
      const fresh = fetch(req)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
