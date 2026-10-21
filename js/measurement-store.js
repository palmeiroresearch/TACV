'use strict';

/* ============================================================
   MeasurementStore — CRUD de mediciones por slice
   Coordenadas guardadas en espacio imagen (px imagen),
   no en canvas. El render convierte al vuelo vía imageToCanvas.
   ============================================================ */

const MeasurementStore = {
    _store: new Map(),  // sliceIndex → Measurement[]
    _notes: new Map(),  // sliceIndex → { text, updatedAt }
    _nextId: 1,
    _sessionId: null,
    _seriesCache: new Map(), // seriesUid → { data, nextId, notes }

    init(sessionId) {
        this._sessionId = sessionId || ('session_' + Date.now());
    },

    /* ── CRUD ─────────────────────────────────────────── */
    add(sliceIndex, measurement) {
        const m = {
            ...measurement,
            id:         this._nextId++,
            sliceIndex,
            createdAt:  Date.now(),
            selected:   false,
        };
        if (!this._store.has(sliceIndex)) this._store.set(sliceIndex, []);
        this._store.get(sliceIndex).push(m);
        this._persist();
        return m;
    },

    get(sliceIndex) {
        return this._store.get(sliceIndex) || [];
    },

    getAll() {
        const all = [];
        this._store.forEach(arr => all.push(...arr));
        return all;
    },

    update(id, fields) {
        for (const [, arr] of this._store) {
            const m = arr.find(x => x.id === id);
            if (m) { Object.assign(m, fields); this._persist(); return true; }
        }
        return false;
    },

    delete(id) {
        for (const [key, arr] of this._store) {
            const idx = arr.findIndex(x => x.id === id);
            if (idx !== -1) {
                arr.splice(idx, 1);
                if (!arr.length) this._store.delete(key);
                this._persist();
                return true;
            }
        }
        return false;
    },

    clearSlice(sliceIndex) {
        this._store.delete(sliceIndex);
        this._persist();
    },

    clearAll() {
        this._store.clear();
        this._notes.clear();
        this._persist();
    },

    selectOnly(id) {
        for (const [, arr] of this._store) {
            arr.forEach(m => m.selected = (m.id === id));
        }
    },

    deselectAll() {
        for (const [, arr] of this._store) {
            arr.forEach(m => m.selected = false);
        }
    },

    /* ── Notas clínicas por slice ─────────────────────── */
    setNote(sliceIndex, text) {
        if (!text?.trim()) { this._notes.delete(sliceIndex); }
        else { this._notes.set(sliceIndex, { text: text.trim(), updatedAt: Date.now() }); }
        this._persist();
    },

    getNote(sliceIndex)  { return this._notes.get(sliceIndex) ?? null; },
    hasNote(sliceIndex)  { return this._notes.has(sliceIndex) && !!this._notes.get(sliceIndex).text; },
    getAllNotes()         {
        return [...this._notes.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([sliceIndex, n]) => ({ sliceIndex, ...n }));
    },

    /* ── Geometría / estadísticas ──────────────────────── */
    computeDistance(p1, p2, pixelSpacing) {
        const [rs, cs] = pixelSpacing || [1, 1];
        const dx = (p2.x - p1.x) * cs;
        const dy = (p2.y - p1.y) * rs;
        return Math.sqrt(dx * dx + dy * dy);
    },

    computeAngle(p1, vertex, p2) {
        const a1 = Math.atan2(p1.y - vertex.y, p1.x - vertex.x);
        const a2 = Math.atan2(p2.y - vertex.y, p2.x - vertex.x);
        let deg = Math.abs(a1 - a2) * 180 / Math.PI;
        if (deg > 180) deg = 360 - deg;
        return deg;
    },

    /* ── Estadísticas de ROI ───────────────────────────────────
       Todas las ROI —elipse, rectángulo, libre y las de NWU— pasan
       por ResearchCore.maskStats: un único sitio donde se convierte
       a UH, se excluye padding y se aplican umbrales.

       Las estadísticas se guardan con PRECISIÓN COMPLETA. El redondeo
       es responsabilidad de quien las muestra (ver _fmtHU en
       overlay-renderer y measurements-panel): una media redondeada a
       entero introduce hasta 1,5 puntos porcentuales de error en la NWU.
       ───────────────────────────────────────────────────────── */

    /**
     * Opciones derivadas del frame que afectan a la medición:
     * padding fuera del FOV y, opcionalmente, umbrales de UH.
     */
    _measureOpts(frame, opts = {}) {
        return {
            padding:           frame?.pixelPaddingValue ?? null,
            paddingRangeLimit: frame?.pixelPaddingRangeLimit ?? null,
            huMin:             opts.huMin ?? null,
            huMax:             opts.huMax ?? null,
        };
    },

    /** Añade el alias `area` que usan los sitios de visualización existentes. */
    _withAreaAlias(st) {
        return { ...st, area: st.areaMm2 };
    },

    computeEllipseStats(pixelData, rows, cols, ellipse, pixelSpacing, slope, intercept, opts = {}) {
        const { cx, cy, rx, ry } = ellipse;
        const st = ResearchCore.maskStats({
            pixelData, rows, cols, slope, intercept, pixelSpacing,
            padding: opts.padding ?? null,
            paddingRangeLimit: opts.paddingRangeLimit ?? null,
            huMin: opts.huMin ?? null,
            huMax: opts.huMax ?? null,
            bbox: { x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry },
            // Mismo criterio de pertenencia que antes: índice entero de píxel,
            // para no alterar qué píxeles entraban en la ROI.
            inside: (x, y) => {
                const nx = (x - cx) / rx, ny = (y - cy) / ry;
                return nx * nx + ny * ny <= 1;
            },
        });
        return this._withAreaAlias(st);
    },

    computeRectStats(pixelData, rows, cols, rect, pixelSpacing, slope, intercept, opts = {}) {
        const { x1, y1, x2, y2 } = rect;
        const st = ResearchCore.maskStats({
            pixelData, rows, cols, slope, intercept, pixelSpacing,
            padding: opts.padding ?? null,
            paddingRangeLimit: opts.paddingRangeLimit ?? null,
            huMin: opts.huMin ?? null,
            huMax: opts.huMax ?? null,
            bbox: { x0: Math.min(x1, x2), y0: Math.min(y1, y2),
                    x1: Math.max(x1, x2), y1: Math.max(y1, y2) },
            inside: () => true,
        });
        return this._withAreaAlias(st);
    },

    computeFreehandStats(pixelData, rows, cols, points, pixelSpacing, slope, intercept, opts = {}) {
        const st = ResearchCore.maskStats({
            pixelData, rows, cols, slope, intercept, pixelSpacing,
            padding: opts.padding ?? null,
            paddingRangeLimit: opts.paddingRangeLimit ?? null,
            huMin: opts.huMin ?? null,
            huMax: opts.huMax ?? null,
            bbox: ResearchCore.polygonBounds(points),
            inside: (x, y) => ResearchCore.pointInPolygon(x + 0.5, y + 0.5, points),
        });
        return this._withAreaAlias(st);
    },

    /**
     * Estadísticas de una ROI poligonal de NWU: mismo rasterizador, con
     * los umbrales de exclusión del estudio.
     */
    computeNwuRoiStats(frame, points, threshold = {}) {
        if (!frame?.pixelData || !points?.length) return null;
        const st = ResearchCore.maskStats({
            pixelData: frame.pixelData, rows: frame.rows, cols: frame.cols,
            slope: frame.rescaleSlope, intercept: frame.rescaleIntercept,
            pixelSpacing: frame.pixelSpacing,
            ...this._measureOpts(frame, threshold),
            bbox: ResearchCore.polygonBounds(points),
            inside: (x, y) => ResearchCore.pointInPolygon(x + 0.5, y + 0.5, points),
        });
        return this._withAreaAlias(st);
    },

    /** Conserva el nombre antiguo para no romper llamadas externas. */
    _pointInPolygon(x, y, pts) {
        return ResearchCore.pointInPolygon(x, y, pts);
    },

    /* ── Hit test — click cerca de una medición ──────── */
    hitTest(sliceIndex, imageX, imageY, radius = 8) {
        const items = this.get(sliceIndex);
        for (let i = items.length - 1; i >= 0; i--) {
            const m = items[i];
            if (this._isNear(m, imageX, imageY, radius)) return m;
        }
        return null;
    },

    _isNear(m, x, y, r) {
        const near = (p) => p && Math.hypot(p.x - x, p.y - y) <= r;
        switch (m.type) {
            case 'distance':  return near(m.p1) || near(m.p2);
            case 'angle':     return near(m.p1) || near(m.vertex) || near(m.p2);
            case 'ellipse':   return Math.abs(x - m.cx) <= m.rx + r && Math.abs(y - m.cy) <= m.ry + r;
            case 'rectangle': return x >= Math.min(m.x1,m.x2)-r && x <= Math.max(m.x1,m.x2)+r &&
                                     y >= Math.min(m.y1,m.y2)-r && y <= Math.max(m.y1,m.y2)+r;
            case 'arrow':     return near(m.tail) || near(m.head);
            case 'text':      return near(m.pos);
            case 'cobb':      return (m.line1 && (near(m.line1.p1) || near(m.line1.p2))) ||
                                     (m.line2 && (near(m.line2.p1) || near(m.line2.p2)));
            case 'freehand':  return m.points?.some(p => Math.hypot(p.x - x, p.y - y) <= r * 2);
            case 'midline':   return near(m.anterior) || near(m.posterior);
            case 'abc_axis':  return near(m.p1) || near(m.p2);
            case 'aspects_probe': return near(m.seed) ||
                                     (m.points && ResearchCore.pointInPolygon(x, y, m.points));
            case 'septum':    return near(m.pos);
            case 'nwu_roi':   // dentro del polígono o justo sobre su contorno.
                              // Radio ajustado (no r·2 como en 'freehand'): un
                              // polígono de 180 puntos con margen holgado roba
                              // clics a la línea media y al septum cercanos.
                              return (m.points && ResearchCore.pointInPolygon(x, y, m.points)) ||
                                     m.points?.some(p => Math.hypot(p.x - x, p.y - y) <= r);
            default:          return false;
        }
    },

    /* ── Volumetría por planimetría ────────────────────────
       El espaciado entre cortes se calcula proyectando
       ImagePositionPatient sobre la normal del corte, no con
       SliceThickness: SliceThickness es el grosor del haz, no la
       distancia entre centros, y difieren en cuanto hay huecos o
       solapamiento. Devuelve avisos cuando los cortes no son
       equidistantes o se solapan.
       ───────────────────────────────────────────────────── */
    computeVolume(measurements, frames) {
        if (!measurements?.length) return null;

        // Área encerrada por la ROI (no la de los píxeles que pasaron el
        // umbral): el volumen de la lesión es su extensión geométrica.
        const rois = measurements.map(m => ({
            sliceIndex: m.sliceIndex,
            areaMm2: m.stats?.areaTotalMm2 ?? m.stats?.areaMm2 ?? m.stats?.area ?? 0,
        }));

        const v = ResearchCore.planimetricVolume(rois, frames);
        if (!v) return null;
        // `sliceCount` se mantiene por compatibilidad con el panel existente
        return { ...v, sliceCount: v.sliceCount };
    },

    /* ── Línea media por corte ─────────────────────────────
       Se guarda como una medición de tipo 'midline', así hereda
       la persistencia IDB, la caché por serie y el borrado.
       Solo puede haber una por corte: definir una nueva reemplaza
       la anterior.
       ───────────────────────────────────────────────────── */
    setMidline(sliceIndex, anterior, posterior, source = 'manual') {
        const existing = this.getMidline(sliceIndex);
        if (existing) {
            this.update(existing.id, { anterior, posterior, source });
            return this.getMidline(sliceIndex);
        }
        return this.add(sliceIndex, { type: 'midline', anterior, posterior, source });
    },

    getMidline(sliceIndex) {
        return this.get(sliceIndex).find(m => m.type === 'midline') ?? null;
    },

    getAllMidlines() {
        return this.getAll().filter(m => m.type === 'midline')
                   .sort((a, b) => a.sliceIndex - b.sliceIndex);
    },

    /* ── Pares de ROI de NWU ───────────────────────────────── */

    /** Pares {lesion, mirror} completos, ordenados por corte. */
    getNwuPairs() {
        const rois = this.getAll().filter(m => m.type === 'nwu_roi');
        const byPair = new Map();
        for (const r of rois) {
            if (!byPair.has(r.pairId)) byPair.set(r.pairId, {});
            byPair.get(r.pairId)[r.role] = r;
        }
        return [...byPair.entries()]
            .map(([pairId, p]) => ({ pairId, lesion: p.lesion, mirror: p.mirror }))
            .filter(p => p.lesion && p.mirror)
            .sort((a, b) => a.lesion.sliceIndex - b.lesion.sliceIndex);
    },

    getNwuRoisForSlice(sliceIndex) {
        return this.get(sliceIndex).filter(m => m.type === 'nwu_roi');
    },

    getSeptum(sliceIndex) {
        return this.get(sliceIndex).find(m => m.type === 'septum') ?? null;
    },

    setSeptum(sliceIndex, pos, shiftMm) {
        const existing = this.getSeptum(sliceIndex);
        if (existing) {
            this.update(existing.id, { pos, shiftMm });
            return this.getSeptum(sliceIndex);
        }
        return this.add(sliceIndex, { type: 'septum', pos, shiftMm });
    },

    /**
     * Recalcula las estadísticas de todas las ROI de NWU con un umbral
     * nuevo. Se llama al editar el rango en el panel: el umbral forma
     * parte de la medición, así que cambiarlo debe re-medir, no solo
     * re-etiquetar.
     */
    recomputeNwuStats(frames, threshold) {
        let updated = 0;
        for (const m of this.getAll()) {
            if (m.type !== 'nwu_roi') continue;
            const f = frames[m.sliceIndex];
            if (!f) continue;
            const stats = this.computeNwuRoiStats(f, m.points, threshold);
            Object.assign(m, { stats, threshold: { ...threshold } });
            updated++;
        }
        if (updated) this._persist();
        return updated;
    },

    /* ── Contexto por serie ────────────────────────────── */
    saveForSeries(uid) {
        if (!uid) return;
        const data = {};
        this._store.forEach((arr, key) => { data[key] = arr.map(m => ({ ...m })); });
        const notes = {};
        this._notes.forEach((n, k) => { notes[k] = n; });
        this._seriesCache.set(uid, { data, nextId: this._nextId, notes });
    },

    loadForSeries(uid) {
        this._store.clear();
        this._notes.clear();
        const cached = uid ? this._seriesCache.get(uid) : null;
        if (cached) {
            for (const [key, arr] of Object.entries(cached.data))
                this._store.set(parseInt(key), arr);
            this._nextId = cached.nextId;
            if (cached.notes) {
                for (const [k, n] of Object.entries(cached.notes))
                    this._notes.set(parseInt(k), n);
            }
        }
        Storage.dispatch('measurementsChanged', {});
    },

    discardForSeries(uid) {
        this._seriesCache.delete(uid);
    },

    /* ── Persistencia IDB ──────────────────────────────── */
    _persistTimer: null,
    _persist() {
        clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            const serialized = {};
            this._store.forEach((arr, key) => { serialized[key] = arr; });
            if (this._notes.size) {
                const notes = {};
                this._notes.forEach((n, k) => { notes[k] = n; });
                serialized['_notes'] = notes;
            }
            Storage.saveMeasurements(this._sessionId, serialized).catch(() => {});
        }, 500);
        Storage.dispatch('measurementsChanged', {});
    },

    async restore(sessionId) {
        const data = await Storage.loadMeasurements(sessionId);
        if (!data) return;
        // Extraer notas antes del loop de mediciones (parseInt('_notes') = NaN, se saltaría,
        // pero lo hacemos explícito para poblar _notes correctamente).
        if (data['_notes']) {
            for (const [k, n] of Object.entries(data['_notes']))
                this._notes.set(parseInt(k), n);
            delete data['_notes'];
        }
        this._store.clear();
        for (const [key, arr] of Object.entries(data)) {
            const idx = parseInt(key);
            if (isNaN(idx)) continue;
            this._store.set(idx, arr);
            arr.forEach(m => { if (m.id >= this._nextId) this._nextId = m.id + 1; });
        }
    },
};
