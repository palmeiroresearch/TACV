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
                case 'ellipse':
                case 'rectangle':
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
