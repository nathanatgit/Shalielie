const CACHE_PREFIX = "photographic-style-port-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;

// Keep this list self-contained so a successful installation guarantees that
// the converter and both supported donor profiles can run without a network.
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./profiles/index.json",
  "./profiles/45-15.zip",
  "./profiles/48-12.zip",
  "./src/box.js",
  "./src/bplist.js",
  "./src/decode.js",
  "./src/exif.js",
  "./src/heif.js",
  "./src/i18n.js",
  "./src/port.js",
  "./src/styles.js",
  "./src/zip.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Third-party requests (the optional decoder and anonymous visit counter)
  // retain their existing failure behavior and are never persisted here.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(networkFirst(request));
});
