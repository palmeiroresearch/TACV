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

        // Canvas TV (Total Variation — entre GL y overlay, oculto por defecto)
        this.tvCanvas = document.createElement('canvas');
        this.tvCanvas.className = 'tv-canvas hidden';
        this.tvCtx = this.tvCanvas.getContext('2d');
        cell.appendChild(this.tvCanvas);

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
            isInverted:          false,
            isSuperResEnabled:   false,
            isMultiWindowEnabled: false,
            multiWindowStrength:  0.85,
            anonymized:          false,
            colorMapId:          'grayscale',

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

            // A/B Comparator
            abMode:   false,
            abSplitX: 0.5,

            // Total Variation denoising (CPU worker, Chambolle 2004)
            tvEnabled:    false,
            tvLambda:     0.12,
            tvIterations: 50,
        };

        this._tvWorker        = null;
        this._tvBusy          = false;
        this._tvDenoisedPixels = null;

        this._resizeObs = new ResizeObserver(() => this.render());
        this._resizeObs.observe(cell);
        this._bindEvents();
    }

    /* ── Cargar un DicomFrame ──────────────────────────── */
    loadFrame(frame, sliceIndex, totalSlices) {
        // Limpiar cache TV al cambiar de frame
        this._tvDenoisedPixels = null;
        this._tvBusy = false;
        this.state.frame       = frame;
        this.state.sliceIndex  = sliceIndex ?? this.state.sliceIndex;
        this.state.totalSlices = totalSlices ?? this.state.totalSlices;
        this.render();
        this._updateStatusBar();
    }

    /* ── Render principal ──────────────────────────────── */
    render() {
        if (!this.renderer) return;

        // Si TV está activo y hay pixels denoised, renderizar con ellos (mismo pipeline: transforms, colormap)
        const renderFrame = (this.state.tvEnabled && this._tvDenoisedPixels && this.state.frame)
            ? { ...this.state.frame, pixelData: this._tvDenoisedPixels,
                sopInstanceUID: this.state.frame.sopInstanceUID + '_tv' }
            : this.state.frame;

        this.renderer.render(renderFrame, this.state);

        // A/B mode: render clean (no-filter) version to secondary canvas
        if (this.state.abMode) {
            this._ensureAbRenderer();
            if (this._abRenderer) {
                const clean = {
                    ...this.state,
                    bicubicEnabled: false, usmEnabled: false, bilateralEnabled: false,
                    anisoEnabled: false, claheEnabled: false, retinexEnabled: false,
                    isSuperResEnabled: false,
                };
                this._abRenderer.render(this.state.frame, clean);
            }
        }

        OverlayRenderer.render(this);
        if (typeof HistogramPanel !== 'undefined' && this === ViewportLayout.getActive()) {
            HistogramPanel.redraw();
        }

        // TV denoising: lanzar worker si está activo y no hay resultado para el frame actual
        if (this.state.tvEnabled && this.state.frame && !this._tvBusy && !this._tvDenoisedPixels) {
            this._triggerTV();
        }
    }

    /* ── Total Variation denoising ────────────────────────── */
    // Opera sobre frame.pixelData (HU raw) → resultado en el pipeline normal de rendering
    _triggerTV() {
        const frame = this.state.frame;
        if (!frame?.pixelData) return;

        if (!this._tvWorker) {
            this._tvWorker = new Worker('js/tv-worker.js');
            this._tvWorker.onmessage = (e) => {
                this._tvBusy = false;
                if (!this.state.tvEnabled || !this.state.frame) return;
                const { result, width, height } = e.data;

                // Convertir float [0,1] de vuelta a raw Int16 (inverso del windowing)
                const f = this.state.frame;
                const wc  = this.state.windowCenter ?? f.windowCenter;
                const ww  = this.state.windowWidth  ?? f.windowWidth;
                const wMin = wc - ww / 2, wMax = wc + ww / 2;
                const denoised = new Int16Array(width * height);
                for (let i = 0; i < width * height; i++) {
                    const hu  = result[i] * (wMax - wMin) + wMin;
                    const raw = (hu - f.rescaleIntercept) / f.rescaleSlope;
                    denoised[i] = Math.max(-32768, Math.min(32767, Math.round(raw)));
                }
                this._tvDenoisedPixels = denoised;

                // Re-render con los pixels denoised (mismo pipeline: transforms, colormap, etc.)
                const tvFrame = { ...f, pixelData: denoised, sopInstanceUID: f.sopInstanceUID + '_tv' };
                this.renderer.render(tvFrame, this.state);
                OverlayRenderer.render(this);
            };
        }

        this._tvBusy = true;

        // Convertir HU a [0,1] usando la ventana actual
        const wc = this.state.windowCenter ?? frame.windowCenter;
        const ww = this.state.windowWidth  ?? frame.windowWidth;
        const wMin = wc - ww / 2, wMax = wc + ww / 2;
        const N = frame.rows * frame.cols;
        const float32 = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const hu = frame.pixelData[i] * frame.rescaleSlope + frame.rescaleIntercept;
            float32[i] = Math.min(1, Math.max(0, (hu - wMin) / (wMax - wMin)));
        }

        this._tvWorker.postMessage(
            { float32Data: float32, width: frame.cols, height: frame.rows,
              lambda: this.state.tvLambda ?? 0.12, iterations: this.state.tvIterations ?? 50 },
            [float32.buffer]
        );
    }

    toggleTV() {
        this.state.tvEnabled = !this.state.tvEnabled;
        document.getElementById('btnTV')?.classList.toggle('on', this.state.tvEnabled);
        if (!this.state.tvEnabled) {
            this._tvBusy = false;
            this._tvDenoisedPixels = null;
        }
        this.render();
    }

    _ensureAbRenderer() {
        const w = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const h = this.glCanvas.offsetHeight || this.glCanvas.height;
        if (this._abCanvas && this._abCanvas.width === w && this._abCanvas.height === h) return;
        try {
            if (!this._abCanvas) this._abCanvas = document.createElement('canvas');
            this._abCanvas.width  = w;
            this._abCanvas.height = h;
            this._abRenderer = new RendererGL(this._abCanvas);
        } catch (e) { this._abRenderer = null; }
    }

    toggleAbMode() {
        this.state.abMode = !this.state.abMode;
        document.getElementById('btnAbMode')?.classList.toggle('on', this.state.abMode);
        this.render();
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

    /* ── Auto W/L desde histograma del slice ────────────── */
    autoWindow() {
        const f = this.state.frame;
        if (!f?.pixelData) return;
        const slope     = f.rescaleSlope     ?? 1;
        const intercept = f.rescaleIntercept ?? -1024;
        const pd = f.pixelData;
        const n  = pd.length;

        // Histograma rápido (O(n)) en lugar de sort (O(n log n))
        const BINS = 4096, rawMin = -32768;
        const hist  = new Uint32Array(BINS);
        const scale = (BINS - 1) / 65535;
        for (let i = 0; i < n; i++) hist[Math.round((pd[i] - rawMin) * scale)]++;

        const p005 = n * 0.005, p995 = n * 0.995;
        let cum = 0, lo = rawMin, hi = 32767;
        let foundLo = false;
        for (let b = 0; b < BINS; b++) {
            cum += hist[b];
            if (!foundLo && cum >= p005) { lo = rawMin + b / scale; foundLo = true; }
            if (cum >= p995) { hi = rawMin + b / scale; break; }
        }

        this.state.windowCenter = ((lo + hi) / 2) * slope + intercept;
        this.state.windowWidth  = Math.max(1, (hi - lo) * slope);
        const sel = document.getElementById('presetSelect');
        if (sel) sel.value = '';    // ningún preset activo tras auto
        this._updateStatusBar();
        this.render();
    }

    /* ── Preset de ventana ─────────────────────────────── */
    applyPreset(presetId) {
        const p = WINDOWING_PRESETS[presetId];
        if (!p) return;
        this.state.presetId    = presetId;
        this.state.windowWidth  = p.width;
        this.state.windowCenter = p.center;
        const sel = document.getElementById('presetSelect');
        if (sel) sel.value = presetId;
        Storage.setSetting('activePreset', presetId);
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

    toggleMultiWindow() {
        this.state.isMultiWindowEnabled = !this.state.isMultiWindowEnabled;
        document.getElementById('btnMultiWindow')?.classList.toggle('on', this.state.isMultiWindowEnabled);
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

        // A/B divider drag
        let abDragging = false;
        gc.addEventListener('mousedown', (e) => {
            if (!this.state.abMode || e.button !== 0) return;
            const splitX = Math.round((this.state.abSplitX ?? 0.5) * gc.offsetWidth);
            if (Math.abs(e.offsetX - splitX) < 10) { abDragging = true; e.stopImmediatePropagation(); }
        }, true);
        gc.addEventListener('mousemove', (e) => {
            if (!abDragging) return;
            this.state.abSplitX = Math.max(0.05, Math.min(0.95, e.offsetX / gc.offsetWidth));
            OverlayRenderer.render(this);
            e.stopImmediatePropagation();
        }, true);
        window.addEventListener('mouseup', () => { abDragging = false; });

        // Touch multi-gesture: single-finger = tool drag, two-finger = pinch-zoom + pan
        const _tprev = {};   // { touchId: {x, y} } — posición previa de cada dedo

        gc.addEventListener('touchstart', (e) => {
            const rect = gc.getBoundingClientRect();
            [...e.changedTouches].forEach(t => {
                _tprev[t.identifier] = { x: t.clientX - rect.left, y: t.clientY - rect.top };
            });
            if (e.touches.length === 1) {
                const t = e.touches[0];
                ToolState.onMouseDown(this, { clientX: t.clientX, clientY: t.clientY, button: 0 });
            } else if (e.touches.length >= 2) {
                ToolState.onMouseLeave(this);   // cancelar drag single-touch activo
            }
        }, { passive: true });

        gc.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const rect = gc.getBoundingClientRect();

            if (e.touches.length === 1) {
                const t = e.touches[0];
                ToolState.onMouseMove(this, { clientX: t.clientX, clientY: t.clientY, button: 0 });
                _tprev[t.identifier] = { x: t.clientX - rect.left, y: t.clientY - rect.top };
            } else if (e.touches.length >= 2) {
                const t0 = e.touches[0], t1 = e.touches[1];
                const cur0 = { x: t0.clientX - rect.left, y: t0.clientY - rect.top };
                const cur1 = { x: t1.clientX - rect.left, y: t1.clientY - rect.top };
                const prv0 = _tprev[t0.identifier] || cur0;
                const prv1 = _tprev[t1.identifier] || cur1;

                // Pinch: ratio de distancias → zoom
                const prevDist = Math.hypot(prv1.x - prv0.x, prv1.y - prv0.y);
                const curDist  = Math.hypot(cur1.x - cur0.x, cur1.y - cur0.y);
                if (prevDist > 8) {
                    const cx = (prv0.x + prv1.x) / 2;
                    const cy = (prv0.y + prv1.y) / 2;
                    this.zoomAt(cx, cy, curDist / prevDist);
                }

                // Traslación del punto medio → pan
                const prevMX = (prv0.x + prv1.x) / 2, prevMY = (prv0.y + prv1.y) / 2;
                const curMX  = (cur0.x + cur1.x) / 2, curMY  = (cur0.y + cur1.y) / 2;
                this.state.panX += curMX - prevMX;
                this.state.panY += curMY - prevMY;

                _tprev[t0.identifier] = cur0;
                _tprev[t1.identifier] = cur1;
                this.render();
            }
        }, { passive: false });

        gc.addEventListener('touchend', (e) => {
            [...e.changedTouches].forEach(t => delete _tprev[t.identifier]);
            if (e.touches.length === 0) {
                const t = e.changedTouches[0];
                ToolState.onMouseUp(this, { clientX: t.clientX, clientY: t.clientY, button: 0 });
            }
        }, { passive: true });

        gc.addEventListener('touchcancel', (e) => {
            [...e.changedTouches].forEach(t => delete _tprev[t.identifier]);
            ToolState.onMouseLeave(this);
        }, { passive: true });
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

    clearFrame() {
        this.state.frame       = null;
        this.state.sliceIndex  = 0;
        this.state.totalSlices = 0;
        this._tvBusy = false;
        this.tvCtx?.clearRect(0, 0, this.tvCanvas.width, this.tvCanvas.height);
        if (this.renderer?.gl) {
            const gl = this.renderer.gl;
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        if (this.overlayCtx) {
            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        }
    }

    destroy() {
        this._resizeObs.disconnect();
        this.renderer?.destroy();
    }
}
