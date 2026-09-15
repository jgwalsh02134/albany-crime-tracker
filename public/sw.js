/* eslint-disable no-restricted-globals */
// Minimal PWA service worker:
// - keeps installability on Chromium
// - does not pretend "Live" works offline (navigation falls back to offline.html)
// - avoids caching API responses (network-only)

const VERSION = "pwa-v1";
const STATIC_CACHE = `static-${VERSION}`;

const STATIC_ASSETS = [
  "/offline.html",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/maskable-192.png",
  "/maskable-512.png",
  "/__grok/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(STATIC_ASSETS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("static-") && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isSameOrigin(url) {
  try {
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}

function isApiPath(url) {
  return url.pathname.startsWith("/api/");
}

function isInternalPath(url) {
  return url.pathname.startsWith("/__grok/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (!isSameOrigin(url)) return;

  // Never cache API routes: live data must be honest/networked.
  if (isApiPath(url)) return;

  // Navigation requests: try network first; if offline, show an honest fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match("/offline.html")) || Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first with update-once behavior.
  const isStaticLike =
    req.destination === "style" ||
    req.destination === "script" ||
    req.destination === "image" ||
    req.destination === "font" ||
    isInternalPath(url);

  if (!isStaticLike) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      // Avoid caching opaque / error responses.
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })(),
  );
});

// Web Push MVP: show a notification with a deep link.
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = null;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = { title: "Albany Watch", body: (event.data && typeof event.data.text === "function" ? event.data.text() : "") };
      }
      const title = String(data?.title || "Albany Watch").slice(0, 120);
      const body = String(data?.body || "").slice(0, 240);
      const url = String(data?.url || "/").trim() || "/";
      const tag = String(data?.tag || "").slice(0, 120) || undefined;
      await self.registration.showNotification(title, {
        body,
        tag,
        data: { url },
        icon: "/icon-192.png",
        badge: "/favicon-32.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        try {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        } catch {
          // keep searching
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});

