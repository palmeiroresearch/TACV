'use strict';

/* ============================================================
   Herramientas de investigación: línea media, ROI de lesión con
   espejo automático, septum pellucidum y ejes A/B para ABC/2.

   Las ROI de NWU se guardan SIEMPRE como polígono, también cuando
   se trazan como elipse. Motivo: reflejar una elipse alineada con
   los ejes sobre una línea media inclinada produce una elipse
   ROTADA, y el renderer de elipse del proyecto no tiene campo de
   rotación. Muestrear la elipse a polígono hace la reflexión
   exacta, garantiza misma forma y área, y permite que lesión y
   espejo compartan un único rasterizador.
   ============================================================ */

const NwuTools = {
    _nextPairId: 1,
    /** Forma con la que se traza la ROI de lesión: 'freehand' | 'ellipse' */
    lesionShape: 'freehand',

    setLesionShape(shape) {
        this.lesionShape = (shape === 'ellipse') ? 'ellipse' : 'freehand';
        document.querySelectorAll('[data-nwu-shape]').forEach(b => {
            b.classList.toggle('active', b.dataset.nwuShape === this.lesionShape);
        });
    },

    nextPairId() {
        // Partir por encima de lo ya existente para que una sesión restaurada
        // desde IndexedDB no reutilice un pairId.
        const used = MeasurementStore.getAll()
            .filter(m => m.type === 'nwu_roi')
            .map(m => parseInt(String(m.pairId).replace(/\D/g, ''), 10) || 0);
        const max = used.length ? Math.max(...used) : 0;
        this._nextPairId = Math.max(this._nextPairId, max + 1);
        return 'pair' + (this._nextPairId++);
    },

    /* ── Crear el par lesión + espejo ─────────────────────── */
    createPair(viewport, points, shape) {
        const f     = viewport.state.frame;
        const slice = viewport.state.sliceIndex;
        const mid   = MeasurementStore.getMidline(slice);

        if (!mid) {
            UI.showToast('Definí primero la línea media en este corte (herramienta L)', 'warning', 4500);
            return null;
        }
        if (!f) return null;

        const threshold = ResearchMode.getThreshold();
        const pairId    = this.nextPairId();

        const mirrorPoints = ResearchCore.reflectPolygon(
            points, mid.anterior, mid.posterior, f.pixelSpacing
        );

        const base = {
            type: 'nwu_roi', pairId, shape,
            threshold: { ...threshold },
            midlineId: mid.id,
        };

        const lesion = MeasurementStore.add(slice, ResearchMode.annotate({
            ...base,
            role: 'lesion',
            points,
            stats: MeasurementStore.computeNwuRoiStats(f, points, threshold),
        }));

        const mirror = MeasurementStore.add(slice, ResearchMode.annotate({
            ...base,
            role: 'mirror',
            points: mirrorPoints,
            mirrorOf: lesion.id,
            originalPoints: mirrorPoints.map(p => ({ ...p })),  // para medir el ajuste
            adjusted: false,
            offsetMm: 0,
            offsetPx: { dx: 0, dy: 0 },
            stats: MeasurementStore.computeNwuRoiStats(f, mirrorPoints, threshold),
        }));

        const sL = lesion.stats, sM = mirror.stats;
        const nwu = ResearchCore.nwu(sL?.mean, sM?.mean);
        UI.showToast(
            nwu != null
                ? `NWU corte ${slice + 1}: ${nwu.toFixed(2)} % · lesión ${sL.mean.toFixed(1)} UH · ` +
                  `contralateral ${sM.mean.toFixed(1)} UH`
                : 'ROI creadas, pero sin píxeles medibles con el umbral actual',
            nwu != null ? 'success' : 'warning', 5000
        );

        if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
        return { lesion, mirror };
    },

    /** Mueve la ROI espejo y registra el ajuste. */
    moveMirror(viewport, mirror, dxImg, dyImg) {
        const f = viewport.state.frame;
        if (!f || !mirror) return;

        const moved = ResearchCore.translatePolygon(mirror.points, dxImg, dyImg);
        const orig  = mirror.originalPoints || mirror.points;

        // Desplazamiento acumulado respecto de la posición reflejada original
        const dx = moved[0].x - orig[0].x;
        const dy = moved[0].y - orig[0].y;
        const offsetMm = ResearchCore.distanceMm({ x: 0, y: 0 }, { x: dx, y: dy }, f.pixelSpacing);

        MeasurementStore.update(mirror.id, {
            points:   moved,
            adjusted: offsetMm > 1e-9,
            offsetMm,
            offsetPx: { dx, dy },
            stats:    MeasurementStore.computeNwuRoiStats(f, moved, mirror.threshold || ResearchMode.getThreshold()),
        });
    },
};

/* ════════════════════════════════════════════════════════════
   Línea media (L)
   ════════════════════════════════════════════════════════════ */
