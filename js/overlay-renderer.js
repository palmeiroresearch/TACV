'use strict';

/* ============================================================
   OverlayRenderer — Canvas 2D superpuesto al WebGL
   Dibuja: overlays DICOM (4 esquinas), markers A/P/R/L,
   barra de escala, mediciones, crosshair, probe tooltip.
   ============================================================ */

const OverlayRenderer = {

    /* ── Render completo ──────────────────────────────── */
    render(viewport) {
        const ctx = viewport.overlayCtx;
        this._sync(viewport);
        ctx.clearRect(0, 0, viewport.overlayCanvas.width, viewport.overlayCanvas.height);

        // Viewports MPR sin frame (coronal/sagital) solo necesitan las guías cruzadas
        if (!viewport.state.frame) {
            if (viewport.mprPlane !== undefined) this.drawMprCrosshair(viewport);
            return;
        }

        // El overlay del detector va DEBAJO de todo lo demás: es un fondo
        // sobre la imagen, no una anotación.
        this.drawDetectorOverlay(viewport);

        this.drawDicomInfo(viewport);
        this.drawOrientationMarkers(viewport);
        this.drawScaleBar(viewport);
        this.drawMeasurements(viewport);
        // Crosshair triplanar (solo en layout MPR)
        if (viewport.mprPlane !== undefined) {
            this.drawMprCrosshair(viewport);
        }
        if (viewport.state.activeTool === TOOL_IDS.PROBE) {
            this.drawCrosshair(viewport);
        }
        this.drawLiveMeasurement(viewport);
        if (viewport.state.abMode) this.drawAbSplit(viewport);
        this.drawNoteIndicator(viewport);
        this.drawResearchBadge(viewport);
    },

    /* ── Formateo de UH y áreas ───────────────────────────
       Las estadísticas se guardan con precisión completa (la NWU lo
       exige); el redondeo ocurre aquí, al mostrarlas. */
    _fmtHU(v, dec = 1)   { return (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(dec); },
    _fmtArea(v, dec = 1) { return (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(dec); },

    /* ── Sincronizar tamaño overlay = canvas WebGL ──── */
    _sync(viewport) {
        const oc = viewport.overlayCanvas;
        const gc = viewport.glCanvas;
        if (oc.width !== gc.offsetWidth || oc.height !== gc.offsetHeight) {
            oc.width  = gc.offsetWidth  || gc.width;
            oc.height = gc.offsetHeight || gc.height;
        }
    },

    /* ── Info DICOM en 4 esquinas ──────────────────── */
    drawDicomInfo(viewport) {
        const ctx  = viewport.overlayCtx;
        const cw   = viewport.overlayCanvas.width;
        const ch   = viewport.overlayCanvas.height;
        const s    = viewport.state;
        const f    = s.frame;
        const pad  = 10;

        ctx.font = '12px Inter, sans-serif';
        ctx.textBaseline = 'top';
        ctx.shadowColor  = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur   = 3;
        ctx.fillStyle    = 'rgba(255,255,255,0.88)';

        // Top-left: paciente (redactado si anonimización activa)
        const anon = s.anonymized;
        const name = anon ? '██████████' : (f.patientName || 'Anónimo');
        const pid  = anon ? '' : (f.patientID  ? `ID: ${f.patientID}` : '');
        const dob  = anon ? '' : (f.patientDOB ? `DOB: ${f.patientDOB}` : '');
        this._textBlock(ctx, pad, pad, [name, pid, dob].filter(Boolean));

        // Top-right: estudio
        const mod  = f.modality || 'CT';
        const date = f.studyDate ? this._formatDate(f.studyDate) : '';
        const desc = f.studyDesc || f.seriesDesc || '';
        this._textBlockRight(ctx, cw - pad, pad, [mod, date, desc].filter(Boolean));

        // Bottom-left: slice
        const sliceStr   = `Slice: ${s.sliceIndex + 1} / ${s.totalSlices || 1}`;
        const thickStr   = f.sliceThickness ? `Espesor: ${f.sliceThickness} mm` : '';
        const posStr     = f.sliceLocation  != null ? `Pos Z: ${f.sliceLocation.toFixed(1)} mm` : '';
        ctx.textBaseline = 'bottom';
        this._textBlock(ctx, pad, ch - pad, [sliceStr, thickStr, posStr].filter(Boolean));

        // Bottom-right: W/L y zoom
        const wl   = `W: ${Math.round(s.windowWidth)} L: ${Math.round(s.windowCenter)}`;
        const zoom = `Zoom: ${Math.round((s.zoom || 1) * 100)}%`;
        this._textBlockRight(ctx, cw - pad, ch - pad, [wl, zoom]);

        ctx.shadowBlur = 0;
    },

    _textBlock(ctx, x, y, lines) {
        const lh = 16;
        const dir = ctx.textBaseline === 'bottom' ? -1 : 1;
        lines.forEach((line, i) => {
            ctx.fillText(line, x, y + dir * i * lh);
        });
    },

    _textBlockRight(ctx, x, y, lines) {
        const lh = 16;
        const dir = ctx.textBaseline === 'bottom' ? -1 : 1;
        ctx.textAlign = 'right';
        lines.forEach((line, i) => {
            ctx.fillText(line, x, y + dir * i * lh);
        });
        ctx.textAlign = 'left';
    },

    _formatDate(d) {
        if (!d || d.length < 8) return d;
        return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    },

    /* ── Markers de orientación A/P/R/L ─────────────── */
    drawOrientationMarkers(viewport) {
        const ctx  = viewport.overlayCtx;
        const cw   = viewport.overlayCanvas.width;
        const ch   = viewport.overlayCanvas.height;
        const s    = viewport.state;
        const pad  = 28;

        // Aplicar flip/rotate a los labels base para que coincidan con la imagen
        let base = s.orientationLabels || ORIENTATION_AXIAL;
        let { top, bottom, left, right } = base;

        if (s.flipH)  { [left, right] = [right, left]; }
        if (s.flipV)  { [top, bottom] = [bottom, top]; }

        const rot = s.rotation ?? 0;
        if (rot === 90)  { [top, right, bottom, left] = [left, top, right, bottom]; }
        if (rot === 180) { [top, bottom] = [bottom, top]; [left, right] = [right, left]; }
        if (rot === 270) { [top, right, bottom, left] = [right, bottom, left, top]; }

        ctx.font      = '14px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,220,0,0.9)';
        ctx.shadowColor = 'rgba(0,0,0,0.95)';
        ctx.shadowBlur  = 3;

        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(top, cw / 2, pad);

        ctx.textBaseline = 'bottom';
        ctx.fillText(bottom, cw / 2, ch - pad);

        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(left, pad, ch / 2);

        ctx.textAlign    = 'right';
        ctx.fillText(right, cw - pad, ch / 2);

        ctx.shadowBlur = 0;
        ctx.textAlign  = 'left';
        ctx.textBaseline = 'alphabetic';
    },

    /* ── Barra de escala ─────────────────────────────── */
    drawScaleBar(viewport) {
        const ctx  = viewport.overlayCtx;
        const cw   = viewport.overlayCanvas.width;
        const ch   = viewport.overlayCanvas.height;
        const s    = viewport.state;
        const f    = s.frame;

        const colSpacing = (f.pixelSpacing && f.pixelSpacing[1]) || 1; // mm/px en imagen
        const pxPerMm    = (s.zoom || 1) * (Math.min(
            viewport.glCanvas.offsetWidth  / f.cols,
            viewport.glCanvas.offsetHeight / f.rows
        )) / colSpacing;

        // Elegir longitud de barra: ~80px → mm redondos
        const candidates = [1, 2, 5, 10, 20, 50, 100, 200];
        let barMm = candidates.find(c => c * pxPerMm >= 60) || 100;
        const barPx = barMm * pxPerMm;

        const x = cw / 2 - barPx / 2;
        const y = ch - 40;

        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur  = 3;

        ctx.beginPath();
        ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
        ctx.moveTo(x, y);     ctx.lineTo(x + barPx, y);
        ctx.moveTo(x + barPx, y - 4); ctx.lineTo(x + barPx, y + 4);
        ctx.stroke();

        ctx.font      = '11px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(`${barMm} mm`, x + barPx / 2, y + 6);

        ctx.shadowBlur = 0;
        ctx.textAlign  = 'left';
    },

    /* ── Mediciones guardadas ────────────────────────── */
    drawMeasurements(viewport) {
        // Las mediciones se guardan en coordenadas del plano axial —
        // no se proyectan al coronal/sagital (no hay transformación 3D).
        if (viewport.mprPlane && viewport.mprPlane !== 'axial') return;
        const items = MeasurementStore.get(viewport.state.sliceIndex);
        items.forEach(m => this._drawMeasurement(viewport, m));
    },

    _drawMeasurement(viewport, m) {
        const color = m.selected ? MEASURE_ACTIVE_COLOR : MEASURE_COLOR;
        switch (m.type) {
            case 'distance':   this._drawDistance(viewport, m, color);  break;
            case 'angle':      this._drawAngle(viewport, m, color);     break;
            case 'ellipse':    this._drawEllipse(viewport, m, color);   break;
            case 'rectangle':  this._drawRect(viewport, m, color);      break;
            case 'arrow':      this._drawArrow(viewport, m, color);     break;
            case 'text':       this._drawText(viewport, m, color);      break;
            case 'cobb':       this._drawCobb(viewport, m, color);      break;
            case 'freehand':   this._drawFreehand(viewport, m, color);  break;
            /* ── Investigación ── */
            case 'midline':    this._drawMidline(viewport, m);          break;
            case 'nwu_roi':    this._drawNwuRoi(viewport, m);           break;
            case 'septum':     this._drawSeptum(viewport, m);           break;
            case 'abc_axis':   this._drawAbcAxis(viewport, m);          break;
            case 'aspects_probe': this._drawAspectsProbe(viewport, m);  break;
        }
    },

    _drawDistance(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const p1  = viewport.imageToCanvas(m.p1.x, m.p1.y);
        const p2  = viewport.imageToCanvas(m.p2.x, m.p2.y);

        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        this._drawEndpointDot(ctx, p1, color);
        this._drawEndpointDot(ctx, p2, color);

        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${m.distanceMm?.toFixed(1)} mm`, mid.x, mid.y - 4);
        ctx.shadowBlur = 0; ctx.textAlign = 'left';
    },

    _drawAngle(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const p1  = viewport.imageToCanvas(m.p1.x, m.p1.y);
        const v   = viewport.imageToCanvas(m.vertex.x, m.vertex.y);
        const p2  = viewport.imageToCanvas(m.p2.x, m.p2.y);

        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(v.x, v.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();

        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${m.angleDeg?.toFixed(1)}°`, v.x, v.y - 8);
        ctx.shadowBlur = 0; ctx.textAlign = 'left';
    },

    _drawEllipse(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const c   = viewport.imageToCanvas(m.cx, m.cy);
        const zoom = viewport.state.zoom || 1;
        const baseZoom = Math.min(
            viewport.glCanvas.offsetWidth  / (m.imageW || 512),
            viewport.glCanvas.offsetHeight / (m.imageH || 512)
        );
        const rxc = m.rx * baseZoom * zoom;
        const ryc = m.ry * baseZoom * zoom;

        ctx.strokeStyle = ROI_STROKE_COLOR; ctx.lineWidth = 1.5;
        ctx.fillStyle   = ROI_FILL_COLOR;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
        ctx.beginPath(); ctx.ellipse(c.x, c.y, rxc, ryc, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();

        if (m.stats) {
            const txt = `Mean: ${this._fmtHU(m.stats.mean)} HU\n` +
                        `Std: ${this._fmtHU(m.stats.std)}\n` +
                        `Area: ${this._fmtArea(m.stats.area)} mm²`;
            ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#60c8ff';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            txt.split('\n').forEach((line, i) => ctx.fillText(line, c.x + rxc + 6, c.y - ryc + i * 14));
        }
        ctx.shadowBlur = 0;
    },

    _drawRect(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const a   = viewport.imageToCanvas(m.x1, m.y1);
        const b   = viewport.imageToCanvas(m.x2, m.y2);

        ctx.strokeStyle = ROI_STROKE_COLOR; ctx.lineWidth = 1.5;
        ctx.fillStyle   = ROI_FILL_COLOR;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
        const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y);
        const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);

        if (m.stats) {
            ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#60c8ff';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            [`Mean: ${this._fmtHU(m.stats.mean)} HU`,
             `Std: ${this._fmtHU(m.stats.std)}`,
             `Area: ${this._fmtArea(m.stats.area)} mm²`]
                .forEach((line, i) => ctx.fillText(line, Math.max(a.x, b.x) + 6, Math.min(a.y, b.y) + i * 14));
        }
        ctx.shadowBlur = 0;
    },

    _drawArrow(viewport, m, color) {
        const ctx  = viewport.overlayCtx;
        const tail = viewport.imageToCanvas(m.tail.x, m.tail.y);
        const head = viewport.imageToCanvas(m.head.x, m.head.y);

        const angle = Math.atan2(head.y - tail.y, head.x - tail.x);
        const hs    = 12; // arrowhead size

        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.lineWidth   = 1.5;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;

        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(head.x, head.y); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(head.x, head.y);
        ctx.lineTo(head.x - hs * Math.cos(angle - 0.4), head.y - hs * Math.sin(angle - 0.4));
        ctx.lineTo(head.x - hs * Math.cos(angle + 0.4), head.y - hs * Math.sin(angle + 0.4));
        ctx.closePath(); ctx.fill();

        if (m.label) {
            ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = color;
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.fillText(m.label, tail.x + 6, tail.y - 4);
        }
        ctx.shadowBlur = 0;
    },

    _drawText(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const pos = viewport.imageToCanvas(m.pos.x, m.pos.y);

        ctx.font = '13px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(m.text || '', pos.x, pos.y);
        ctx.shadowBlur = 0;
    },

    _drawCobb(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        const toC = (p) => viewport.imageToCanvas(p.x, p.y);
        const COLORS = ['#00E5FF', '#FF6EC7'];  // cyan line1, pink line2

        [m.line1, m.line2].forEach((line, li) => {
            if (!line?.p1 || !line?.p2) return;
            const p1 = toC(line.p1), p2 = toC(line.p2);
            ctx.strokeStyle = COLORS[li]; ctx.lineWidth = 2;
            ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();

            // Tick marks perpendicular at endpoints
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len * 7, ny = dx / len * 7;
            ctx.lineWidth = 1.5;
            [[p1], [p2]].forEach(([pt]) => {
                ctx.beginPath();
                ctx.moveTo(pt.x - nx, pt.y - ny);
                ctx.lineTo(pt.x + nx, pt.y + ny);
                ctx.stroke();
            });
        });

        // Angle label between the two lines
        if (m.line1?.p2 && m.line2?.p1) {
            const mid1 = toC({ x: (m.line1.p1.x + m.line1.p2.x) / 2, y: (m.line1.p1.y + m.line1.p2.y) / 2 });
            const mid2 = toC({ x: (m.line2.p1.x + m.line2.p2.x) / 2, y: (m.line2.p1.y + m.line2.p2.y) / 2 });
            const mx = (mid1.x + mid2.x) / 2, my = (mid1.y + mid2.y) / 2;
            ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = '#fff';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(`Cobb: ${m.angleDeg}°`, mx, my);
        }
        ctx.shadowBlur = 0; ctx.textAlign = 'left';
    },

    _drawFreehand(viewport, m, color) {
        const ctx = viewport.overlayCtx;
        if (!m.points?.length) return;

        ctx.strokeStyle = ROI_STROKE_COLOR; ctx.lineWidth = 1.5;
        ctx.fillStyle   = ROI_FILL_COLOR;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 2;

        ctx.beginPath();
        m.points.forEach((p, i) => {
            const c = viewport.imageToCanvas(p.x, p.y);
            i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();

        if (m.stats) {
            const first = viewport.imageToCanvas(m.points[0].x, m.points[0].y);
            ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = '#60c8ff';
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.shadowBlur = 2;
            [`Mean: ${this._fmtHU(m.stats.mean)} HU`,
             `Std: ${this._fmtHU(m.stats.std)}`,
             `Area: ${this._fmtArea(m.stats.area)} mm²`]
                .forEach((line, i) => ctx.fillText(line, first.x + 6, first.y + i * 14));
        }
        ctx.shadowBlur = 0;
    },

    _drawEndpointDot(ctx, p, color) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    },

    /* ════════════════════════════════════════════════════════
       Elementos de investigación
       ════════════════════════════════════════════════════════ */

    _RESEARCH_COLORS: {
        midline:      '#00FF9D',
        lesion:       '#FF5252',
        mirror:       '#4FC3F7',
        mirrorMoved:  '#FFB300',
        septum:       '#E040FB',
        abcAxis:      '#FFD700',
    },

    /** Línea media: inserción anterior ↔ posterior de la hoz. */
    _drawMidline(viewport, m) {
        const ctx = viewport.overlayCtx;
        const a = viewport.imageToCanvas(m.anterior.x,  m.anterior.y);
        const p = viewport.imageToCanvas(m.posterior.x, m.posterior.y);
        const C = this._RESEARCH_COLORS.midline;

        ctx.save();
        ctx.strokeStyle = C;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([7, 4]);
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);

        // Asas cuadradas en los extremos: señalan que son arrastrables
        ctx.fillStyle = C;
        [a, p].forEach(q => { ctx.fillRect(q.x - 4, q.y - 4, 8, 8); });

        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = C;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('A', a.x, a.y - 7);
        ctx.textBaseline = 'top';
        ctx.fillText('P', p.x, p.y + 7);

        // Marcar cuándo la línea viene de la estimación automática sin revisar
        if (m.source === 'auto') {
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#FFB300';
            ctx.fillText('auto — revisar', (a.x + p.x) / 2 + 8, (a.y + p.y) / 2);
        }
        ctx.restore();
    },

    /** ROI de NWU: lesión o espejo, con sus estadísticas. */
    _drawNwuRoi(viewport, m) {
        const ctx = viewport.overlayCtx;
        if (!m.points?.length) return;

        const isLesion = m.role === 'lesion';
        const color = isLesion
            ? this._RESEARCH_COLORS.lesion
            : (m.adjusted ? this._RESEARCH_COLORS.mirrorMoved : this._RESEARCH_COLORS.mirror);

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = m.selected ? 2.5 : 1.8;
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;

        ctx.beginPath();
        m.points.forEach((p, i) => {
            const c = viewport.imageToCanvas(p.x, p.y);
            i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath();
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();

        // Etiqueta junto al punto más alto de la ROI
        let top = m.points[0];
        for (const p of m.points) if (p.y < top.y) top = p;
        const anchor = viewport.imageToCanvas(top.x, top.y);

        const s = m.stats;
        const lines = [isLesion ? 'LESIÓN' : (m.adjusted ? 'ESPEJO (ajustado)' : 'ESPEJO')];
        if (s) {
            lines.push(`${this._fmtHU(s.mean)} ± ${this._fmtHU(s.std)} HU`);
            lines.push(`n=${s.count} · ${this._fmtArea(s.areaMm2)} mm²`);
            if (s.excludedTotal > 0) lines.push(`excl. ${s.excludedTotal}`);
        } else {
            lines.push('sin estadísticas');
        }
        if (!isLesion && m.adjusted) lines.push(`Δ ${m.offsetMm.toFixed(1)} mm`);

        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = color;
        lines.forEach((line, i) => {
            ctx.fillText(line, anchor.x + 8, anchor.y - 4 - (lines.length - 1 - i) * 12);
        });
        ctx.restore();
    },

    /** Septum pellucidum y su distancia perpendicular a la línea media. */
    _drawSeptum(viewport, m) {
        const ctx = viewport.overlayCtx;
        const p   = viewport.imageToCanvas(m.pos.x, m.pos.y);
        const C   = this._RESEARCH_COLORS.septum;
        const mid = MeasurementStore.getMidline(viewport.state.sliceIndex);

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;

        // Segmento perpendicular hasta la línea media, que es lo que se mide
        if (mid) {
            const f = viewport.state.frame;
            const [rs, cs] = f?.pixelSpacing || [1, 1];
            // Pie de la perpendicular, en espacio métrico
            const ax = mid.anterior.x * cs,  ay = mid.anterior.y * rs;
            const bx = mid.posterior.x * cs, by = mid.posterior.y * rs;
            const px = m.pos.x * cs,         py = m.pos.y * rs;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            if (len2 > 0) {
                const t = ((px - ax) * dx + (py - ay) * dy) / len2;
                const foot = viewport.imageToCanvas((ax + t * dx) / cs, (ay + t * dy) / rs);
                ctx.strokeStyle = C;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        ctx.fillStyle = C;
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();

        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const txt = (m.shiftMm == null)
            ? 'Septum'
            : `Desv. ${Math.abs(m.shiftMm).toFixed(1)} mm`;
        ctx.fillText(txt, p.x + 7, p.y - 5);
        ctx.restore();
    },

    /** Ejes A y B del ayudante ABC/2. */
    _drawAbcAxis(viewport, m) {
        const ctx = viewport.overlayCtx;
        const p1  = viewport.imageToCanvas(m.p1.x, m.p1.y);
        const p2  = viewport.imageToCanvas(m.p2.x, m.p2.y);
        const C   = this._RESEARCH_COLORS.abcAxis;

        ctx.save();
        ctx.strokeStyle = C; ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
        this._drawEndpointDot(ctx, p1, C);
        this._drawEndpointDot(ctx, p2, C);

        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.fillStyle = C;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${m.axis} = ${m.distanceMm.toFixed(1)} mm`,
                     (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 5);
        ctx.restore();
    },

    /* ════════════════════════════════════════════════════════
       Overlay del detector automático
       ════════════════════════════════════════════════════════ */

    /**
     * Pinta el mapa de asimetría y los contornos de los candidatos.
     *
     * El bitmap viene a resolución de IMAGEN y se coloca con la misma
     * transformación afín que usa el render WebGL, derivada de tres puntos de
     * imageToCanvas. Así queda alineado con cualquier zoom, desplazamiento,
     * volteo y rotación sin tocar el renderer ni el pipeline de filtros —
     * importa porque este overlay nunca debe pasar por un filtro.
     */
    drawDetectorOverlay(viewport) {
        if (typeof Detector === 'undefined' || !Detector.hasResult()) return;
        if (viewport.mprPlane && viewport.mprPlane !== 'axial') return;

        const ctx = viewport.overlayCtx;
        const z   = viewport.state.sliceIndex;
        const bmp = Detector.getOverlayFor(z);
        const contours = Detector.getContoursFor(z);
        if (!bmp && !contours?.length) { this.drawDetectorBadge(viewport); return; }

        // Transformación afín exacta a partir de tres puntos
        const o = viewport.imageToCanvas(0, 0);
        const a = viewport.imageToCanvas(1, 0);
        const b = viewport.imageToCanvas(0, 1);

        if (bmp) {
            ctx.save();
            ctx.globalAlpha = Detector.opacity;
            ctx.imageSmoothingEnabled = false;
            ctx.setTransform(a.x - o.x, a.y - o.y, b.x - o.x, b.y - o.y, o.x, o.y);
            ctx.drawImage(bmp, 0, 0);
            ctx.restore();
        }

        if (contours?.length) {
            ctx.save();
            ctx.lineJoin = 'round';
            for (const c of contours) {
                if (!c.contour?.length) continue;
                const hypo = c.kind === 'hypodense';
                ctx.strokeStyle = hypo ? '#4FC3F7' : '#FF5252';
                ctx.lineWidth = 2;
                ctx.setLineDash([]);
                ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
                this._strokePolygon(ctx, viewport, c.contour);

                // El espejo va discontinuo: es la referencia, no el hallazgo
                if (c.mirrorContour?.length) {
                    ctx.setLineDash([5, 4]);
                    ctx.lineWidth = 1.2;
                    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
                    this._strokePolygon(ctx, viewport, c.mirrorContour);
                    ctx.setLineDash([]);
                }

                // Etiqueta en cifras, nunca en diagnóstico
                let top = c.contour[0];
                for (const p of c.contour) if (p.y < top.y) top = p;
                const at = viewport.imageToCanvas(top.x, top.y);
                const lines = [
                    `${hypo ? 'hipodensa' : 'hiperdensa'} · ${c.volumeMl.toFixed(2)} mL`,
                ];
                if (c.meanHu != null) {
                    lines.push(`${c.meanHu.toFixed(1)} UH` +
                               (c.mirrorMeanHu != null ? ` vs ${c.mirrorMeanHu.toFixed(1)}` : ''));
                }
                if (c.nwu != null) lines.push(`NWU ${c.nwu.toFixed(1)} %`);
                if (c.flags?.length) lines.push(c.flags.join(' · '));

                ctx.font = '10px Inter, sans-serif';
                ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
                ctx.fillStyle = hypo ? '#4FC3F7' : '#FF5252';
                lines.forEach((t, i) => {
                    ctx.fillText(t, at.x + 8, at.y - 4 - (lines.length - 1 - i) * 12);
                });
            }
            ctx.restore();
        }

        this.drawDetectorBadge(viewport);
    },

    _strokePolygon(ctx, viewport, pts) {
        ctx.beginPath();
        pts.forEach((p, i) => {
            const c = viewport.imageToCanvas(p.x, p.y);
            i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
        });
        ctx.closePath();
        ctx.stroke();
    },

    /**
     * Sello de análisis automático, quemado en el canvas para que cualquier
     * PNG o informe exportado con el overlay encima lo lleve.
     */
    drawDetectorBadge(viewport) {
        const ctx = viewport.overlayCtx;
        const cw  = viewport.overlayCanvas.width;
        const ch  = viewport.overlayCanvas.height;
        const label = 'ANÁLISIS AUTOMÁTICO — NO DIAGNÓSTICO';

        ctx.save();
        ctx.font = 'bold 9px Inter, sans-serif';
        const w = ctx.measureText(label).width + 16;
        const x = (cw - w) / 2, y = ch - 58;

        ctx.fillStyle = 'rgba(120, 50, 10, 0.45)';
        ctx.fillRect(x, y, w, 16);
        ctx.strokeStyle = 'rgba(255, 170, 70, 0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 15);
        ctx.fillStyle = '#FFCC80';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cw / 2, y + 8.5);
        ctx.restore();
    },

    /** Sonda ASPECTS: círculo, su espejo y el ΔUH. */
    _drawAspectsProbe(viewport, m) {
        const ctx = viewport.overlayCtx;
        if (!m.points?.length) return;
        const color = m.flagged ? '#FF7043' : '#80CBC4';

        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
        ctx.strokeStyle = color;
        ctx.lineWidth = m.selected ? 2.4 : 1.6;
        this._strokePolygon(ctx, viewport, m.points);

        if (m.mirrorPoints?.length) {
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.2;
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            this._strokePolygon(ctx, viewport, m.mirrorPoints);
            ctx.setLineDash([]);
        }

        const c = viewport.imageToCanvas(m.seed.x, m.seed.y);
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const lines = [m.regionLabel || 'Sonda'];
        if (m.deltaHu != null) {
            lines.push(`ΔUH ${m.deltaHu.toFixed(2)}` +
                       (m.z != null ? ` · z ${m.z.toFixed(1)}` : ''));
        }
        lines.forEach((t, i) => ctx.fillText(t, c.x + 10, c.y - 4 - (lines.length - 1 - i) * 12));
        ctx.restore();
    },

    /**
     * Sello de modo investigación quemado en el overlay.
     * Va en el canvas —no solo en el DOM— para que cualquier PNG o informe
     * exportado desde el modo investigación lleve la marca.
     */
    drawResearchBadge(viewport) {
        if (typeof ResearchMode === 'undefined' || !ResearchMode.isActive()) return;
        const ctx = viewport.overlayCtx;
        const cw  = viewport.overlayCanvas.width;

        const label = 'INVESTIGACIÓN · SIN PROCESAMIENTO';
        ctx.save();
        ctx.font = 'bold 9px Inter, sans-serif';
        const w = ctx.measureText(label).width + 16;
        const x = (cw - w) / 2, y = 4;

        ctx.fillStyle = 'rgba(0, 200, 120, 0.18)';
        ctx.fillRect(x, y, w, 16);
        ctx.strokeStyle = 'rgba(0, 255, 157, 0.75)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 15);

        ctx.fillStyle = '#00FF9D';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cw / 2, y + 8.5);
        ctx.restore();
    },

    /* ── Indicador de nota clínica en overlay ───────────── */
    drawNoteIndicator(viewport) {
        if (viewport.mprPlane && viewport.mprPlane !== 'axial') return;
        if (!MeasurementStore.hasNote(viewport.state.sliceIndex)) return;
        const ctx = viewport.overlayCtx;
        const ch  = viewport.overlayCanvas.height;
        ctx.save();
        ctx.font         = '13px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = 'rgba(0,0,0,0.55)';
        ctx.fillRect(6, ch - 28, 24, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText('📝', 8, ch - 18);
        ctx.restore();
    },

    /* ── Medición en progreso (mientras el usuario dibuja) ── */
    drawLiveMeasurement(viewport) {
        const live = viewport.state.liveMeasurement;
        if (!live) return;

        // Línea media en curso: un solo segmento discontinuo
        if (live.type === 'midline_partial') {
            const ctx = viewport.overlayCtx;
            const a = viewport.imageToCanvas(live.anterior.x,  live.anterior.y);
            const p = viewport.imageToCanvas(live.posterior.x, live.posterior.y);
            ctx.save();
            ctx.strokeStyle = this._RESEARCH_COLORS.midline;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(p.x, p.y); ctx.stroke();
            ctx.restore();
            return;
        }

        // ROI de NWU en curso: contorno, sin estadísticas todavía
        if (live.type === 'nwu_live') {
            const ctx = viewport.overlayCtx;
            if (!live.points?.length) return;
            ctx.save();
            ctx.strokeStyle = this._RESEARCH_COLORS.lesion;
            ctx.lineWidth = 1.8;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            live.points.forEach((p, i) => {
                const c = viewport.imageToCanvas(p.x, p.y);
                i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y);
            });
            ctx.closePath(); ctx.stroke();
            ctx.restore();
            return;
        }

        if (live.type === 'cobb_partial') {
            // Dibujar línea 1 completa + línea 2 en curso
            const ctx = viewport.overlayCtx;
            const toC = (p) => viewport.imageToCanvas(p.x, p.y);
            const COLORS = ['#00E5FF', '#FF6EC7'];
            [live.line1, live.line2].forEach((line, li) => {
                if (!line?.p1 || !line?.p2) return;
                const p1 = toC(line.p1), p2 = toC(line.p2);
                ctx.strokeStyle = COLORS[li]; ctx.lineWidth = 1.5;
                ctx.setLineDash([5, 3]);
                ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
                ctx.setLineDash([]);
            });
            return;
        }
        this._drawMeasurement(viewport, { ...live, selected: true });
    },

    /* ── Crosshair triplanar ─────────────────────────── */
    // Colores por plano de referencia
    _COLORS: { axial: '#FFD700', coronal: '#00CFFF', sagital: '#FF6B6B' },

    drawMprCrosshair(viewport) {
        const vps = typeof ViewportLayout !== 'undefined' ? ViewportLayout.getAll() : [];
        if (vps.length < 2) return;

        // Encontrar viewports por plano
        const find = (plane) => vps.find(v => v.mprPlane === plane);
        const axialVP    = find('axial');
        const coronalVP  = find('coronal');
        const sagitalVP  = find('sagital');

        const dims = typeof MprVolume !== 'undefined' ? MprVolume.getDims() : null;
        if (!dims) return;

        const ctx = viewport.overlayCtx;
        const cw  = viewport.overlayCanvas.width;
        const ch  = viewport.overlayCanvas.height;
        const C   = this._COLORS;

        const axialZ = axialVP
            ? (axialVP.state.sliceIndex + 0.5) / (axialVP.state.totalSlices || dims.depth)
            : 0.5;
        const coronalY = coronalVP ? (coronalVP._sliceFraction ?? 0.5) : 0.5;
        const sagitalX = sagitalVP ? (sagitalVP._sliceFraction ?? 0.5) : 0.5;

        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur  = 3;

        // ── Vista AXIAL: líneas de coronal (horizontal) y sagital (vertical)
        if (viewport.mprPlane === 'axial' && viewport.state.frame) {
            const f = viewport.state.frame;
            // Coronal: línea horizontal en la fila donde corta el plano coronal
            const rowY = coronalY * f.rows;
            const screenCoronal = viewport.imageToCanvas(f.cols / 2, rowY);
            ctx.strokeStyle = C.coronal;
            ctx.beginPath();
            ctx.moveTo(0, screenCoronal.y);
            ctx.lineTo(cw, screenCoronal.y);
            ctx.stroke();

            // Sagital: línea vertical en la columna donde corta el plano sagital
            const colX = sagitalX * f.cols;
            const screenSagital = viewport.imageToCanvas(colX, f.rows / 2);
            ctx.strokeStyle = C.sagital;
            ctx.beginPath();
            ctx.moveTo(screenSagital.x, 0);
            ctx.lineTo(screenSagital.x, ch);
            ctx.stroke();
        }

        // ── Vistas CORONAL y SAGITAL: líneas de axial (Z) y la otra vista
        if (viewport.mprPlane === 'coronal' || viewport.mprPlane === 'sagital') {
            // Cuando zAscending=false el shader invierte Z (up=[0,0,-1], origin.z=1),
            // así que la fracción para la guía también debe invertirse.
            const zAsc = MprVolume.getDims()?.zAscending ?? true;
            const axialZGuide = zAsc ? axialZ : (1 - axialZ);
            // Línea horizontal = posición axial (Z)
            const axialScreenY = this._mprTexcoordToScreenY(axialZGuide, viewport, ch);
            ctx.strokeStyle = C.axial;
            ctx.beginPath();
            ctx.moveTo(0, axialScreenY);
            ctx.lineTo(cw, axialScreenY);
            ctx.stroke();

            // Línea vertical = la otra vista MPR
            const otherFrac = viewport.mprPlane === 'coronal' ? sagitalX : coronalY;
            const otherScreenX = this._mprTexcoordToScreenX(otherFrac, viewport, cw);
            ctx.strokeStyle = viewport.mprPlane === 'coronal' ? C.sagital : C.coronal;
            ctx.beginPath();
            ctx.moveTo(otherScreenX, 0);
            ctx.lineTo(otherScreenX, ch);
            ctx.stroke();
        }

        ctx.restore();
    },

    // Convierte texcoord.y [0,1] de volumen → posición Y en canvas del viewport MPR
    _mprTexcoordToScreenY(tcY, viewport, ch) {
        // Shader: v_texcoord.y = sy * (0.5 - canvas_y/ch) + ty + 0.5
        // Invertido: canvas_y = (0.5 - (tcY - 0.5 - ty) / sy) * ch
        const t = viewport._buildMprTransform ? viewport._buildMprTransform() : null;
        if (!t) return (1 - tcY) * ch;
        // t es Float32Array column-major 3x3: [m00,m10,m20, m01,m11,m21, m02,m12,m22]
        const sy = t[4];   // m[1][1] = sy en la diagonal
        const ty = t[7];   // m[2][1] = ty
        const centered_y = (tcY - 0.5 - ty) / (sy || 1);
        return Math.max(0, Math.min(ch, (0.5 - centered_y) * ch));
    },

    // Convierte texcoord.x [0,1] de volumen → posición X en canvas del viewport MPR
    _mprTexcoordToScreenX(tcX, viewport, cw) {
        const t = viewport._buildMprTransform ? viewport._buildMprTransform() : null;
        if (!t) return tcX * cw;
        const sx = t[0];   // m[0][0] = sx
        const tx = t[6];   // m[2][0] = tx
        const centered_x = (tcX - 0.5 - tx) / (sx || 1);
        return Math.max(0, Math.min(cw, (0.5 + centered_x) * cw));
    },

    /* ── Crosshair del probe ──────────────────────────── */
    drawCrosshair(viewport) {
        const pos = viewport.state.mousePos;
        if (!pos) return;
        const ctx = viewport.overlayCtx;
        const cw  = viewport.overlayCanvas.width;
        const ch  = viewport.overlayCanvas.height;

        ctx.strokeStyle = 'rgba(255,255,0,0.5)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pos.x, 0); ctx.lineTo(pos.x, ch);
        ctx.moveTo(0, pos.y); ctx.lineTo(cw, pos.y);
        ctx.stroke();
        ctx.setLineDash([]);
    },

    /* ── A/B split comparator ────────────────────────── */
    drawAbSplit(viewport) {
        const ctx     = viewport.overlayCtx;
        const cw      = viewport.overlayCanvas.width;
        const ch      = viewport.overlayCanvas.height;
        const splitX  = Math.round((viewport.state.abSplitX ?? 0.5) * cw);

        // Draw "original" (no-filter) canvas on the left half
        if (viewport._abCanvas) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, splitX, ch);
            ctx.clip();
            ctx.drawImage(viewport._abCanvas, 0, 0, cw, ch);
            ctx.restore();
        }

        // Divider line
        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur  = 4;
        ctx.setLineDash([8, 4]);
        ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, ch); ctx.stroke();
        ctx.setLineDash([]);

        // Drag handle at center
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(splitX, ch / 2, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5; ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.fillStyle = '#333'; ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⇔', splitX, ch / 2);

        // Labels
        const labelBg = (x, label) => {
            const m = ctx.measureText(label);
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(x, 6, m.width + 12, 18);
            ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
            ctx.fillText(label, x + 6, 9);
        };
        ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.shadowBlur = 0;
        labelBg(6, 'ORIGINAL');
        labelBg(splitX + 6, 'FILTROS');

        ctx.restore();
    },
};
