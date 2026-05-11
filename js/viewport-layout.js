'use strict';

/* ============================================================
   ViewportLayout — Gestor de layouts multi-viewport
   ============================================================ */

const ViewportLayout = {
    _viewports: [],
    _activeId:  0,
    _layout:    '1x1',
    syncEnabled: false,

    toggleSync() {
        this.syncEnabled = !this.syncEnabled;
        document.getElementById('btnSync')?.classList.toggle('on', this.syncEnabled);
    },

    /* ── Inicializar con layout dado ─────────────────── */
    init(layout) {
        this.setLayout(layout || Storage.getSetting('activeLayout') || '1x1');
    },

    /* ── Cambiar layout ──────────────────────────────── */
    setLayout(layout) {
        this._layout = layout;
        Storage.setSetting('activeLayout', layout);

        // Destruir viewports existentes
        this._viewports.forEach(vp => vp.destroy());
        this._viewports = [];

        const grid = document.getElementById('viewportGrid');
        grid.setAttribute('data-layout', layout);
        grid.innerHTML = '';

        // Número de viewports según layout
        const counts = { '1x1': 1, '2x1': 2, '2x2': 4, 'mpr': 3 };
        const n = counts[layout] || 1;

        for (let i = 0; i < n; i++) {
            const cell = document.createElement('div');
            cell.className = 'viewport-cell';
            cell.id        = `viewport-cell-${i}`;
            grid.appendChild(cell);

            const vp = new Viewport(cell, i);
            this._viewports.push(vp);
        }

        // Activar el primero
        ToolState.setActiveViewport(this._viewports[0]);

        // Actualizar botones de layout
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layout === layout);
        });

        Storage.dispatch('layoutChanged', { layout, count: n });
        return this._viewports;
    },

    getActive() {
        return ToolState.activeViewport || this._viewports[0];
    },

    getAll() { return this._viewports; },

    /* ── Cargar serie en todos los viewports principales ── */
    loadSeriesInAll(series, startIndex = 0) {
        const mainVp = this._viewports[0];
        if (mainVp && series[startIndex]) {
            mainVp.loadFrame(series[startIndex], startIndex, series.length);
        }
    },
};
