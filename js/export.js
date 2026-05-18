'use strict';

const Export = {
    /* ── PNG ─────────────────────────────────────────── */
    async exportPNG(viewport) {
        viewport = viewport || ViewportLayout.getActive();
        if (!viewport?.state.frame) { UI.showToast('No hay imagen cargada', 'warning'); return; }
        const blob = await viewport.captureBlob('image/png');
        this._download(blob, `tac_slice_${(viewport.state.sliceIndex + 1)}.png`);
        UI.showToast('Imagen PNG exportada', 'success');
    },

    async exportJPEG(viewport) {
        viewport = viewport || ViewportLayout.getActive();
        if (!viewport?.state.frame) { UI.showToast('No hay imagen cargada', 'warning'); return; }
        const blob = await viewport.captureBlob('image/jpeg', 0.93);
        this._download(blob, `tac_slice_${(viewport.state.sliceIndex + 1)}.jpg`);
        UI.showToast('Imagen JPEG exportada', 'success');
    },

    /* ── Copiar al portapapeles ──────────────────────── */
    async copyToClipboard(viewport) {
        viewport = viewport || ViewportLayout.getActive();
        if (!viewport?.state.frame) { UI.showToast('No hay imagen cargada', 'warning'); return; }
        try {
            const blob = await viewport.captureBlob('image/png');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            UI.showToast('Imagen copiada al portapapeles', 'success');
        } catch {
            UI.showToast('Error copiando al portapapeles', 'error');
        }
    },

    /* ── Imprimir ─────────────────────────────────────── */
    async print(viewport) {
        viewport = viewport || ViewportLayout.getActive();
        if (!viewport?.state.frame) return;
        const blob   = await viewport.captureBlob('image/png');
        const url    = URL.createObjectURL(blob);
        const win    = window.open('', '_blank');
        const f      = viewport.state.frame;
        win.document.write(`
            <!DOCTYPE html><html><head>
            <title>TAC Viewer — ${f.patientName || 'Imagen'}</title>
            <style>
                body { margin: 0; background: #000; display: flex; flex-direction: column;
                       align-items: center; justify-content: center; min-height: 100vh; }
                img  { max-width: 100%; max-height: 90vh; image-rendering: pixelated; }
                p    { color: #fff; font: 12px/1 sans-serif; margin: 8px 0 0; }
            </style></head><body>
            <img src="${url}" onload="window.print()">
            <p>${f.patientName || ''} — Slice ${viewport.state.sliceIndex + 1}</p>
            </body></html>
        `);
        win.document.close();
        win.onafterprint = () => { win.close(); URL.revokeObjectURL(url); };
    },

    /* ── Mediciones CSV ─────────────────────────────── */
    exportMeasurementsCSV() {
        const all = MeasurementStore.getAll();
        if (!all.length) { UI.showToast('No hay mediciones para exportar', 'warning'); return; }
        const rows = ['Slice,Tipo,Valor,Unidad,Detalle'];
        all.sort((a, b) => a.sliceIndex - b.sliceIndex).forEach(m => {
            let val = '', unit = '', detail = '';
            switch (m.type) {
                case 'distance':  val = m.distanceMm?.toFixed(2) ?? ''; unit = 'mm'; break;
                case 'angle':     val = m.angleDeg?.toFixed(1) ?? ''; unit = 'deg'; break;
                case 'cobb':      val = m.angleDeg?.toFixed(1) ?? ''; unit = 'deg (Cobb)'; break;
                case 'ellipse':
                case 'rectangle':
                case 'freehand':
                    val = m.stats?.mean ?? ''; unit = 'HU';
                    detail = m.stats ? `std=${m.stats.std} min=${m.stats.min} max=${m.stats.max} area=${m.stats.area}mm2` : '';
                    break;
                case 'arrow':  val = m.label || ''; break;
                case 'text':   val = m.text || ''; break;
            }
            rows.push(`${m.sliceIndex + 1},${m.type},${val},${unit},"${detail}"`);
        });
        this._download(new Blob([rows.join('\n')], { type: 'text/csv' }), 'mediciones.csv');
        UI.showToast('Mediciones exportadas como CSV', 'success');
    },

    /* ── Reporte HTML estructurado ───────────────────── */
    async exportReport(viewport) {
        viewport = viewport || ViewportLayout.getActive();
        if (!viewport?.state.frame) { UI.showToast('No hay imagen cargada', 'warning'); return; }

        UI.showToast('Generando reporte…', 'info', 3500);

        const f    = viewport.state.frame;
        const s    = viewport.state;
        const all  = MeasurementStore.getAll().sort((a, b) => a.sliceIndex - b.sliceIndex);
        const date = new Date().toLocaleString('es-ES');

        const fmtVal = (m) => {
            switch (m.type) {
                case 'distance':  return `${m.distanceMm?.toFixed(2) ?? '—'} mm`;
                case 'angle':     return `${m.angleDeg?.toFixed(1) ?? '—'}°`;
                case 'cobb':      return `${m.angleDeg?.toFixed(1) ?? '—'}° (Cobb)`;
                case 'ellipse':
                case 'rectangle':
                case 'freehand':  return m.stats ? `Media ${m.stats.mean} ±${m.stats.std} HU · Área ${m.stats.area} mm²` : '—';
                case 'arrow':     return m.label || 'Indicador visual';
                case 'text':      return m.text || '—';
                default:          return '—';
            }
        };
        const typeEs = {
            distance:  'Distancia',     angle:     'Ángulo',
            cobb:      'Ángulo de Cobb', ellipse:   'ROI Elipse',
            rectangle: 'ROI Rectángulo', freehand:  'ROI Libre',
            arrow:     'Flecha',         text:      'Texto',
        };

        // ── Determinar qué slices capturar ──────────────────────────
        // Si hay mediciones: capturar solo los slices anotados.
        // Si no hay: capturar solo el slice actual (fallback).
        const annotatedIdxs = all.length
            ? [...new Set(all.map(m => m.sliceIndex))].sort((a, b) => a - b)
            : [s.sliceIndex];

        const series      = SeriesPanel.getSeries();
        const origFrame   = viewport.state.frame;
        const origSlice   = viewport.state.sliceIndex;
        const origTotal   = viewport.state.totalSlices;
        const origTv      = viewport.state.tvEnabled;
        viewport.state.tvEnabled = false; // evitar esperar al worker durante captura

        // ── Capturar imagen de cada slice anotado ───────────────────
        const captures = [];
        for (const idx of annotatedIdxs) {
            const frame = series[idx] ?? origFrame;
            viewport.loadFrame(frame, idx, series.length || origTotal);
            viewport.render();
            await new Promise(r => requestAnimationFrame(r));
            const blob = await viewport.captureBlob('image/png');
            const b64  = await new Promise(r => {
                const rd = new FileReader();
                rd.onload = () => r(rd.result);
                rd.readAsDataURL(blob);
            });
            captures.push({ idx, b64, measurements: all.filter(m => m.sliceIndex === idx) });
        }

        // ── Restaurar slice original ─────────────────────────────────
        viewport.state.tvEnabled = origTv;
        viewport.loadFrame(origFrame, origSlice, origTotal);
        viewport.render();

        // ── Construir secciones por slice ───────────────────────────
        const sliceSections = captures.map(({ idx, b64, measurements }) => {
            const mRows = measurements.map(m =>
                `<tr><td>${typeEs[m.type] || m.type}</td><td>${fmtVal(m)}</td></tr>`
            ).join('');
            const mTable = mRows
                ? `<table><thead><tr><th>Tipo</th><th>Valor</th></tr></thead><tbody>${mRows}</tbody></table>`
                : '';
            return `
<div class="slice-block">
  <h2>Slice ${idx + 1}</h2>
  <img src="${b64}" alt="Slice ${idx + 1}">
  ${mTable}
</div>`;
        }).join('\n');

        // ── HTML final ───────────────────────────────────────────────
        const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<title>Reporte TAC — ${f.patientName || 'Paciente'}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:960px;margin:40px auto;color:#222;background:#fff}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:14px;font-weight:700;border-bottom:2px solid #0066cc;padding-bottom:4px;margin:28px 0 10px;color:#0066cc;text-transform:uppercase;letter-spacing:.04em}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;background:#f5f7fa;padding:12px;border-radius:6px}
  .meta dt{font-weight:600;color:#555}.meta dd{margin:0}
  .slice-block{margin-bottom:40px;padding-bottom:32px;border-bottom:1px solid #e8eaed}
  .slice-block:last-child{border-bottom:none}
  img{width:100%;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.15);margin:8px 0 12px;display:block}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th{background:#0066cc;color:#fff;padding:7px 10px;text-align:left}
  td{padding:6px 10px;border-bottom:1px solid #e0e0e0}
  tr:last-child td{border-bottom:none}tr:nth-child(even) td{background:#f9f9f9}
  footer{font-size:11px;color:#aaa;text-align:center;margin-top:32px}
</style></head><body>
<h1>Informe de Imagen TAC</h1>
<p style="font-size:12px;color:#888;margin:2px 0 16px">Generado: ${date}</p>

<h2>Datos del Paciente y Estudio</h2>
<dl class="meta">
  <dt>Paciente</dt><dd>${f.patientName || '—'}</dd>
  <dt>ID</dt><dd>${f.patientID || '—'}</dd>
  <dt>Fecha nac.</dt><dd>${f.patientDOB || '—'}</dd>
  <dt>Sexo</dt><dd>${f.patientSex || '—'}</dd>
  <dt>Modalidad</dt><dd>${f.modality || 'CT'}</dd>
  <dt>Fecha estudio</dt><dd>${f.studyDate || '—'}</dd>
  <dt>Descripción</dt><dd>${f.studyDesc || f.seriesDesc || '—'}</dd>
  <dt>Institución</dt><dd>${f.institutionName || '—'}</dd>
  <dt>W/L</dt><dd>${Math.round(s.windowWidth)} / ${Math.round(s.windowCenter)}</dd>
  <dt>Slices con anotaciones</dt><dd>${annotatedIdxs.length}</dd>
</dl>

<h2>Imágenes Anotadas (${captures.length} slice${captures.length !== 1 ? 's' : ''})</h2>
${sliceSections}

<footer>Generado con TAC Viewer — Visor DICOM Avanzado</footer>
</body></html>`;

        this._download(new Blob([html], { type: 'text/html' }), `reporte_${f.patientID || 'TAC'}.html`);
        UI.showToast('Reporte exportado', 'success');
    },

    exportMeasurementsJSON() {
        const all = MeasurementStore.getAll();
        if (!all.length) { UI.showToast('No hay mediciones para exportar', 'warning'); return; }
        this._download(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }), 'mediciones.json');
        UI.showToast('Mediciones exportadas como JSON', 'success');
    },

    /* ── Helper ──────────────────────────────────────── */
    _download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
};
