/* Spectra offline shell — runtime cache, no build step.
 *
 * Same-origin GETs only, and never /__grok/* (platform install flows must
 * always reach the network). Strategy:
 *  - navigations: network-first, falling back to the cached shell when
 *    offline (analyses themselves live in component state + IndexedDB,
 *    so a reloaded-offline tab restores instantly on the next file drop).
 *  - scripts / styles / fonts / images / worker: cache-first, then network
 *    with the fresh copy stored for next time.
 * Bump CACHE when the shell contract changes.
 */
const CACHE = "spectra-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Best-effort shell prime; a failure must never block activation.
      try {
        await cache.add("/");
      } catch {
        // Offline on first visit: nothing to prime yet.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isCacheable(url) {
  if (!url.origin || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/__grok/")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isCacheable(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          const shell = await cache.match("/");
          if (shell) return shell;
          return Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) {
        // Revalidate quietly; the cached copy renders instantly either way.
        fetch(request)
          .then((fresh) => {
            if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => undefined);
          })
          .catch(() => undefined);
        return cached;
      }
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => undefined);
        return fresh;
      } catch {
        return Response.error();
      }
    })(),
  );
});

