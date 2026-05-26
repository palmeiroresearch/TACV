'use strict';

/* ── Ventana Flotante (Overlay Comparador) ─────────────────────────────────
   Muestra el mismo slice con un preset W/L y colormap alternativos,
   superpuesto sobre el viewport principal como un panel arrastrable con zoom.

   Técnica: loupeCanvas del mismo tamaño que el viewport, renderizado con
   parámetros alternativos, ocultado con clip-path:inset() para que solo
   sea visible el área bajo el marco arrastrable.

   Drag: el marco se puede arrastrar desde la barra superior, la barra de zoom
   O desde el área de imagen (div transparente encima de la imagen).
   El offset se calcula en coordenadas del cell para evitar el salto inicial:
     dragOX = clientX_mousedown - cellRect.left - frame.offsetLeft
   y en cada movimiento:
     newLeft = clientX - cellRect.left - dragOX

   Probe: mide HU en el centro de la lupa usando la transformada inversa del
   loupeState (idéntica a Viewport.canvasToImage con zoom/pan propios).
   ────────────────────────────────────────────────────────────────────────── */

const Loupe = {
    _viewport:     null,
    _renderer:     null,
    _loupeCanvas:  null,
    _frame:        null,
    _dragOX:       0,
    _dragOY:       0,

    presetId:      'stroke',
    colorMapId:    'grayscale',
    _zoomPct:      0,
    _probeActive:  false,

    _HEADER_H: 52,  // 30px (preset/cmap/X) + 22px (zoom slider)
    _FOOTER_H: 28,  // barra inferior con probe + valor HU

    isActive(vp) { return this._viewport === vp; },

    /* ── Abrir ────────────────────────────────────────────── */
    open(viewport) {
        if (!viewport?.state.frame) { UI.showToast('No hay imagen cargada', 'warning'); return; }
        if (this._viewport) this.close();

        this._viewport = viewport;
        const cell = viewport.cell;

        const loupeCanvas = document.createElement('canvas');
        loupeCanvas.className = 'loupe-canvas';
        cell.appendChild(loupeCanvas);
        this._loupeCanvas = loupeCanvas;

        this._renderer = new RendererGL(loupeCanvas);

        const frame = document.createElement('div');
        frame.className = 'loupe-frame';
        frame.style.left = Math.round(cell.offsetWidth  * 0.25) + 'px';
        frame.style.top  = Math.round(cell.offsetHeight * 0.25) + 'px';
        frame.innerHTML = this._buildFrameHTML();
        cell.appendChild(frame);
        this._frame = frame;

        this._bindFrameEvents();
        this.refresh(viewport);

        document.getElementById('btnLoupe')?.classList.add('active');
    },

    /* ── Cerrar ───────────────────────────────────────────── */
    close() {
        this._loupeCanvas?.remove();
        this._frame?.remove();
        this._renderer    = null;
        this._loupeCanvas = null;
        this._frame       = null;
        this._viewport    = null;
        this._zoomPct     = 0;
        this._probeActive = false;
        document.getElementById('btnLoupe')?.classList.remove('active');
    },

    /* ── Renderizar ───────────────────────────────────────── */
    refresh(viewport) {
        if (!this._renderer || !viewport?.state.frame || !this._frame) return;

        const cw = viewport.cell.offsetWidth;
        const ch = viewport.cell.offsetHeight;
        if (!cw || !ch) return;

        const H   = this._HEADER_H;
        const F   = this._FOOTER_H;
        const mag = 1 + this._zoomPct / 100;

        // Centro del área de imagen del marco (entre header y footer)
        const lx = this._frame.offsetLeft + this._frame.offsetWidth  / 2;
        const ly = this._frame.offsetTop  + H + (this._frame.offsetHeight - H - F) / 2;

        const loupeState = {
            ...viewport.state,
            windowWidth:  WINDOWING_PRESETS[this.presetId]?.width  ?? 80,
            windowCenter: WINDOWING_PRESETS[this.presetId]?.center ?? 40,
            presetId:     this.presetId,
            colorMapId:   this.colorMapId,
            zoom:         viewport.state.zoom * mag,
            panX:         mag * viewport.state.panX - (mag - 1) * (lx - cw / 2),
            panY:         mag * viewport.state.panY + (mag - 1) * (ch / 2 - ly),
            tvEnabled:        false,
            claheEnabled:     false,
            bilateralEnabled: false,
            anisoEnabled:     false,
            retinexEnabled:   false,
            isSuperResEnabled: false,
            bicubicEnabled:   false,
            usmEnabled:       false,
            abMode:           false,
        };

        this._renderer.render(viewport.state.frame, loupeState);
        this._updateClipPath();

        if (this._probeActive) {
            const hu = this._sampleHU(viewport.state.frame, loupeState, cw, ch, lx, ly);
            const el = this._frame.querySelector('[data-loupe-hu]');
            if (el) el.textContent = hu !== null ? `${Math.round(hu)} HU` : '—';
        }
    },

    /* ── Clip-path ────────────────────────────────────────── */
    _updateClipPath() {
        const frame  = this._frame;
        const canvas = this._loupeCanvas;
        if (!frame || !canvas || !this._viewport) return;

        const H  = this._HEADER_H;
        const F  = this._FOOTER_H;
        const cw = this._viewport.cell.offsetWidth;
        const ch = this._viewport.cell.offsetHeight;

        const top    = frame.offsetTop  + H;
        const left   = frame.offsetLeft;
        const right  = cw - frame.offsetLeft - frame.offsetWidth;
        const bottom = ch - frame.offsetTop  - frame.offsetHeight + F;

        canvas.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    },

    /* ── HTML interno del marco ───────────────────────────── */
    _buildFrameHTML() {
        const presetOptions = Object.entries(WINDOWING_PRESETS)
            .map(([k, v]) => `<option value="${k}"${k === this.presetId ? ' selected' : ''}>${v.label}</option>`)
            .join('');
        const cmapOptions = [
            ['grayscale', 'Gris'],
            ['hotIron',   '🔥 Hot'],
            ['spectrum',  '🌈 Espectro'],
            ['coolWarm',  'Cool/Warm'],
        ].map(([k, l]) => `<option value="${k}"${k === this.colorMapId ? ' selected' : ''}>${l}</option>`).join('');

        return `
        <div class="loupe-header" data-drag-handle>
            <span class="loupe-title">⊞ Lupa</span>
            <select class="loupe-select" data-loupe-preset>${presetOptions}</select>
            <select class="loupe-select" data-loupe-cmap>${cmapOptions}</select>
            <button class="loupe-close" data-loupe-close>✕</button>
        </div>
        <div class="loupe-zoom-bar" data-drag-handle>
            <span class="loupe-zoom-label">Zoom</span>
            <input type="range" class="loupe-zoom-slider" data-loupe-zoom
                   min="0" max="400" step="10" value="0">
            <span class="loupe-zoom-value" data-loupe-zoom-val>×1.0</span>
        </div>
        <div class="loupe-img-drag" data-drag-handle></div>
        <div class="loupe-crosshair" data-loupe-crosshair></div>
        <div class="loupe-bottom-bar">
            <button class="loupe-probe-btn" data-loupe-probe title="Medir HU en el centro de la lupa">⊕</button>
            <span class="loupe-hu-value" data-loupe-hu>—</span>
        </div>`;
    },

    /* ── Eventos del marco ────────────────────────────────── */
    _bindFrameEvents() {
        const frame = this._frame;

        frame.querySelector('[data-loupe-preset]').addEventListener('change', (e) => {
            this.presetId = e.target.value;
            this.refresh(this._viewport);
        });

        frame.querySelector('[data-loupe-cmap]').addEventListener('change', (e) => {
            this.colorMapId = e.target.value;
            this.refresh(this._viewport);
        });

        const slider  = frame.querySelector('[data-loupe-zoom]');
        const zoomVal = frame.querySelector('[data-loupe-zoom-val]');
        slider.addEventListener('input', () => {
            this._zoomPct = parseInt(slider.value);
            zoomVal.textContent = `×${(1 + this._zoomPct / 100).toFixed(1)}`;
            this.refresh(this._viewport);
        });
        slider.addEventListener('keydown', (e) => e.stopPropagation());

        frame.querySelector('[data-loupe-close]').addEventListener('click', () => this.close());

        frame.querySelector('[data-loupe-probe]').addEventListener('click', () => {
            this._probeActive = !this._probeActive;
            frame.querySelector('[data-loupe-probe]').classList.toggle('active', this._probeActive);
            frame.querySelector('[data-loupe-crosshair]').classList.toggle('visible', this._probeActive);
            if (!this._probeActive) {
                const el = frame.querySelector('[data-loupe-hu]');
                if (el) el.textContent = '—';
            } else {
                this.refresh(this._viewport);
            }
        });

        // Drag — todas las zonas marcadas [data-drag-handle]:
        //   header, zoom-bar, y el área de imagen (loupe-img-drag)
        frame.querySelectorAll('[data-drag-handle]').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' ||
                    e.target.tagName === 'INPUT') return;
                e.preventDefault();
                this._startDrag(e.clientX, e.clientY);
                const onMv = (ev) => this._onDragMove(ev.clientX, ev.clientY);
                const onUp = () => {
                    document.removeEventListener('mousemove', onMv);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMv);
                document.addEventListener('mouseup', onUp);
            });

            handle.addEventListener('touchstart', (e) => {
                if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' ||
                    e.target.tagName === 'INPUT') return;
                const t = e.touches[0];
                this._startDrag(t.clientX, t.clientY);
                const onMv = (ev) => {
                    ev.preventDefault();
                    this._onDragMove(ev.touches[0].clientX, ev.touches[0].clientY);
                };
                const onUp = () => {
                    document.removeEventListener('touchmove', onMv);
                    document.removeEventListener('touchend', onUp);
                };
                document.addEventListener('touchmove', onMv, { passive: false });
                document.addEventListener('touchend', onUp);
            }, { passive: true });
        });
    },

    // Calcular el offset del clic DENTRO del marco en coordenadas del cell.
    // Esto evita el salto inicial: el offset es siempre relativo al cell,
    // igual que frame.style.left/top, sin mezclar coordenadas del browser.
    _startDrag(clientX, clientY) {
        const cellRect = this._viewport.cell.getBoundingClientRect();
        this._dragOX   = clientX - cellRect.left - this._frame.offsetLeft;
        this._dragOY   = clientY - cellRect.top  - this._frame.offsetTop;
    },

    _onDragMove(clientX, clientY) {
        if (!this._frame || !this._viewport) return;
        const cell     = this._viewport.cell;
        const cellRect = cell.getBoundingClientRect();
        let x = clientX - cellRect.left - this._dragOX;
        let y = clientY - cellRect.top  - this._dragOY;
        x = Math.max(0, Math.min(cell.offsetWidth  - this._frame.offsetWidth,  x));
        y = Math.max(0, Math.min(cell.offsetHeight - this._frame.offsetHeight, y));
        this._frame.style.left = x + 'px';
        this._frame.style.top  = y + 'px';
        if (this._zoomPct > 0 || this._probeActive) this.refresh(this._viewport);
        else this._updateClipPath();
    },

    /* ── Medir HU en el centro de la lupa ────────────────── */
    // Inversa del shader: canvas coord → imagen coord → pixelData → HU
    // Usa loupeState (zoom/pan propios de la lupa, no del viewport principal)
    _sampleHU(frame, state, cw, ch, cx, cy) {
        if (!frame?.pixelData) return null;
        const { cols, rows } = frame;
        const rot    = (state.rotation ?? 0) * Math.PI / 180;
        const is90   = (state.rotation === 90 || state.rotation === 270);
        const effW   = is90 ? rows : cols;
        const effH   = is90 ? cols : rows;
        const base   = Math.min(cw / effW, ch / effH);
        const z      = state.zoom * base;
        const fxSign = state.flipH ? -1 : 1;
        const fySign = state.flipV ? -1 : 1;
        const cosR   = Math.cos(rot), sinR = Math.sin(rot);

        const dx  = cx - (cw / 2 + state.panX);
        const dy  = cy - (ch / 2 + state.panY);
        const rdx =  cosR * dx + sinR * dy;
        const rdy = -sinR * dx + cosR * dy;

        const imgX = rdx / (z * fxSign) + cols / 2;
        const imgY = -rdy / (z * fySign) + rows / 2;

        const px = Math.round(imgX);
        const py = Math.round(imgY);
        if (px < 0 || px >= cols || py < 0 || py >= rows) return null;

        const raw = frame.pixelData[py * cols + px];
        return raw * (frame.rescaleSlope ?? 1) + (frame.rescaleIntercept ?? 0);
    },
};
