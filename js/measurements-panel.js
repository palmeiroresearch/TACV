'use strict';

const MeasurementsPanel = {
    _open: false,

    init() {
        Storage.on('measurementsChanged', () => { if (this._open) this.refresh(); });
    },

    open() {
        const panel = document.getElementById('measurementsPanel');
        if (!panel) return;
        // Con el botón oculto por el personalizador, el atajo M abría el panel
        // fuera de la pantalla: anchorPanel cae a una esquina si no hay ancla.
        UI.anchorPanel(panel, ['btnMeasurementsPanel']);
        panel.classList.remove('hidden');
        document.getElementById('btnMeasurementsPanel')?.classList.add('active');
        this._open = true;
        this.refresh();
    },

    close() {
        document.getElementById('measurementsPanel')?.classList.add('hidden');
        document.getElementById('btnMeasurementsPanel')?.classList.remove('active');
        this._open = false;
    },

    toggle() { this._open ? this.close() : this.open(); },

    refresh() {
        const body = document.getElementById('mpBody');
        if (!body) return;

        const all   = MeasurementStore.getAll();
        const notes = MeasurementStore.getAllNotes();

        if (!all.length && !notes.length) {
            body.innerHTML = '<div class="mp-empty">No hay mediciones en este estudio</div>';
            return;
        }

        // Unión de slices con mediciones y slices con notas
        const bySlice = new Map();
        all.forEach(m => {
            if (!bySlice.has(m.sliceIndex)) bySlice.set(m.sliceIndex, []);
            bySlice.get(m.sliceIndex).push(m);
        });
        notes.forEach(n => { if (!bySlice.has(n.sliceIndex)) bySlice.set(n.sliceIndex, []); });

        const sortedSlices = [...bySlice.keys()].sort((a, b) => a - b);

        body.innerHTML = sortedSlices.map(sliceIdx => {
            const items = bySlice.get(sliceIdx) || [];
            const note  = MeasurementStore.getNote(sliceIdx);
            const badge = note ? ' <span class="mp-note-badge" title="Tiene nota clínica">📝</span>' : '';

            const rows = items.map(m => {
                const { val, unit } = this._formatValue(m);
                const label = this._typeLabel(m.type);
                const color = this._typeColor(m.type);
                return `
                <div class="mp-row">
                    <span class="mp-badge" style="background:${color}"></span>
                    <span class="mp-type">${label}</span>
                    <span class="mp-value" title="${val} ${unit}">${val} ${unit}</span>
                    <span class="mp-actions">
                        <button class="mp-btn" data-goto="${sliceIdx}" title="Ir al slice">→</button>
                        <button class="mp-btn delete" data-del="${m.id}" title="Eliminar">✕</button>
                    </span>
                </div>`;
            }).join('');

            const noteText = this._escapeHtml(note?.text ?? '');
            const charCount = (note?.text ?? '').length;
            const clearBtn = note ? `<button class="mp-note-clear" data-note-clear="${sliceIdx}">× borrar</button>` : '';
            const noteArea = `
            <div class="mp-note-area" data-note-slice="${sliceIdx}">
                <textarea class="mp-note-textarea" data-note-slice="${sliceIdx}"
                    placeholder="Nota clínica para este slice…" rows="3">${noteText}</textarea>
                <div class="mp-note-footer">
                    <span class="mp-note-counter" data-note-counter="${sliceIdx}">${charCount} car.</span>
                    ${clearBtn}
                </div>
            </div>`;

            const count = items.length;
            const countLabel = count ? ` · ${count} medición${count !== 1 ? 'es' : ''}` : '';
            return `
            <div class="mp-slice-header" data-goto="${sliceIdx}">Slice ${sliceIdx + 1}${countLabel}${badge}</div>
            ${rows}
            ${noteArea}`;
        }).join('');

        body.querySelectorAll('[data-goto]').forEach(el => {
            el.addEventListener('click', () => SeriesPanel.jumpTo(parseInt(el.dataset.goto)));
        });
        body.querySelectorAll('[data-del]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                MeasurementStore.delete(parseInt(el.dataset.del));
                ViewportLayout.getActive()?.render();
            });
        });

        this._bindNoteEvents(body);

        // Sección de volumetría (si hay ROI libres)
        const freehandAll = all.filter(m => m.type === 'freehand');
        if (freehandAll.length) this._renderVolumeSection(body, freehandAll);
    },

    _bindNoteEvents(body) {
        body.querySelectorAll('textarea[data-note-slice]').forEach(ta => {
            const sliceIdx = parseInt(ta.dataset.noteSlice);

            // Solo actualizar el contador durante la escritura — sin guardar ni re-renderizar.
            // Guardar durante el input dispara refresh() → body.innerHTML se reconstruye
            // → el textarea se destruye → foco perdido a los ~600ms.
            ta.addEventListener('input', () => {
                const counter = body.querySelector(`[data-note-counter="${sliceIdx}"]`);
                if (counter) counter.textContent = `${ta.value.length} car.`;
            });

            // Guardar al salir del textarea (foco ya perdido → refresh() no interfiere)
            ta.addEventListener('blur', () => {
                MeasurementStore.setNote(sliceIdx, ta.value);
                ViewportLayout.getActive()?.render();
            });

            ta.addEventListener('keydown', (e) => e.stopPropagation());
        });

        body.querySelectorAll('[data-note-clear]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                MeasurementStore.setNote(parseInt(btn.dataset.noteClear), '');
                ViewportLayout.getActive()?.render();
            });
        });
    },

    _escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    _renderVolumeSection(body, freehandAll) {
        const section = document.createElement('div');
        section.className = 'mp-vol-section';
        const n1 = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(1);

        const rows = freehandAll
            .sort((a, b) => a.sliceIndex - b.sliceIndex)
            .map(m => {
                const a = m.stats?.areaTotalMm2 ?? m.stats?.area;
                return `<label class="mp-vol-row">
                    <input type="checkbox" data-vol-id="${m.id}" checked>
                    <span class="mp-vol-slice">Slice ${m.sliceIndex + 1}</span>
                    <span class="mp-vol-area">${n1(a)} mm²</span>
                </label>`;
            }).join('');

        section.innerHTML = `
            <div class="mp-vol-title">Volumen por planimetría</div>
            <div class="mp-vol-rows">${rows}</div>
            <button class="mp-vol-btn" id="btnCalcVolume">Calcular Volumen</button>
            <div class="mp-vol-result hidden" id="mpVolResult"></div>`;

        body.appendChild(section);

        section.querySelector('#btnCalcVolume').addEventListener('click', () => {
            const checked = [...section.querySelectorAll('input[data-vol-id]:checked')]
                .map(cb => parseInt(cb.dataset.volId));
            if (!checked.length) return;

            const selected = freehandAll.filter(m => checked.includes(m.id));
            const frames   = SeriesPanel.getSeries();
            const result   = MeasurementStore.computeVolume(selected, frames);
            const res      = section.querySelector('#mpVolResult');
            if (!result) {
                res.textContent = 'Error calculando volumen';
                res.classList.remove('hidden');
                return;
            }

            const sp = result.spacing;
            let html = `<span class="mp-vol-main">${result.mL.toFixed(2)} mL</span>
                <span class="mp-vol-sub">${result.sliceCount} slice${
                    result.sliceCount !== 1 ? 's' : ''} · espaciado ${n1(sp?.mean)} mm (${
                    sp?.source === 'ImagePositionPatient' ? 'ImagePositionPatient' : sp?.source})</span>`;

            /* ── Ayudante ABC/2 ──────────────────────────────────
               A y B las mide el usuario con la herramienta de ejes en el
               corte de mayor área; C se deriva de los cortes con lesión.
               La estimación por radio equivalente que había antes no era
               ABC/2: suponía la lesión circular y usaba SliceThickness. */
            const axes  = MeasurementStore.getAll().filter(m => m.type === 'abc_axis');
            const lastA = [...axes].reverse().find(m => m.axis === 'A');
            const lastB = [...axes].reverse().find(m => m.axis === 'B');
            const sliceIdxs = [...new Set(selected.map(m => m.sliceIndex))].sort((a, b) => a - b);
            const cInfo = ResearchCore.deriveC(sliceIdxs, frames);

            // Corte donde deben medirse A y B
            let bigIdx = null, bigArea = -1;
            for (const m of selected) {
                const a = m.stats?.areaTotalMm2 ?? m.stats?.area ?? 0;
                if (a > bigArea) { bigArea = a; bigIdx = m.sliceIndex; }
            }

            if (lastA && lastB && cInfo.cMm != null) {
                const abc = ResearchCore.abc2(lastA.distanceMm, lastB.distanceMm, cInfo.cMm);
                html += `<span class="mp-vol-abc2">ABC/2 = ${abc.mL.toFixed(2)} mL
                    <span class="mp-vol-dim">A ${n1(lastA.distanceMm)} × B ${
                        n1(lastB.distanceMm)} × C ${n1(cInfo.cMm)} mm</span></span>`;
            } else {
                html += `<span class="mp-vol-abc2 mp-vol-pending">ABC/2: medí A y B con la
                    herramienta de ejes (tecla B)${bigIdx != null
                        ? ` en el corte de mayor área (slice ${bigIdx + 1})` : ''}.
                    ${lastA ? `A = ${n1(lastA.distanceMm)} mm ya medida. ` : ''}
                    C se deriva de los ${sliceIdxs.length} corte(s) con lesión${
                        cInfo.cMm != null ? ` → ${n1(cInfo.cMm)} mm` : ''}.</span>`;
            }

            for (const w of (result.warnings || [])) {
                html += `<span class="mp-vol-warn">${this._escapeHtml(w)}</span>`;
            }

            res.innerHTML = html;
            res.classList.remove('hidden');
        });
    },

    _formatValue(m) {
        // Las estadísticas se guardan con precisión completa; aquí se redondea
        // solo para mostrar.
        const n1 = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(1);
        switch (m.type) {
            case 'distance':  return { val: m.distanceMm?.toFixed(2) ?? '—', unit: 'mm' };
            case 'angle':     return { val: m.angleDeg?.toFixed(1) ?? '—', unit: '°' };
            case 'cobb':      return { val: m.angleDeg?.toFixed(1) ?? '—', unit: '° Cobb' };
            case 'ellipse':
            case 'rectangle':
            case 'freehand':  return { val: m.stats?.mean != null
                                  ? `${n1(m.stats.mean)}±${n1(m.stats.std)}` : '—', unit: 'HU' };
            case 'nwu_roi':   return { val: m.stats?.mean != null
                                  ? `${m.role === 'lesion' ? 'L' : 'C'} ${n1(m.stats.mean)}±${n1(m.stats.std)}` +
                                    (m.stats.excludedTotal ? ` (−${m.stats.excludedTotal})` : '')
                                  : '—', unit: 'HU' };
            case 'midline':   return { val: m.source === 'auto' ? 'auto (revisar)'
                                  : (m.source === 'auto-adjusted' ? 'auto corregida' : 'manual'), unit: '' };
            case 'septum':    return { val: n1(Math.abs(m.shiftMm)), unit: 'mm desv.' };
            case 'abc_axis':  return { val: `${m.axis} ${n1(m.distanceMm)}`, unit: 'mm' };
            case 'arrow':     return { val: m.label || '(sin etiqueta)', unit: '' };
            case 'text':      return { val: m.text || '(vacío)', unit: '' };
            default:          return { val: '—', unit: '' };
        }
    },

    _typeLabel(type) {
        return { distance: 'Dist', angle: 'Ángulo', ellipse: 'Elipse', rectangle: 'Rect',
                 arrow: 'Flecha', text: 'Texto', cobb: 'Cobb', freehand: 'Libre',
                 nwu_roi: 'NWU', midline: 'Línea media', septum: 'Septum',
                 abc_axis: 'Eje ABC' }[type] || type;
    },

    _typeColor(type) {
        return { distance: '#FFD700', angle: '#00CFFF', ellipse: '#FF6B35', rectangle: '#7CFC00',
                 arrow: '#FF69B4', text: '#aaa', cobb: '#00E5FF', freehand: '#7CFC00',
                 nwu_roi: '#FF5252', midline: '#00FF9D', septum: '#E040FB',
                 abc_axis: '#FFD700' }[type] || '#888';
    },
};