ToolHandlers[TOOL_IDS.NWU_MIDLINE] = {
    _pending: null,      // primer punto ya marcado
    _dragging: null,     // { measurement, end: 'anterior'|'posterior' }

    onDown(viewport, pos, drag) {
        const p     = viewport.canvasToImage(pos.x, pos.y);
        const slice = viewport.state.sliceIndex;
        const mid   = MeasurementStore.getMidline(slice);

        // Si hay línea media y el clic cae sobre un extremo: arrastrarlo
        if (mid) {
            const near = (q) => q && Math.hypot(q.x - p.x, q.y - p.y) <= 10;
            if (near(mid.anterior))  { this._dragging = { id: mid.id, end: 'anterior'  }; return; }
            if (near(mid.posterior)) { this._dragging = { id: mid.id, end: 'posterior' }; return; }
        }

        // Dos clics definen una línea media nueva
        if (!this._pending) {
            this._pending = p;
            viewport.state.liveMeasurement = { type: 'midline_partial', anterior: p, posterior: p };
        } else {
            MeasurementStore.setMidline(slice, this._pending, p, 'manual');
            this._pending = null;
            viewport.state.liveMeasurement = null;
            if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
        }
    },

    onDrag(viewport, pos) {
        const p = viewport.canvasToImage(pos.x, pos.y);

        if (this._dragging) {
            const mid = MeasurementStore.getAll().find(m => m.id === this._dragging.id);
            if (!mid) { this._dragging = null; return; }
            MeasurementStore.update(mid.id, {
                [this._dragging.end]: p,
                // Una estimación automática corregida a mano deja de ser automática
                source: mid.source === 'auto' ? 'auto-adjusted' : mid.source,
            });
            return;
        }
        if (this._pending) {
            viewport.state.liveMeasurement = {
                type: 'midline_partial', anterior: this._pending, posterior: p,
            };
        }
    },

    onUp(viewport) {
        if (this._dragging) {
            this._dragging = null;
            // Las ROI espejo se reflejaron sobre la línea anterior: avisar.
            const slice = viewport.state.sliceIndex;
            if (MeasurementStore.getNwuRoisForSlice(slice).length) {
                UI.showToast('Línea media movida: recalculá las ROI espejo desde el panel ' +
                             'de investigación si querés rehacerlas', 'warning', 5000);
            }
            if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
        }
    },

    /** Propone la línea media del corte actual por estimación automática. */
    estimate(viewport) {
        const f = viewport?.state.frame;
        if (!f) { UI.showToast('No hay imagen cargada', 'warning'); return null; }

        const est = ResearchCore.estimateMidline(f);
        if (!est) {
            UI.showToast('No se pudo estimar la línea media en este corte — definila a mano ' +
                         '(2 clics con la herramienta L)', 'warning', 5000);
            return null;
        }

        MeasurementStore.setMidline(
            viewport.state.sliceIndex, est.anterior, est.posterior, 'auto');

        const pct = Math.round(est.confidence * 100);
        UI.showToast(
            pct >= 60
                ? `Línea media estimada (confianza ${pct} %) — arrastrá los extremos para corregirla`
                : `Línea media estimada con BAJA confianza (${pct} %) — revisala y corregila a mano`,
            pct >= 60 ? 'info' : 'warning', 5500
        );

        viewport.render();
        if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
        return est;
    },
};

/* ════════════════════════════════════════════════════════════
   ROI de lesión → genera la espejo (N)
   Soporta trazo libre y elipse; el resultado es siempre polígono.
   ════════════════════════════════════════════════════════════ */
