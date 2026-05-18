'use strict';

/* ============================================================
   SeriesManager — Gestiona múltiples series DICOM cargadas
   en la sesión. Permite cambiar entre ellas sin perder las
   otras que ya están en memoria.
   ============================================================ */

const SeriesManager = {
    _series:    [],    // [{ uid, name, frames[], date, modality }]
    _activeIdx: 0,

    /* ── Agregar una nueva serie ─────────────────────── */
    add(frames) {
        if (!frames?.length) return;
        const first = frames[0];
        const uid   = first.sopInstanceUID?.slice(0, 20) ||
                      `series_${Date.now()}_${this._series.length}`;
        // Usar SeriesInstanceUID si disponible (tag x0020000e)
        const seriesUid = first.allTags?.['x0020000e'] || uid;

        // Evitar duplicado
        const existing = this._series.findIndex(s => s.uid === seriesUid);
        if (existing !== -1) {
            this._series[existing].frames = frames;
            return existing;
        }

        const name = first.seriesDesc || first.studyDesc ||
                     `Serie ${this._series.length + 1}`;
        this._series.push({
            uid:      seriesUid,
            name:     name.slice(0, 30),
            frames,
            date:     first.studyDate || '',
            modality: first.modality  || 'CT',
            patient:  first.patientName || 'Anónimo',
        });
        return this._series.length - 1;
    },

    setActive(idx) {
        if (idx < 0 || idx >= this._series.length) return;
        this._activeIdx = idx;
        Storage.dispatch('seriesChanged', { idx, series: this._series[idx] });
    },

    clear() { this._series = []; this._activeIdx = 0; },

    removeActive() {
        if (!this._series.length) return;
        this._series.splice(this._activeIdx, 1);
        this._activeIdx = Math.max(0, Math.min(this._activeIdx, this._series.length - 1));
    },

    getActive()    { return this._series[this._activeIdx] || null; },
    getAll()       { return this._series; },
    getCount()     { return this._series.length; },
    getActiveIdx() { return this._activeIdx; },

    /* ── Renderiza el selector en el panel de thumbnails ── */
    renderTabs() {
        let bar = document.getElementById('seriesTabBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'seriesTabBar';
            bar.className = 'series-tab-bar';
            const panel = document.getElementById('seriesPanel');
            panel?.insertBefore(bar, panel.firstChild);
        }

        if (this._series.length <= 1) { bar.classList.add('hidden'); return; }
        bar.classList.remove('hidden');

        bar.innerHTML = this._series.map((s, i) => `
            <button class="series-tab${i === this._activeIdx ? ' active' : ''}"
                    data-idx="${i}" title="${s.patient} — ${s.name}">
                <span class="series-tab-num">${i + 1}</span>
                <span class="series-tab-name">${s.name}</span>
            </button>`).join('');

        bar.querySelectorAll('.series-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                SeriesManager.setActive(idx);
            });
        });
    },
};
