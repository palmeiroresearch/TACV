'use strict';

/* ============================================================
   Viewport — Maneja una celda de visualización CT
   Contiene: canvas WebGL (imagen) + canvas 2D (overlays)
   ============================================================ */

class Viewport {
    constructor(cell, id) {
        this.id   = id;
        this.cell = cell;

        // Canvas WebGL (imagen CT)
        this.glCanvas = document.createElement('canvas');
        this.glCanvas.className = 'gl-canvas';
        cell.appendChild(this.glCanvas);

        // Canvas 2D (overlays — encima del WebGL)
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.className = 'overlay-canvas';
        this.overlayCtx = this.overlayCanvas.getContext('2d');
        cell.appendChild(this.overlayCanvas);

        // Motor WebGL2
        try {
            this.renderer = new RendererGL(this.glCanvas);
        } catch (err) {
            cell.innerHTML = `<div style="color:red;padding:20px">WebGL2 no disponible: ${err.message}</div>`;
            return;
        }

        // Estado del viewport
        const preset = WINDOWING_PRESETS[DEFAULT_PRESET];
        this.state = {
            frame:         null,
            sliceIndex:    0,
            totalSlices:   0,

            // Windowing
            windowWidth:   preset.width,
            windowCenter:  preset.center,
            presetId:      DEFAULT_PRESET,

            // Transforms
            zoom:       1,
            panX:       0,
            panY:       0,
            flipH:      false,
            flipV:      false,
            rotation:   0,

            // Opciones
            isInverted:        false,
            isSuperResEnabled: false,
            colorMapId:        'grayscale',

            // Orientación (para overlays)
            orientationLabels: { ...ORIENTATION_AXIAL },

            // Tool state
            activeTool:      null,
            mousePos:        null,
            liveMeasurement: null,
        };

        this._resizeObs = new ResizeObserver(() => this.render());
        this._resizeObs.observe(cell);
        this._bindEvents();
    }

    /* ── Cargar un DicomFrame ──────────────────────────── */
    loadFrame(frame, sliceIndex, totalSlices) {
        this.state.frame       = frame;
        this.state.sliceIndex  = sliceIndex ?? this.state.sliceIndex;
        this.state.totalSlices = totalSlices ?? this.state.totalSlices;
        this.render();
        this._updateStatusBar();
    }

    /* ── Render principal ──────────────────────────────── */
    render() {
        if (!this.renderer) return;
        this.renderer.render(this.state.frame, this.state);
        OverlayRenderer.render(this);
    }

    /* ── Fit to window ─────────────────────────────────── */
    fitToWindow() {
        this.state.zoom = 1;
        this.state.panX = 0;
        this.state.panY = 0;
    }

