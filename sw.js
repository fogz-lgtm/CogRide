// Service worker (CogRide, or FluxRide under flux/): the app opens instantly
// and works offline from a cached copy of this build. A new deploy installs
// alongside and waits; the page offers "Update ready" between rides and only
// then switches over, so an update never reloads the app mid-ride.
//
// Both apps share one site, so each touches only its own caches, and
// CogRide's worker leaves pages of the nested app alone.
const BUILD = '__BUILD__';
const APP_ID = '__APP__';
const CACHE = `${APP_ID}-${BUILD}`;
const SHELL_FILES = "__SHELL_FILES__";
const FONT_CACHE = `${APP_ID}-fonts`;
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(`${APP_ID}-`) && k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Only this app's own page; any other page on the site (FluxRide under
    // flux/, say) loads from the network until its own worker takes over.
    if (request.mode === 'navigate' && url.pathname !== SCOPE && url.pathname !== `${SCOPE}index.html`) return;
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const key = request.mode === 'navigate' ? './index.html' : request;
        // Module URLs carry ?v=<build>; this cache is already per build.
        const hit = await cache.match(key, { ignoreSearch: true });
        return hit || fetch(request);
      })(),
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
        return response;
      })(),
    );
  }
  // Everything else (Strava) goes straight to the network.
});
