/* WebAuth Vault — offline service worker
 *
 * SECURITY: Cache versioning — increment CACHE_NAME on every security update
 * to ensure clients receive patched code promptly. The 'activate' handler
 * deletes old caches so stale JavaScript is not served indefinitely.
 */
const CACHE_NAME = 'webauth-v6';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  // SECURITY: webcrypto-fallback.js is now a fail-closed guard (no CryptoJS)
  './webcrypto-fallback.js',
  './secret-store.js',
  './google-auth-proto.js',
  './crypto-vault.js',
  './qr-helper.js',
  './file-sync.js',
  './p2p-sync-trystero.js',
  './app.js',
  './ui-shell.js',
  // SECURITY: Dependencies vendored locally — no CDN JavaScript
  './vendor/otpauth-9.3.1.umd.min.js',
  './vendor/jsqr-1.4.0.js',
  // P2P Trystero strategies (bundled single-file ESM) — cached for offline sync
  './vendor/trystero-esm/trystero-torrent.mjs',
  './vendor/trystero-esm/trystero-nostr.mjs'
];

// SECURITY: Only cache same-origin assets. External CDN caching removed
// to prevent stale third-party JavaScript from being served.
// Google Fonts CSS is not executable JavaScript and is low-risk.
const CACHEABLE_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  // SECURITY: Delete ALL old caches to prevent stale code from being served
  // after a security update.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCacheableCdn = CACHEABLE_ORIGINS.includes(url.hostname);
  if (!isSameOrigin && !isCacheableCdn) return;

  // App navigations: network-first so updates propagate, cache as offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
