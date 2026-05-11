'use strict';

/* ============================================================
   app.js — Punto de entrada: init, orquestación, eventos globales
   ============================================================ */

(async function init() {
    // Storage + session ID
    await Storage.initDB();
    const sessionId = 'session_' + Date.now();
    MeasurementStore.init(sessionId);
    await MeasurementStore.restore(sessionId);

    // Layout inicial
    ViewportLayout.init('1x1');

    // Metadata panel
    MetadataPanel.init();

    // Measurements panel
    MeasurementsPanel.init();

    // Worker pool para parseo DICOM
    DicomLoader.init();

    // Toolbar buttons
    UI.wireToolbar();
    UI.applySettings();

    // Tool inicial
    ToolState.setTool(TOOL_IDS.WINDOWING);

    // Preset inicial
    document.querySelector('.preset-btn[data-preset="brain"]')?.classList.add('active');

    // Keyboard shortcuts globales
    document.addEventListener('keydown', (e) => ToolState.onKeyDown(e));

    // Navegar slices (desde ToolState / SeriesPanel)
    Storage.on('navigateSlice', ({ delta }) => {
        SeriesPanel.navigateDelta(delta);
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

    let firstFrame = null;

    const series = await DicomLoader.loadFiles(files, {
        onProgress: (loaded, total) => {
            UI.updateLoadingBar(loaded, total);
        },
        onFrameLoaded: (frame, idx) => {
            // Mostrar el primer frame inmediatamente
            if (idx === 0) {
                firstFrame = frame;
                const vp = ViewportLayout.getActive();
                if (vp) vp.loadFrame(frame, 0, 1);
            }
        },
    });

    UI.hideLoadingBar();

    if (!series || series.length === 0) {
        UI.showToast('No se encontraron frames DICOM válidos', 'error');
        return;
    }

    // Cargar serie en panel y viewport
    SeriesPanel.init(series);
    const vp = ViewportLayout.getActive();
    if (vp) {
        vp.loadFrame(series[0], 0, series.length);
        vp.fitToWindow();
        vp.render();
    }

    // Metadata del primer frame
    MetadataPanel.show(series[0]);

    // Preparar buffer CPU para MPR (sincrónico — ~50ms para 40 frames)
    // La subida a GPU ocurre lazy la primera vez que se activa el layout MPR
    MprVolume.setSeries(series);

    // Guardamos en IDB el session state
    Storage.saveSession({
        sliceIndex: 0,
        windowWidth:  vp?.state.windowWidth,
        windowCenter: vp?.state.windowCenter,
        zoom: 1, panX: 0, panY: 0,
    });

    UI.showToast(`${series.length} imágenes cargadas — ${series[0].patientName || ''}`, 'success', 4000);
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
    navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('SW registration failed:', err);
    });
}
