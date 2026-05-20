'use strict';

/* ============================================================
   TAC Viewer — Service Worker
   Estrategia: Cache-First agresivo.
   - Install: pre-cachea TODOS los assets estáticos
   - Activate: limpia caches viejos y reclama clientes
   - Fetch: sirve desde cache; actualiza en background
   - Message: SKIP_WAITING para activar update aprobado por usuario
   ============================================================ */

const CACHE_VERSION = 'v1.4.2';
const CACHE_NAME    = `tac-viewer-${CACHE_VERSION}`;

const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    /* ── Librerías externas ── */
    './lib/dicom-parser.min.js',
    './lib/pako.min.js',
    /* ── Fuentes self-hosted ── */
    './css/fonts/inter-latin.woff2',
    './css/fonts/inter-latin-ext.woff2',
    /* ── CSS ── */
    './css/main.css',
    './css/layout.css',
    './css/toolbar.css',
    './css/thumbnail.css',
    './css/panels.css',
    /* ── JS — en orden de dependencias ── */
    './js/capabilities.js',
    './js/config.js',
    './js/storage.js',
    './js/colormap.js',
    './js/shaders.js',
    './js/filter-shaders.js',
    './js/dicom-parser-bridge.js',
    './js/dicom-loader.js',
    './js/dicom.worker.js',
    './js/measurement-store.js',
    './js/tool-state.js',
    './js/tools-basic.js',
    './js/tools-measure.js',
    './js/tools-annotate.js',
    './js/post-processor.js',
    './js/renderer-gl.js',
    './js/overlay-renderer.js',
    './js/viewport.js',
    './js/viewport-layout.js',
    './js/series-panel.js',
    './js/series-manager.js',
    './js/mpr-volume.js',
    './js/mpr-viewport.js',
    './js/metadata-panel.js',
    './js/measurements-panel.js',
    './js/histogram-panel.js',
    './js/export.js',
    './js/tv-worker.js',
    './js/case-library.js',
    './js/ui.js',
    './js/app.js',
    /* ── Íconos PWA ── */
    './icons/icon-192.png',
    './icons/icon-512.png',
];

/* ── Install: pre-cachear todo ───────────────────────────── */
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => {
                // No hacemos skipWaiting aquí — esperamos aprobación del usuario
                // excepto en la primera instalación (sin controller previo)
            })
    );
});

/* ── Activate: limpiar caches viejos ─────────────────────── */
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((k) => k.startsWith('tac-viewer-') && k !== CACHE_NAME)
                    .map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

/* ── Fetch: Cache-First ───────────────────────────────────── */
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    // Peticiones a otros orígenes (CDN externas, etc.) — pass-through
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;

    e.respondWith(
        caches.match(e.request).then((cached) => {
            if (cached) {
                // Servir desde cache; actualizar en background silenciosamente
                fetch(e.request)
                    .then((res) => {
                        if (res.ok) {
                            caches.open(CACHE_NAME).then((c) => c.put(e.request, res.clone()));
                        }
                    })
                    .catch(() => {});
                return cached;
            }
            // No está en cache → ir a red y cachear
            return fetch(e.request).then((res) => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});

/* ── Message: SKIP_WAITING (aprobado por usuario) ────────── */
self.addEventListener('message', (e) => {
    if (e.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    // Responder con la versión actual (para futuros checks manuales)
    if (e.data?.type === 'GET_VERSION') {
        e.ports[0]?.postMessage({ version: CACHE_VERSION });
    }
});
