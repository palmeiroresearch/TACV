'use strict';

/* ── Pan ─────────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.PAN] = {
    onDrag(viewport, pos, dx, dy) {
        viewport.state.panX += dx;
        viewport.state.panY += dy;
        this._updateStatus(viewport);
    },
    _updateStatus(vp) {
        document.getElementById('statusZoom').textContent =
            `Zoom: ${Math.round((vp.state.zoom || 1) * 100)}%`;
    },
};

/* ── Zoom ────────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.ZOOM] = {
    onDrag(viewport, pos, dx, dy) {
        const factor = dy > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        viewport.zoomAt(pos.x, pos.y, factor);
        document.getElementById('statusZoom').textContent =
            `Zoom: ${Math.round((viewport.state.zoom || 1) * 100)}%`;
    },
};

/* ── Windowing (W/L) ─────────────────────────────────────── */
ToolHandlers[TOOL_IDS.WINDOWING] = {
    onDrag(viewport, pos, dx, dy) {
        const s  = viewport.state;
        // Derecha → aumenta ancho, Arriba → aumenta nivel (centro)
        s.windowWidth  = Math.max(1,   s.windowWidth  + dx * WL_SENSITIVITY);
        s.windowCenter = s.windowCenter - dy * WL_SENSITIVITY;

        // Desactivar preset seleccionado (custom)
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        this._updateStatus(s);
    },
    _updateStatus(s) {
        document.getElementById('statusWL').textContent =
            `W: ${Math.round(s.windowWidth)} L: ${Math.round(s.windowCenter)}`;
    },
};

/* ── Pointer (selección / hit-test) ──────────────────────── */
ToolHandlers[TOOL_IDS.POINTER] = {
    onDown(viewport, pos, drag) {
        const imgPos = viewport.canvasToImage(pos.x, pos.y);
        const hit = MeasurementStore.hitTest(viewport.state.sliceIndex, imgPos.x, imgPos.y);
        if (hit) {
            MeasurementStore.selectOnly(hit.id);
        } else {
            MeasurementStore.deselectAll();
        }
    },
    onDrag(viewport, pos, dx, dy, drag) {
        // Mover medición seleccionada
        const items = MeasurementStore.get(viewport.state.sliceIndex);
        const sel   = items.find(m => m.selected);
        if (!sel) return;
        const imgDx = dx / ((viewport.state.zoom || 1) * Math.min(
            viewport.glCanvas.offsetWidth  / (viewport.state.frame?.cols || 512),
            viewport.glCanvas.offsetHeight / (viewport.state.frame?.rows || 512)
        ));
        const imgDy = dy / ((viewport.state.zoom || 1) * Math.min(
            viewport.glCanvas.offsetWidth  / (viewport.state.frame?.cols || 512),
            viewport.glCanvas.offsetHeight / (viewport.state.frame?.rows || 512)
        ));
        this._shiftMeasurement(sel, imgDx, imgDy);
        MeasurementStore.update(sel.id, sel);
    },
    _shiftMeasurement(m, dx, dy) {
        const shiftPt = (p) => p && (p.x += dx, p.y += dy);
        switch (m.type) {
            case 'distance': shiftPt(m.p1); shiftPt(m.p2); break;
            case 'angle':    shiftPt(m.p1); shiftPt(m.vertex); shiftPt(m.p2); break;
            case 'ellipse':  m.cx += dx; m.cy += dy; break;
            case 'rectangle':m.x1 += dx; m.x2 += dx; m.y1 += dy; m.y2 += dy; break;
            case 'arrow':    shiftPt(m.tail); shiftPt(m.head); break;
            case 'text':     shiftPt(m.pos); break;
        }
    },
};

/* ── Probe ───────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.PROBE] = {
    onDown(viewport, pos) {
        this._showHU(viewport, pos);
    },
    onDrag(viewport, pos) {
        this._showHU(viewport, pos);
    },
    _showHU(viewport, pos) {
        const imgPos = viewport.canvasToImage(pos.x, pos.y);
        const f = viewport.state.frame;
        if (!f) return;
        const x = Math.round(imgPos.x), y = Math.round(imgPos.y);
        if (x < 0 || x >= f.cols || y < 0 || y >= f.rows) return;
        const raw = f.pixelData[y * f.cols + x];
        const hu  = Math.round(raw * f.rescaleSlope + f.rescaleIntercept);

        const tooltip = document.getElementById('probeTooltip');
        tooltip.textContent = `HU: ${hu}`;
        tooltip.style.left  = (pos.x + viewport.glCanvas.getBoundingClientRect().left + 12) + 'px';
        tooltip.style.top   = (pos.y + viewport.glCanvas.getBoundingClientRect().top  - 10) + 'px';
        tooltip.classList.remove('hidden');
    },
    onUp() {
        setTimeout(() => document.getElementById('probeTooltip').classList.add('hidden'), 1500);
    },
};
