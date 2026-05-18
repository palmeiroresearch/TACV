'use strict';

/* ============================================================
   MeasurementStore — CRUD de mediciones por slice
   Coordenadas guardadas en espacio imagen (px imagen),
   no en canvas. El render convierte al vuelo vía imageToCanvas.
   ============================================================ */

const MeasurementStore = {
    _store: new Map(),  // sliceIndex → Measurement[]
    _nextId: 1,
    _sessionId: null,
    _seriesCache: new Map(), // seriesUid → { data, nextId }

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

    computeEllipseStats(pixelData, rows, cols, ellipse, pixelSpacing, slope, intercept) {
        const { cx, cy, rx, ry } = ellipse;
        const [rs, cs] = pixelSpacing || [1, 1];
        const values = [];
        const x0 = Math.max(0, Math.floor(cx - rx));
        const x1 = Math.min(cols - 1, Math.ceil(cx + rx));
        const y0 = Math.max(0, Math.floor(cy - ry));
        const y1 = Math.min(rows - 1, Math.ceil(cy + ry));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const nx = (x - cx) / rx, ny = (y - cy) / ry;
                if (nx * nx + ny * ny <= 1) {
                    const raw = pixelData[y * cols + x];
                    values.push(raw * slope + intercept);
                }
            }
        }
        return this._stats(values, rx, ry, cs, rs, 'ellipse');
    },

    computeRectStats(pixelData, rows, cols, rect, pixelSpacing, slope, intercept) {
        const { x1, y1, x2, y2 } = rect;
        const [rs, cs] = pixelSpacing || [1, 1];
        const values = [];
        const xi0 = Math.max(0, Math.min(x1, x2)), xi1 = Math.min(cols - 1, Math.max(x1, x2));
        const yi0 = Math.max(0, Math.min(y1, y2)), yi1 = Math.min(rows - 1, Math.max(y1, y2));
        for (let y = yi0; y <= yi1; y++) {
            for (let x = xi0; x <= xi1; x++) {
                const raw = pixelData[y * cols + x];
                values.push(raw * slope + intercept);
            }
        }
        const w = Math.abs(x2 - x1) * cs, h = Math.abs(y2 - y1) * rs;
        return this._stats(values, null, null, cs, rs, 'rect', w, h);
    },

    computeFreehandStats(pixelData, rows, cols, points, pixelSpacing, slope, intercept) {
        const [rs, cs] = pixelSpacing || [1, 1];
        // Bounding box
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        points.forEach(p => {
            if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
            if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
        });
        const values = [];
        for (let y = Math.max(0, Math.floor(yMin)); y <= Math.min(rows - 1, Math.ceil(yMax)); y++) {
            for (let x = Math.max(0, Math.floor(xMin)); x <= Math.min(cols - 1, Math.ceil(xMax)); x++) {
                if (this._pointInPolygon(x + 0.5, y + 0.5, points)) {
                    values.push(pixelData[y * cols + x] * slope + intercept);
                }
            }
        }
        const w = (xMax - xMin) * cs, h = (yMax - yMin) * rs;
        return this._stats(values, null, null, cs, rs, 'rect', w, h);
    },

    _pointInPolygon(x, y, pts) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    },

    _stats(values, rx, ry, cs, rs, type, forcedW, forcedH) {
        if (!values.length) return { mean: 0, std: 0, min: 0, max: 0, area: 0, count: 0 };
        const n    = values.length;
        const mean = values.reduce((a, b) => a + b, 0) / n;
        const std  = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
        const min  = Math.min(...values);
        const max  = Math.max(...values);
        const area = type === 'ellipse'
            ? Math.PI * rx * cs * ry * rs
            : (forcedW * forcedH);
        return { mean: Math.round(mean), std: Math.round(std), min: Math.round(min), max: Math.round(max), area: Math.round(area), count: n };
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
            default:          return false;
        }
    },

    /* ── Contexto por serie ────────────────────────────── */
    saveForSeries(uid) {
        if (!uid) return;
        const data = {};
        this._store.forEach((arr, key) => { data[key] = arr.map(m => ({ ...m })); });
        this._seriesCache.set(uid, { data, nextId: this._nextId });
    },

    loadForSeries(uid) {
        this._store.clear();
        const cached = uid ? this._seriesCache.get(uid) : null;
        if (cached) {
            for (const [key, arr] of Object.entries(cached.data))
                this._store.set(parseInt(key), arr);
            this._nextId = cached.nextId;
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
            Storage.saveMeasurements(this._sessionId, serialized).catch(() => {});
        }, 500);
        Storage.dispatch('measurementsChanged', {});
    },

    async restore(sessionId) {
        const data = await Storage.loadMeasurements(sessionId);
        if (!data) return;
        this._store.clear();
        for (const [key, arr] of Object.entries(data)) {
            this._store.set(parseInt(key), arr);
            arr.forEach(m => { if (m.id >= this._nextId) this._nextId = m.id + 1; });
        }
    },
};
