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
        const all   = MeasurementStore.getAll();
        const notes = MeasurementStore.getAllNotes();
        if (!all.length && !notes.length) { UI.showToast('No hay mediciones ni notas para exportar', 'warning'); return; }

        const rows = ['Slice,Tipo,Valor,Unidad,Detalle'];
        all.sort((a, b) => a.sliceIndex - b.sliceIndex).forEach(m => {
            let val = '', unit = '', detail = '';
            switch (m.type) {
                case 'distance':  val = m.distanceMm?.toFixed(2) ?? ''; unit = 'mm'; break;
                case 'angle':     val = m.angleDeg?.toFixed(1) ?? ''; unit = 'deg'; break;
                case 'cobb':      val = m.angleDeg?.toFixed(1) ?? ''; unit = 'deg (Cobb)'; break;
                case 'ellipse':
                case 'rectangle':
                case 'freehand': {
                    const s = m.stats;
                    const n = (v, d = 1) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d);
                    val = s?.mean != null ? n(s.mean) : ''; unit = 'HU';
                    detail = s ? `std=${n(s.std)} mediana=${n(s.median)} min=${n(s.min)} ` +
                                 `max=${n(s.max)} n=${s.count} area=${n(s.area)}mm2` : '';
                    break;
                }
                case 'arrow':  val = m.label || ''; break;
                case 'text':   val = m.text || ''; break;
            }
            rows.push(`${m.sliceIndex + 1},${m.type},${val},${unit},"${detail}"`);
        });

        if (notes.length) {
            rows.push('');
            rows.push('NOTAS CLÍNICAS');
            rows.push('Slice,Nota');
            notes.forEach(n => {
                const safe = (n.text || '').replace(/"/g, '""');
                rows.push(`${n.sliceIndex + 1},"${safe}"`);
            });
        }

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
                case 'freehand':  return m.stats?.mean != null
                    ? `Media ${m.stats.mean.toFixed(1)} ±${(m.stats.std ?? 0).toFixed(1)} HU · ` +
                      `Área ${(m.stats.area ?? 0).toFixed(1)} mm²`
                    : '—';
                case 'nwu_roi':   return m.stats?.mean != null
                    ? `${m.role === 'lesion' ? 'Lesión' : 'Contralateral'} ` +
                      `${m.stats.mean.toFixed(1)} ±${(m.stats.std ?? 0).toFixed(1)} HU · ` +
                      `n=${m.stats.count}${m.stats.excludedTotal ? ` · ${m.stats.excludedTotal} excl.` : ''}`
                    : '—';
                case 'midline':   return `Línea media (${m.source || 'manual'})`;
                case 'septum':    return m.shiftMm != null
                    ? `Desviación ${Math.abs(m.shiftMm).toFixed(1)} mm` : '—';
                case 'abc_axis':  return `Eje ${m.axis} = ${m.distanceMm.toFixed(1)} mm`;
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
            nwu_roi:   'ROI NWU',        midline:   'Línea media',
            septum:    'Septum',         abc_axis:  'Eje ABC/2',
        };

        // En modo investigación el informe no puede llevar datos del paciente:
        // es un documento que sale del dispositivo y acaba en una carpeta de estudio.
        const research = (typeof ResearchMode !== 'undefined') && ResearchMode.isActive();

        // ── Determinar qué slices capturar ──────────────────────────
        // Unión de slices con mediciones y slices con notas clínicas.
        // Si no hay ninguno: solo el slice actual (fallback).
        const noteIdxs = MeasurementStore.getAllNotes().map(n => n.sliceIndex);
        const annotatedIdxs = (all.length || noteIdxs.length)
            ? [...new Set([...all.map(m => m.sliceIndex), ...noteIdxs])].sort((a, b) => a - b)
            : [s.sliceIndex];

        // Forzar anonimización del overlay quemado en las capturas
        const origAnon = viewport.state.anonymized;
        if (research) viewport.state.anonymized = true;

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
            captures.push({ idx, b64,
                measurements: all.filter(m => m.sliceIndex === idx),
                note: MeasurementStore.getNote(idx) });
        }

        // ── Restaurar slice original ─────────────────────────────────
        viewport.state.tvEnabled  = origTv;
        viewport.state.anonymized = origAnon;
        viewport.loadFrame(origFrame, origSlice, origTotal);
        viewport.render();

        // ── Construir secciones por slice ───────────────────────────
        const sliceSections = captures.map(({ idx, b64, measurements, note }) => {
            const mRows = measurements.map(m =>
                `<tr><td>${typeEs[m.type] || m.type}</td><td>${fmtVal(m)}</td></tr>`
            ).join('');
            const mTable = mRows
                ? `<table><thead><tr><th>Tipo</th><th>Valor</th></tr></thead><tbody>${mRows}</tbody></table>`
                : '';
            const noteBlock = note
                ? `<div class="slice-note"><strong>Nota clínica:</strong><br>${note.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>`
                : '';
            return `
<div class="slice-block">
  <h2>Slice ${idx + 1}</h2>
  <img src="${b64}" alt="Slice ${idx + 1}">
  ${noteBlock}${mTable}
</div>`;
        }).join('\n');

        // ── HTML final ───────────────────────────────────────────────
        const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<title>Reporte TAC — ${research ? (ResearchMode.getCaseCode() || 'Caso') : (f.patientName || 'Paciente')}</title>
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
  .slice-note{background:#fffbe6;border-left:4px solid #f0ad00;padding:10px 14px;margin:8px 0 12px;font-size:13px;border-radius:4px;white-space:pre-wrap;line-height:1.5}
  .research-banner{background:#e8f8f0;border:1px solid #0a8;color:#065f46;padding:8px 12px;border-radius:5px;font-size:12px;font-weight:600;margin:0 0 16px;letter-spacing:.02em}
</style></head><body>
<h1>Informe de Imagen TAC</h1>
<p style="font-size:12px;color:#888;margin:2px 0 16px">Generado: ${date}</p>
${research ? `<div class="research-banner">
  MODO INVESTIGACIÓN — sin procesamiento de imagen · app v${APP_VERSION}
  · caso ${ResearchMode.getCaseCode() || '—'}
  · lector ${ResearchMode.getReaderId() || '—'}
</div>` : ''}

<h2>${research ? 'Datos del Estudio (anonimizado)' : 'Datos del Paciente y Estudio'}</h2>
<dl class="meta">
  ${research ? `
  <dt>Código de caso</dt><dd>${ResearchMode.getCaseCode() || '—'}</dd>
  <dt>Lector</dt><dd>${ResearchMode.getReaderId() || '—'}</dd>` : `
  <dt>Paciente</dt><dd>${f.patientName || '—'}</dd>
  <dt>ID</dt><dd>${f.patientID || '—'}</dd>
  <dt>Fecha nac.</dt><dd>${f.patientDOB || '—'}</dd>
  <dt>Sexo</dt><dd>${f.patientSex || '—'}</dd>`}
  <dt>Modalidad</dt><dd>${f.modality || 'CT'}</dd>
  <dt>Fecha estudio</dt><dd>${f.studyDate || '—'}</dd>
  <dt>Descripción</dt><dd>${f.studyDesc || f.seriesDesc || '—'}</dd>
  ${research ? '' : `<dt>Institución</dt><dd>${f.institutionName || '—'}</dd>`}
  <dt>Equipo</dt><dd>${[f.manufacturer, f.manufacturerModel].filter(Boolean).join(' ') || '—'}</dd>
  <dt>kVp / Kernel</dt><dd>${[f.kvp, f.convolutionKernel].filter(Boolean).join(' / ') || '—'}</dd>
  <dt>W/L</dt><dd>${Math.round(s.windowWidth)} / ${Math.round(s.windowCenter)}</dd>
  <dt>Slices con anotaciones</dt><dd>${annotatedIdxs.length}</dd>
</dl>

<h2>Imágenes Anotadas (${captures.length} slice${captures.length !== 1 ? 's' : ''})</h2>
${sliceSections}

<footer>Generado con TAC Viewer — Visor DICOM Avanzado</footer>
</body></html>`;

        const reportName = research
            ? `reporte_${ResearchMode.getCaseCode() || 'caso'}.html`
            : `reporte_${f.patientID || 'TAC'}.html`;
        this._download(new Blob([html], { type: 'text/html' }), reportName);
        UI.showToast('Reporte exportado', 'success');
    },

    exportMeasurementsJSON() {
        const all = MeasurementStore.getAll();
        if (!all.length) { UI.showToast('No hay mediciones para exportar', 'warning'); return; }
        this._download(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }), 'mediciones.json');
        UI.showToast('Mediciones exportadas como JSON', 'success');
    },

    /* ════════════════════════════════════════════════════════
       Exportación de investigación

       NUNCA incluye nombre, ID, fecha de nacimiento, sexo del
       paciente ni institución: solo el código de caso anonimizado,
       derivado del StudyInstanceUID. Todo el procesamiento ocurre
       en el navegador; estos archivos se escriben en el disco del
       usuario y no se envían a ningún sitio.
       ════════════════════════════════════════════════════════ */

    /** Metadatos técnicos del estudio, sin datos identificativos. */
    _researchMeta() {
        const frames = SeriesPanel.getSeries() || [];
        const f = frames[0] || ViewportLayout.getActive()?.state.frame;
        if (!f) return null;

        const spacing = ResearchCore.sliceSpacing(frames);

        return {
            // Identificación anonimizada
            caseCode:  ResearchMode.getCaseCode() || null,
            studyHash: ResearchMode.getStudyHash() || null,
            readerId:  ResearchMode.getReaderId() || null,

            // Procedencia
            measuredAt:   new Date().toISOString(),
            measuredAtLocal: new Date().toLocaleString('es-ES'),
            appVersion:   APP_VERSION,
            researchMode: ResearchMode.isActive(),
            userAgent:    navigator.userAgent,

            // Metadatos técnicos del DICOM
            dicom: {
                modality:            f.modality || null,
                studyDate:           f.studyDate || null,
                studyTime:           f.studyTime || null,
                acquisitionDate:     f.acquisitionDate || null,
                acquisitionTime:     f.acquisitionTime || null,
                manufacturer:        f.manufacturer || null,
                manufacturerModelName: f.manufacturerModel || null,
                kvp:                 f.kvp ?? null,
                tubeCurrent:         f.tubeCurrent ?? null,
                exposure:            f.exposure ?? null,
                convolutionKernel:   f.convolutionKernel || null,
                protocolName:        f.protocolName || null,
                bodyPart:            f.bodyPart || null,
                seriesDescription:   f.seriesDesc || null,
                studyDescription:    f.studyDesc || null,
                sliceThickness:      f.sliceThickness ?? null,
                spacingBetweenSlices: f.spacingBetweenSlices ?? null,
                pixelSpacing:        f.pixelSpacing || null,
                rows:                f.rows, columns: f.cols,
                rescaleSlope:        f.rescaleSlope,
                rescaleIntercept:    f.rescaleIntercept,
                rescaleSlopeMissing:     !!f.rescaleSlopeMissing,
                rescaleInterceptMissing: !!f.rescaleInterceptMissing,
                pixelPaddingValue:      f.pixelPaddingValue ?? null,
                pixelPaddingRangeLimit: f.pixelPaddingRangeLimit ?? null,
                imageOrientationPatient: f.imageOrientation || null,
                sliceCountInSeries:  frames.length,
            },

            // Espaciado CALCULADO, no el declarado
            computedSpacing: {
                meanMm:      spacing.mean,
                sdMm:        spacing.sd,
                minMm:       spacing.min,
                maxMm:       spacing.max,
                source:      spacing.source,
                irregular:   spacing.irregular,
                overlap:     spacing.overlap,
                warnings:    spacing.warnings,
            },

            threshold: ResearchMode.getThreshold(),
        };
    },

    /** Documento completo de investigación, reimportable. */
    buildResearchDocument() {
        const meta = this._researchMeta();
        if (!meta) return null;

        const results = ResearchPanel.computeResults();
        const frames  = SeriesPanel.getSeries() || [];

        // Todas las ROI con sus estadísticas Y sus coordenadas, para poder
        // repintarlas sobre el mismo estudio en una auditoría.
        const measurements = MeasurementStore.getAll().map(m => {
            const f = frames[m.sliceIndex];
            return {
                ...m,
                // Ancla al corte por SOPInstanceUID: el índice de corte por sí
                // solo no identifica el corte si la serie se recarga distinta.
                sopInstanceUID: f?.sopInstanceUID ?? null,
                instanceNumber: f?.instanceNumber ?? null,
            };
        });

        return {
            format:        'tacv-research',
            formatVersion: 2,
            meta,
            nwu: {
                perSlice: results.perSlice,
                global:   results.global,
            },
            volume: results.volume,
            abc2:   results.abc,
            midlineShift: results.septa,
            midlines:     results.midlines,
            measurements,
            notes: MeasurementStore.getAllNotes(),
        };
    },

    exportResearchJSON() {
        const doc = this.buildResearchDocument();
        if (!doc) { UI.showToast('No hay estudio abierto', 'warning'); return; }
        if (!doc.measurements.length) {
            UI.showToast('No hay mediciones para exportar', 'warning'); return;
        }
        this._warnIfNotResearchMode();

        const name = `tacv_${doc.meta.caseCode || 'caso'}_${
            (doc.meta.readerId || 'lector').replace(/[^\w-]/g, '')}_${this._stamp()}.json`;
        this._download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name);
        UI.showToast('Datos de investigación exportados (JSON)', 'success');
    },

    exportResearchCSV() {
        const doc = this.buildResearchDocument();
        if (!doc) { UI.showToast('No hay estudio abierto', 'warning'); return; }
        this._warnIfNotResearchMode();

        const m = doc.meta;
        const q = (v) => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const num = (v, d = 4) =>
            (v == null || !Number.isFinite(v)) ? '' : Number(v).toFixed(d);

        const lines = [];

        /* ── Bloque 1: estudio ── */
        lines.push('# TACV — Exportación de investigación');
        lines.push('# Datos anonimizados: no contiene nombre ni identificador de paciente.');
        lines.push('');
        lines.push('SECCION,Clave,Valor');
        const studyRows = [
            ['CodigoCaso',            m.caseCode],
            ['HashEstudio',           m.studyHash],
            ['Lector',                m.readerId],
            ['FechaHoraMedicion',     m.measuredAt],
            ['VersionApp',            m.appVersion],
            ['ModoInvestigacion',     m.researchMode ? 'si' : 'NO'],
            ['StudyDate',             m.dicom.studyDate],
            ['AcquisitionTime',       m.dicom.acquisitionTime],
            ['Manufacturer',          m.dicom.manufacturer],
            ['ManufacturerModelName', m.dicom.manufacturerModelName],
            ['KVP',                   m.dicom.kvp],
            ['SliceThickness_mm',     m.dicom.sliceThickness],
            ['SpacingBetweenSlices_mm', m.dicom.spacingBetweenSlices],
            ['EspaciadoCalculado_mm', num(m.computedSpacing.meanMm, 3)],
            ['EspaciadoCalculado_fuente', m.computedSpacing.source],
            ['EspaciadoCalculado_min_mm', num(m.computedSpacing.minMm, 3)],
            ['EspaciadoCalculado_max_mm', num(m.computedSpacing.maxMm, 3)],
            ['CortesNoEquidistantes', m.computedSpacing.irregular ? 'si' : 'no'],
            ['CortesSolapados',       m.computedSpacing.overlap ? 'si' : 'no'],
            ['ConvolutionKernel',     m.dicom.convolutionKernel],
            ['PixelSpacing_mm',       m.dicom.pixelSpacing ? m.dicom.pixelSpacing.join('\\') : ''],
            ['RescaleSlope',          m.dicom.rescaleSlope],
            ['RescaleIntercept',      m.dicom.rescaleIntercept],
            ['RescaleInterceptAusente', m.dicom.rescaleInterceptMissing ? 'si' : 'no'],
            ['PixelPaddingValue',     m.dicom.pixelPaddingValue],
            ['UmbralExclusion_UH_min', m.threshold.huMin],
            ['UmbralExclusion_UH_max', m.threshold.huMax],
        ];
        studyRows.forEach(([k, v]) => lines.push(`ESTUDIO,${q(k)},${q(v)}`));

        /* ── Bloque 2: NWU por corte ── */
        lines.push('');
        lines.push('SECCION,Corte,ParID,LesionMedia_UH,LesionSD_UH,LesionMediana_UH,LesionPixeles,' +
                   'LesionExcluidos,LesionArea_mm2,ContraMedia_UH,ContraSD_UH,ContraMediana_UH,' +
                   'ContraPixeles,ContraExcluidos,ContraArea_mm2,NWU_pct,EspejoAjustado,' +
                   'EspejoDesplazamiento_mm,Umbral_min_UH,Umbral_max_UH');
        for (const s of doc.nwu.perSlice) {
            lines.push([
                'NWU_CORTE', s.sliceIndex + 1, q(s.pairId),
                num(s.lesionMean), num(s.lesionStd), num(s.lesionMedian),
                s.lesionCount, s.lesionExcluded, num(s.lesionAreaMm2, 3),
                num(s.contraMean), num(s.contraStd), num(s.contraMedian),
                s.contraCount, s.contraExcluded, num(s.contraAreaMm2, 3),
                num(s.nwu), s.mirrorAdjusted ? 'si' : 'no', num(s.mirrorOffsetMm, 2),
                s.threshold?.huMin ?? '', s.threshold?.huMax ?? '',
            ].join(','));
        }

        /* ── Bloque 3: resumen global ── */
        const g = doc.nwu.global;
        lines.push('');
        lines.push('SECCION,Clave,Valor');
        [
            ['NWU_global_pct',          num(g.nwu)],
            ['NWU_global_metodo',       'media ponderada por numero de pixeles'],
            ['NWU_global_cortes',       g.slicesUsed],
            ['NWU_global_lesion_UH',    num(g.lesionMean)],
            ['NWU_global_contra_UH',    num(g.contraMean)],
            ['NWU_global_lesion_pixeles', g.lesionCount],
            ['NWU_global_contra_pixeles', g.contraCount],
            ['Volumen_planimetria_mL',  num(doc.volume?.mL, 3)],
            ['Volumen_planimetria_mm3', num(doc.volume?.mm3, 1)],
            ['Volumen_cortes',          doc.volume?.sliceCount ?? ''],
            ['ABC2_A_mm',               num(doc.abc2?.aMm, 2)],
            ['ABC2_B_mm',               num(doc.abc2?.bMm, 2)],
            ['ABC2_C_mm',               num(doc.abc2?.cMm, 2)],
            ['ABC2_mL',                 num(doc.abc2?.mL, 3)],
        ].forEach(([k, v]) => lines.push(`GLOBAL,${q(k)},${q(v)}`));

        for (const w of (doc.volume?.warnings || [])) {
            lines.push(`AVISO,Volumen,${q(w)}`);
        }

        /* ── Bloque 4: desviación de la línea media ── */
        if (doc.midlineShift.length) {
            lines.push('');
            lines.push('SECCION,Corte,Desviacion_mm,Septum_x_px,Septum_y_px');
            for (const s of doc.midlineShift) {
                lines.push(['LINEA_MEDIA_DESV', s.sliceIndex + 1,
                            num(Math.abs(s.shiftMm), 2),
                            num(s.pos?.x, 2), num(s.pos?.y, 2)].join(','));
            }
        }

        /* ── Bloque 5: línea media por corte ── */
        if (doc.midlines.length) {
            lines.push('');
            lines.push('SECCION,Corte,Origen,Anterior_x_px,Anterior_y_px,Posterior_x_px,Posterior_y_px');
            for (const l of doc.midlines) {
                lines.push(['LINEA_MEDIA', l.sliceIndex + 1, q(l.source),
                            num(l.anterior?.x, 2), num(l.anterior?.y, 2),
                            num(l.posterior?.x, 2), num(l.posterior?.y, 2)].join(','));
            }
        }

        /* ── Bloque 6: todas las ROI con estadísticas y coordenadas ── */
        lines.push('');
        lines.push('SECCION,Corte,Tipo,Rol,ParID,Media_UH,SD_UH,Mediana_UH,Min_UH,Max_UH,' +
                   'Pixeles,Excluidos_bajo,Excluidos_alto,Excluidos_padding,Area_medida_mm2,' +
                   'Area_total_mm2,Valor,Unidad,ModoInvestigacion,VersionApp,Coordenadas_px');
        for (const mm of doc.measurements) {
            const st = mm.stats || {};
            let val = '', unit = '';
            switch (mm.type) {
                case 'distance': case 'abc_axis':
                    val = num(mm.distanceMm, 2); unit = 'mm'; break;
                case 'angle': case 'cobb':
                    val = num(mm.angleDeg, 1); unit = 'grados'; break;
                case 'septum':
                    val = num(mm.shiftMm, 2); unit = 'mm'; break;
                case 'text':  val = mm.text || '';  break;
                case 'arrow': val = mm.label || ''; break;
            }
            lines.push([
                'ROI', mm.sliceIndex + 1, q(mm.type), q(mm.role || ''), q(mm.pairId || ''),
                num(st.mean), num(st.std), num(st.median), num(st.min), num(st.max),
                st.count ?? '', st.excludedLow ?? '', st.excludedHigh ?? '',
                st.excludedPadding ?? '',
                num(st.areaMm2, 3), num(st.areaTotalMm2, 3),
                q(val), q(unit),
                mm.researchMode === undefined ? '' : (mm.researchMode ? 'si' : 'no'),
                q(mm.appVersion || ''),
                q(this._coordsOf(mm)),
            ].join(','));
        }

        const name = `tacv_${m.caseCode || 'caso'}_${
            (m.readerId || 'lector').replace(/[^\w-]/g, '')}_${this._stamp()}.csv`;
        // BOM para que Excel reconozca UTF-8 y no rompa los acentos
        this._download(new Blob(['﻿' + lines.join('\r\n')],
                                { type: 'text/csv;charset=utf-8' }), name);
        UI.showToast('Datos de investigación exportados (CSV)', 'success');
    },

    /** Coordenadas de una medición, compactas, en píxeles de imagen. */
    _coordsOf(m) {
        const p = (q) => q ? `${q.x.toFixed(1)} ${q.y.toFixed(1)}` : '';
        switch (m.type) {
            case 'nwu_roi':
            case 'freehand':
                return (m.points || []).map(q => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(';');
            case 'ellipse':
                return `c=${m.cx.toFixed(1)} ${m.cy.toFixed(1)};r=${m.rx.toFixed(1)} ${m.ry.toFixed(1)}`;
            case 'rectangle':
                return `${m.x1.toFixed(1)} ${m.y1.toFixed(1)};${m.x2.toFixed(1)} ${m.y2.toFixed(1)}`;
            case 'midline':
                return `${p(m.anterior)};${p(m.posterior)}`;
            case 'septum':   return p(m.pos);
            case 'text':     return p(m.pos);
            case 'arrow':    return `${p(m.tail)};${p(m.head)}`;
            case 'angle':    return `${p(m.p1)};${p(m.vertex)};${p(m.p2)}`;
            case 'distance':
            case 'abc_axis': return `${p(m.p1)};${p(m.p2)}`;
            case 'cobb':     return `${p(m.line1?.p1)};${p(m.line1?.p2)};` +
                                    `${p(m.line2?.p1)};${p(m.line2?.p2)}`;
            default:         return '';
        }
    },

    _warnIfNotResearchMode() {
        if (!ResearchMode.isActive()) {
            UI.showToast('Atención: el modo investigación está desactivado. La exportación ' +
                         'queda marcada como no controlada.', 'warning', 6000);
        }
    },

    _stamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
               `${p(d.getHours())}${p(d.getMinutes())}`;
    },

    /* ════════════════════════════════════════════════════════
       Exportación del análisis automático

       `format: 'tacv-detector'`, distinto de 'tacv-research', para
       que estos datos NO se puedan confundir nunca con los del
       estudio. La reimportación de investigación rechaza este
       formato, y al revés.
       ════════════════════════════════════════════════════════ */

    buildDetectorDocument() {
        const r = Detector.getResult();
        if (!r) return null;
        const meta = this._researchMeta();
        if (!meta) return null;

        // Se reutiliza el bloque técnico, pero se marca que esto NO es una
        // medición del estudio: el modo investigación estaba apagado por
        // definición, porque el detector no corre con él activo.
        const strip = (c) => ({
            kind: c.kind,
            volumeMl: c.volumeMl, volumeMm3: c.volumeMm3,
            meanHu: c.meanHu, contraMeanHu: c.contraMeanHu, nwu: c.nwu,
            minHu: c.minHu, maxHu: c.maxHu,
            asymMeanHu: c.asymMeanHu ?? null,
            peripheralFraction: c.peripheralFraction ?? null,
            detectedVoxels: c.detectedVoxels, measuredPixels: c.measuredPixels,
            sliceRange: c.sliceRange, sliceCount: c.sliceCount,
            centroid: c.centroid, sideMm: c.sideMm, hemisphereLabel: c.hemisphereLabel,
            threshold: c.threshold,
            flags: (c.flags || []).map(f => ({ code: f.code, text: f.text })),
            perSlice: c.perSlice.map(s => ({
                sliceIndex: s.sliceIndex,
                detectedVoxels: s.detectedVoxels,
                gapMm: s.gapMm, volumeMm3: s.volumeMm3, nwu: s.nwu,
                lesionMean: s.lesion?.mean ?? null, lesionStd: s.lesion?.std ?? null,
                lesionCount: s.lesion?.count ?? 0,
                lesionExcluded: s.lesion?.excludedTotal ?? 0,
                mirrorMean: s.mirror?.mean ?? null, mirrorCount: s.mirror?.count ?? 0,
            })),
        });

        const sc = Detector.aspectsScore();

        return {
            format: 'tacv-detector',
            formatVersion: 1,
            disclaimer: 'Análisis automático de asimetría. NO es un diagnóstico y NO forma ' +
                        'parte del conjunto de datos de investigación. Las cifras describen ' +
                        'densidad y asimetría, no cronología ni etiología.',
            meta: { ...meta, researchMode: false, analyzedAt: r.analyzedAt, elapsedMs: r.ms },
            params: r.params,
            analyzedSlices: r.analyzed,
            spacing: r.spacing,
            candidates: {
                hypodense:  r.ischemia.map(strip),
                hyperdense: r.hemorrhage.map(strip),
            },
            sectorsPerSlice: r.perSlice
                .filter(s => s.analyzed)
                .map(s => ({
                    sliceIndex: s.sliceIndex,
                    midlineSource: s.midlineSource,
                    midlineConfidence: s.midlineConfidence,
                    flagged: (s.sectors || []).filter(x => x.flagged).map(x => ({
                        angFromDeg: x.angFromDeg, angToDeg: x.angToDeg, radBin: x.radBin,
                        deltaHu: x.deltaHu, z: x.z, nwu: x.nwu,
                        hypodenseLabel: x.hypodenseLabel,
                        posMean: x.pos.mean, posCount: x.pos.count,
                        negMean: x.neg.mean, negCount: x.neg.count,
                    })),
                })),
            aspects: {
                measured: sc.measured, affected: sc.affected,
                score: sc.score, complete: sc.complete,
                probeRadiusMm: DetectCore.DEFAULTS.probeRadiusMm,
                regions: sc.regions.map(reg => ({
                    id: reg.id, label: reg.label, level: reg.level,
                    sliceIndex: reg.probe?.sliceIndex ?? null,
                    seed: reg.probe?.seed ?? null,
                    probeMean: reg.probe?.probeStats?.mean ?? null,
                    mirrorMean: reg.probe?.mirrorStats?.mean ?? null,
                    deltaHu: reg.probe?.deltaHu ?? null,
                    z: reg.probe?.z ?? null,
                    nwu: reg.probe?.nwu ?? null,
                    flagged: reg.probe?.flagged ?? null,
                })),
            },
            warnings: r.warnings,
        };
    },

    exportDetectorJSON() {
        const doc = this.buildDetectorDocument();
        if (!doc) { UI.showToast('No hay análisis automático que exportar', 'warning'); return; }
        const name = `tacv_detector_${doc.meta.caseCode || 'caso'}_${this._stamp()}.json`;
        this._download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name);
        UI.showToast('Análisis automático exportado (JSON)', 'success');
    },

    exportDetectorCSV() {
        const doc = this.buildDetectorDocument();
        if (!doc) { UI.showToast('No hay análisis automático que exportar', 'warning'); return; }

        const q = (v) => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const num = (v, d = 3) => (v == null || !Number.isFinite(v)) ? '' : Number(v).toFixed(d);
        const lines = [];

        lines.push('# TACV — Análisis automático de asimetría');
        lines.push('# NO ES UN DIAGNÓSTICO y NO forma parte del conjunto de datos de investigación.');
        lines.push('# Las cifras describen densidad y asimetría, no cronología ni etiología.');
        lines.push('');
        lines.push('SECCION,Clave,Valor');
        [['CodigoCaso', doc.meta.caseCode], ['HashEstudio', doc.meta.studyHash],
         ['FechaHoraAnalisis', doc.meta.analyzedAt], ['VersionApp', doc.meta.appVersion],
         ['ModoInvestigacion', 'NO (el detector no funciona con el modo activo)'],
         ['CortesAnalizados', doc.analyzedSlices.length],
         ['Espaciado_mm', num(doc.spacing?.mean, 3)],
         ['Espaciado_fuente', doc.spacing?.source],
         ['Manufacturer', doc.meta.dicom.manufacturer],
         ['KVP', doc.meta.dicom.kvp],
         ['ConvolutionKernel', doc.meta.dicom.convolutionKernel],
        ].forEach(([k, v]) => lines.push(`ESTUDIO,${q(k)},${q(v)}`));

        lines.push('');
        lines.push('SECCION,Clave,Valor');
        for (const [k, v] of Object.entries(doc.params)) {
            if (k === 'threshold') {
                lines.push(`PARAMETRO,umbral_exclusion_min_UH,${q(v.huMin)}`);
                lines.push(`PARAMETRO,umbral_exclusion_max_UH,${q(v.huMax)}`);
            } else lines.push(`PARAMETRO,${q(k)},${q(v)}`);
        }

        lines.push('');
        lines.push('SECCION,Tipo,Volumen_mL,Media_UH,Contralateral_UH,NWU_pct,Min_UH,Max_UH,' +
                   'Asimetria_UH,FraccionPeriferica,VoxelesDetectados,PixelesMedidos,' +
                   'CorteDesde,CorteHasta,Hemisferio,Marcas');
        for (const kind of ['hypodense', 'hyperdense']) {
            for (const c of doc.candidates[kind]) {
                lines.push([
                    'CANDIDATO', kind === 'hypodense' ? 'hipodensa' : 'hiperdensa',
                    num(c.volumeMl), num(c.meanHu, 2), num(c.contraMeanHu, 2), num(c.nwu, 2),
                    num(c.minHu, 1), num(c.maxHu, 1), num(c.asymMeanHu, 2),
                    num(c.peripheralFraction, 3),
                    c.detectedVoxels, c.measuredPixels,
                    c.sliceRange ? c.sliceRange[0] + 1 : '', c.sliceRange ? c.sliceRange[1] + 1 : '',
                    q(c.hemisphereLabel), q(c.flags.map(f => f.code).join(' ')),
                ].join(','));
            }
        }

        lines.push('');
        lines.push('SECCION,Corte,Angulo_desde,Angulo_hasta,Banda,Delta_UH,z,NWU_pct,LadoHipodenso,' +
                   'Media_pos,N_pos,Media_neg,N_neg');
        for (const s of doc.sectorsPerSlice) {
            for (const f of s.flagged) {
                lines.push(['SECTOR', s.sliceIndex + 1, f.angFromDeg, f.angToDeg, f.radBin + 1,
                            num(f.deltaHu, 2), num(f.z, 2), num(f.nwu, 2), q(f.hypodenseLabel),
                            num(f.posMean, 2), f.posCount, num(f.negMean, 2), f.negCount].join(','));
            }
        }

        lines.push('');
        lines.push('SECCION,Region,Nivel,Corte,Sonda_UH,Espejo_UH,Delta_UH,z,NWU_pct,SuperaUmbral');
        for (const reg of doc.aspects.regions) {
            lines.push(['ASPECTS', q(reg.id), q(reg.level),
                        reg.sliceIndex != null ? reg.sliceIndex + 1 : '',
                        num(reg.probeMean, 2), num(reg.mirrorMean, 2),
                        num(reg.deltaHu, 2), num(reg.z, 2), num(reg.nwu, 2),
                        reg.flagged == null ? '' : (reg.flagged ? 'si' : 'no')].join(','));
        }
        lines.push(`ASPECTS_RESUMEN,regiones_medidas,${doc.aspects.measured}`);
        lines.push(`ASPECTS_RESUMEN,regiones_afectadas,${doc.aspects.affected}`);
        lines.push(`ASPECTS_RESUMEN,recuento,${doc.aspects.score ?? ''}`);
        lines.push(`ASPECTS_RESUMEN,radio_sonda_mm,${doc.aspects.probeRadiusMm}`);

        for (const w of doc.warnings) lines.push(`AVISO,,${q(w)}`);

        const name = `tacv_detector_${doc.meta.caseCode || 'caso'}_${this._stamp()}.csv`;
        this._download(new Blob(['﻿' + lines.join('\r\n')],
                                { type: 'text/csv;charset=utf-8' }), name);
        UI.showToast('Análisis automático exportado (CSV)', 'success');
    },

    /* ════════════════════════════════════════════════════════
       Reimportación para auditoría / segundo lector
       ════════════════════════════════════════════════════════ */

    async importResearchJSON(file) {
        let doc;
        try {
            doc = JSON.parse(await file.text());
        } catch {
            UI.showToast('El archivo no es un JSON válido', 'error'); return;
        }
        if (doc?.format === 'tacv-detector') {
            UI.showToast('Ese archivo es un análisis automático, no una lectura del estudio. ' +
                         'No se puede importar como medición.', 'error', 6000);
            return;
        }
        if (doc?.format !== 'tacv-research' || !Array.isArray(doc.measurements)) {
            UI.showToast('No es una exportación de investigación de TACV', 'error'); return;
        }

        const frames = SeriesPanel.getSeries() || [];
        if (!frames.length) {
            UI.showToast('Abrí primero el estudio sobre el que querés superponer las ROI',
                         'warning', 5000);
            return;
        }

        // Validar que es el MISMO estudio: el hash se deriva del
        // StudyInstanceUID, así que coincide sin exponer el UID.
        const currentHash = ResearchMode.getStudyHash();
        const docHash     = doc.meta?.studyHash;
        if (currentHash && docHash && currentHash !== docHash) {
            const ok = confirm(
                `ATENCIÓN: el archivo pertenece a otro estudio.\n\n` +
                `Archivo:  ${docHash}\n` +
                `Abierto:  ${currentHash}\n\n` +
                `Superponer estas ROI sobre un estudio distinto produce mediciones ` +
                `sin sentido. ¿Continuar de todos modos?`
            );
            if (!ok) { UI.showToast('Importación cancelada', 'info'); return; }
        }

        // Reanclar por SOPInstanceUID cuando sea posible: el índice de corte
        // depende del orden de carga, el UID no.
        const bySop = new Map();
        frames.forEach((f, i) => { if (f.sopInstanceUID) bySop.set(f.sopInstanceUID, i); });

        let imported = 0, remapped = 0, skipped = 0;
        MeasurementStore.clearAll();

        for (const m of doc.measurements) {
            let idx = m.sliceIndex;
            if (m.sopInstanceUID && bySop.has(m.sopInstanceUID)) {
                const mapped = bySop.get(m.sopInstanceUID);
                if (mapped !== idx) remapped++;
                idx = mapped;
            }
            if (idx == null || idx < 0 || idx >= frames.length) { skipped++; continue; }

            const { id, sliceIndex, selected, ...rest } = m;
            MeasurementStore.add(idx, { ...rest, selected: false, importedFrom: file.name });
            imported++;
        }

        // Notas clínicas, si venían
        for (const n of (doc.notes || [])) {
            if (n.sliceIndex >= 0 && n.sliceIndex < frames.length) {
                MeasurementStore.setNote(n.sliceIndex, n.text);
            }
        }

        // Restaurar el umbral del archivo: medir con otro umbral daría otras cifras
        if (doc.meta?.threshold) {
            ResearchMode.setThreshold(doc.meta.threshold);
            const min = document.getElementById('rpHuMin');
            const max = document.getElementById('rpHuMax');
            if (min) min.value = doc.meta.threshold.huMin ?? '';
            if (max) max.value = doc.meta.threshold.huMax ?? '';
        }

        ViewportLayout.getAll().forEach(vp => vp.render());
        if (typeof ResearchPanel !== 'undefined') ResearchPanel.refresh();

        const bits = [`${imported} medición(es) superpuesta(s)`];
        if (remapped) bits.push(`${remapped} reancladas por SOPInstanceUID`);
        if (skipped)  bits.push(`${skipped} descartadas (corte inexistente)`);
        UI.showToast(bits.join(' · '), skipped ? 'warning' : 'success', 6000);

        // Dejar claro de quién son las mediciones que se están viendo
        if (doc.meta?.readerId || doc.meta?.measuredAtLocal) {
            UI.showToast(
                `Mostrando la lectura de ${doc.meta.readerId || 'lector sin ID'} ` +
                `(${doc.meta.measuredAtLocal || doc.meta.measuredAt}, ` +
                `app v${doc.meta.appVersion}${doc.meta.researchMode ? '' : ', SIN modo investigación'})`,
                'info', 8000
            );
        }
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
