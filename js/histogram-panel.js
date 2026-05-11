'use strict';

/* ============================================================
   HistogramPanel — Canvas 2D con histograma de HU del slice
   actual + handles arrastrables para ajustar W/L en tiempo real
   ============================================================ */

const HistogramPanel = {
    _open:     false,
    _canvas:   null,
    _ctx:      null,
    _hist:     null,     // Uint32Array 512 bins
    _huMin:    -1024,
    _huMax:    3072,
    _dragging: null,     // 'lo' | 'hi' | null
    _viewport: null,

    init() {
        Storage.on('sliceChanged', () => { if (this._open) this._rebuildAndDraw(); });
        Storage.on('layoutChanged', () => { if (this._open) this._rebuildAndDraw(); });
    },

    /* Llamado desde RendererGL o viewport después de un render para redibujar handles */
    redraw() { if (this._open && this._hist) this._draw(); },

    open() {
        const panel = document.getElementById('histogramPanel');
        if (!panel) return;
        const btn  = document.getElementById('btnHistogram');
        const rect = btn?.getBoundingClientRect();
        if (rect) {
            panel.style.top   = (rect.bottom + 6) + 'px';
            panel.style.right = Math.max(4, window.innerWidth - rect.right) + 'px';
            panel.style.left  = 'auto';
        }
        panel.classList.remove('hidden');
        btn?.classList.add('active');
        this._open = true;
        this._canvas = document.getElementById('histCanvas');
        this._ctx    = this._canvas?.getContext('2d');
        this._bindDrag();
        this._rebuildAndDraw();
    },

    close() {
        document.getElementById('histogramPanel')?.classList.add('hidden');
        document.getElementById('btnHistogram')?.classList.remove('active');
        this._open = false;
    },

    toggle() { this._open ? this.close() : this.open(); },

    /* ── Construir histograma desde el frame activo ─── */
    _rebuildAndDraw() {
        const vp = ViewportLayout.getActive();
        this._viewport = vp;
        const f = vp?.state.frame;
        if (!f?.pixelData) { this._hist = null; this._draw(); return; }

        const slope     = f.rescaleSlope     ?? 1;
        const intercept = f.rescaleIntercept ?? -1024;
        const pd = f.pixelData;
        const n  = pd.length;

        const BINS = 512;
        this._hist   = new Uint32Array(BINS);
        this._huMin  = -1024;
        this._huMax  = 3072;
        const range  = this._huMax - this._huMin;

        for (let i = 0; i < n; i++) {
            const hu  = pd[i] * slope + intercept;
            const bin = Math.round(((hu - this._huMin) / range) * (BINS - 1));
            if (bin >= 0 && bin < BINS) this._hist[bin]++;
        }

        this._draw();
    },

    /* ── Dibujar histograma + handles W/L ────────────── */
    _draw() {
        const canvas = this._canvas;
        const ctx    = this._ctx;
        if (!canvas || !ctx) return;

        const W = canvas.width  = canvas.offsetWidth  || 280;
        const H = canvas.height = canvas.offsetHeight || 140;
        const vp  = this._viewport || ViewportLayout.getActive();
        const s   = vp?.state;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#0a1020';
        ctx.fillRect(0, 0, W, H);

        if (!this._hist) {
            ctx.fillStyle = '#555';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Sin imagen', W / 2, H / 2);
            return;
        }

        // Log-scale histogram
        const maxCount = Math.max(...this._hist);
        const logMax   = Math.log1p(maxCount);

        ctx.fillStyle = '#2a4a7a';
        for (let b = 0; b < this._hist.length; b++) {
            const x = Math.round(b / this._hist.length * W);
            const h = Math.round(Math.log1p(this._hist[b]) / logMax * (H - 20));
            ctx.fillRect(x, H - 20 - h, Math.max(1, W / this._hist.length), h);
        }

        // W/L range overlay
        if (s) {
            const wMin = s.windowCenter - s.windowWidth / 2;
            const wMax = s.windowCenter + s.windowWidth / 2;
            const xLo  = this._huToX(wMin, W);
            const xHi  = this._huToX(wMax, W);

            ctx.fillStyle = 'rgba(255,200,50,0.12)';
            ctx.fillRect(xLo, 0, xHi - xLo, H - 20);

            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(xLo, 0); ctx.lineTo(xLo, H - 20); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(xHi, 0); ctx.lineTo(xHi, H - 20); ctx.stroke();

            // Labels
            ctx.fillStyle = '#FFD700';
            ctx.font = '10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`${Math.round(wMin)}`, Math.max(2, xLo - 24), H - 5);
            ctx.textAlign = 'right';
            ctx.fillText(`${Math.round(wMax)}`, Math.min(W - 2, xHi + 24), H - 5);

            // W/L display
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.textAlign = 'center';
            ctx.fillText(`W:${Math.round(s.windowWidth)} L:${Math.round(s.windowCenter)}`, W / 2, H - 5);
        }

        // HU scale axis
        ctx.fillStyle = '#444';
        ctx.fillRect(0, H - 20, W, 1);
        const ticks = [-1000, -500, 0, 500, 1000, 2000, 3000];
        ctx.fillStyle = '#666'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        ticks.forEach(hu => {
            const x = this._huToX(hu, W);
            if (x >= 0 && x <= W) {
                ctx.fillRect(x, H - 20, 1, 4);
                ctx.fillText(hu === 0 ? '0' : `${hu}`, x, H - 8);
            }
        });
    },

    _huToX(hu, W) {
        return Math.round(((hu - this._huMin) / (this._huMax - this._huMin)) * W);
    },
    _xToHu(x, W) {
        return (x / W) * (this._huMax - this._huMin) + this._huMin;
    },

    /* ── Drag handles ────────────────────────────────── */
    _bindDrag() {
        const canvas = this._canvas;
        if (!canvas || canvas._histBound) return;
        canvas._histBound = true;

        const getPos = (e) => {
            const r = canvas.getBoundingClientRect();
            return (e.clientX - r.left) / (r.width || 1);
        };
        const HANDLE_PX = 8;

        canvas.addEventListener('mousedown', (e) => {
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            const x   = e.clientX - canvas.getBoundingClientRect().left;
            const W   = canvas.offsetWidth;
            const wMin = vp.state.windowCenter - vp.state.windowWidth / 2;
            const wMax = vp.state.windowCenter + vp.state.windowWidth / 2;
            const xLo  = this._huToX(wMin, W);
            const xHi  = this._huToX(wMax, W);

            if (Math.abs(x - xLo) < HANDLE_PX) this._dragging = 'lo';
            else if (Math.abs(x - xHi) < HANDLE_PX) this._dragging = 'hi';
            else if (x > xLo && x < xHi) this._dragging = 'center';
            if (this._dragging) this._dragStartX = x;
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!this._dragging) return;
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            const W  = canvas.offsetWidth;
            const x  = e.clientX - canvas.getBoundingClientRect().left;
            const hu = this._xToHu(x, W);
            const s  = vp.state;

            if (this._dragging === 'lo') {
                const wMax = s.windowCenter + s.windowWidth / 2;
                s.windowWidth  = Math.max(1, wMax - hu);
                s.windowCenter = hu + s.windowWidth / 2;
            } else if (this._dragging === 'hi') {
                const wMin = s.windowCenter - s.windowWidth / 2;
                s.windowWidth  = Math.max(1, hu - wMin);
                s.windowCenter = wMin + s.windowWidth / 2;
            } else {
                const dhu = this._xToHu(x - this._dragStartX + W / 2, W) - (this._huMin + this._huMax) / 2;
                s.windowCenter += dhu * 0.05;
                this._dragStartX = x;
            }
            vp.render();
            this._draw();
        });

        window.addEventListener('mouseup', () => { this._dragging = null; });
    },
};
