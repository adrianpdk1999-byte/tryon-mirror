// Offline support: keeps the app and the face AI on the tablet after the first load.
const VERSION = "tryon-v1";
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const APP = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
const AI = [
  `${MP}/vision_bundle.mjs`,
  `${MP}/wasm/vision_wasm_internal.js`, `${MP}/wasm/vision_wasm_internal.wasm`,
  `${MP}/wasm/vision_wasm_nosimd_internal.js`, `${MP}/wasm/vision_wasm_nosimd_internal.wasm`,
  MODEL,
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(APP);
    // AI files are large; cache each one, ignore individual failures (they are cached on first use anyway)
    await Promise.all(AI.map(u => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isApp = url.origin === location.origin;
  const isAI = url.href.startsWith(MP) || url.href === MODEL;
  if (!isApp && !isAI) return;

  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = isApp && (url.pathname.endsWith("/") || req.mode === "navigate") ? "index.html" : req;
    const hit = await c.match(key, { ignoreSearch: isApp });
    if (isApp) {
      // app files: use cache, refresh in background when online
      const net = fetch(req).then(r => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response("Offline", { status: 503 });
    }
    if (hit) return hit;                       // AI files never change for a pinned version
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  })());
});
