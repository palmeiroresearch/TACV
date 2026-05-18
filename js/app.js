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

    // Case library
    CaseLibrary.init();

    // Worker pool para parseo DICOM
    DicomLoader.init();

    // Toolbar buttons
    UI.wireToolbar();
    UI.applySettings();

    // Tool inicial
    ToolState.setTool(TOOL_IDS.POINTER);

    // Preset inicial: restaurar el último usado o usar el predeterminado
    const savedPreset = Storage.getSettings().activePreset || DEFAULT_PRESET;
    const presetSel = document.getElementById('presetSelect');
    if (presetSel) presetSel.value = savedPreset;

    // Keyboard shortcuts globales
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            CaseLibrary.toggle();
            return;
        }
        ToolState.onKeyDown(e);
    });

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

/* ── Activar frames ya parseados (sin I/O ni parsing) ─── */
function activateFrames(allFrames) {
    if (!allFrames?.length) {
        UI.showToast('No se encontraron frames DICOM válidos', 'error');
        return -1;
    }
    document.getElementById('welcomeScreen')?.remove();

    const byUID = new Map();
    allFrames.forEach(frame => {
        const uid = frame.allTags?.['x0020000e'] || 'default';
        if (!byUID.has(uid)) byUID.set(uid, []);
        byUID.get(uid).push(frame);
    });

    let firstSeriesIdx = -1;
    byUID.forEach((frames) => {
        const idx = SeriesManager.add(frames);   // add() ignora duplicados por SeriesInstanceUID
        if (firstSeriesIdx === -1) firstSeriesIdx = idx;
    });

    SeriesManager.renderTabs();
    _activateSeries(firstSeriesIdx === -1 ? 0 : firstSeriesIdx);
    document.getElementById('btnCloseStudy')?.classList.remove('hidden');

    const total      = allFrames.length;
    const seriesCount = byUID.size;
    UI.showToast(
        `${total} imágenes${seriesCount > 1 ? ` en ${seriesCount} series` : ''} — ${allFrames[0].patientName || ''}`,
        'success', 3500
    );
    return firstSeriesIdx;
}

/* ── Cargar archivos DICOM (desde disco) ────────────────── */
async function loadFiles(files) {
    document.getElementById('welcomeScreen')?.remove();
    UI.showLoadingBar();

    const allFrames = await DicomLoader.loadFiles(files, {
        onProgress:   (loaded, total) => UI.updateLoadingBar(loaded, total),
        onFrameLoaded: (frame, idx) => {
            if (idx === 0) {
                const vp = ViewportLayout.getActive();
                if (vp) vp.loadFrame(frame, 0, 1);
            }
        },
    });

    UI.hideLoadingBar();
    activateFrames(allFrames);
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
        // Sincronizar W/L con el preset guardado para que select y display coincidan siempre
        const preset = Storage.getSettings().activePreset || DEFAULT_PRESET;
        vp.applyPreset(preset);
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

/* ── Cerrar estudio actual ──────────────────────────────── */
function closeAll() {
    SeriesPanel.stopCine();

    SeriesManager.clear();
    SeriesManager.renderTabs();
    MprVolume.clear();

    ViewportLayout.getAll().forEach(vp => vp.clearFrame());

    const strip = document.getElementById('thumbnailStrip');
    if (strip) strip.innerHTML = '';
    document.getElementById('sliceCounter')?.classList.add('hidden');
    document.getElementById('seriesTabBar')?.remove();

    const patientInfo = document.getElementById('patientInfo');
    if (patientInfo) patientInfo.innerHTML = '';
    const metaTagList = document.getElementById('metaTagList');
    if (metaTagList) metaTagList.innerHTML = '';

    ['statusSlice','statusHU','statusWL','statusZoom','statusPos'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.textContent = ['Slice: —','HU: —','W: — L: —','Zoom: 100%','Pos: —'][i];
    });
    const statusStudy = document.getElementById('statusStudy');
    if (statusStudy) statusStudy.textContent = '';

    document.getElementById('btnCloseStudy')?.classList.add('hidden');

    // Mostrar welcome screen si no está ya
    if (!document.getElementById('welcomeScreen')) {
        const ws = document.createElement('div');
        ws.id = 'welcomeScreen';
        ws.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--viewport-bg);z-index:100;animation:fadeIn 0.3s ease;';
        ws.innerHTML = `
            <div class="welcome-inner">
                <div class="welcome-icon">⬡</div>
                <h1 class="welcome-title">TAC Viewer</h1>
                <p class="welcome-sub">Visor DICOM avanzado</p>
                <div class="welcome-actions">
                    <button class="btn-welcome-open" id="btnWelcomeOpen">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        Abrir archivos DICOM
                    </button>
                    <p class="welcome-drag">o arrastrá los archivos .dcm aquí</p>
                </div>
                <div class="welcome-info">
                    <span>Scroll: navegar slices</span>
                    <span>Botón derecho + drag: W/L</span>
                    <span>Ctrl + Scroll: zoom</span>
                </div>
            </div>`;
        document.getElementById('mainArea')?.appendChild(ws);
        document.getElementById('btnWelcomeOpen')?.addEventListener('click', () =>
            document.getElementById('fileInput')?.click());
    }

    Storage.saveSession({});
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
