'use strict';

/* ============================================================
   UI — Helpers de interfaz: toast, modal, toolbar setup
   ============================================================ */

const UI = {

    /* ── Toast ───────────────────────────────────────── */
    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        const toast     = document.createElement('div');
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.25s ease forwards';
            setTimeout(() => toast.remove(), 260);
        }, duration);
    },

    /* ── Loading progress bar ────────────────────────── */
    showLoadingBar() {
        if (document.getElementById('loadingBar')) return;
        const bar  = document.createElement('div');
        bar.id     = 'loadingBar';
        const fill = document.createElement('div');
        fill.id    = 'loadingBarFill';
        bar.appendChild(fill);
        document.getElementById('toolbar').appendChild(bar);
    },

    updateLoadingBar(loaded, total) {
        const fill = document.getElementById('loadingBarFill');
        if (fill) fill.style.width = `${Math.round(loaded / total * 100)}%`;
    },

    hideLoadingBar() {
        const bar = document.getElementById('loadingBar');
        if (bar) { setTimeout(() => bar.remove(), 400); }
    },

    /* ── Wire toolbar tool buttons ───────────────────── */
    wireToolbar() {
        // Tool buttons
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => ToolState.setTool(btn.dataset.tool));
        });

        // Windowing presets
        document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const vp = ViewportLayout.getActive();
                vp?.applyPreset(btn.dataset.preset);
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Color maps
        document.querySelectorAll('.tool-btn[data-map]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn[data-map]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                ViewportLayout.getAll().forEach(vp => {
                    vp.state.colorMapId = btn.dataset.map;
                    vp.render();
                });
                Storage.setSetting('activeColorMap', btn.dataset.map);
            });
        });

        // Layouts
        document.querySelectorAll('.layout-btn[data-layout]').forEach(btn => {
            btn.addEventListener('click', () => {
                const layout = btn.dataset.layout;
                ViewportLayout.setLayout(layout);
                // Si es MPR, cargar viewports especializados
                if (layout === 'mpr') this._setupMprLayout();
                // Recargar serie en los viewports
                const series = SeriesPanel.getSeries();
                if (series.length > 0) {
                    ViewportLayout.loadSeriesInAll(series, SeriesPanel.getActiveIndex());
                }
            });
        });

        // Controles de viewport
        document.getElementById('btnFit')?.addEventListener('click', () => {
            ViewportLayout.getActive()?.fitToWindow();
            ViewportLayout.getActive()?.render();
        });
        document.getElementById('btnActualSize')?.addEventListener('click', () => {
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            vp.state.zoom = 1; vp.state.panX = 0; vp.state.panY = 0;
            vp.render();
        });
        document.getElementById('btnFlipH')?.addEventListener('click', () => ViewportLayout.getActive()?.flipH());
        document.getElementById('btnFlipV')?.addEventListener('click', () => ViewportLayout.getActive()?.flipV());
        document.getElementById('btnRotCW')?.addEventListener('click', () => ViewportLayout.getActive()?.rotateCW());
        document.getElementById('btnRotCCW')?.addEventListener('click', () => ViewportLayout.getActive()?.rotateCCW());
        document.getElementById('btnInvert')?.addEventListener('click',    () => ViewportLayout.getActive()?.toggleInvert());
        document.getElementById('btnSuperRes')?.addEventListener('click', () => ViewportLayout.getActive()?.toggleSuperRes());

        // Zoom panel
        this._wireZoomPanel();

        // Export
        document.getElementById('btnExportPng')?.addEventListener('click', () => Export.exportPNG());
        document.getElementById('btnCopy')?.addEventListener('click', () => Export.copyToClipboard());

        // Cine
        document.getElementById('cinePlay')?.addEventListener('click', () => SeriesPanel.toggleCine());
        document.getElementById('cinePrev')?.addEventListener('click', () => SeriesPanel.navigateDelta(-1));
        document.getElementById('cineNext')?.addEventListener('click', () => SeriesPanel.navigateDelta(1));
        document.getElementById('cineFps')?.addEventListener('input', (e) => SeriesPanel.setFps(parseInt(e.target.value)));
    },

    /* ── Zoom panel ──────────────────────────────────── */
    _wireZoomPanel() {
        const panel      = document.getElementById('zoomPanel');
        const slider     = document.getElementById('zoomSlider');
        const valueLabel = document.getElementById('zoomPanelValue');
        const toggleBtn  = document.getElementById('btnZoomToggle');
        if (!panel || !slider || !toggleBtn) return;

        // Actualizar slider y label con el zoom actual del viewport
        const syncSlider = () => {
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            const pct = Math.round(vp.state.zoom * 100);
            slider.value     = Math.max(25, Math.min(800, pct));
            valueLabel.textContent = pct + '%';
        };

        // Posicionar el panel debajo del botón
        const openPanel = () => {
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.top  = (rect.bottom + 6) + 'px';
            panel.style.left = Math.max(4, rect.left - 80) + 'px';
            panel.classList.remove('hidden');
            toggleBtn.classList.add('active');
            syncSlider();
        };
        const closePanel = () => {
            panel.classList.add('hidden');
            toggleBtn.classList.remove('active');
        };

        // Toggle al hacer click en el botón
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.contains('hidden') ? openPanel() : closePanel();
        });

        // Cerrar al clickear fuera
        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== toggleBtn) closePanel();
        });

        // Slider → zoom centrado en el viewport
        slider.addEventListener('input', () => {
            const pct = parseInt(slider.value);
            valueLabel.textContent = pct + '%';
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            const newZoom = pct / 100;
            const cw = vp.glCanvas.offsetWidth  || vp.glCanvas.width;
            const ch = vp.glCanvas.offsetHeight || vp.glCanvas.height;
            vp.zoomAt(cw / 2, ch / 2, newZoom / vp.state.zoom);
            vp.render();
            document.getElementById('statusZoom').textContent = `Zoom: ${pct}%`;
        });

        // Botones rápidos de porcentaje
        document.querySelectorAll('.zoom-quick-btn[data-zoom]').forEach(btn => {
            btn.addEventListener('click', () => {
                slider.value = btn.dataset.zoom;
                slider.dispatchEvent(new Event('input'));
            });
        });

        // Botón Ajustar
        document.getElementById('zoomFitBtn')?.addEventListener('click', () => {
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            vp.fitToWindow();
            vp.render();
            syncSlider();
        });

        // Sincronizar slider cuando el zoom cambia externamente (Ctrl+scroll)
        Storage.on('zoomChanged', syncSlider);
    },

    /* ── Setup layout MPR ────────────────────────────── */
    _setupMprLayout() {
        const cells = document.querySelectorAll('.viewport-cell');
        if (cells.length < 3) return;

        const planes   = ['axial', 'coronal', 'sagital'];
        const series   = SeriesPanel.getSeries();
        const midIdx   = Math.floor(series.length / 2);
        const refFrame = series[midIdx] || series[0];

        // Capturar estado del viewport axial antes de destruirlo
        const refState = { ...ViewportLayout._viewports[0]?.state };

        ViewportLayout._viewports.forEach((vp, i) => {
            vp.destroy();
            const mprVp = new MprViewport(cells[i], i, planes[i]);
            // Compartir estado W/L/zoom del viewport axial
            mprVp.state.windowWidth  = refState.windowWidth;
            mprVp.state.windowCenter = refState.windowCenter;
            mprVp.state.colorMapId   = refState.colorMapId || 'grayscale';
            // El axial carga el frame del medio de la serie
            if (planes[i] === 'axial' && refFrame) {
                mprVp.loadFrame(refFrame, midIdx, series.length);
            }
            ViewportLayout._viewports[i] = mprVp;
        });

        ToolState.setActiveViewport(ViewportLayout._viewports[0]);

        // render() en cada viewport MPR sube lazy la textura a su propio contexto GL
        ViewportLayout.getAll().forEach(vp => vp.render());
    },

    /* ── Aplicar settings guardados ─────────────────── */
    applySettings() {
        const settings = Storage.getSettings();

        // Color map
        const mapBtn = document.querySelector(`.tool-btn[data-map="${settings.activeColorMap}"]`);
        if (mapBtn) {
            document.querySelectorAll('.tool-btn[data-map]').forEach(b => b.classList.remove('active'));
            mapBtn.classList.add('active');
        }

        // FPS slider
        const fps = settings.cineFps || 8;
        const fpsEl = document.getElementById('cineFps');
        if (fpsEl) fpsEl.value = fps;
        document.getElementById('cineFpsLabel').textContent = `${fps} fps`;
    },
};
