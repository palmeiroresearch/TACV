'use strict';

const MeasurementsPanel = {
    _open: false,

    init() {
        Storage.on('measurementsChanged', () => { if (this._open) this.refresh(); });
    },

    open() {
        const panel = document.getElementById('measurementsPanel');
        if (!panel) return;
        const btn  = document.getElementById('btnMeasurementsPanel');
        const rect = btn?.getBoundingClientRect();
        if (rect) {
            panel.style.top   = (rect.bottom + 6) + 'px';
            panel.style.right = Math.max(4, window.innerWidth - rect.right) + 'px';
            panel.style.left  = 'auto';
        }
        panel.classList.remove('hidden');
        btn?.classList.add('active');
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

        const all = MeasurementStore.getAll();
        if (!all.length) {
            body.innerHTML = '<div class="mp-empty">No hay mediciones en este estudio</div>';
            return;
        }

        const bySlice = new Map();
        all.forEach(m => {
            if (!bySlice.has(m.sliceIndex)) bySlice.set(m.sliceIndex, []);
            bySlice.get(m.sliceIndex).push(m);
        });

        const sortedSlices = [...bySlice.keys()].sort((a, b) => a - b);

        body.innerHTML = sortedSlices.map(sliceIdx => {
            const items = bySlice.get(sliceIdx);
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
            return `
            <div class="mp-slice-header" data-goto="${sliceIdx}">Slice ${sliceIdx + 1} · ${items.length} medición${items.length !== 1 ? 'es' : ''}</div>
            ${rows}`;
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

        // Sección de volumetría (si hay ROI libres)
        const freehandAll = all.filter(m => m.type === 'freehand');
        if (freehandAll.length) this._renderVolumeSection(body, freehandAll);
    },

    _renderVolumeSection(body, freehandAll) {
        const section = document.createElement('div');
        section.className = 'mp-vol-section';

        const rows = freehandAll
            .sort((a, b) => a.sliceIndex - b.sliceIndex)
            .map(m => {
                const area = m.stats?.area != null ? `${m.stats.area} mm²` : '—';
                return `<label class="mp-vol-row">
                    <input type="checkbox" data-vol-id="${m.id}" checked>
                    <span class="mp-vol-slice">Slice ${m.sliceIndex + 1}</span>
                    <span class="mp-vol-area">${area}</span>
                </label>`;
            }).join('');

        section.innerHTML = `
            <div class="mp-vol-title">Volumetría por integración</div>
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
            if (!result) { res.textContent = 'Error calculando volumen'; res.classList.remove('hidden'); return; }

            const mL = result.mL.toFixed(2);
            let html = `<span class="mp-vol-main">${mL} mL</span>
                        <span class="mp-vol-sub">${result.sliceCount} slice${result.sliceCount !== 1 ? 's' : ''} · trapezoidal</span>`;

            // Estimación ABC/2 si es un solo slice (quick estimate)
            if (result.sliceCount === 1) {
                const m = selected[0];
                const f = frames[m.sliceIndex];
                if (f && m.stats) {
                    const [rs, cs] = f.pixelSpacing || [1, 1];
                    const equiv_r  = Math.sqrt(m.stats.area / Math.PI); // radio equivalente en mm
                    const abc2     = (equiv_r * 2 * equiv_r * 2 * (f.sliceThickness || 5)) / 2000;
                    html += `<span class="mp-vol-abc2">ABC/2 ≈ ${abc2.toFixed(1)} mL (1 slice)</span>`;
                }
            }

            res.innerHTML = html;
            res.classList.remove('hidden');
        });
    },

    _formatValue(m) {
        switch (m.type) {
            case 'distance':  return { val: m.distanceMm?.toFixed(2) ?? '—', unit: 'mm' };
            case 'angle':     return { val: m.angleDeg?.toFixed(1) ?? '—', unit: '°' };
            case 'cobb':      return { val: m.angleDeg?.toFixed(1) ?? '—', unit: '° Cobb' };
            case 'ellipse':
            case 'rectangle':
            case 'freehand':  return { val: m.stats ? `${m.stats.mean}±${m.stats.std}` : '—', unit: 'HU' };
            case 'arrow':     return { val: m.label || '(sin etiqueta)', unit: '' };
            case 'text':      return { val: m.text || '(vacío)', unit: '' };
            default:          return { val: '—', unit: '' };
        }
    },

    _typeLabel(type) {
        return { distance: 'Dist', angle: 'Ángulo', ellipse: 'Elipse', rectangle: 'Rect',
                 arrow: 'Flecha', text: 'Texto', cobb: 'Cobb', freehand: 'Libre' }[type] || type;
    },

    _typeColor(type) {
        return { distance: '#FFD700', angle: '#00CFFF', ellipse: '#FF6B35', rectangle: '#7CFC00',
                 arrow: '#FF69B4', text: '#aaa', cobb: '#00E5FF', freehand: '#7CFC00' }[type] || '#888';
    },
};
