/* ============================================================
   TAC Viewer — Service Worker
   Estrategia: Cache-First con actualización en background
   ============================================================ */

const CACHE_NAME = 'tac-viewer-v1.0.0';

const ASSETS = [
    './index.html',
    './manifest.json',
    './lib/dicom-parser.min.js',
    './lib/pako.min.js',
    './css/main.css',
    './css/layout.css',
    './css/toolbar.css',
    './css/thumbnail.css',
    './css/panels.css',
    './js/config.js',
    './js/storage.js',
    './js/colormap.js',
    './js/shaders.js',
    './js/dicom-parser-bridge.js',
    './js/dicom.worker.js',
    './js/dicom-loader.js',
    './js/measurement-store.js',
    './js/tool-state.js',
    './js/tools-basic.js',
    './js/tools-measure.js',
    './js/tools-annotate.js',
    './js/renderer-gl.js',
    './js/overlay-renderer.js',
    './js/viewport.js',
    './js/viewport-layout.js',
    './js/series-panel.js',
    './js/mpr-volume.js',
    './js/mpr-viewport.js',
    './js/metadata-panel.js',
    './js/export.js',
    './js/ui.js',
    './js/app.js',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then((cached) => {
            const network = fetch(e.request).then((res) => {
                if (res.ok) {
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, res.clone()));
                }
                return res;
            }).catch(() => {});
            return cached || network;
        })
    );
});

self.addEventListener('message', (e) => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
