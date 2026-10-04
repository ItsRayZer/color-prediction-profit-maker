// 01:01 Service Worker for Standalone PWA Installation
const CACHE_NAME = '0101-pwa-cache-v5';
const ASSETS_TO_CACHE = [
  '/',
  '/mobile',
  '/mobile.css',
  '/mobile.js',
  '/logo_0101.jpg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Robust cache population: follow redirects (e.g. Cloudflare Pages 308 redirects) and never abort entire install on single asset glitch
      for (const url of ASSETS_TO_CACHE) {
        try {
          const res = await fetch(url, { redirect: 'follow' });
          if (res && (res.status === 200 || res.type === 'opaque')) {
            await cache.put(url, res);
          }
        } catch (e) {
          console.warn('[PWA SW Install] Non-critical cache skip for:', url, e);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Pass Firebase RTDB, external lottery feeds, and third-party APIs directly to network
  if (url.hostname.includes('firebasedatabase.app') || 
      url.hostname.includes('lottery') || 
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('dhaniwin') ||
      url.hostname.includes('razorpay') ||
      url.hostname.includes('rzp.io')) {
    return;
  }

  // 1. Navigation requests (PWA startup, standalone launch, tab transitions)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          // Robust offline fallback: serve cached mobile view or home view without throwing ERR_FAILED
          const cache = await caches.open(CACHE_NAME);
          const cached = (await cache.match('/mobile')) ||
                         (await cache.match('/mobile.html')) ||
                         (await cache.match('/')) ||
                         (await cache.match(req));
          if (cached) return cached;
          return new Response('<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:40px;"><h2>01:01 Terminal</h2><p>Connecting to Cloudflare network...</p><button onclick="location.reload()" style="background:#0a84ff;color:#fff;border:none;padding:10px 20px;border-radius:10px;font-size:14px;cursor:pointer;">Retry</button></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 2. Static assets (CSS, JS, images, icons)
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) {
        // Stale-while-revalidate in background
        fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, networkRes));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req).catch(() => new Response('', { status: 408 }));
    })
  );
});
