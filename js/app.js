'use strict';

/* ============================================================
   app.js — Punto de entrada: init, orquestación, eventos globales
   ============================================================ */

(async function init() {
    // Banner informativo en iOS — fixed sobre el status bar, no afecta el grid
    if (typeof Capabilities !== 'undefined' && Capabilities.isIOS) {
        const banner = document.createElement('div');
        banner.className = 'caps-warning';
        banner.textContent = 'iPad/iOS: MPR y filtros avanzados desactivados · W/L: herramienta W + arrastrar';
        document.body.appendChild(banner);
    }

    // Storage + session ID
    await Storage.initDB();
    const sessionId = 'session_' + Date.now();
    MeasurementStore.init(sessionId);
    await MeasurementStore.restore(sessionId);

    // Layout inicial
    ViewportLayout.init('1x1');

    // Metadata panel — la lógica de collapse en táctiles está en MetadataPanel.init()
    MetadataPanel.init();

    // Measurements panel
    MeasurementsPanel.init();

    // Histogram panel
    HistogramPanel.init();

    // Worker pool para parseo DICOM
    DicomLoader.init();

    // Toolbar buttons
    UI.wireToolbar();
    UI.applySettings();

    // Tool inicial
    ToolState.setTool(TOOL_IDS.WINDOWING);

    // Preset inicial
    const presetSel = document.getElementById('presetSelect');
    if (presetSel) presetSel.value = DEFAULT_PRESET;

    // Keyboard shortcuts globales
    document.addEventListener('keydown', (e) => ToolState.onKeyDown(e));

    // Navegar slices (desde ToolState / SeriesPanel)
    Storage.on('navigateSlice', ({ delta }) => {
        SeriesPanel.navigateDelta(delta);
    });

    // Cambio de serie (desde SeriesManager tabs)
    Storage.on('seriesChanged', ({ idx }) => {
        _activateSeries(idx);
        SeriesManager.renderTabs();
    });

    // Drag-drop + file picker
    DicomLoader.setupDragDrop(loadFiles);

    // Restaurar sesión si existe
    const session = await Storage.loadSession();
    if (session) {
        applySession(session);
    }

    // Service Worker
    registerSW();

    console.log(`TAC Viewer v${APP_VERSION} — listo`);
})();

/* ── Cargar archivos DICOM ──────────────────────────────── */
async function loadFiles(files) {
    document.getElementById('welcomeScreen')?.remove();
    UI.showLoadingBar();

    const allFrames = await DicomLoader.loadFiles(files, {
        onProgress: (loaded, total) => UI.updateLoadingBar(loaded, total),
        onFrameLoaded: (frame, idx) => {
            if (idx === 0) {
                const vp = ViewportLayout.getActive();
                if (vp) vp.loadFrame(frame, 0, 1);
            }
        },
    });

    UI.hideLoadingBar();

    if (!allFrames?.length) {
        UI.showToast('No se encontraron frames DICOM válidos', 'error');
        return;
    }

    // Agrupar por SeriesInstanceUID (tag x0020000e)
    const byUID = new Map();
    allFrames.forEach(frame => {
        const uid = frame.allTags?.['x0020000e'] || 'default';
        if (!byUID.has(uid)) byUID.set(uid, []);
        byUID.get(uid).push(frame);
    });

    // Añadir cada serie al SeriesManager
    let firstSeriesIdx = -1;
    byUID.forEach((frames, uid) => {
        const idx = SeriesManager.add(frames);
        if (firstSeriesIdx === -1) firstSeriesIdx = idx;
    });

    SeriesManager.renderTabs();

    // Cargar la primera serie nueva
    _activateSeries(firstSeriesIdx === -1 ? 0 : firstSeriesIdx);

    const total = allFrames.length;
    const seriesCount = byUID.size;
    UI.showToast(
        `${total} imágenes cargadas${seriesCount > 1 ? ` en ${seriesCount} series` : ''} — ${allFrames[0].patientName || ''}`,
        'success', 4000
    );
}

/* ── Activar una serie por índice en SeriesManager ─────── */
function _activateSeries(idx) {
    SeriesManager.setActive(idx);
    const entry  = SeriesManager.getActive();
    if (!entry) return;
    const series = entry.frames;

    SeriesPanel.init(series);
    const vp = ViewportLayout.getActive();
    if (vp) {
        vp.loadFrame(series[0], 0, series.length);
        vp.fitToWindow();
        vp.render();
    }

    MetadataPanel.show(series[0]);
    MprVolume.setSeries(series);

    Storage.saveSession({
        sliceIndex: 0,
        windowWidth:  vp?.state.windowWidth,
        windowCenter: vp?.state.windowCenter,
        zoom: 1, panX: 0, panY: 0,
    });
}

/* ── Aplicar estado de sesión guardado ──────────────────── */
function applySession(session) {
    const vp = ViewportLayout.getActive();
    if (!vp || !session) return;
    if (session.windowWidth)  vp.state.windowWidth  = session.windowWidth;
    if (session.windowCenter) vp.state.windowCenter = session.windowCenter;
    if (session.zoom)   vp.state.zoom = session.zoom;
    if (session.panX != null) vp.state.panX = session.panX;
    if (session.panY != null) vp.state.panY = session.panY;
}

/* ── Service Worker ─────────────────────────────────────── */
function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then((registration) => {
            // Forzar chequeo inmediato de nueva versión en cada apertura
            registration.update().catch(() => {});

            // ¿Ya hay un SW esperando? (tab estaba abierta durante install)
            if (registration.waiting) {
                _showUpdateBanner(registration);
                return;
            }

            // Detectar nuevo SW mientras la app está abierta
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                if (!newWorker) return;
                newWorker.addEventListener('statechange', () => {
                    // "installed" + hay un controller = nuevo SW listo, esperando aprobación
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        _showUpdateBanner(registration);
                    }
                    // Primera instalación: activar sin preguntar
                    if (newWorker.state === 'activated' && !navigator.serviceWorker.controller) {
                        console.log('[SW] Primera instalación — app lista para uso offline');
                    }
                });
            });
        })
        .catch((err) => console.warn('[SW] Registro fallido:', err));

    // Cuando el nuevo SW toma control → recargar para usar los assets nuevos
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
    });
}

function _showUpdateBanner(registration) {
    const banner = document.getElementById('swUpdateBanner');
    if (!banner || !banner.classList.contains('hidden')) return;
    banner.classList.remove('hidden');

    const btnNow    = document.getElementById('btnSwUpdateNow');
    const btnLater  = document.getElementById('btnSwUpdateLater');

    const doUpdate = () => {
        banner.classList.add('hidden');
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    };
    const dismiss = () => banner.classList.add('hidden');

    btnNow?.addEventListener('click',   doUpdate, { once: true });
    btnLater?.addEventListener('click', dismiss,  { once: true });
}

/* ── PWA Install prompt ─────────────────────────────────── */
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPrompt = e;
    document.getElementById('btnInstallPwa')?.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
    _installPrompt = null;
    document.getElementById('btnInstallPwa')?.classList.add('hidden');
    UI.showToast('App instalada — funciona completamente offline', 'success', 4000);
});

function triggerInstall() {
    if (!_installPrompt) return;
    _installPrompt.prompt();
    _installPrompt.userChoice.then(() => {
        _installPrompt = null;
        document.getElementById('btnInstallPwa')?.classList.add('hidden');
    });
}
