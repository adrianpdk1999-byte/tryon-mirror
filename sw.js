// Offline support: keeps the app and the face AI on the device after the first load.
const APP_CACHE = "app-v2";          // bump this after changing index.html
const AI_CACHE = "ai-v1";            // AI files are pinned to one version; no need to bump
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
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP);
    const ai = await caches.open(AI_CACHE);
    // carry AI files over from the old single cache, then fetch anything missing
    const old = await caches.has("tryon-v1") ? await caches.open("tryon-v1") : null;
    await Promise.all(AI.map(async u => {
      if (await ai.match(u)) return;
      const prev = old && await old.match(u);
      if (prev) return ai.put(u, prev);
      return ai.add(new Request(u, { mode: "cors" })).catch(() => {});
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP_CACHE && k !== AI_CACHE) await caches.delete(k);
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
    if (isAI) {
      const ai = await caches.open(AI_CACHE);
      const hit = await ai.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) ai.put(req, r.clone());
      return r;
    }
    // app files: network first (so updates show at once), cache when offline
    const app = await caches.open(APP_CACHE);
    const key = url.pathname.endsWith("/") || req.mode === "navigate" ? "index.html" : req;
    try {
      const r = await fetch(req);
      if (r.ok) app.put(key, r.clone());
      return r;
    } catch (err) {
      return (await app.match(key, { ignoreSearch: true })) || new Response("Offline", { status: 503 });
    }
  })());
});
