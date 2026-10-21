'use strict';

/* ============================================================
   Detector — orquestación del análisis automático de asimetría.

   Reglas que impone este módulo, por diseño:

   1. NO FUNCIONA EN MODO INVESTIGACIÓN. Si la app iluminase el
      área de infarto antes de que el lector trace la ROI de NWU,
      esa medición dejaría de ser una observación independiente.
      El detector es herramienta clínica y de cribado, separada
      del estudio.

   2. NO MIDE: propone. Cada región aceptada se convierte en una
      ROI que se vuelve a medir con el rasterizador validado, y
      queda marcada `source: 'detector'`.

   3. NO ARRANCA SIN LÍNEA MEDIA CONFIRMADA. Tres grados de error
      bastan para producir un mapa de asimetría falso en todo el
      cerebro — está medido en las pruebas.

   4. NO DIAGNOSTICA. Habla en cifras: «región hipodensa, 14,2 mL,
      ΔUH −7,2, NWU 18 %», nunca «infarto».
   ============================================================ */

const Detector = {
    _worker:    null,
    _msgId:     0,
    _pending:   new Map(),

    _result:    null,     // última salida de analyzeSeries
    _running:   false,
    _confirmed: new Set(),// índices de corte con línea media confirmada
    _overlay:   null,     // { z, mode, canvas }
    _contours:  new Map(),// z → contornos de ese corte
    _probes:    [],       // sondas ASPECTS colocadas

    mode:       'asymmetry',   // 'asymmetry' | 'sectors' | 'off'
    opacity:    0.55,

    /* ════════════════════════════════════════════════════════
       Ciclo de vida
       ════════════════════════════════════════════════════════ */

    init() {
        document.getElementById('btnDetector')?.addEventListener('click', () => this.toggleRun());
        Storage.on('researchModeChanged', ({ active }) => {
            if (active) this.clear('Modo investigación activado: análisis automático descartado.');
        });
        Storage.on('seriesChanged', () => this.clear());
    },

    isBlocked() {
        return typeof ResearchMode !== 'undefined' && ResearchMode.isActive();
    },

    /**
     * ¿Ha puesto el usuario esta función en su barra?
     *
     * Viene desactivada de fábrica (TOOLBAR_HIDDEN_BY_DEFAULT) porque está en
     * estudio y no es diagnóstica. Con los botones ocultos, el atajo de teclado
     * seguiría colocando sondas sin panel donde leerlas, así que también pasa
     * por aquí: la función entera es opt-in, no solo su botón.
     */
    isSurfaced() {
        if (typeof UI === 'undefined' || !UI.isToolbarItemVisible) return true;
        return UI.isToolbarItemVisible('btn-detector') ||
               UI.isToolbarItemVisible('btn-detector-panel');
    },

    _warnNotSurfaced() {
        UI.showToast('El análisis automático de asimetría está desactivado. Es una función ' +
                     'en estudio y no diagnóstica: activala en «Personalizar barra» si querés ' +
                     'usarla.', 'info', 6500);
    },

    hasResult() { return !!this._result; },
    getResult() { return this._result; },
    isRunning() { return this._running; },

    _ensureWorker() {
        if (this._worker) return this._worker;
        this._worker = new Worker('js/detect-worker.js');
        this._worker.onmessage = (e) => {
            const { id } = e.data;
            const cb = this._pending.get(id);
            this._pending.delete(id);
            cb?.(e.data);
        };
        this._worker.onerror = (e) => {
            console.error('[Detector] worker:', e.message);
            UI.showToast('Error en el análisis automático: ' + e.message, 'error', 6000);
            this._running = false;
            DetectorPanel.refresh();
        };
        return this._worker;
    },

    _send(payload, transfer) {
        return new Promise((resolve) => {
            const id = ++this._msgId;
            this._pending.set(id, resolve);
            this._ensureWorker().postMessage({ ...payload, id }, transfer || []);
        });
    },

    /* ════════════════════════════════════════════════════════
       Línea media: confirmación obligatoria
       ════════════════════════════════════════════════════════ */

    /** ¿Está confirmada la línea media del corte actual? */
    isMidlineConfirmed(sliceIndex) {
        const m = MeasurementStore.getMidline(sliceIndex);
        if (!m) return false;
        return m.source === 'manual' || m.source === 'auto-adjusted' ||
               this._confirmed.has(sliceIndex);
    },

    /** Marca la línea media del corte actual como revisada por el usuario. */
    confirmMidline(sliceIndex) {
        const m = MeasurementStore.getMidline(sliceIndex);
        if (!m) {
            UI.showToast('Este corte no tiene línea media. Estimala o definila a mano.',
                         'warning', 4500);
            return false;
        }
        this._confirmed.add(sliceIndex);
        UI.showToast(`Línea media del corte ${sliceIndex + 1} confirmada`, 'success', 2500);
        DetectorPanel.refresh();
        return true;
    },

    /**
     * Línea media de cada corte para el worker. La del corte de referencia va
     * como 'confirmed'; las demás se estiman y se marcan como tales, para que
     * el análisis pueda declarar en qué cortes se fió de una estimación.
     */
    _collectMidlines(frames) {
        const out = {};
        for (let z = 0; z < frames.length; z++) {
            const stored = MeasurementStore.getMidline(z);
            if (stored) {
                out[z] = {
                    anterior: stored.anterior, posterior: stored.posterior,
                    source: this._confirmed.has(z) ? 'confirmed' : stored.source,
                    confidence: stored.source === 'manual' ? 1 : (stored.confidence ?? 0.5),
                };
                continue;
            }
            const est = ResearchCore.estimateMidline(frames[z]);
            if (est) {
                out[z] = { anterior: est.anterior, posterior: est.posterior,
                           source: 'auto', confidence: est.confidence };
            }
        }
        return out;
    },

    /* ════════════════════════════════════════════════════════
       Ejecución
       ════════════════════════════════════════════════════════ */

    async toggleRun() {
        if (this._result) { this.clear(); return; }
        await this.run();
    },

    async run() {
        if (!this.isSurfaced()) { this._warnNotSurfaced(); return null; }
        if (this.isBlocked()) {
            UI.showToast('El análisis automático no funciona en modo investigación: ' +
                         'ver una región marcada antes de medirla contamina la medición. ' +
                         'Desactivá el modo investigación para usarlo.', 'warning', 7000);
            return null;
        }
        if (this._running) return null;

        const vp = ViewportLayout.getActive();
        const frames = SeriesPanel.getSeries() || [];
        if (!frames.length || !vp?.state.frame) {
            UI.showToast('No hay estudio cargado', 'warning');
            return null;
        }

        const z = vp.state.sliceIndex;
        if (!this.isMidlineConfirmed(z)) {
            this._promptMidline(vp, z);
            return null;
        }

        this._running = true;
        DetectorPanel.open();
        DetectorPanel.refresh();
        UI.showToast('Analizando la serie…', 'info', 2500);

        const midlines = this._collectMidlines(frames);
        const threshold = (typeof ResearchMode !== 'undefined')
            ? ResearchMode.getThreshold() : { ...NWU_DEFAULTS };

        // Los frames se CLONAN (no se transfieren): el hilo principal los
        // sigue necesitando para renderizar y medir.
        const payload = frames.map(f => ({
            rows: f.rows, cols: f.cols, pixelData: f.pixelData,
            rescaleSlope: f.rescaleSlope, rescaleIntercept: f.rescaleIntercept,
            pixelSpacing: f.pixelSpacing, sliceThickness: f.sliceThickness,
            imagePosition: f.imagePosition, imageOrientation: f.imageOrientation,
            sliceLocation: f.sliceLocation, sopInstanceUID: f.sopInstanceUID,
            pixelPaddingValue: f.pixelPaddingValue,
            pixelPaddingRangeLimit: f.pixelPaddingRangeLimit,
        }));

        const res = await this._send({ cmd: 'analyze', frames: payload, midlines, threshold });
        this._running = false;

        if (!res.ok) {
            UI.showToast('El análisis falló: ' + res.error, 'error', 6000);
            DetectorPanel.refresh();
            return null;
        }

        this._result = { ...res.result, ms: res.ms, analyzedAt: new Date().toISOString() };
        this._contours.clear();

        const nI = this._result.ischemia.length;
        const nH = this._result.hemorrhage.length;
        UI.showToast(
            (nI || nH)
                ? `${nI} región(es) hipodensa(s) y ${nH} hiperdensa(s) en ${res.ms} ms`
                : `Sin regiones candidatas (${res.ms} ms)`,
            (nI || nH) ? 'success' : 'info', 4500
        );

        await this.refreshOverlay();
        DetectorPanel.refresh();
        return this._result;
    },

    _promptMidline(vp, z) {
        const m = MeasurementStore.getMidline(z);
        if (!m) {
            const est = ToolHandlers[TOOL_IDS.NWU_MIDLINE].estimate(vp);
            UI.showToast(
                est ? 'Revisá la línea media propuesta y confirmala para analizar.'
                    : 'Definí la línea media a mano (herramienta L) y confirmala.',
                'warning', 6000
            );
        } else {
            UI.showToast('Confirmá la línea media de este corte antes de analizar. ' +
                         'Tres grados de error bastan para falsear el mapa entero.',
                         'warning', 6000);
        }
        DetectorPanel.open();
        DetectorPanel.refresh();
    },

    clear(message) {
        this._result = null;
        this._overlay = null;
        this._contours.clear();
        this._probes = [];
        if (this._worker) this._send({ cmd: 'reset' }).catch(() => {});
        document.getElementById('btnDetector')?.classList.remove('on');
        ViewportLayout.getAll().forEach(v => v.render());
        if (typeof DetectorPanel !== 'undefined') DetectorPanel.refresh();
        if (message) UI.showToast(message, 'info', 4000);
    },

    /* ════════════════════════════════════════════════════════
       Overlay
       ════════════════════════════════════════════════════════ */

    setMode(mode) {
        this.mode = mode;
        if (mode === 'off') { this._overlay = null; ViewportLayout.getAll().forEach(v => v.render()); }
        else this.refreshOverlay();
        DetectorPanel.refresh();
    },

    setOpacity(a) {
        this.opacity = Math.max(0, Math.min(1, a));
        ViewportLayout.getAll().forEach(v => v.render());
    },

    /** Bitmap del overlay para el corte visible, generado en el worker. */
    async refreshOverlay() {
        if (!this._result || this.mode === 'off') return;
        const vp = ViewportLayout.getActive();
        const z = vp?.state.sliceIndex;
        if (z == null) return;
        if (this._overlay?.z === z && this._overlay?.mode === this.mode) return;

        const res = await this._send({ cmd: 'overlay', z, mode: this.mode });
        if (!res.ok || res.empty) {
            this._overlay = { z, mode: this.mode, canvas: null };
            vp.render();
            return;
        }

        const cv = document.createElement('canvas');
        cv.width = res.width; cv.height = res.height;
        cv.getContext('2d').putImageData(
            new ImageData(new Uint8ClampedArray(res.rgba), res.width, res.height), 0, 0);
        this._overlay = { z, mode: this.mode, canvas: cv };
        vp.render();

        if (!this._contours.has(z)) {
            const c = await this._send({ cmd: 'contours', z });
            if (c.ok) { this._contours.set(z, c.contours); vp.render(); }
        }
    },

    getOverlayFor(sliceIndex) {
        if (!this._result || this.mode === 'off') return null;
        return (this._overlay?.z === sliceIndex) ? this._overlay.canvas : null;
    },

    getContoursFor(sliceIndex) {
        if (!this._result) return null;
        return this._contours.get(sliceIndex) || null;
    },

    /** Llamado al navegar de corte. */
    onSliceChanged() {
        if (this._result && this.mode !== 'off') this.refreshOverlay();
    },

    /* ════════════════════════════════════════════════════════
       Aceptar una región → ROI medida por el camino validado
       ════════════════════════════════════════════════════════ */

    /**
     * Convierte un candidato en mediciones reales. No copia ninguna cifra del
     * detector: vuelve a medir el contorno con MeasurementStore, que es el
     * mismo camino que una ROI trazada a mano.
     */
    acceptCandidate(kind, index) {
        const list = kind === 'hypodense' ? this._result?.ischemia : this._result?.hemorrhage;
        const cand = list?.[index];
        if (!cand) return null;

        const frames = SeriesPanel.getSeries() || [];
        const threshold = (typeof ResearchMode !== 'undefined')
            ? ResearchMode.getThreshold() : { ...NWU_DEFAULTS };

        const stamp = {
            source: 'detector',
            detectorKind: kind,
            detectorParams: this._result.params,
            detectorAnalyzedAt: this._result.analyzedAt,
            appVersion: APP_VERSION,
            researchMode: false,     // el detector no corre en modo investigación
        };

        let created = 0;
        // Se piden los contornos de cada corte del candidato
        const promises = cand.perSlice.map(s => this._send({ cmd: 'contours', z: s.sliceIndex }));

        return Promise.all(promises).then((all) => {
            all.forEach((res, k) => {
                if (!res.ok) return;
                const z = cand.perSlice[k].sliceIndex;
                const match = res.contours.find(c => c.kind === kind && c.index === index);
                if (!match?.contour) return;
                const f = frames[z];
                if (!f) return;

                if (kind === 'hypodense' && match.mirrorContour) {
                    // Par lesión/espejo, igual que la herramienta de NWU
                    const pairId = 'det' + Date.now() + '_' + z;
                    const lesion = MeasurementStore.add(z, {
                        ...stamp, type: 'nwu_roi', role: 'lesion', pairId, shape: 'freehand',
                        points: match.contour, threshold: { ...threshold },
                        stats: MeasurementStore.computeNwuRoiStats(f, match.contour, threshold),
                    });
                    MeasurementStore.add(z, {
                        ...stamp, type: 'nwu_roi', role: 'mirror', pairId, shape: 'freehand',
                        points: match.mirrorContour,
                        originalPoints: match.mirrorContour.map(p => ({ ...p })),
                        mirrorOf: lesion.id, adjusted: false, offsetMm: 0, offsetPx: { dx: 0, dy: 0 },
                        threshold: { ...threshold },
                        stats: MeasurementStore.computeNwuRoiStats(f, match.mirrorContour, threshold),
                    });
                } else {
                    MeasurementStore.add(z, {
                        ...stamp, type: 'freehand', points: match.contour,
                        stats: MeasurementStore.computeFreehandStats(
                            f.pixelData, f.rows, f.cols, match.contour,
                            f.pixelSpacing, f.rescaleSlope, f.rescaleIntercept,
                            MeasurementStore._measureOpts(f)),
                    });
                }
                created++;
            });

            ViewportLayout.getAll().forEach(v => v.render());
            UI.showToast(
                created
                    ? `Región aceptada: ${created} ROI creada(s) y re-medida(s) con el ` +
                      `rasterizador exacto. Revisalas antes de usarlas.`
                    : 'No se pudo convertir la región en ROI', created ? 'success' : 'error', 5500);
            if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
            return created;
        });
    },

    /* ════════════════════════════════════════════════════════
       Sondas ASPECTS
       ════════════════════════════════════════════════════════ */

    ASPECTS_REGIONS: Object.freeze([
        { id: 'C',  label: 'Caudado',          level: 'ganglionar' },
        { id: 'L',  label: 'Lenticular',       level: 'ganglionar' },
        { id: 'IC', label: 'Cápsula interna',  level: 'ganglionar' },
        { id: 'I',  label: 'Ínsula',           level: 'ganglionar' },
        { id: 'M1', label: 'M1',               level: 'ganglionar' },
        { id: 'M2', label: 'M2',               level: 'ganglionar' },
        { id: 'M3', label: 'M3',               level: 'ganglionar' },
        { id: 'M4', label: 'M4',               level: 'supraganglionar' },
        { id: 'M5', label: 'M5',               level: 'supraganglionar' },
        { id: 'M6', label: 'M6',               level: 'supraganglionar' },
    ]),

    pendingRegion: null,

    startProbe(regionId) {
        if (!this.isSurfaced()) { this._warnNotSurfaced(); return; }
        if (this.isBlocked()) {
            UI.showToast('No disponible en modo investigación', 'warning');
            return;
        }
        this.pendingRegion = regionId;
        ToolState.setTool(TOOL_IDS.ASPECTS_SEED);
        const r = this.ASPECTS_REGIONS.find(x => x.id === regionId);
        UI.showToast(`Marcá el centro de ${r?.label || regionId} con un clic`, 'info', 4000);
    },

    async placeProbe(viewport, seed) {
        const z = viewport.state.sliceIndex;
        const f = viewport.state.frame;
        const regionId = this.pendingRegion;
        if (!f) return;

        const mid = MeasurementStore.getMidline(z);
        if (!mid) {
            UI.showToast('Este corte no tiene línea media (herramienta L)', 'warning', 4500);
            return;
        }

        const threshold = (typeof ResearchMode !== 'undefined')
            ? ResearchMode.getThreshold() : { ...NWU_DEFAULTS };
        const p = DetectCore.aspectsProbe(f, seed, mid, threshold);

        const region = this.ASPECTS_REGIONS.find(x => x.id === regionId);
        MeasurementStore.add(z, {
            type: 'aspects_probe',
            regionId: regionId || null,
            regionLabel: region?.label || null,
            seed, points: p.probe, mirrorPoints: p.mirror,
            probeStats: p.probeStats, mirrorStats: p.mirrorStats,
            deltaHu: p.deltaHu, z: p.z, nwu: p.nwu,
            radiusMm: p.radiusMm, flagged: p.flagged,
            threshold: { ...threshold },
            source: 'aspects-probe', appVersion: APP_VERSION,
        });

        this.pendingRegion = null;
        viewport.render();
        DetectorPanel.refresh();
        UI.showToast(
            p.deltaHu != null
                ? `${region?.label || 'Sonda'}: ΔUH ${p.deltaHu.toFixed(2)} · ` +
                  `z ${p.z?.toFixed(1) ?? '—'}${p.flagged ? ' · supera umbral' : ''}`
                : 'Sonda sin píxeles medibles', 'info', 5000);
    },

    getProbes() {
        return MeasurementStore.getAll().filter(m => m.type === 'aspects_probe')
            .sort((a, b) => a.sliceIndex - b.sliceIndex);
    },

    /** Recuento tipo ASPECTS: regiones marcadas sobre 10. */
    aspectsScore() {
        const probes = this.getProbes();
        const byRegion = new Map();
        for (const p of probes) if (p.regionId) byRegion.set(p.regionId, p);
        const measured = byRegion.size;
        const affected = [...byRegion.values()].filter(p => p.flagged).length;
        return {
            measured, affected,
            score: measured ? 10 - affected : null,
            complete: measured === 10,
            regions: this.ASPECTS_REGIONS.map(r => ({ ...r, probe: byRegion.get(r.id) || null })),
        };
    },
};

/* ════════════════════════════════════════════════════════════
   Herramienta de sonda ASPECTS: un clic coloca la sonda y su
   espejo, y los mide con el rasterizador exacto.
   ════════════════════════════════════════════════════════════ */
ToolHandlers[TOOL_IDS.ASPECTS_SEED] = {
    onDown(viewport, pos) {
        if (!Detector.isSurfaced()) { Detector._warnNotSurfaced(); return; }
        if (Detector.isBlocked()) {
            UI.showToast('No disponible en modo investigación', 'warning');
            return;
        }
        Detector.placeProbe(viewport, viewport.canvasToImage(pos.x, pos.y));
    },
    onDrag() {},
    onUp() {},
};
