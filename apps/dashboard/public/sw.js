/* Service worker: Web Push notifications and the offline shell. */

const STATIC_CACHE = "ct-static-v2";
const PAGE_CACHE = "ct-pages-v2";
const OFFLINE_URL = "/offline.html";
const PRECACHE = ["/", "/chats", OFFLINE_URL];

// Local development reuses some Next chunk URLs between recompiles, so a
// cache-first SW would pin an old bundle until the SW is unregistered (stale
// UI after every edit). On local hosts static assets go network-first and the
// cache is only the offline fallback; production keeps cache-first for
// immutable hashed chunks.
const IS_LOCAL_HOST =
  self.location.hostname === "localhost" ||
  self.location.hostname === "127.0.0.1" ||
  self.location.hostname === "[::1]" ||
  self.location.hostname === "::1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGE_CACHE);
      // One failed path must not abort the install: /chats is not statically
      // generated and may answer a redirect in some deployments.
      await Promise.all(
        PRECACHE.map((url) => cache.add(url).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([STATIC_CACHE, PAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isPrivatePath(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/accounts") ||
    url.pathname.startsWith("/logs")
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/** Network-first variant for dev, where chunk URLs are not immutable. */
async function networkFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(PAGE_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached || (await network) || (await cache.match(OFFLINE_URL));
}

async function networkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match(OFFLINE_URL));
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivatePath(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      url.pathname === "/chats"
        ? networkFirst(request)
        : staleWhileRevalidate(request),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      IS_LOCAL_HOST ? networkFirstStatic(request) : cacheFirst(request),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "CombainTelegram",
      body: event.data ? event.data.text() : "",
    };
  }

  const title = data.title || "CombainTelegram";
  const chatId = data.chatId;
  const url = chatId ? `/chats?chat=${encodeURIComponent(chatId)}` : "/chats";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || (chatId ? `chat:${chatId}` : "combain"),
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url || "/chats",
    self.location.origin,
  ).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        const clientUrl = new URL(client.url);
        if (
          clientUrl.origin === self.location.origin &&
          clientUrl.pathname === "/chats"
        ) {
          if ("navigate" in client) await client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