ToolHandlers[TOOL_IDS.NWU_LESION] = {
    _movingMirror: null,

    onDown(viewport, pos, drag) {
        const p = viewport.canvasToImage(pos.x, pos.y);

        // Clic dentro de una ROI espejo existente → moverla
        const hit = MeasurementStore.get(viewport.state.sliceIndex).find(m =>
            m.type === 'nwu_roi' && m.role === 'mirror' &&
            m.points && ResearchCore.pointInPolygon(p.x, p.y, m.points)
        );
        if (hit) {
            this._movingMirror = hit.id;
            drag.data.last = p;
            MeasurementStore.selectOnly(hit.id);
            return;
        }

        if (NwuTools.lesionShape === 'ellipse') {
            drag.data.center = p;
        } else {
            drag.data.points = [p];
            drag.data.lastAdded = { ...pos };
        }
    },

    onDrag(viewport, pos, dx, dy, drag) {
        const p = viewport.canvasToImage(pos.x, pos.y);

        if (this._movingMirror != null) {
            const mirror = MeasurementStore.getAll().find(m => m.id === this._movingMirror);
            if (mirror && drag.data.last) {
                NwuTools.moveMirror(viewport, mirror, p.x - drag.data.last.x, p.y - drag.data.last.y);
                drag.data.last = p;
            }
            return;
        }

        if (NwuTools.lesionShape === 'ellipse') {
            const c = drag.data.center;
            if (!c) return;
            const rx = Math.abs(p.x - c.x), ry = Math.abs(p.y - c.y);
            viewport.state.liveMeasurement = {
                type: 'nwu_live',
                points: ResearchCore.polygonFromEllipse(c.x, c.y, rx, ry, 180),
            };
        } else {
            if (!drag.data.points) return;
            if (Math.hypot(pos.x - drag.data.lastAdded.x, pos.y - drag.data.lastAdded.y) > 4) {
                drag.data.points.push(p);
                drag.data.lastAdded = { ...pos };
            }
            viewport.state.liveMeasurement = {
                type: 'nwu_live', points: [...drag.data.points],
            };
        }
    },

    onUp(viewport, pos, drag) {
        if (this._movingMirror != null) {
            const mirror = MeasurementStore.getAll().find(m => m.id === this._movingMirror);
            this._movingMirror = null;
            if (mirror?.adjusted) {
                UI.showToast(
                    `ROI espejo ajustada ${mirror.offsetMm.toFixed(1)} mm — queda registrado ` +
                    `en la exportación`, 'info', 3500);
            }
            if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
            return;
        }

        const live = viewport.state.liveMeasurement;
        viewport.state.liveMeasurement = null;

        let points = null;
        if (NwuTools.lesionShape === 'ellipse') {
            const c = drag.data.center;
            const p = viewport.canvasToImage(pos.x, pos.y);
            if (!c) return;
            const rx = Math.abs(p.x - c.x), ry = Math.abs(p.y - c.y);
            if (rx < 3 || ry < 3) return;
            points = ResearchCore.polygonFromEllipse(c.x, c.y, rx, ry, 180);
        } else {
            const pts = drag.data.points;
            if (!pts || pts.length < 5) return;
            points = [...pts];
        }
        if (!points || !live) return;

        NwuTools.createPair(viewport, points, NwuTools.lesionShape);
    },
};

/* ════════════════════════════════════════════════════════════
   Septum pellucidum → desviación de la línea media (J)
   ════════════════════════════════════════════════════════════ */
ToolHandlers[TOOL_IDS.NWU_SEPTUM] = {
    onDown(viewport, pos) {
        const p     = viewport.canvasToImage(pos.x, pos.y);
        const slice = viewport.state.sliceIndex;
        const f     = viewport.state.frame;
        const mid   = MeasurementStore.getMidline(slice);

        if (!mid) {
            UI.showToast('Definí primero la línea media en este corte (herramienta L)', 'warning', 4500);
            return;
        }

        const shiftMm = ResearchCore.perpendicularDistanceMm(
            p, mid.anterior, mid.posterior, f?.pixelSpacing);

        MeasurementStore.setSeptum(slice, p, shiftMm);
        UI.showToast(
            `Desviación de la línea media: ${Math.abs(shiftMm).toFixed(1)} mm`, 'success', 3500);
        viewport.render();
        if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
    },
    onDrag() {},
    onUp() {},
};

/* ════════════════════════════════════════════════════════════
   Ejes A y B para ABC/2 (B)
   Dos arrastres consecutivos: el primero es A, el segundo B.
   ════════════════════════════════════════════════════════════ */
ToolHandlers[TOOL_IDS.NWU_AB] = {
    _axis: 'A',

    onDown(viewport, pos, drag) {
        drag.data.p1 = viewport.canvasToImage(pos.x, pos.y);
    },

    onDrag(viewport, pos, dx, dy, drag) {
        const p2 = viewport.canvasToImage(pos.x, pos.y);
        const f  = viewport.state.frame;
        viewport.state.liveMeasurement = {
            type: 'distance',
            p1: drag.data.p1, p2,
            distanceMm: MeasurementStore.computeDistance(drag.data.p1, p2, f?.pixelSpacing),
        };
    },

    onUp(viewport, pos, drag) {
        const p2   = viewport.canvasToImage(pos.x, pos.y);
        const f    = viewport.state.frame;
        const dist = MeasurementStore.computeDistance(drag.data.p1, p2, f?.pixelSpacing);
        viewport.state.liveMeasurement = null;
        if (dist < 2) return;

        MeasurementStore.add(viewport.state.sliceIndex, ResearchMode.annotate({
            type: 'abc_axis',
            axis: this._axis,
            p1: drag.data.p1, p2,
            distanceMm: dist,
        }));

        UI.showToast(
            this._axis === 'A'
                ? `Eje A = ${dist.toFixed(1)} mm — medí ahora B, perpendicular a A`
                : `Eje B = ${dist.toFixed(1)} mm — C se deriva de los cortes con lesión`,
            'info', 3500
        );
        this._axis = this._axis === 'A' ? 'B' : 'A';
        if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();
    },
};
