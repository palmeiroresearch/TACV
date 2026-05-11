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
    },

    _formatValue(m) {
        switch (m.type) {
            case 'distance':  return { val: m.distanceMm?.toFixed(2) ?? '—', unit: 'mm' };
            case 'angle':     return { val: m.angleDeg?.toFixed(1) ?? '—', unit: '°' };
            case 'ellipse':
            case 'rectangle': return { val: m.stats ? `${m.stats.mean}±${m.stats.std}` : '—', unit: 'HU' };
            case 'arrow':     return { val: m.label || '(sin etiqueta)', unit: '' };
            case 'text':      return { val: m.text || '(vacío)', unit: '' };
            default:          return { val: '—', unit: '' };
        }
    },

    _typeLabel(type) {
        return { distance: 'Dist', angle: 'Ángulo', ellipse: 'Elipse', rectangle: 'Rect', arrow: 'Flecha', text: 'Texto' }[type] || type;
    },

    _typeColor(type) {
        return { distance: '#FFD700', angle: '#00CFFF', ellipse: '#FF6B35', rectangle: '#7CFC00', arrow: '#FF69B4', text: '#aaa' }[type] || '#888';
    },
};
