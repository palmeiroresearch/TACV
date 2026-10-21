'use strict';

/* ============================================================
   TAC Viewer — Service Worker
   Estrategia: Cache-First agresivo.
   - Install: pre-cachea TODOS los assets estáticos
   - Activate: limpia caches viejos y reclama clientes
   - Fetch: sirve desde cache; actualiza en background
   - Message: SKIP_WAITING para activar update aprobado por usuario
   ============================================================ */

const CACHE_VERSION = 'v1.6.1';
const CACHE_NAME    = `tac-viewer-${CACHE_VERSION}`;

/* ── Modo investigación: congelación de actualizaciones ──────
   Mientras esté activo, el SW NO revalida en segundo plano. Sin esto, la
   estrategia cache-first reescribe la caché en silencio y la siguiente
   recarga cambia el código de la app a mitad de una sesión de medición,
   con lo que la versión sellada en las mediciones ya no sería la que las
   produjo.

   El flag se PERSISTE en la caché porque un service worker se detiene y
   reinicia cuando el navegador quiere: una variable de módulo se perdería
   y la congelación se levantaría sola sin que el usuario lo sepa.
   ──────────────────────────────────────────────────────────── */
const FREEZE_FLAG_URL = './__research_frozen';

let _frozen     = null;   // null = aún no leído de la caché
let _frozenRead = null;   // promesa de la lectura en curso

function getFrozen() {
    if (_frozen !== null) return Promise.resolve(_frozen);
    if (_frozenRead) return _frozenRead;
    _frozenRead = caches.open(CACHE_NAME)
        .then((c) => c.match(FREEZE_FLAG_URL))
        .then((res) => { _frozen = !!res; return _frozen; })
        .catch(() => { _frozen = false; return false; });
    return _frozenRead;
}

async function setFrozen(on) {
    _frozen = !!on;
    _frozenRead = Promise.resolve(_frozen);
    try {
        const c = await caches.open(CACHE_NAME);
        if (on) await c.put(FREEZE_FLAG_URL, new Response('1'));
        else    await c.delete(FREEZE_FLAG_URL);
    } catch { /* si la caché falla, queda el flag en memoria */ }
}

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
    './css/research.css',
    './css/detector.css',
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
    './js/research-core.js',
    './js/detect-core.js',
    './js/measurement-store.js',
    './js/tool-state.js',
    './js/tools-basic.js',
    './js/tools-measure.js',
    './js/tools-annotate.js',
    './js/research-mode.js',
    './js/tools-nwu.js',
    './js/detector.js',
    './js/detect-worker.js',
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
    './js/research-panel.js',
    './js/detector-panel.js',
    './js/export.js',
    './js/tv-worker.js',
    './js/case-library.js',
    './js/loupe.js',
    './js/ui.js',
    './js/app.js',
    /* ── Íconos PWA ── */
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-192.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png',
    './icons/favicon-16.png',
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

    e.respondWith((async () => {
        const cached = await caches.match(e.request);

        if (cached) {
            // Con el modo investigación activo se sirve SOLO desde caché:
            // ninguna actualización puede entrar sin confirmación del usuario.
            if (await getFrozen()) return cached;

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
        const res = await fetch(e.request);
        if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return res;
    })());
});

/* ── Message: SKIP_WAITING (aprobado por usuario) ────────── */
self.addEventListener('message', (e) => {
    const data = e.data || {};

    if (data.type === 'SKIP_WAITING') {
        // Última barrera: nunca activar un SW nuevo con el modo investigación
        // congelado, aunque algo en la app haya dejado pasar la petición.
        e.waitUntil(getFrozen().then((frozen) => {
            if (frozen) {
                console.warn('[SW] SKIP_WAITING ignorado: modo investigación activo');
                return;
            }
            self.skipWaiting();
        }));
        return;
    }

    if (data.type === 'GET_VERSION') {
        e.waitUntil(getFrozen().then((frozen) => {
            e.ports[0]?.postMessage({ version: CACHE_VERSION, frozen });
        }));
        return;
    }

    if (data.type === 'RESEARCH_FREEZE') {
        e.waitUntil(setFrozen(true).then(() =>
            console.log('[SW] Modo investigación: actualizaciones automáticas congeladas')));
        return;
    }

    if (data.type === 'RESEARCH_UNFREEZE') {
        e.waitUntil(setFrozen(false).then(() =>
            console.log('[SW] Modo investigación desactivado: actualizaciones reanudadas')));
    }
});
