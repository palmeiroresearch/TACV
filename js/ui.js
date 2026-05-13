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
        // En iOS: ocultar MPR (requiere TEXTURE_3D + float extensions que fallan en Safari)
        if (typeof Capabilities !== 'undefined' && Capabilities.isIOS) {
            document.querySelector('.layout-btn[data-layout="mpr"]')?.remove();
        }

        // Tool buttons
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => ToolState.setTool(btn.dataset.tool));
        });

        // Windowing preset select
        document.getElementById('presetSelect')?.addEventListener('change', (e) => {
            ViewportLayout.getActive()?.applyPreset(e.target.value);
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
        document.getElementById('btnFlipV')?.addEventListener('click', () => {
            ViewportLayout.getActive()?.flipV();
            // Sincronizar apariencia del botón con el estado real
            const vp = ViewportLayout.getActive();
            document.getElementById('btnFlipV')?.classList.toggle('on', vp?.state?.flipV ?? false);
        });
        document.getElementById('btnRotCW')?.addEventListener('click', () => ViewportLayout.getActive()?.rotateCW());
        document.getElementById('btnRotCCW')?.addEventListener('click', () => ViewportLayout.getActive()?.rotateCCW());
        document.getElementById('btnInvert')?.addEventListener('click',    () => ViewportLayout.getActive()?.toggleInvert());
        document.getElementById('btnSuperRes')?.addEventListener('click', () => ViewportLayout.getActive()?.toggleSuperRes());
        document.getElementById('btnAnonymize')?.addEventListener('click', () => ViewportLayout.getActive()?.toggleAnonymize());
        document.getElementById('btnAbMode')?.addEventListener('click', () => ViewportLayout.getActive()?.toggleAbMode());

        // Zoom panel
        this._wireZoomPanel();

        // Filters panel
        this._wireFiltersPanel();

        // Export
        document.getElementById('btnExportPng')?.addEventListener('click', () => Export.exportPNG());
        document.getElementById('btnExportReport')?.addEventListener('click', () => Export.exportReport());
        document.getElementById('btnCopy')?.addEventListener('click', () => Export.copyToClipboard());

        // Auto W/L
        document.getElementById('btnAutoWindow')?.addEventListener('click', () => ViewportLayout.getActive()?.autoWindow());

        // Viewport sync
        document.getElementById('btnSync')?.addEventListener('click', () => ViewportLayout.toggleSync());

        // Histogram panel
        this._wireHistogramPanel();

        // Cine
        document.getElementById('cinePlay')?.addEventListener('click', () => SeriesPanel.toggleCine());
        document.getElementById('cinePrev')?.addEventListener('click', () => SeriesPanel.navigateDelta(-1));
        document.getElementById('cineNext')?.addEventListener('click', () => SeriesPanel.navigateDelta(1));
        document.getElementById('cineFps')?.addEventListener('change', (e) => SeriesPanel.setFps(parseInt(e.target.value)));

        // Case library
        document.getElementById('btnCaseLibrary')?.addEventListener('click', () => CaseLibrary.toggle());

        // Cerrar estudio
        document.getElementById('btnCloseStudy')?.addEventListener('click', () => closeAll());

        // Help modal
        this._wireHelpModal();

        // Measurements panel
        this._wireMeasurementsPanel();

        // Context menu
        this._wireContextMenu();

        // Adaptar toolbar a las capacidades del dispositivo
        this._applyMobileAdaptations();
    },

    /* ── Adaptar toolbar según dispositivo ─────────────── */
    _applyMobileAdaptations() {
        const cap = (typeof Capabilities !== 'undefined') ? Capabilities : null;
        if (!cap) return;

        const rm  = (id)  => document.getElementById(id)?.remove();
        const rmQ = (sel) => document.querySelector(sel)?.remove();

        // iOS Safari: filtros FBO rotos + GPU pesado
        if (cap.isIOS) {
            rm('btnFilters');    // FBO RGBA32F no funciona en Safari
            rm('btnSuperRes');   // shader experimental, pesado en mobile
        }

        // Cualquier táctil: controles que requieren arrastre preciso de mouse
        if (cap.isTouch) {
            rm('btnAbMode');     // divisor A/B requiere drag preciso
            rm('btnHistogram');  // líneas W/L requieren drag preciso
        }

        // Teléfonos (<600px): layouts multi-viewport y sync innecesarios
        if (cap.isMobile) {
            rmQ('.layout-btn[data-layout="2x1"]');
            rmQ('.layout-btn[data-layout="2x2"]');
            rm('btnSync');
        }
    },

    /* ── Histogram panel ────────────────────────────── */
    _wireHistogramPanel() {
        const panel = document.getElementById('histogramPanel');
        const btn   = document.getElementById('btnHistogram');
        if (!panel) return;

        btn?.addEventListener('click', (e) => { e.stopPropagation(); HistogramPanel.toggle(); });
        document.getElementById('histogramPanelClose')?.addEventListener('click', () => HistogramPanel.close());

        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== btn) HistogramPanel.close();
        }, true);
    },

    /* ── Help modal ─────────────────────────────────── */
    _wireHelpModal() {
        const modal = document.getElementById('helpModal');
        if (!modal) return;

        const open  = () => modal.classList.remove('hidden');
        const close = () => modal.classList.add('hidden');

        document.getElementById('btnHelp')?.addEventListener('click', open);
        document.getElementById('helpModalClose')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === '?' || e.key === 'F1') { e.preventDefault(); modal.classList.toggle('hidden'); }
            if (e.key === 'Escape') {
                close();
                document.getElementById('contextMenu')?.classList.add('hidden');
                MeasurementsPanel.close();
                CaseLibrary.close();
            }
            if (e.key.toLowerCase() === 'm') {
                e.preventDefault();
                MeasurementsPanel.toggle();
            }
        });
    },

    /* ── Measurements panel ─────────────────────────── */
    _wireMeasurementsPanel() {
        const panel = document.getElementById('measurementsPanel');
        const btn   = document.getElementById('btnMeasurementsPanel');
        if (!panel) return;

        btn?.addEventListener('click', (e) => { e.stopPropagation(); MeasurementsPanel.toggle(); });
        document.getElementById('measurementsPanelClose')?.addEventListener('click', () => MeasurementsPanel.close());

        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== btn) MeasurementsPanel.close();
        }, true);

        document.getElementById('btnMpCsv')?.addEventListener('click',  () => Export.exportMeasurementsCSV());
        document.getElementById('btnMpJson')?.addEventListener('click', () => Export.exportMeasurementsJSON());

        document.getElementById('btnMpClearSlice')?.addEventListener('click', () => {
            const vp = ViewportLayout.getActive();
            if (!vp) return;
            MeasurementStore.clearSlice(vp.state.sliceIndex);
            vp.render();
        });
        document.getElementById('btnMpClearAll')?.addEventListener('click', () => {
            if (confirm('¿Eliminar TODAS las mediciones del estudio?')) {
                MeasurementStore.clearAll();
                ViewportLayout.getAll().forEach(vp => vp.render());
            }
        });
    },

    /* ── Context menu ───────────────────────────────── */
    _wireContextMenu() {
        document.getElementById('ctxDelete')?.addEventListener('click', () => {
            const menu = document.getElementById('contextMenu');
            const id = parseInt(menu?.dataset.measurementId);
            if (!isNaN(id)) {
                MeasurementStore.delete(id);
                ViewportLayout.getActive()?.render();
            }
            menu?.classList.add('hidden');
        });
        document.getElementById('ctxGoSlice')?.addEventListener('click', () => {
            const menu = document.getElementById('contextMenu');
            const id = parseInt(menu?.dataset.measurementId);
            if (!isNaN(id)) {
                const m = MeasurementStore.getAll().find(x => x.id === id);
                if (m) SeriesPanel.jumpTo(m.sliceIndex);
            }
            menu?.classList.add('hidden');
        });
    },

    /* ── showContextMenu (llamado desde tool-state) ── */
    showContextMenu(x, y, measurement) {
        const menu = document.getElementById('contextMenu');
        if (!menu) return;
        menu.style.left = Math.min(x, window.innerWidth  - 190) + 'px';
        menu.style.top  = Math.min(y, window.innerHeight - 90)  + 'px';
        menu.dataset.measurementId = measurement.id;
        menu.classList.remove('hidden');

        const close = (e) => {
            if (!menu.contains(e.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('mousedown', close);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', close), 0);
    },

    /* ── Filters panel ──────────────────────────────── */
    _wireFiltersPanel() {
        const panel  = document.getElementById('filtersPanel');
        const openBtn = document.getElementById('btnFilters');
        if (!panel || !openBtn) return;

        // Abrir / cerrar
        const open = () => {
            const rect = openBtn.getBoundingClientRect();
            panel.style.top   = (rect.bottom + 6) + 'px';
            panel.style.right = Math.max(4, window.innerWidth - rect.right) + 'px';
            panel.style.left  = 'auto';
            panel.classList.remove('hidden');
            openBtn.classList.add('active');
        };
        const close = () => {
            panel.classList.add('hidden');
            openBtn.classList.remove('active');
        };

        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.contains('hidden') ? open() : close();
        });
        document.getElementById('filtersPanelClose')?.addEventListener('click', close);
        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target) && e.target !== openBtn) close();
        });

        // Helper: conectar checkbox → toggle de filtro + mostrar/ocultar params
        const wireToggle = (checkId, stateKey, paramsId) => {
            const chk = document.getElementById(checkId);
            const params = paramsId ? document.getElementById(paramsId) : null;
            if (!chk) return;
            chk.addEventListener('change', () => {
                ViewportLayout.getAll().forEach(vp => vp.setFilter(stateKey, chk.checked));
                if (params) params.classList.toggle('visible', chk.checked);
            });
        };

        // Helper: conectar slider → campo de estado
        const wireSlider = (sliderId, labelId, stateKey, decimals = 1) => {
            const sl = document.getElementById(sliderId);
            const lb = document.getElementById(labelId);
            if (!sl) return;
            sl.addEventListener('input', () => {
                const val = parseFloat(sl.value);
                if (lb) lb.textContent = val.toFixed(decimals);
                ViewportLayout.getAll().forEach(vp => vp.setFilter(stateKey, val));
            });
        };

        // Bicubic
        wireToggle('chkBicubic', 'bicubicEnabled', null);

        // Unsharp Masking
        wireToggle('chkUsm', 'usmEnabled', 'paramsUsm');
        wireSlider('slUsm',  'lblUsm',  'usmStrength',  1);
        wireSlider('slUsmR', 'lblUsmR', 'usmRadius',    1);

        // Bilateral
        wireToggle('chkBilateral', 'bilateralEnabled', 'paramsBilateral');
        wireSlider('slBilS', 'lblBilS', 'bilateralSigmaS', 1);
        wireSlider('slBilR', 'lblBilR', 'bilateralSigmaR', 2);

        // Anisotropic Diffusion
        wireToggle('chkAniso', 'anisoEnabled', 'paramsAniso');
        wireSlider('slAnisoN', 'lblAnisoN', 'anisoIterations', 0);
        wireSlider('slAnisoK', 'lblAnisoK', 'anisoK', 2);
        document.querySelectorAll('input[name="anisoFunc"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const val = parseInt(radio.value);
                ViewportLayout.getAll().forEach(vp => vp.setFilter('anisoFunc', val));
            });
        });

        // CLAHE
        wireToggle('chkClahe', 'claheEnabled', 'paramsClahe');
        wireSlider('slClaheClip', 'lblClaheClip', 'claheClipLimit', 1);
        wireSlider('slClaheStr',  'lblClaheStr',  'claheStrength',  2);

        // Retinex
        wireToggle('chkRetinex', 'retinexEnabled', 'paramsRetinex');
        wireSlider('slRetGain', 'lblRetGain', 'retinexGain',   2);
        wireSlider('slRetOff',  'lblRetOff',  'retinexOffset', 2);

        // Reset todo
        document.getElementById('btnFiltersReset')?.addEventListener('click', () => {
            // Desmarcar todos los checkboxes
            ['chkBicubic','chkUsm','chkBilateral','chkAniso','chkClahe','chkRetinex']
                .forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
            // Ocultar params
            ['paramsUsm','paramsBilateral','paramsAniso','paramsClahe','paramsRetinex']
                .forEach(id => document.getElementById(id)?.classList.remove('visible'));
            // Resetear estado en todos los viewports
            const defaults = {
                bicubicEnabled: false, usmEnabled: false, bilateralEnabled: false,
                anisoEnabled: false,   claheEnabled: false, retinexEnabled: false,
            };
            ViewportLayout.getAll().forEach(vp => {
                Object.assign(vp.state, defaults);
                vp.render();
            });
            UI.showToast('Filtros restablecidos', 'info', 2000);
        });
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

        // Windowing preset select
        const presetSel = document.getElementById('presetSelect');
        if (presetSel) presetSel.value = settings.activePreset || DEFAULT_PRESET;

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
    },
};
