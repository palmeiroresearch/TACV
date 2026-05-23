'use strict';

/* ============================================================
   SeriesPanel — Thumbnail strip + cine playback
   ============================================================ */

const SeriesPanel = {
    _series:       [],
    _activeIndex:  0,
    _cineInterval: null,
    _cineFps:      8,

    /* ── Inicializar con una serie cargada ───────────── */
    init(series) {
        this._series      = series;
        this._activeIndex = 0;
        this._renderThumbnails();
        this._updateCounter(0);
        document.getElementById('sliceCounter').classList.remove('hidden');
    },

    /* ── Renderizar thumbnails (CPU 2D — sin contexto WebGL adicional) ── */
    // Se evita crear un RendererGL extra porque los tablets tienen límite estricto
    // de contextos WebGL simultáneos (~8). Con los viewports principales ya activos,
    // crear otro contexto falla silenciosamente y los thumbnails nunca aparecen.
    _renderThumbnails() {
        const strip = document.getElementById('thumbnailStrip');
        strip.innerHTML = '';

        // Lote adaptativo: en tablet reducir trabajo simultáneo
        const isTouch = typeof Capabilities !== 'undefined' && Capabilities.isTouch;
        const batchDelay = isTouch ? 40 : 20;  // ms entre lotes

        this._series.forEach((frame, i) => {
            const item   = document.createElement('div');
            item.className = 'thumb-item loading';
            item.dataset.index = i;

            const canvas = document.createElement('canvas');
            canvas.width  = THUMB_SIZE;
            canvas.height = THUMB_SIZE;

            const label = document.createElement('div');
            label.className   = 'thumb-label';
            label.textContent = frame.instanceNumber ?? (i + 1);

            item.appendChild(canvas);
            item.appendChild(label);
            strip.appendChild(item);

            item.addEventListener('click', () => this.jumpTo(i));

            const renderThumb = () => {
                try {
                    this._renderThumb2D(canvas, frame);
                    item.classList.remove('loading');
                } catch (e) { console.warn('Thumb error:', e); }
            };

            // Escalonar por lotes para no saturar el hilo principal en tablet
            setTimeout(renderThumb, Math.floor(i / 5) * batchDelay);
        });

        this.setActive(0);
    },

    /* ── Render 2D de thumbnail (windowing CPU, sin WebGL) ── */
    _renderThumb2D(canvas, frame) {
        const ctx = canvas.getContext('2d');
        const tw  = canvas.width;
        const th  = canvas.height;
        const fw  = frame.cols;
        const fh  = frame.rows;
        const preset    = WINDOWING_PRESETS.brain;
        const wMin      = preset.center - preset.width / 2;
        const wRange    = preset.width;
        const slope     = frame.rescaleSlope     ?? 1;
        const intercept = frame.rescaleIntercept ?? -1024;
        const pd        = frame.pixelData;

        const imageData = ctx.createImageData(tw, th);
        const d = imageData.data;
        for (let ty = 0; ty < th; ty++) {
            // flipV: convención radiológica (fila 0 = inferior en pantalla)
            const sy = Math.floor((th - 1 - ty) / th * fh);
            const srcRow = sy * fw;
            for (let tx = 0; tx < tw; tx++) {
                const sx  = Math.floor(tx / tw * fw);
                const hu  = pd[srcRow + sx] * slope + intercept;
                const v   = hu <= wMin ? 0 : hu >= wMin + wRange ? 255
                          : ((hu - wMin) / wRange * 255 + 0.5) | 0;
                const idx = (ty * tw + tx) * 4;
                d[idx] = d[idx + 1] = d[idx + 2] = v;
                d[idx + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    },

    /* ── Navegar a un slice ──────────────────────────── */
    jumpTo(index) {
        index = Math.max(0, Math.min(this._series.length - 1, index));
        this._activeIndex = index;

        const vp = ViewportLayout.getActive();
        const frame = this._series[index];
        // Nunca cargar frame 2D en viewports MPR coronal/sagital (usan textura 3D)
        const canLoad = (v) => !v.mprPlane || v.mprPlane === 'axial';
        if (ViewportLayout.syncEnabled && frame) {
            ViewportLayout.getAll().forEach(v => {
                if (canLoad(v)) v.loadFrame(frame, index, this._series.length);
            });
        } else if (vp && frame && canLoad(vp)) {
            vp.loadFrame(frame, index, this._series.length);
        }

        // Actualizar crosshair en los viewports MPR (coronal/sagital muestran línea de posición axial)
        ViewportLayout.getAll().forEach(otherVp => {
            if (otherVp !== vp && otherVp.mprPlane && otherVp.mprPlane !== 'axial') {
                otherVp.render();
            }
        });

        this.setActive(index);
        this._updateCounter(index);
        Storage.dispatch('sliceChanged', { index });
    },

    navigateDelta(delta) {
        this.jumpTo(this._activeIndex + delta);
    },

    /* ── Marcar thumbnail activo ──────────────────────── */
    setActive(index) {
        const strip = document.getElementById('thumbnailStrip');
        strip.querySelectorAll('.thumb-item').forEach(item => {
            item.classList.toggle('active', parseInt(item.dataset.index) === index);
        });
        // Scroll al thumbnail activo
        const active = strip.querySelector(`.thumb-item[data-index="${index}"]`);
        active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },

    _updateCounter(index) {
        document.getElementById('sliceCounter').textContent =
            `${index + 1} / ${this._series.length}`;
    },

    /* ── Cine playback ─────────────────────────────────── */
    startCine() {
        if (this._cineInterval) return;
        const btn = document.getElementById('cinePlay');
        btn.textContent = '⏸';
        btn.classList.add('playing');

        this._cineInterval = setInterval(() => {
            const next = (this._activeIndex + 1) % this._series.length;
            this.jumpTo(next);
        }, 1000 / this._cineFps);
    },

    stopCine() {
        if (!this._cineInterval) return;
        clearInterval(this._cineInterval);
        this._cineInterval = null;
        const btn = document.getElementById('cinePlay');
        btn.textContent = '▶';
        btn.classList.remove('playing');
    },

    toggleCine() {
        this._cineInterval ? this.stopCine() : this.startCine();
    },

    setFps(fps) {
        this._cineFps = fps;
        const fpsEl = document.getElementById('cineFps');
        if (fpsEl) fpsEl.value = fps;
        if (this._cineInterval) { this.stopCine(); this.startCine(); }
    },

    getSeries() { return this._series; },
    getActiveIndex() { return this._activeIndex; },
};
