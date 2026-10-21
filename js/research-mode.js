'use strict';

/* ============================================================
   ResearchMode — Modo investigación.

   Al activarse:
   · Desactiva y BLOQUEA todo el procesamiento que genera o altera
     valores de píxel (los 6 filtros WebGL, TV denoising y
     superresolución). La ventana/nivel sigue permitida porque no
     altera los valores medidos, solo cómo se mapean a gris.
   · Muestra un indicador permanente en pantalla.
   · Congela el service worker: ni revalidación en segundo plano ni
     banner de actualización sin confirmación explícita.
   · Sella cada medición con la versión exacta de la app, el ID del
     lector y el código de caso anonimizado.

   El estado se guarda en localStorage, así que sobrevive a recargas:
   una sesión de lectura no debe perder el modo por un refresco.
   ============================================================ */

const ResearchMode = {
    STORAGE_KEY: 'tacv_research',

    _active:    false,
    _readerId:  '',
    _caseCode:  '',
    _caseCodeAuto: '',          // derivado del StudyInstanceUID
    _caseCodeManual: false,     // true si el usuario lo sobrescribió
    _threshold: { ...NWU_DEFAULTS },
    _pendingSwUpdate: null,     // registro de SW en espera, si llegó con el modo activo

    /* ════════════════════════════════════════════════════════
       Init
       ════════════════════════════════════════════════════════ */

    init() {
        const saved = this._load();
        this._active         = !!saved.active;
        this._readerId       = saved.readerId  || '';
        this._caseCodeManual = !!saved.caseCodeManual;
        if (this._caseCodeManual) this._caseCode = saved.caseCode || '';
        this._threshold = {
            huMin: saved.threshold?.huMin ?? NWU_DEFAULTS.huMin,
            huMax: saved.threshold?.huMax ?? NWU_DEFAULTS.huMax,
        };

        this._buildIndicator();
        this._wireToggle();

        if (this._active) {
            // Re-aplicar el bloqueo tras una recarga
            this._apply(true, { silent: true });
        } else {
            this._syncToggleUi();
        }
    },

    /* ════════════════════════════════════════════════════════
       Estado
       ════════════════════════════════════════════════════════ */

    isActive()    { return this._active; },
    getReaderId() { return this._readerId; },
    getThreshold(){ return { ...this._threshold }; },

    setReaderId(id) {
        this._readerId = (id || '').trim();
        this._save();
    },

    setThreshold({ huMin, huMax }) {
        // null/'' significa "sin límite por ese lado", no 0.
        const parse = (v) => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        this._threshold = { huMin: parse(huMin), huMax: parse(huMax) };
        this._save();
        return this.getThreshold();
    },

    getCaseCode() { return this._caseCode; },

    setCaseCode(code) {
        const c = (code || '').trim();
        if (!c || c === this._caseCodeAuto) {
            // Volver al derivado automáticamente
            this._caseCodeManual = false;
            this._caseCode = this._caseCodeAuto;
        } else {
            this._caseCodeManual = true;
            this._caseCode = c;
        }
        this._save();
        return this._caseCode;
    },

    /**
     * Deriva un código de caso estable y no reversible del StudyInstanceUID.
     * El mismo estudio da el mismo código para los dos lectores, sin que el
     * código permita recuperar el UID ni ningún dato del paciente.
     * Se calcula en el navegador con crypto.subtle; nada sale del dispositivo.
     */
    async deriveCaseCode(frame) {
        const uid = frame?.studyInstanceUID || frame?.allTags?.['x0020000d'] || '';
        if (!uid) {
            this._caseCodeAuto = '';
            if (!this._caseCodeManual) this._caseCode = '';
            return this._caseCode;
        }
        let hex = '';
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid));
            hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
        } catch {
            // Sin crypto.subtle (contexto no seguro): hash determinista de reserva.
            // Menos resistente a colisiones, pero igualmente no reversible a ojo.
            let h1 = 0x811c9dc5, h2 = 0x01000193;
            for (let i = 0; i < uid.length; i++) {
                h1 = ((h1 ^ uid.charCodeAt(i)) * 0x01000193) >>> 0;
                h2 = ((h2 + uid.charCodeAt(i) * (i + 1)) * 0x85ebca6b) >>> 0;
            }
            hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
        }
        this._caseCodeAuto = 'TACV-' + hex.slice(0, 10);
        if (!this._caseCodeManual) this._caseCode = this._caseCodeAuto;
        this._save();
        return this._caseCode;
    },

    /** Hash del estudio, para validar que un JSON reimportado es del mismo estudio. */
    getStudyHash() { return this._caseCodeAuto; },

    /** Sello de procedencia que se adjunta a cada medición y a la exportación. */
    stamp() {
        return {
            researchMode: this._active,
            appVersion:   APP_VERSION,
            readerId:     this._readerId || null,
            caseCode:     this._caseCode || null,
        };
    },

    /* ════════════════════════════════════════════════════════
       Activación / desactivación
       ════════════════════════════════════════════════════════ */

    toggle() { return this._apply(!this._active); },

    set(on) { return this._apply(!!on); },

    _apply(on, { silent = false } = {}) {
        this._active = on;
        this._save();

        if (on) {
            const turnedOff = this._forceCleanPipeline();
            this._lockFilterUi(true);
            this._freezeServiceWorker(true);
            if (!silent) {
                UI.showToast(
                    turnedOff.length
                        ? `Modo investigación activo — ${turnedOff.length} filtro(s) desactivado(s) y bloqueado(s)`
                        : 'Modo investigación activo — procesamiento bloqueado',
                    'success', 4000
                );
            }
        } else {
            this._lockFilterUi(false);
            this._freezeServiceWorker(false);
            if (!silent) UI.showToast('Modo investigación desactivado', 'info', 2500);
            // Si llegó una actualización mientras estaba activo, ofrecerla ahora
            if (this._pendingSwUpdate) {
                const reg = this._pendingSwUpdate;
                this._pendingSwUpdate = null;
                if (typeof _showUpdateBanner === 'function') _showUpdateBanner(reg);
            }
        }

        this._syncToggleUi();
        this._updateIndicator();
        if (typeof ViewportLayout !== 'undefined') {
            ViewportLayout.getAll().forEach(vp => vp.render());
        }
        Storage.dispatch('researchModeChanged', { active: on });
        return this._active;
    },

    /**
     * Apaga todo el procesamiento que altera valores, en todos los viewports.
     * Se hace en el estado directamente (no vía toggleFilter) porque esos
     * métodos ya rechazan cambios con el modo activo.
     */
    _forceCleanPipeline() {
        const turnedOff = [];
        if (typeof ViewportLayout === 'undefined') return turnedOff;

        ViewportLayout.getAll().forEach(vp => {
            for (const key of RESEARCH_BLOCKED_FILTERS) {
                if (vp.state[key]) {
                    vp.state[key] = false;
                    if (!turnedOff.includes(key)) turnedOff.push(key);
                }
            }
            // Limpiar la caché de TV: si quedara, un render podría usarla
            vp._tvDenoisedPixels = null;
            vp._tvBusy = false;
        });

        // Sincronizar los controles de la interfaz con el estado real
        for (const id of Object.values(RESEARCH_FILTER_CHECKBOXES)) {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        }
        ['paramsUsm', 'paramsBilateral', 'paramsAniso', 'paramsClahe', 'paramsRetinex']
            .forEach(id => document.getElementById(id)?.classList.remove('visible'));
        for (const id of Object.values(RESEARCH_BLOCKED_BUTTONS)) {
            document.getElementById(id)?.classList.remove('on');
        }
        return turnedOff;
    },

    /** Deshabilita o rehabilita los controles de procesamiento. */
    _lockFilterUi(lock) {
        for (const id of Object.values(RESEARCH_FILTER_CHECKBOXES)) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.disabled = lock;
            el.closest('.fp-section')?.classList.toggle('fp-locked', lock);
        }
        // Sliders de parámetros de filtro
        document.querySelectorAll('#filtersPanel input[type="range"]').forEach(sl => {
            sl.disabled = lock;
        });
        document.querySelectorAll('#filtersPanel input[name="anisoFunc"]').forEach(r => {
            r.disabled = lock;
        });

        for (const id of Object.values(RESEARCH_BLOCKED_BUTTONS)) {
            const btn = document.getElementById(id);
            if (!btn) continue;
            btn.classList.toggle('research-locked', lock);
            btn.disabled = lock;
        }

        // Aviso dentro del panel de filtros
        let note = document.getElementById('fpResearchNote');
        if (lock && !note) {
            const panel = document.getElementById('filtersPanel');
            if (panel) {
                note = document.createElement('div');
                note.id = 'fpResearchNote';
                note.className = 'fp-research-note';
                note.textContent = 'Modo investigación activo: el procesamiento está bloqueado ' +
                                   'para preservar los valores originales. La ventana/nivel sigue disponible.';
                panel.insertBefore(note, panel.children[1] || null);
            }
        } else if (!lock && note) {
            note.remove();
        }
    },

    /* ════════════════════════════════════════════════════════
       Service worker
       ════════════════════════════════════════════════════════ */

    /**
     * Con el modo activo, el SW deja de revalidar en segundo plano. Sin esto,
     * la estrategia cache-first reescribe la caché en silencio y la siguiente
     * recarga cambia el código de la app a mitad de una sesión de medición.
     */
    _freezeServiceWorker(freeze) {
        const msg = { type: freeze ? 'RESEARCH_FREEZE' : 'RESEARCH_UNFREEZE' };
        if (!('serviceWorker' in navigator)) return;

        // Enviar al controlador actual si ya existe…
        try { navigator.serviceWorker.controller?.postMessage(msg); } catch {}

        // …y de nuevo cuando el registro esté listo. Al restaurar el modo
        // desde localStorage al arrancar, el SW todavía no controla la página
        // y el primer mensaje se perdería: la congelación no se aplicaría.
        navigator.serviceWorker.ready
            .then((reg) => { (reg.active || navigator.serviceWorker.controller)?.postMessage(msg); })
            .catch(() => {});
    },

    /** Llamado por app.js cuando hay un SW nuevo esperando. */
    deferSwUpdate(registration) {
        if (!this._active) return false;
        this._pendingSwUpdate = registration;
        UI.showToast(
            'Hay una actualización disponible. No se aplicará mientras el modo ' +
            'investigación esté activo.', 'warning', 6000
        );
        return true;
    },

    /* ════════════════════════════════════════════════════════
       Interfaz
       ════════════════════════════════════════════════════════ */

    _wireToggle() {
        document.getElementById('btnResearchMode')?.addEventListener('click', () => this.toggle());
    },

    _syncToggleUi() {
        const btn = document.getElementById('btnResearchMode');
        if (btn) {
            btn.classList.toggle('on', this._active);
            btn.setAttribute('aria-pressed', String(this._active));
            btn.title = this._active
                ? 'Modo investigación ACTIVO — procesamiento bloqueado. Clic para desactivar.'
                : 'Modo investigación — bloquea todo el procesamiento que altera valores de píxel';
        }
        document.body.classList.toggle('research-mode', this._active);
    },

    _buildIndicator() {
        if (document.getElementById('researchIndicator')) return;
        const el = document.createElement('div');
        el.id = 'researchIndicator';
        el.className = 'research-indicator hidden';
        el.innerHTML =
            '<span class="ri-dot"></span>' +
            '<span class="ri-text">MODO INVESTIGACIÓN</span>' +
            '<span class="ri-sub" id="riSub"></span>';
        document.body.appendChild(el);
    },

    _updateIndicator() {
        const el = document.getElementById('researchIndicator');
        if (!el) return;
        el.classList.toggle('hidden', !this._active);
        const sub = document.getElementById('riSub');
        if (sub) {
            const bits = [`v${APP_VERSION}`, 'sin procesamiento'];
            if (this._caseCode) bits.unshift(this._caseCode);
            if (this._readerId) bits.push(`lector ${this._readerId}`);
            sub.textContent = bits.join(' · ');
        }
    },

    /** Refresca el indicador cuando cambia el caso o el lector. */
    refresh() { this._updateIndicator(); },

    /* ════════════════════════════════════════════════════════
       Persistencia
       ════════════════════════════════════════════════════════ */

    _load() {
        try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}'); }
        catch { return {}; }
    },

    _save() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                active:         this._active,
                readerId:       this._readerId,
                caseCode:       this._caseCode,
                caseCodeManual: this._caseCodeManual,
                threshold:      this._threshold,
            }));
        } catch { /* localStorage lleno o bloqueado: el modo sigue activo en memoria */ }
        this._updateIndicator();
    },

    /**
     * Guarda para una medición: usado por las herramientas al crear ROI.
     * Si el modo NO está activo se marca explícitamente como false, no se
     * omite: la ausencia del campo sería ambigua al auditar.
     */
    annotate(measurement) {
        return { ...measurement, ...this.stamp(), measuredAt: new Date().toISOString() };
    },
};