    /* ── Zoom centrado en un punto del canvas ──────────── */
    zoomAt(cx, cy, factor) {
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.state.zoom * factor));
        if (newZoom === this.state.zoom) return;
        const scale  = newZoom / this.state.zoom;
        const cw = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch = this.glCanvas.offsetHeight || this.glCanvas.height;
        // El pan se mide desde el centro del canvas.
        // X: offset = cx - cw/2  (crece a la derecha, igual que canvas y texcoord X)
        // Y: offset = ch/2 - cy  (invertido: canvas Y crece hacia abajo, texcoord Y hacia arriba)
        this.state.panX = scale * this.state.panX + (scale - 1) * (cx - cw / 2);
        this.state.panY = scale * this.state.panY + (scale - 1) * (ch / 2 - cy);
        this.state.zoom = newZoom;
        document.getElementById('statusZoom').textContent = `Zoom: ${Math.round(newZoom * 100)}%`;
    }

    /* ── Preset de ventana ─────────────────────────────── */
    applyPreset(presetId) {
        const p = WINDOWING_PRESETS[presetId];
        if (!p) return;
        this.state.presetId    = presetId;
        this.state.windowWidth  = p.width;
        this.state.windowCenter = p.center;
        this._updateStatusBar();
        this.render();
    }

    /* ── Flip / Rotate ─────────────────────────────────── */
    flipH()  { this.state.flipH = !this.state.flipH; this.render(); }
    flipV()  { this.state.flipV = !this.state.flipV; this.render(); }
    rotateCW()  { this.state.rotation = (this.state.rotation + 90) % 360; this.render(); }
    rotateCCW() { this.state.rotation = ((this.state.rotation - 90) + 360) % 360; this.render(); }
    toggleInvert() {
        this.state.isInverted = !this.state.isInverted;
        document.getElementById('btnInvert').classList.toggle('on', this.state.isInverted);
        this.render();
    }

    toggleSuperRes() {
        this.state.isSuperResEnabled = !this.state.isSuperResEnabled;
        document.getElementById('btnSuperRes')?.classList.toggle('on', this.state.isSuperResEnabled);
        this.render();
    }

    /* ── Conversión canvas ↔ imagen ─────────────────────── */
    canvasToImage(cx, cy) {
        const f = this.state.frame;
        if (!f) return { x: 0, y: 0 };

        const cw = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch = this.glCanvas.offsetHeight || this.glCanvas.height;
        const baseZoom = Math.min(cw / f.cols, ch / f.rows);
        const z  = this.state.zoom * baseZoom;
        const rot = this.state.rotation * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const ox  = cw / 2 + this.state.panX;
        const oy  = ch / 2 + this.state.panY;

        // Invertir transform: canvas → imagen
        let dx = (cx - ox), dy = (cy - oy);
        // Des-rotar
        const rdx =  cos * dx + sin * dy;
        const rdy = -sin * dx + cos * dy;
        const sx = this.state.flipH ? -1 : 1;
        const sy = this.state.flipV ? -1 : 1;
        // NOTA: el eje Y de canvas (crece ↓) es OPUESTO al eje Y de textura WebGL (crece ↑).
        // Por eso se NIEGA rdy en la conversión a fila imagen.
        return {
            x:  rdx / (z * sx) + f.cols / 2,
            y: f.rows / 2 - rdy / (z * sy),
        };
    }

    imageToCanvas(ix, iy) {
        const f = this.state.frame;
        if (!f) return { x: 0, y: 0 };

        const cw = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch = this.glCanvas.offsetHeight || this.glCanvas.height;
        const baseZoom = Math.min(cw / f.cols, ch / f.rows);
        const z  = this.state.zoom * baseZoom;
        const rot = this.state.rotation * Math.PI / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const sx = this.state.flipH ? -1 : 1;
        const sy = this.state.flipV ? -1 : 1;

        const dx = (ix - f.cols / 2) * z * sx;
        const dy = (iy - f.rows / 2) * z * sy;
        // Igual que arriba: se NIEGAN los términos dy para compensar la inversión Y
        return {
            x: cw / 2 + this.state.panX + cos * dx - sin * dy,
            y: ch / 2 + this.state.panY - sin * dx - cos * dy,
        };
    }

    /* ── Bindings de eventos ─────────────────────────── */
    _bindEvents() {
        // Los overlayCanvas no capturan eventos (pointer-events: none en CSS)
        // El glCanvas captura todo
        const gc = this.glCanvas;
        gc.addEventListener('mousedown',   (e) => ToolState.onMouseDown(this, e));
        gc.addEventListener('mousemove',   (e) => ToolState.onMouseMove(this, e));
        gc.addEventListener('mouseup',     (e) => ToolState.onMouseUp(this, e));
        gc.addEventListener('mouseleave',  ()  => ToolState.onMouseLeave(this));
        gc.addEventListener('wheel',       (e) => ToolState.onWheel(this, e), { passive: false });
        gc.addEventListener('contextmenu', (e) => ToolState.onContextMenu(e));
        gc.addEventListener('mouseenter',  ()  => ToolState.setActiveViewport(this));

        // Touch support básico
        gc.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                ToolState.onMouseDown(this, this._touchToMouse(e.touches[0]));
            }
        }, { passive: true });
        gc.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1) {
                ToolState.onMouseMove(this, this._touchToMouse(e.touches[0]));
            }
        }, { passive: false });
        gc.addEventListener('touchend', (e) => {
            ToolState.onMouseUp(this, this._touchToMouse(e.changedTouches[0]));
        }, { passive: true });
    }

    _touchToMouse(touch) {
        return { clientX: touch.clientX, clientY: touch.clientY, button: 0 };
    }

    _updateStatusBar() {
        const s = this.state;
        document.getElementById('statusSlice').textContent =
            `Slice: ${s.sliceIndex + 1} / ${s.totalSlices || 1}`;
        document.getElementById('statusWL').textContent =
            `W: ${Math.round(s.windowWidth)} L: ${Math.round(s.windowCenter)}`;
        document.getElementById('statusZoom').textContent =
            `Zoom: ${Math.round((s.zoom || 1) * 100)}%`;
    }

    /* ── Capturar imagen como blob ──────────────────── */
    async captureBlob(type = 'image/png', quality = 0.95) {
        return new Promise(resolve => this.glCanvas.toBlob(resolve, type, quality));
    }

    destroy() {
        this._resizeObs.disconnect();
        this.renderer?.destroy();
    }
}
