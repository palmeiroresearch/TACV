'use strict';

/* ============================================================
   DetectorPanel — resultados del análisis automático.

   Habla en cifras, no en diagnósticos: «región hipodensa,
   14,2 mL, ΔUH −7,2, NWU 18 %», nunca «infarto». El lenguaje
   diagnóstico convertiría la app en producto sanitario y es
   indefendible en revisión por pares; una cifra con su método, no.
   ============================================================ */

const DetectorPanel = {
    _open: false,

    init() {
        const btn = document.getElementById('btnDetectorPanel');
        btn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
        document.getElementById('dpClose')?.addEventListener('click', () => this.close());
        document.getElementById('dpExportCsv')?.addEventListener('click',  () => Export.exportDetectorCSV());
        document.getElementById('dpExportJson')?.addEventListener('click', () => Export.exportDetectorJSON());
        Storage.on('measurementsChanged', () => { if (this._open) this.refresh(); });
        Storage.on('researchModeChanged', () => { if (this._open) this.refresh(); });
    },

    open() {
        const panel = document.getElementById('detectorPanel');
        if (!panel) return;
        // Si el usuario puso solo el botón de análisis y no el del panel, hay
        // que anclarse al que tenga en la barra.
        UI.anchorPanel(panel, ['btnDetectorPanel', 'btnDetector']);
        panel.classList.remove('hidden');
        document.getElementById('btnDetectorPanel')?.classList.add('active');
        this._open = true;
        this.refresh();
    },

    close() {
        document.getElementById('detectorPanel')?.classList.add('hidden');
        document.getElementById('btnDetectorPanel')?.classList.remove('active');
        this._open = false;
    },

    toggle() { this._open ? this.close() : this.open(); },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    refresh() {
        const body = document.getElementById('dpBody');
        if (!body) return;

        const n1  = (v, d = 1) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d);
        const pct = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(1) + ' %';

        /* ── Bloqueado por modo investigación ── */
        if (Detector.isBlocked()) {
            body.innerHTML = `
                <div class="dp-blocked">
                  <div class="dp-blocked-title">No disponible en modo investigación</div>
                  <p>Ver una región marcada antes de medirla contamina la medición: la ROI
                     deja de ser una observación independiente y el estudio pierde validez.</p>
                  <p>El análisis automático es una herramienta clínica y de cribado, separada
                     del estudio. Desactivá el modo investigación para usarlo.</p>
                </div>`;
            return;
        }

        const vp = ViewportLayout.getActive();
        const z  = vp?.state.sliceIndex ?? 0;
        const r  = Detector.getResult();

        /* ── Sin análisis todavía ── */
        if (!r) {
            const confirmed = Detector.isMidlineConfirmed(z);
            const mid = MeasurementStore.getMidline(z);
            body.innerHTML = `
                <div class="dp-section">
                  <div class="dp-section-title">Antes de analizar</div>
                  <div class="dp-step ${mid ? 'done' : ''}">
                    <span>1. Línea media del corte ${z + 1}</span>
                    <strong>${mid ? (mid.source === 'manual' ? 'manual'
                          : mid.source === 'auto-adjusted' ? 'automática corregida'
                          : 'automática sin revisar') : 'sin definir'}</strong>
                  </div>
                  <div class="dp-step ${confirmed ? 'done' : ''}">
                    <span>2. Confirmación</span>
                    <strong>${confirmed ? 'confirmada' : 'pendiente'}</strong>
                  </div>
                  <div class="dp-actions">
                    <button class="dp-btn" id="dpEstimate">Estimar línea media</button>
                    <button class="dp-btn" id="dpManual">Definir a mano</button>
                    <button class="dp-btn ${mid && !confirmed ? 'primary' : ''}"
                            id="dpConfirm" ${mid ? '' : 'disabled'}>Confirmar</button>
                  </div>
                  <div class="dp-hint">La confirmación es obligatoria: tres grados de error en
                    la línea media bastan para producir un mapa de asimetría falso en todo el
                    cerebro, incluso en un cerebro perfectamente simétrico.</div>
                  <div class="dp-actions">
                    <button class="dp-btn primary" id="dpRun" ${confirmed ? '' : 'disabled'}>
                      ${Detector.isRunning() ? 'Analizando…' : 'Analizar la serie'}</button>
                  </div>
                </div>
                ${this._limitsHtml()}`;
            this._wireSetup(vp, z);
            return;
        }

        /* ── Resultados ── */
        const cand = (c, kind, idx) => {
            const hypo = kind === 'hypodense';
            return `
            <div class="dp-cand ${hypo ? 'hypo' : 'hyper'}">
              <div class="dp-cand-head">
                <span class="dp-cand-kind">${hypo ? 'Región hipodensa' : 'Región hiperdensa'}</span>
                <span class="dp-cand-vol">${n1(c.volumeMl, 2)} mL</span>
              </div>
              <div class="dp-kv"><span>Media medida</span><strong>${n1(c.meanHu)} UH</strong></div>
              ${hypo ? `
              <div class="dp-kv"><span>Contralateral</span><strong>${n1(c.contraMeanHu)} UH</strong></div>
              <div class="dp-kv"><span>NWU</span><strong>${pct(c.nwu)}</strong></div>
              <div class="dp-kv"><span>Asimetría media</span><strong>${n1(c.asymMeanHu)} UH</strong></div>`
              : `<div class="dp-kv"><span>Máximo</span><strong>${n1(c.maxHu, 0)} UH</strong></div>
                 <div class="dp-kv"><span>Fracción periférica</span>
                   <strong>${Math.round((c.peripheralFraction ?? 0) * 100)} %</strong></div>`}
              <div class="dp-kv"><span>Hemisferio</span><strong>${c.hemisphereLabel ?? '—'}</strong></div>
              <div class="dp-kv"><span>Cortes</span>
                <strong>${c.sliceRange ? `${c.sliceRange[0] + 1}–${c.sliceRange[1] + 1}` : '—'}</strong>
                <span class="dp-dim">${c.sliceCount} con lesión</span></div>
              <div class="dp-kv"><span>Píxeles medidos</span><strong>${c.measuredPixels ?? '—'}</strong>
                <span class="dp-dim">de ${c.detectedVoxels} detectados</span></div>
              ${(c.flags || []).map(f =>
                  `<div class="dp-flag">${this._esc(f.text)}</div>`).join('')}
              <div class="dp-actions">
                <button class="dp-btn" data-goto="${c.sliceRange ? c.sliceRange[0] : 0}">Ir al corte</button>
                <button class="dp-btn" data-accept="${kind}:${idx}">Aceptar como ROI</button>
              </div>
            </div>`;
        };

        const sliceInfo = r.perSlice.find(s => s.sliceIndex === z);
        const flagged = (sliceInfo?.sectors || []).filter(s => s.flagged);

        const sectorRows = flagged.length ? `
            <table class="dp-table">
              <thead><tr><th>Sector</th><th>ΔUH</th><th>z</th><th>Lado</th></tr></thead>
              <tbody>${flagged.map(s => `
                <tr><td>${s.angFromDeg}–${s.angToDeg}° · banda ${s.radBin + 1}</td>
                    <td>${n1(s.deltaHu, 2)}</td>
                    <td>${n1(s.z, 1)}</td>
                    <td>${s.hypodenseLabel ?? '—'}</td></tr>`).join('')}
              </tbody>
            </table>`
            : `<div class="dp-empty">Ningún sector supera el umbral en el corte ${z + 1}.</div>`;

        const sc = Detector.aspectsScore();
        const aspectsRows = sc.regions.map(reg => {
            const p = reg.probe;
            return `<tr class="${p?.flagged ? 'dp-row-flag' : ''}">
                <td>${reg.label}</td>
                <td>${p ? n1(p.probeStats?.mean) : '—'}</td>
                <td>${p ? n1(p.mirrorStats?.mean) : '—'}</td>
                <td>${p ? n1(p.deltaHu, 2) : '—'}</td>
                <td>${p ? n1(p.z, 1) : '—'}</td>
                <td>${p ? '' : `<button class="dp-btn-mini" data-probe="${reg.id}">marcar</button>`}</td>
            </tr>`;
        }).join('');

        body.innerHTML = `
            <div class="dp-section">
              <div class="dp-section-title">Vista</div>
              <div class="dp-actions">
                ${['asymmetry', 'sectors', 'off'].map(m => `
                  <button class="dp-btn ${Detector.mode === m ? 'active' : ''}" data-mode="${m}">
                    ${{ asymmetry: 'Asimetría', sectors: 'Sectores', off: 'Sin overlay' }[m]}
                  </button>`).join('')}
              </div>
              <div class="dp-slider-row">
                <span>Opacidad</span>
                <input type="range" id="dpOpacity" min="0" max="100"
                       value="${Math.round(Detector.opacity * 100)}">
                <span id="dpOpacityVal">${Math.round(Detector.opacity * 100)} %</span>
              </div>
              <div class="dp-legend">
                <span class="dp-sw hypo"></span> más hipodenso que el contralateral
                <span class="dp-dim">· solo se tiñe el lado hipodenso</span>
              </div>
            </div>

            <div class="dp-section">
              <div class="dp-section-title">
                Regiones candidatas
                <span class="dp-dim">${r.ischemia.length} hipodensa(s) · ${r.hemorrhage.length} hiperdensa(s)</span>
              </div>
              ${r.ischemia.map((c, i) => cand(c, 'hypodense', i)).join('')}
              ${r.hemorrhage.map((c, i) => cand(c, 'hyperdense', i)).join('')}
              ${(!r.ischemia.length && !r.hemorrhage.length)
                  ? '<div class="dp-empty">Sin regiones candidatas por encima de los umbrales.</div>' : ''}
            </div>

            <div class="dp-section">
              <div class="dp-section-title">Sectores del corte ${z + 1}
                <span class="dp-dim">18 pares, espejados por construcción</span></div>
              ${sectorRows}
              <div class="dp-hint">Un sector se marca cuando ΔUH y |z| superan umbral a la vez:
                a 2–6 UH el ΔUH por sí solo no distingue señal de ruido.</div>
            </div>

            <div class="dp-section">
              <div class="dp-section-title">Sondas ASPECTS
                <span class="dp-dim">${sc.measured}/10 regiones medidas</span></div>
              ${sc.measured ? `<div class="dp-score">
                  <span class="dp-score-main">${sc.score ?? '—'}</span>
                  <span class="dp-score-sub">recuento tipo ASPECTS ·
                    ${sc.affected} región(es) por encima de umbral
                    ${sc.complete ? '' : '· incompleto'}</span></div>` : ''}
              <table class="dp-table">
                <thead><tr><th>Región</th><th>UH</th><th>Espejo</th><th>ΔUH</th><th>z</th><th></th></tr></thead>
                <tbody>${aspectsRows}</tbody>
              </table>
              <div class="dp-hint">Sonda circular estandarizada de ${n1(DetectCore.DEFAULTS.probeRadiusMm)} mm
                de radio, no segmentación del territorio completo: menos exhaustiva y bastante
                más reproducible entre lectores.</div>
            </div>

            <div class="dp-section">
              <div class="dp-section-title">Procedencia</div>
              <div class="dp-kv"><span>Cortes analizados</span><strong>${r.analyzed.length}</strong></div>
              <div class="dp-kv"><span>Espaciado</span>
                <strong>${n1(r.spacing?.mean, 2)} mm</strong>
                <span class="dp-dim">${r.spacing?.source ?? '—'}</span></div>
              <div class="dp-kv"><span>Tiempo</span><strong>${r.ms} ms</strong></div>
              <div class="dp-kv"><span>Versión</span><strong>v${APP_VERSION}</strong></div>
              <div class="dp-actions">
                <button class="dp-btn" id="dpRerun">Volver a analizar</button>
                <button class="dp-btn" id="dpClear">Descartar análisis</button>
              </div>
            </div>

            ${(r.warnings || []).map(w => `<div class="dp-alert">${this._esc(w)}</div>`).join('')}
            ${this._limitsHtml()}`;

        this._wireResults(body, vp);
    },

    _limitsHtml() {
        return `
        <div class="dp-section dp-limits">
          <div class="dp-section-title">Lo que este análisis NO hace</div>
          <ul>
            <li>No diagnostica. Da cifras de densidad y de asimetría; la lectura es tuya.</li>
            <li>Mide densidad, no cronología: un infarto antiguo, la leucoaraiosis asimétrica
                y un quiste aracnoideo dan la misma firma que un infarto agudo.</li>
            <li>La isquemia se busca por asimetría, así que una lesión bilateral y simétrica,
                o que cruza la línea media, es invisible por construcción.</li>
            <li>No busca hemorragia subaracnoidea.</li>
            <li>La fosa posterior y la base del cráneo dan artefacto de endurecimiento del haz:
                la asimetría ahí es poco fiable.</li>
          </ul>
        </div>`;
    },

    _wireSetup(vp, z) {
        document.getElementById('dpEstimate')?.addEventListener('click', () => {
            ToolHandlers[TOOL_IDS.NWU_MIDLINE].estimate(vp);
            this.refresh();
        });
        document.getElementById('dpManual')?.addEventListener('click', () => {
            ToolState.setTool(TOOL_IDS.NWU_MIDLINE);
            UI.showToast('Marcá la inserción anterior y la posterior de la hoz (2 clics)',
                         'info', 4000);
        });
        document.getElementById('dpConfirm')?.addEventListener('click', () => {
            Detector.confirmMidline(z);
        });
        document.getElementById('dpRun')?.addEventListener('click', () => Detector.run());
    },

    _wireResults(body, vp) {
        body.querySelectorAll('[data-mode]').forEach(b =>
            b.addEventListener('click', () => Detector.setMode(b.dataset.mode)));

        const sl = body.querySelector('#dpOpacity');
        sl?.addEventListener('input', () => {
            Detector.setOpacity(parseInt(sl.value) / 100);
            const lbl = body.querySelector('#dpOpacityVal');
            if (lbl) lbl.textContent = sl.value + ' %';
        });

        body.querySelectorAll('[data-goto]').forEach(b =>
            b.addEventListener('click', () => SeriesPanel.jumpTo(parseInt(b.dataset.goto))));

        body.querySelectorAll('[data-accept]').forEach(b =>
            b.addEventListener('click', () => {
                const [kind, idx] = b.dataset.accept.split(':');
                b.disabled = true;
                Detector.acceptCandidate(kind, parseInt(idx));
            }));

        body.querySelectorAll('[data-probe]').forEach(b =>
            b.addEventListener('click', () => Detector.startProbe(b.dataset.probe)));

        body.querySelector('#dpRerun')?.addEventListener('click', async () => {
            Detector.clear();
            await Detector.run();
        });
        body.querySelector('#dpClear')?.addEventListener('click', () => Detector.clear());
    },
};
