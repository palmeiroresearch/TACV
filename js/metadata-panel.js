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
        const lf = filter.toLowerCase();
        const knownTags = DICOM_TAGS;

        const keys = Object.keys(allTags).sort((a, b) => {
            const aK = !!knownTags[a], bK = !!knownTags[b];
            if (aK && !bK) return -1;
            if (!aK && bK) return 1;
            return a.localeCompare(b);
        });

        // Batch via innerHTML — evita reflow por cada tag
        const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const html = [];
        for (const tag of keys) {
            const val  = allTags[tag] || '';
            const name = knownTags[tag] || '';
            if (lf && !name.toLowerCase().includes(lf) && !tag.includes(lf) && !val.toLowerCase().includes(lf)) continue;
            html.push(
                `<div class="meta-tag-item">` +
                `<span class="meta-tag-key">${esc(tag)}</span>` +
                `<span class="meta-tag-val" title="${esc(val)}">${esc(val) || '—'}</span>` +
                (name ? `<span class="meta-tag-name">${esc(name)}</span>` : '') +
                `</div>`
            );
        }
        el.innerHTML = html.join('');
    },

    /* ── Init (bindings) ─────────────────────────────── */
    init() {
        const searchInput = document.getElementById('metaSearch');
        searchInput?.addEventListener('input', (e) => {
            if (this._currentFrame) {
                this._renderTagList(this._currentFrame.allTags || {}, e.target.value);
            }
        });

        const toggle = document.getElementById('metaToggle');
        const panel  = document.getElementById('metadataPanel');
        if (!toggle || !panel) return;

        const setCollapsed = (collapsed) => {
            panel.classList.toggle('collapsed', collapsed);
            toggle.textContent = collapsed ? '❯' : '✕';
            toggle.title = collapsed ? 'Abrir panel Info DICOM' : 'Cerrar panel';
            Storage.setSetting('metaPanelOpen', !collapsed);
        };

        // Botón toggle: stopPropagation evita que el click suba al panel click listener
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            setCollapsed(!panel.classList.contains('collapsed'));
        });

        // Click en el panel colapsado → reabrir (ya no hay conflicto gracias al stopPropagation)
        panel.addEventListener('click', () => {
            if (panel.classList.contains('collapsed')) setCollapsed(false);
        });

        // En táctiles arrancar siempre colapsado; en PC respetar localStorage
        const isTouch = typeof Capabilities !== 'undefined' && Capabilities.isTouch;
        const shouldCollapse = isTouch ? true : !Storage.getSetting('metaPanelOpen');
        setCollapsed(shouldCollapse);
    },
};
