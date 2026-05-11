'use strict';

/* ============================================================
   ToolState — Máquina de estados central de herramientas
   Todas las interacciones mouse/touch del usuario pasan aquí.
   ============================================================ */

const ToolState = {
    _activeTool: TOOL_IDS.WINDOWING,
    _activeViewport: null,
    _drag: null,   // { tool, startX, startY, button, data }

    get activeTool() { return this._activeTool; },
    get activeViewport() { return this._activeViewport; },

    setTool(toolId) {
        if (!Object.values(TOOL_IDS).includes(toolId)) return;
        this._activeTool = toolId;
        document.body.setAttribute('data-tool', toolId);

        // Actualizar botones en toolbar
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === toolId);
        });

        Storage.dispatch('toolChanged', { toolId });
    },

    setActiveViewport(viewport) {
        if (this._activeViewport === viewport) return;
        this._activeViewport?.cell?.classList.remove('active');
        this._activeViewport = viewport;
        viewport?.cell?.classList.add('active');
    },

    /* ── Routing de eventos mouse ────────────────────── */
    onMouseDown(viewport, e) {
        this.setActiveViewport(viewport);
        const pos = this._pos(viewport.glCanvas, e);

        // Botón derecho siempre es W/L
        const tool = e.button === 2 ? TOOL_IDS.WINDOWING : this._activeTool;

        this._drag = {
            tool,
            startX: pos.x, startY: pos.y,
            lastX:  pos.x, lastY:  pos.y,
            button: e.button,
            data:   {},
        };

        this._getHandler(tool)?.onDown?.(viewport, pos, this._drag);
        viewport.render();
    },

    onMouseMove(viewport, e) {
        const pos = this._pos(viewport.glCanvas, e);
        viewport.state.mousePos = pos;

        // Actualizar status bar — HU en posición actual
        if (viewport.state.frame) {
            const imgPos = viewport.canvasToImage(pos.x, pos.y);
            const hu = this._getHU(viewport, imgPos);
            if (hu !== null) {
                document.getElementById('statusHU').textContent = `HU: ${Math.round(hu)}`;
                document.getElementById('statusPos').textContent =
                    `Pos: (${Math.round(imgPos.x)}, ${Math.round(imgPos.y)})`;
            }
        }

        if (this._drag) {
            const dx = pos.x - this._drag.lastX;
            const dy = pos.y - this._drag.lastY;
            this._drag.lastX = pos.x;
            this._drag.lastY = pos.y;
            this._getHandler(this._drag.tool)?.onDrag?.(viewport, pos, dx, dy, this._drag);
            viewport.render();
        } else {
            // Hover: probe tooltip + overlay redraw
            if (this._activeTool === TOOL_IDS.PROBE) viewport.render();
        }
    },

    onMouseUp(viewport, e) {
        if (!this._drag) return;
        const pos = this._pos(viewport.glCanvas, e);
        this._getHandler(this._drag.tool)?.onUp?.(viewport, pos, this._drag);
        this._drag = null;
        viewport.render();
        this._saveSession(viewport);
    },

    onMouseLeave(viewport) {
        viewport.state.mousePos = null;
        if (this._activeTool === TOOL_IDS.PROBE) viewport.render();
        document.getElementById('statusHU').textContent  = 'HU: —';
        document.getElementById('statusPos').textContent = 'Pos: —';
    },

    onWheel(viewport, e) {
        e.preventDefault();
        this.setActiveViewport(viewport);

        if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            const pos = this._pos(viewport.glCanvas, e);
            viewport.zoomAt(pos.x, pos.y, factor);
            viewport.render();
            Storage.dispatch('zoomChanged', { zoom: viewport.state.zoom });
        } else if (viewport.mprPlane && viewport.mprPlane !== 'axial') {
            // MPR coronal/sagital: scroll cambia la posición del corte
            // Paso de 2% del volumen por tick de scroll
            const delta = e.deltaY > 0 ? 0.02 : -0.02;
            viewport.setSliceFraction(viewport._sliceFraction + delta);
            // setSliceFraction ya llama render()
        } else {
            // Viewport axial: scroll navega slices.
            // SeriesPanel.jumpTo ya llama vp.render() — NO llamar render() extra aquí
            // porque con filtros activos el doble render deja el FBO en estado inválido.
            const delta = e.deltaY > 0 ? 1 : -1;
            Storage.dispatch('navigateSlice', { delta, viewportId: viewport.id });
        }
        this._saveSession(viewport);
    },

    onContextMenu(e) {
        e.preventDefault();
        const vp = this._activeViewport;
        if (!vp) return;
        const rect = vp.glCanvas.getBoundingClientRect();
        const imgPos = vp.canvasToImage(e.clientX - rect.left, e.clientY - rect.top);
        const hit = MeasurementStore.hitTest(vp.state.sliceIndex, imgPos.x, imgPos.y);
        if (hit) {
            MeasurementStore.selectOnly(hit.id);
            vp.render();
            UI.showContextMenu(e.clientX, e.clientY, hit);
        }
    },

    onKeyDown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        const tool = SHORTCUTS[e.key.toLowerCase()];
        if (tool) { this.setTool(tool); return; }

        const vp = this._activeViewport;
        if (!vp) return;

        switch (e.key) {
            case ' ':
                e.preventDefault();
                vp.fitToWindow(); vp.render(); break;
            case 'Delete':
            case 'Backspace': {
                const items = MeasurementStore.get(vp.state.sliceIndex);
                const sel = items.find(m => m.selected);
                if (sel) { MeasurementStore.delete(sel.id); vp.render(); }
                break;
            }
            case 'ArrowLeft':
            case 'ArrowUp':
                e.preventDefault();
                Storage.dispatch('navigateSlice', { delta: -1 }); break;
            case 'ArrowRight':
            case 'ArrowDown':
                e.preventDefault();
                Storage.dispatch('navigateSlice', { delta: 1 }); break;
            case 'PageUp':
                e.preventDefault();
                Storage.dispatch('navigateSlice', { delta: -5 }); break;
            case 'PageDown':
                e.preventDefault();
                Storage.dispatch('navigateSlice', { delta: 5 }); break;
        }
    },

    /* ── Helpers ─────────────────────────────────────── */
    _pos(canvas, e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },

    _getHU(viewport, imgPos) {
        const f = viewport.state.frame;
        if (!f) return null;
        const x = Math.round(imgPos.x), y = Math.round(imgPos.y);
        if (x < 0 || x >= f.cols || y < 0 || y >= f.rows) return null;
        const raw = f.pixelData[y * f.cols + x];
        return raw * f.rescaleSlope + f.rescaleIntercept;
    },

    _getHandler(toolId) {
        return ToolHandlers[toolId] || null;
    },

    _saveSession(vp) {
        Storage.saveSession({
            sliceIndex: vp.state.sliceIndex,
            windowWidth: vp.state.windowWidth,
            windowCenter: vp.state.windowCenter,
            zoom: vp.state.zoom,
            panX: vp.state.panX,
            panY: vp.state.panY,
        }).catch(() => {});
    },
};

/* Objeto global donde se registran los handlers de cada tool */
const ToolHandlers = {};
