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

        UI.showToast('Generando reporte…', 'info', 2000);
        const blob   = await viewport.captureBlob('image/png');
        const reader = new FileReader();
        const imgB64 = await new Promise(res => { reader.onload = () => res(reader.result); reader.readAsDataURL(blob); });

        const f    = viewport.state.frame;
        const s    = viewport.state;
        const all  = MeasurementStore.getAll().sort((a, b) => a.sliceIndex - b.sliceIndex);
        const date = new Date().toLocaleString('es-ES');

        const fmtVal = (m) => {
            switch (m.type) {
                case 'distance':  return `${m.distanceMm?.toFixed(2) ?? '—'} mm`;
                case 'angle':     return `${m.angleDeg?.toFixed(1) ?? '—'}°`;
                case 'ellipse':
                case 'rectangle': return m.stats ? `Media ${m.stats.mean} ±${m.stats.std} HU · Área ${m.stats.area} mm²` : '—';
                case 'arrow':     return m.label || '—';
                case 'text':      return m.text || '—';
                default:          return '—';
            }
        };
        const typeEs = { distance: 'Distancia', angle: 'Ángulo', ellipse: 'ROI Elipse', rectangle: 'ROI Rectángulo', arrow: 'Flecha', text: 'Texto' };

        const rows = all.length
            ? all.map(m => `<tr><td>${m.sliceIndex + 1}</td><td>${typeEs[m.type] || m.type}</td><td>${fmtVal(m)}</td></tr>`).join('')
            : '<tr><td colspan="3" style="color:#888;text-align:center">Sin mediciones</td></tr>';

        const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<title>Reporte TAC — ${f.patientName || 'Paciente'}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;color:#222;background:#fff}
  h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;font-weight:600;border-bottom:2px solid #0066cc;padding-bottom:4px;margin:24px 0 10px;color:#0066cc}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:13px;background:#f5f7fa;padding:12px;border-radius:6px}
  .meta dt{font-weight:600;color:#555}.meta dd{margin:0}
  img{width:100%;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.15);margin:8px 0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#0066cc;color:#fff;padding:7px 10px;text-align:left}
  td{padding:6px 10px;border-bottom:1px solid #e0e0e0}
  tr:last-child td{border-bottom:none}tr:nth-child(even){background:#f9f9f9}
  footer{font-size:11px;color:#aaa;text-align:center;margin-top:32px}
</style></head><body>
<h1>Informe de Imagen TAC</h1>
<p style="font-size:12px;color:#888">Generado: ${date}</p>

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
  <dt>Slice</dt><dd>${s.sliceIndex + 1} / ${s.totalSlices || '?'}</dd>
  <dt>W/L</dt><dd>${Math.round(s.windowWidth)} / ${Math.round(s.windowCenter)}</dd>
</dl>

<h2>Imagen</h2>
<img src="${imgB64}" alt="Imagen TAC">

<h2>Mediciones (${all.length})</h2>
<table><thead><tr><th>Slice</th><th>Tipo</th><th>Valor</th></tr></thead><tbody>${rows}</tbody></table>

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
