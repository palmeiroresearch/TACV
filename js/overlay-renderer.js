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
        const { canvas } = viewport.overlayCanvas;
        this._sync(viewport);
        ctx.clearRect(0, 0, viewport.overlayCanvas.width, viewport.overlayCanvas.height);

        if (!viewport.state.frame) return;

        this.drawDicomInfo(viewport);
        this.drawOrientationMarkers(viewport);
        this.drawScaleBar(viewport);
        this.drawMeasurements(viewport);
        if (viewport.state.activeTool === TOOL_IDS.PROBE) {
            this.drawCrosshair(viewport);
        }
        this.drawLiveMeasurement(viewport);
    },

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

        // Top-left: paciente
        const name = f.patientName || 'Anónimo';
        const pid  = f.patientID   ? `ID: ${f.patientID}` : '';
        const dob  = f.patientDOB  ? `DOB: ${f.patientDOB}` : '';
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
        const m    = viewport.state.orientationLabels || ORIENTATION_AXIAL;
        const pad  = 28;

        ctx.font      = '14px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,220,0,0.9)';
        ctx.shadowColor = 'rgba(0,0,0,0.95)';
        ctx.shadowBlur  = 3;

        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(m.top, cw / 2, pad);

        ctx.textBaseline = 'bottom';
        ctx.fillText(m.bottom, cw / 2, ch - pad);

        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.left, pad, ch / 2);

        ctx.textAlign    = 'right';
        ctx.fillText(m.right, cw - pad, ch / 2);

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
            const txt = `Mean: ${m.stats.mean} HU\nStd: ${m.stats.std}\nArea: ${m.stats.area} mm²`;
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
            [`Mean: ${m.stats.mean} HU`, `Std: ${m.stats.std}`, `Area: ${m.stats.area} mm²`]
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

    _drawEndpointDot(ctx, p, color) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    },

    /* ── Medición en progreso (mientras el usuario dibuja) ── */
    drawLiveMeasurement(viewport) {
        const live = viewport.state.liveMeasurement;
        if (!live) return;
        this._drawMeasurement(viewport, { ...live, selected: true });
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
};
