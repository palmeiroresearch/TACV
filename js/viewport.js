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
            flipV:      true,   // Convención radiológica: anterior (ojos) arriba = fila 0 abajo en GL
            rotation:   0,

            // Opciones de visualización
            isInverted:        false,
            isSuperResEnabled: false,
            anonymized:        false,
            colorMapId:        'grayscale',

            // Filtros de post-procesamiento
            bicubicEnabled:    false,
            usmEnabled:        false,
            usmStrength:       1.0,
            usmRadius:         1.5,
            usmThreshold:      0.01,
            bilateralEnabled:  false,
            bilateralSigmaS:   2.0,
            bilateralSigmaR:   0.1,
            anisoEnabled:      false,
            anisoIterations:   10,
            anisoK:            0.1,
            anisoLambda:       0.2,
            anisoFunc:         0,
            claheEnabled:      false,
            claheClipLimit:    2.0,
            claheStrength:     0.7,
            claheTileSize:     64,
            retinexEnabled:    false,
            retinexGain:       0.5,
            retinexOffset:     0.5,
            retinexSigmaS:     15,
            retinexSigmaM:     60,
            retinexSigmaL:     120,

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
        // Mantiene fijo el píxel bajo el cursor.
        // Derivado de: texcoord_cursor = constante antes/después del zoom.
        // panX: texcoord.x = (cx-cw/2-panX)/(b·iw·z) → panX_new = scale·panX - (scale-1)·(cx-cw/2)
        // panY: texcoord.y = (cy-ch/2-panY)/(b·ih·z) → panY_new = scale·panY + (scale-1)·(ch/2-cy)
        this.state.panX = scale * this.state.panX - (scale - 1) * (cx - cw / 2);
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

    toggleAnonymize() {
        this.state.anonymized = !this.state.anonymized;
        document.getElementById('btnAnonymize')?.classList.toggle('on', this.state.anonymized);
        this.render();
    }

    // Setter genérico para cualquier campo de filtro
    setFilter(key, value) {
        this.state[key] = value;
        this.render();
    }

    toggleFilter(key, btnId) {
        this.state[key] = !this.state[key];
        if (btnId) document.getElementById(btnId)?.classList.toggle('on', this.state[key]);
        this.render();
    }

    /* ── Conversión canvas ↔ imagen ─────────────────────── */
    // Estas funciones deben ser el INVERSO exacto de _buildTransform en renderer-gl.js.
    // El invariante: imageToCanvas(canvasToImage(p)) === p para todo p visible.

    canvasToImage(cx, cy) {
        const f = this.state.frame;
        if (!f) return { x: 0, y: 0 };

        const cw   = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch   = this.glCanvas.offsetHeight || this.glCanvas.height;
        const rot  = (this.state.rotation ?? 0) * Math.PI / 180;
        const is90 = (this.state.rotation === 90 || this.state.rotation === 270);
        const effW = is90 ? f.rows : f.cols;
        const effH = is90 ? f.cols : f.rows;
        const base = Math.min(cw / effW, ch / effH);
        const z    = this.state.zoom * base;
        const sxAbs = is90 ? ch/(base*f.rows*this.state.zoom) : cw/(base*f.cols*this.state.zoom);
        const syAbs = is90 ? cw/(base*f.cols*this.state.zoom) : ch/(base*f.rows*this.state.zoom);
        const fxSign = this.state.flipH ? -1 : 1;
        const fySign = this.state.flipV ? -1 : 1;

        // Derivado de: texcoord.x = (cx-cw/2-panX)/(b·iw·z) + 0.5  (no rot, no flip)
        // Con flip/rot: invertir el transform del shader
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const ox = cw / 2 + this.state.panX;
        const oy = ch / 2 + this.state.panY;
        const dx = cx - ox, dy = cy - oy;
        // Des-rotar (inverso del shader que aplica -rot)
        const rdx =  cos * dx + sin * dy;
        const rdy = -sin * dx + cos * dy;

        return {
            x:  rdx / (z * fxSign) + f.cols / 2,
            y: -rdy / (z * fySign) + f.rows / 2,
        };
    }

    imageToCanvas(ix, iy) {
        const f = this.state.frame;
        if (!f) return { x: 0, y: 0 };

        const cw   = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch   = this.glCanvas.offsetHeight || this.glCanvas.height;
        const rot  = (this.state.rotation ?? 0) * Math.PI / 180;
        const is90 = (this.state.rotation === 90 || this.state.rotation === 270);
        const effW = is90 ? f.rows : f.cols;
        const effH = is90 ? f.cols : f.rows;
        const base  = Math.min(cw / effW, ch / effH);
        const z     = this.state.zoom * base;
        const fxSign = this.state.flipH ? -1 : 1;
        const fySign = this.state.flipV ? -1 : 1;

        const cos = Math.cos(rot), sin = Math.sin(rot);
        const dx =  (ix - f.cols / 2) * z * fxSign;
        const dy = -(iy - f.rows / 2) * z * fySign;  // negado: canvas Y ↓ vs textura Y ↑
        return {
            x: cw / 2 + this.state.panX + cos * dx - sin * dy,
            y: ch / 2 + this.state.panY + sin * dx + cos * dy,
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
