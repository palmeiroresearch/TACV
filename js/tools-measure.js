'use strict';

/* ── Distance ────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.DISTANCE] = {
    onDown(viewport, pos, drag) {
        drag.data.p1 = viewport.canvasToImage(pos.x, pos.y);
    },
    onDrag(viewport, pos, dx, dy, drag) {
        const p2 = viewport.canvasToImage(pos.x, pos.y);
        const f  = viewport.state.frame;
        const dist = MeasurementStore.computeDistance(drag.data.p1, p2, f?.pixelSpacing);
        viewport.state.liveMeasurement = {
            type: 'distance',
            p1: drag.data.p1, p2,
            distanceMm: dist,
        };
    },
    onUp(viewport, pos, drag) {
        const p2   = viewport.canvasToImage(pos.x, pos.y);
        const f    = viewport.state.frame;
        const dist = MeasurementStore.computeDistance(drag.data.p1, p2, f?.pixelSpacing);
        if (dist < 2) { viewport.state.liveMeasurement = null; return; }
        MeasurementStore.add(viewport.state.sliceIndex, {
            type: 'distance',
            p1: drag.data.p1, p2,
            distanceMm: dist,
        });
        viewport.state.liveMeasurement = null;
    },
};

/* ── Angle (3 clics: p1 → vertex → p2) ──────────────────── */
ToolHandlers[TOOL_IDS.ANGLE] = {
    _pending: null, // { p1, vertex }

    onDown(viewport, pos, drag) {
        const imgPos = viewport.canvasToImage(pos.x, pos.y);
        if (!this._pending) {
            this._pending = { p1: imgPos };
        } else if (!this._pending.vertex) {
            this._pending.vertex = imgPos;
        } else {
            const p2  = imgPos;
            const deg = MeasurementStore.computeAngle(this._pending.p1, this._pending.vertex, p2);
            MeasurementStore.add(viewport.state.sliceIndex, {
                type: 'angle',
                p1: this._pending.p1,
                vertex: this._pending.vertex,
                p2,
                angleDeg: deg,
            });
            this._pending = null;
            viewport.state.liveMeasurement = null;
        }
    },
    onDrag(viewport, pos) {
        if (!this._pending) return;
        const p = viewport.canvasToImage(pos.x, pos.y);
        if (this._pending.vertex) {
            const deg = MeasurementStore.computeAngle(this._pending.p1, this._pending.vertex, p);
            viewport.state.liveMeasurement = {
                type: 'angle', p1: this._pending.p1,
                vertex: this._pending.vertex, p2: p, angleDeg: deg,
            };
        } else {
            viewport.state.liveMeasurement = {
                type: 'distance', p1: this._pending.p1, p2: p, distanceMm: 0,
            };
        }
    },
    onUp() {},
};

/* ── Ellipse ROI ─────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.ELLIPSE] = {
    onDown(viewport, pos, drag) {
        drag.data.center = viewport.canvasToImage(pos.x, pos.y);
    },
    onDrag(viewport, pos, dx, dy, drag) {
        const cur = viewport.canvasToImage(pos.x, pos.y);
        const c   = drag.data.center;
        const rx  = Math.abs(cur.x - c.x);
        const ry  = Math.abs(cur.y - c.y);
        const f   = viewport.state.frame;
        viewport.state.liveMeasurement = {
            type: 'ellipse',
            cx: c.x, cy: c.y, rx, ry,
            imageW: f?.cols, imageH: f?.rows,
        };
    },
    onUp(viewport, pos, drag) {
        const live = viewport.state.liveMeasurement;
        if (!live || live.rx < 3 || live.ry < 3) {
            viewport.state.liveMeasurement = null; return;
        }
        const f = viewport.state.frame;
        const stats = f ? MeasurementStore.computeEllipseStats(
            f.pixelData, f.rows, f.cols,
            { cx: live.cx, cy: live.cy, rx: live.rx, ry: live.ry },
            f.pixelSpacing, f.rescaleSlope, f.rescaleIntercept
        ) : null;
        MeasurementStore.add(viewport.state.sliceIndex, { ...live, stats });
        viewport.state.liveMeasurement = null;
    },
};

/* ── Rectangle ROI ───────────────────────────────────────── */
ToolHandlers[TOOL_IDS.RECTANGLE] = {
    onDown(viewport, pos, drag) {
        drag.data.origin = viewport.canvasToImage(pos.x, pos.y);
    },
    onDrag(viewport, pos, dx, dy, drag) {
        const cur = viewport.canvasToImage(pos.x, pos.y);
        const o   = drag.data.origin;
        const f   = viewport.state.frame;
        viewport.state.liveMeasurement = {
            type: 'rectangle',
            x1: o.x, y1: o.y, x2: cur.x, y2: cur.y,
            imageW: f?.cols, imageH: f?.rows,
        };
    },
    onUp(viewport, pos, drag) {
        const live = viewport.state.liveMeasurement;
        if (!live || Math.abs(live.x2 - live.x1) < 3) {
            viewport.state.liveMeasurement = null; return;
        }
        const f = viewport.state.frame;
        const stats = f ? MeasurementStore.computeRectStats(
            f.pixelData, f.rows, f.cols,
            { x1: live.x1, y1: live.y1, x2: live.x2, y2: live.y2 },
            f.pixelSpacing, f.rescaleSlope, f.rescaleIntercept
        ) : null;
        MeasurementStore.add(viewport.state.sliceIndex, { ...live, stats });
        viewport.state.liveMeasurement = null;
    },
};
