/* Spectra offline shell — runtime cache, no build step.
 *
 * Same-origin GETs only, and never /__grok/* (platform install flows must
 * always reach the network). Strategy:
 *  - navigations: network-first, falling back to the cached shell when
 *    offline (analyses themselves live in component state + IndexedDB,
 *    so a reloaded-offline tab restores instantly on the next file drop).
 *  - scripts / styles / fonts / images / worker: cache-first, then network
 *    with the fresh copy stored for next time.
 *  - only ok (2xx) responses are ever stored, so a 5xx/404 page can never
 *    become the offline shell.
 *  - growth is bounded: every deploy ships new hashed asset names, so the
 *    cache is trimmed oldest-first to MAX_ENTRIES (on activate, and after
 *    writes inside the fetch event's lifetime via waitUntil). Revalidation
 *    re-puts each asset it serves, which moves it to the back of the
 *    insertion order — the trim is effectively LRU, and the "/" shell is
 *    never evicted.
 * Bump CACHE when the shell contract changes.
 */
const CACHE_PREFIX = "spectra-shell-";
const CACHE = `${CACHE_PREFIX}v2`;
const MAX_ENTRIES = 80;

async function trimCache() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys(); // insertion order: oldest first
  const shellUrl = new URL("/", self.location.origin).href;
  const evictable = keys.filter((req) => req.url !== shellUrl);
  const excess = keys.length - MAX_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(evictable.slice(0, excess).map((req) => cache.delete(req)));
}

// Coalesce trims: a page load stores dozens of assets in one burst. One
// trim runs at a time; puts that land while it runs request one more pass
// instead of starting their own. Every caller hands the returned promise to
// event.waitUntil, so the worker stays alive until the trim has finished
// (a bare timer could be killed with the worker before it ever fired).
let trimming = null;
let trimAgain = false;
function requestTrim() {
  if (trimming) {
    trimAgain = true;
    return trimming;
  }
  trimming = (async () => {
    try {
      do {
        trimAgain = false;
        await trimCache();
      } while (trimAgain);
    } catch {
      // Best-effort: the next write retries.
    } finally {
      trimming = null;
    }
  })();
  return trimming;
}

/** Store an ok response, then trim. Pass the result to event.waitUntil. */
function store(cache, request, response) {
  if (!response || !response.ok) return Promise.resolve();
  return cache
    .put(request, response.clone())
    .then(requestTrim)
    .catch(() => undefined);
}

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
      // Only retire our own older shells; other caches on this origin
      // (platform PWA layer) are not ours to delete.
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
      );
      await trimCache().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

function isCacheable(url) {
  if (!url.origin || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/__grok/")) return false;
  // Dynamic endpoints must never be served cache-first.
  if (/^\/(api|auth|_serverFn)(\/|$)/.test(url.pathname)) return false;
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
          // Only a healthy page may become the offline shell.
          if (fresh.ok) event.waitUntil(store(await caches.open(CACHE), request, fresh));
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
        event.waitUntil(
          fetch(request)
            .then((fresh) => store(cache, request, fresh))
            .catch(() => undefined),
        );
        return cached;
      }
      try {
        const fresh = await fetch(request);
        event.waitUntil(store(cache, request, fresh));
        return fresh;
      } catch {
        return Response.error();
      }
    })(),
  );
});
