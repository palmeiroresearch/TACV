'use strict';

const MetadataPanel = {
    _currentFrame: null,

    /* ── Mostrar info de un frame ────────────────────── */
    show(frame) {
        this._currentFrame = frame;
        this._renderPatientInfo(frame);
        this._renderTagList(frame.allTags || {}, '');
    },

    _renderPatientInfo(frame) {
        const el = document.getElementById('patientInfo');
        const sex = frame.patientSex === 'M' ? '♂' : frame.patientSex === 'F' ? '♀' : '';
        el.innerHTML = `
            <div class="patient-name">${frame.patientName || 'Anónimo'}</div>
            <div class="patient-sub">
                ${frame.patientID ? `<span>ID: ${frame.patientID}</span>` : ''}
                ${frame.patientDOB ? `<span>DOB: ${frame.patientDOB}</span>` : ''}
                ${sex ? `<span>${sex}</span>` : ''}
                <span class="meta-badge">${frame.modality || 'CT'}</span>
            </div>
            ${frame.studyDate ? `<div style="font-size:11px;color:var(--text-tertiary)">Estudio: ${frame.studyDate}</div>` : ''}
            ${frame.studyDesc || frame.seriesDesc ? `<div style="font-size:11px;color:var(--text-tertiary)">${frame.studyDesc || frame.seriesDesc}</div>` : ''}
        `;
        document.getElementById('statusStudy').textContent =
            `${frame.patientName || ''} | ${frame.studyDate || ''}`;
    },

    _renderTagList(allTags, filter) {
        const el = document.getElementById('metaTagList');
        el.innerHTML = '';
        const lf = filter.toLowerCase();

        const knownTags = DICOM_TAGS;

        // Tags conocidos primero, luego el resto
        const keys = Object.keys(allTags).sort((a, b) => {
            const aKnown = !!knownTags[a], bKnown = !!knownTags[b];
            if (aKnown && !bKnown) return -1;
            if (!aKnown && bKnown) return 1;
            return a.localeCompare(b);
        });

        for (const tag of keys) {
            const val  = allTags[tag] || '';
            const name = knownTags[tag] || '';
            if (lf && !name.toLowerCase().includes(lf) && !tag.includes(lf) && !val.toLowerCase().includes(lf)) continue;

            const item = document.createElement('div');
            item.className = 'meta-tag-item';
            item.innerHTML = `
                <span class="meta-tag-key">${tag}</span>
                <span class="meta-tag-val" title="${val}">${val || '—'}</span>
                ${name ? `<span class="meta-tag-name">${name}</span>` : ''}
            `;
            el.appendChild(item);
        }
    },

    /* ── Init (bindings) ─────────────────────────────── */
    init() {
        const searchInput = document.getElementById('metaSearch');
        searchInput.addEventListener('input', (e) => {
            if (this._currentFrame) {
                this._renderTagList(this._currentFrame.allTags || {}, e.target.value);
            }
        });

        const toggle = document.getElementById('metaToggle');
        const panel  = document.getElementById('metadataPanel');
        toggle.addEventListener('click', () => {
            panel.classList.add('collapsed');
            Storage.setSetting('metaPanelOpen', false);
        });

        panel.addEventListener('click', () => {
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                Storage.setSetting('metaPanelOpen', true);
            }
        });

        // Restaurar estado colapsado
        if (!Storage.getSetting('metaPanelOpen')) panel.classList.add('collapsed');
    },
};
