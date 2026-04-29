// ---------------------------------------------------------------------------
// Claude Mobile — Service Worker
//
// Strategy: stale-while-revalidate for app-shell assets (HTML / JS / CSS /
// fonts / images), network-only for everything else (the bridge server's
// HTTP API + the WebSocket — which doesn't go through fetch at all but
// listing it for clarity).
//
// The SW is purely about installability + faster cold starts. The chat
// itself is a thin WS client over a LAN server, so there's nothing useful
// to cache for offline use beyond the static shell.
//
// NOTE: Service Workers require a secure context (HTTPS or localhost).
// When the app is opened via http://<lan-ip>:3111 the browser will refuse
// to register this SW — that's fine, the manifest + meta tags still let
// iOS Safari "Add to Home Screen" the page and run it standalone.
// ---------------------------------------------------------------------------

// The `__BUILD_ID__` placeholder is rewritten to a unique per-build id by
// scripts/build.ts after sw.js is copied into `dist/`. That guarantees every
// deploy produces a distinct SHELL_CACHE name, which in turn forces the SW
// `activate` handler to evict the previous cache and drop any stale shell
// references to hashed chunks that no longer exist on the server.
const SHELL_CACHE = 'codiby-code-mobile-shell-__BUILD_ID__';

// On install, prime the cache with the bare shell. We do best-effort here
// — failures (e.g. asset not yet in dist) shouldn't block install.
const SHELL_URLS = [
  '/m',
  '/manifest.webmanifest',
  '/brand/codiby-isotipo.jpg',
  '/brand/codiby-wordmark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_URLS).catch(() => {});
    } catch {/* ignore */}
    // Take control immediately on next load
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Wipe old caches so a new SW deployment doesn't keep stale assets
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
    // Notify every open client so they can soft-reload onto the new
    // hashed chunks instead of sitting on the stale page.
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of clients) {
      try { c.postMessage({ type: 'sw-activated', cache: SHELL_CACHE }); } catch {}
    }
  })());
});

// Allow pages to ask the waiting SW to activate immediately (no need to close
// every tab first). Paired with `registration.waiting.postMessage({type:'skip-waiting'})`
// from the registration site.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

// Fetch handler is what makes the app installable on Android Chrome.
// Strategy: stale-while-revalidate for GET requests within our origin that
// look like static assets; network-only for everything else (API calls).
function isShellAsset(url) {
  const u = new URL(url);
  if (u.origin !== self.location.origin) return false;
  if (u.pathname === '/m' || u.pathname === '/m/' || u.pathname === '/m/index.html') return true;
  if (u.pathname === '/manifest.webmanifest') return true;
  if (u.pathname.startsWith('/brand/')) return true;
  if (u.pathname.startsWith('/assets/')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!isShellAsset(req.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    // Kick off a background revalidation
    const networkP = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await networkP) || new Response('Offline', { status: 503 });
  })());
});

// Future hook: web push handler. Left as a stub so the SW is ready when /
// if we add server-sent push (vs. the current Telegram-based notify path).
self.addEventListener('push', (event) => {
  let payload = { title: 'Claude', body: 'Update from your session' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/brand/codiby-isotipo.jpg',
      badge: '/brand/codiby-isotipo.jpg',
      tag: 'claude-mobile',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => c.url.includes('/m'));
    if (existing) { existing.focus(); return; }
    await self.clients.openWindow('/m');
  })());
});
