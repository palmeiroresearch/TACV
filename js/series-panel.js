'use strict';

/* ============================================================
   SeriesPanel — Thumbnail strip + cine playback
   ============================================================ */

const SeriesPanel = {
    _series:       [],
    _activeIndex:  0,
    _cineInterval: null,
    _cineFps:      8,
    _renderer:     null,  // RendererGL compartido para thumbnails

    /* ── Inicializar con una serie cargada ───────────── */
    init(series) {
        this._series      = series;
        this._activeIndex = 0;
        this._renderThumbnails();
        this._updateCounter(0);
        document.getElementById('sliceCounter').classList.remove('hidden');
    },

    /* ── Renderizar thumbnails ───────────────────────── */
    _renderThumbnails() {
        const strip = document.getElementById('thumbnailStrip');
        strip.innerHTML = '';

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

            // Renderizar thumbnail de forma diferida para no bloquear el UI
            const renderThumb = () => {
                if (!this._renderer) {
                    try {
                        const offscreen = document.createElement('canvas');
                        offscreen.width  = THUMB_SIZE;
                        offscreen.height = THUMB_SIZE;
                        this._renderer = new RendererGL(offscreen);
                    } catch { return; }
                }
                try {
                    const thumbState = {
                        zoom: 1, panX: 0, panY: 0,
                        flipH: false, flipV: false, rotation: 0,
                        isInverted: false, colorMapId: 'grayscale',
                        presetId: 'brain',
                        windowWidth:  WINDOWING_PRESETS.brain.width,
                        windowCenter: WINDOWING_PRESETS.brain.center,
                    };
                    // render() usa el offscreen canvas (THUMB_SIZE×THUMB_SIZE, no en DOM)
                    // resize() detecta offsetWidth=0 y no lo toca → contexto GL intacto
                    this._renderer.render(frame, thumbState);
                    // Copiar resultado al canvas visible del thumbnail
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(this._renderer.canvas, 0, 0, THUMB_SIZE, THUMB_SIZE);
                    item.classList.remove('loading');
                } catch (e) { console.warn('Thumb error:', e); }
            };

            if ('requestIdleCallback' in window) {
                requestIdleCallback(renderThumb, { timeout: 2000 });
            } else {
                setTimeout(renderThumb, i * 30);
            }
        });

        this.setActive(0);
    },

    /* ── Navegar a un slice ──────────────────────────── */
    jumpTo(index) {
        index = Math.max(0, Math.min(this._series.length - 1, index));
        this._activeIndex = index;

        const vp = ViewportLayout.getActive();
        if (vp && this._series[index]) {
            vp.loadFrame(this._series[index], index, this._series.length);
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
        document.getElementById('cineFpsLabel').textContent = `${fps} fps`;
        if (this._cineInterval) { this.stopCine(); this.startCine(); }
    },

    getSeries() { return this._series; },
    getActiveIndex() { return this._activeIndex; },
};
