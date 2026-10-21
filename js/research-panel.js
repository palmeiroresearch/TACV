'use strict';

/* ============================================================
   ResearchPanel — Panel de resultados de investigación.

   Reúne: identificación (código de caso + lector), umbrales de
   exclusión, tabla de NWU por corte, NWU global ponderada,
   volumen por planimetría, ayudante ABC/2, desviación de la línea
   media y la exportación/reimportación trazable.
   ============================================================ */

const ResearchPanel = {
    _open: false,

    /* ════════════════════════════════════════════════════════
       Ciclo de vida
       ════════════════════════════════════════════════════════ */

    init() {
        Storage.on('measurementsChanged', () => { if (this._open) this.refresh(); });
        Storage.on('researchModeChanged', () => { if (this._open) this.refresh(); });

        const btn = document.getElementById('btnResearchPanel');
        btn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
        document.getElementById('rpClose')?.addEventListener('click', () => this.close());

        this._wireControls();
    },

    open() {
        const panel = document.getElementById('researchPanel');
        if (!panel) return;
        UI.anchorPanel(panel, ['btnResearchPanel', 'btnResearchMode']);
        panel.classList.remove('hidden');
        document.getElementById('btnResearchPanel')?.classList.add('active');
        this._open = true;
        this.refresh();
    },

    close() {
        document.getElementById('researchPanel')?.classList.add('hidden');
        document.getElementById('btnResearchPanel')?.classList.remove('active');
        this._open = false;
    },

    toggle() { this._open ? this.close() : this.open(); },

    /** Llamado al activar una serie: deriva el código de caso del estudio. */
    async onSeriesActivated(frame) {
        if (!frame) return;
        await ResearchMode.deriveCaseCode(frame);
        this._syncIdentityInputs();
        ResearchMode.refresh();
        if (this._open) this.refresh();
    },

    /* ════════════════════════════════════════════════════════
       Controles
       ════════════════════════════════════════════════════════ */

    _wireControls() {
        // Identificación
        const reader = document.getElementById('rpReaderId');
        reader?.addEventListener('change', () => {
            ResearchMode.setReaderId(reader.value);
            ResearchMode.refresh();
        });
        reader?.addEventListener('keydown', (e) => e.stopPropagation());

        const caseInput = document.getElementById('rpCaseCode');
        caseInput?.addEventListener('change', () => {
            caseInput.value = ResearchMode.setCaseCode(caseInput.value);
            ResearchMode.refresh();
            this.refresh();
        });
        caseInput?.addEventListener('keydown', (e) => e.stopPropagation());

        document.getElementById('rpCaseCodeReset')?.addEventListener('click', () => {
            const v = ResearchMode.setCaseCode('');
            const el = document.getElementById('rpCaseCode');
            if (el) el.value = v;
            ResearchMode.refresh();
            this.refresh();
        });

        // Umbrales de exclusión
        const applyThreshold = () => {
            const huMin = document.getElementById('rpHuMin')?.value;
            const huMax = document.getElementById('rpHuMax')?.value;
            const t = ResearchMode.setThreshold({ huMin, huMax });

            // El umbral forma parte de la medición: cambiarlo debe RE-MEDIR
            const frames = SeriesPanel.getSeries() || [];
            const n = MeasurementStore.recomputeNwuStats(frames, t);
            if (n) UI.showToast(`Umbral aplicado — ${n} ROI recalculadas`, 'success', 3000);
            ViewportLayout.getAll().forEach(vp => vp.render());
            this.refresh();
        };
        document.getElementById('rpHuMin')?.addEventListener('change', applyThreshold);
        document.getElementById('rpHuMax')?.addEventListener('change', applyThreshold);
        ['rpHuMin', 'rpHuMax'].forEach(id =>
            document.getElementById(id)?.addEventListener('keydown', (e) => e.stopPropagation()));

        document.getElementById('rpThresholdReset')?.addEventListener('click', () => {
            const min = document.getElementById('rpHuMin');
            const max = document.getElementById('rpHuMax');
            if (min) min.value = NWU_DEFAULTS.huMin;
            if (max) max.value = NWU_DEFAULTS.huMax;
            applyThreshold();
        });

        // Los controles de línea media, forma de ROI y «rehacer espejo» viven en
        // el HTML que regenera refresh(), así que se conectan allí, no aquí.

        // Exportación
        document.getElementById('rpExportCsv')?.addEventListener('click',  () => Export.exportResearchCSV());
        document.getElementById('rpExportJson')?.addEventListener('click', () => Export.exportResearchJSON());

        const importInput = document.getElementById('rpImportFile');
        document.getElementById('rpImportJson')?.addEventListener('click', () => importInput?.click());
        importInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) Export.importResearchJSON(file);
            e.target.value = '';
        });
    },

    _syncIdentityInputs() {
        const r = document.getElementById('rpReaderId');
        const c = document.getElementById('rpCaseCode');
        const min = document.getElementById('rpHuMin');
        const max = document.getElementById('rpHuMax');
        const t = ResearchMode.getThreshold();
        if (r && r.value !== ResearchMode.getReaderId()) r.value = ResearchMode.getReaderId();
        if (c && document.activeElement !== c) c.value = ResearchMode.getCaseCode();
        if (min && document.activeElement !== min) min.value = t.huMin ?? '';
        if (max && document.activeElement !== max) max.value = t.huMax ?? '';
    },

    /**
     * Rehace la ROI espejo del corte actual sobre la línea media vigente.
     * Se usa después de corregir la línea media: las ROI espejo existentes
     * se reflejaron sobre la línea anterior y quedarían desalineadas.
     */
    _remirrorCurrentSlice() {
        const vp = ViewportLayout.getActive();
        const f  = vp?.state.frame;
        if (!f) return;
        const slice = vp.state.sliceIndex;
        const mid   = MeasurementStore.getMidline(slice);
        if (!mid) { UI.showToast('Este corte no tiene línea media definida', 'warning'); return; }

        const pairs = MeasurementStore.getNwuPairs()
            .filter(p => p.lesion.sliceIndex === slice);
        if (!pairs.length) { UI.showToast('Este corte no tiene ROI de NWU', 'warning'); return; }

        const threshold = ResearchMode.getThreshold();
        for (const { lesion, mirror } of pairs) {
            const pts = ResearchCore.reflectPolygon(
                lesion.points, mid.anterior, mid.posterior, f.pixelSpacing);
            MeasurementStore.update(mirror.id, {
                points: pts,
                originalPoints: pts.map(p => ({ ...p })),
                adjusted: false,
                offsetMm: 0,
                offsetPx: { dx: 0, dy: 0 },
                midlineId: mid.id,
                stats: MeasurementStore.computeNwuRoiStats(f, pts, threshold),
            });
        }
        UI.showToast(`${pairs.length} ROI espejo rehechas — se perdió el ajuste manual`, 'info', 4000);
        vp.render();
        this.refresh();
    },

    /* ════════════════════════════════════════════════════════
       Resultados
       ════════════════════════════════════════════════════════ */

    /** Resumen completo. Lo reutiliza la exportación, así que no toca el DOM. */
    computeResults() {
        const frames = SeriesPanel.getSeries() || [];
        const pairs  = MeasurementStore.getNwuPairs();

        const perSlice = pairs.map(({ pairId, lesion, mirror }) => {
            const sL = lesion.stats, sM = mirror.stats;
            return {
                pairId,
                sliceIndex:   lesion.sliceIndex,
                lesionMean:   sL?.mean ?? null,
                lesionStd:    sL?.std ?? null,
                lesionMedian: sL?.median ?? null,
                lesionCount:  sL?.count ?? 0,
                lesionExcluded: sL?.excludedTotal ?? 0,
                lesionAreaMm2:  sL?.areaMm2 ?? null,
                contraMean:   sM?.mean ?? null,
                contraStd:    sM?.std ?? null,
                contraMedian: sM?.median ?? null,
                contraCount:  sM?.count ?? 0,
                contraExcluded: sM?.excludedTotal ?? 0,
                contraAreaMm2:  sM?.areaMm2 ?? null,
                nwu:          ResearchCore.nwu(sL?.mean, sM?.mean),
                mirrorAdjusted: !!mirror.adjusted,
                mirrorOffsetMm: mirror.offsetMm ?? 0,
                threshold:    lesion.threshold ?? null,
            };
        });

        const global = ResearchCore.nwuWeighted(perSlice);

        // Volumen: usa las ROI de lesión de NWU y, si no hay, las ROI libres
        const lesionRois = pairs.length
            ? pairs.map(p => p.lesion)
            : MeasurementStore.getAll().filter(m => m.type === 'freehand');
        const volume = lesionRois.length
            ? MeasurementStore.computeVolume(lesionRois, frames)
            : null;

        // ABC/2
        const axes = MeasurementStore.getAll().filter(m => m.type === 'abc_axis');
        const lastA = [...axes].reverse().find(m => m.axis === 'A');
        const lastB = [...axes].reverse().find(m => m.axis === 'B');
        const lesionSlices = [...new Set(lesionRois.map(m => m.sliceIndex))].sort((a, b) => a - b);
        const cInfo = lesionSlices.length ? ResearchCore.deriveC(lesionSlices, frames) : null;
        const abc = (lastA && lastB && cInfo?.cMm != null)
            ? { ...ResearchCore.abc2(lastA.distanceMm, lastB.distanceMm, cInfo.cMm),
                aMm: lastA.distanceMm, bMm: lastB.distanceMm, cMm: cInfo.cMm,
                aSlice: lastA.sliceIndex, bSlice: lastB.sliceIndex,
                spacingMm: cInfo.spacingMm, sliceCount: cInfo.sliceCount }
            : { aMm: lastA?.distanceMm ?? null, bMm: lastB?.distanceMm ?? null,
                cMm: cInfo?.cMm ?? null, mL: null, mm3: null };

        // Corte de mayor área, donde deben medirse A y B
        let largestSlice = null, largestArea = -1;
        for (const m of lesionRois) {
            const a = m.stats?.areaTotalMm2 ?? m.stats?.areaMm2 ?? m.stats?.area ?? 0;
            if (a > largestArea) { largestArea = a; largestSlice = m.sliceIndex; }
        }

        const septa = MeasurementStore.getAll()
            .filter(m => m.type === 'septum')
            .map(m => ({ sliceIndex: m.sliceIndex, shiftMm: m.shiftMm, pos: m.pos }))
            .sort((a, b) => a.sliceIndex - b.sliceIndex);

        const midlines = MeasurementStore.getAllMidlines().map(m => ({
            sliceIndex: m.sliceIndex, anterior: m.anterior,
            posterior: m.posterior, source: m.source,
        }));

        return {
            perSlice, global, volume, abc,
            largestSlice, largestArea: largestArea >= 0 ? largestArea : null,
            septa, midlines,
            spacing: ResearchCore.sliceSpacing(frames,
                lesionSlices.length ? lesionSlices : undefined),
        };
    },

    refresh() {
        const body = document.getElementById('rpBody');
        if (!body) return;
        this._syncIdentityInputs();

        const r  = this.computeResults();
        const vp = ViewportLayout.getActive();
        const slice = vp?.state.sliceIndex ?? 0;
        const mid   = MeasurementStore.getMidline(slice);

        const hu   = (v, d = 1) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d);
        const pct  = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(2) + ' %';
        const mm2  = (v) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(1);

        /* ── Estado del corte actual ── */
        const midStatus = mid
            ? `<span class="rp-ok">definida</span> <span class="rp-dim">(${
                 { manual: 'manual', auto: 'automática — revisar',
                   'auto-adjusted': 'automática corregida' }[mid.source] || mid.source})</span>`
            : '<span class="rp-warn">sin definir</span>';

        /* ── Tabla por corte ── */
        const rows = r.perSlice.map(s => `
            <tr>
              <td>${s.sliceIndex + 1}</td>
              <td>${hu(s.lesionMean)}<span class="rp-dim"> ±${hu(s.lesionStd)}</span></td>
              <td>${hu(s.contraMean)}<span class="rp-dim"> ±${hu(s.contraStd)}</span></td>
              <td>${s.lesionCount} / ${s.contraCount}</td>
              <td>${s.lesionExcluded} / ${s.contraExcluded}</td>
              <td class="rp-nwu">${pct(s.nwu)}</td>
              <td>${s.mirrorAdjusted
                     ? `<span class="rp-warn" title="ROI espejo desplazada manualmente">↔ ${s.mirrorOffsetMm.toFixed(1)}</span>`
                     : '<span class="rp-dim">—</span>'}</td>
            </tr>`).join('');

        const table = r.perSlice.length ? `
            <table class="rp-table">
              <thead><tr>
                <th title="Número de corte">Corte</th>
                <th title="Media ± SD de la ROI de lesión">Lesión UH</th>
                <th title="Media ± SD de la ROI contralateral">Contral. UH</th>
                <th title="Píxeles medidos: lesión / contralateral">Píx.</th>
                <th title="Píxeles excluidos por umbral o padding">Excl.</th>
                <th>NWU</th>
                <th title="Ajuste manual de la ROI espejo, en mm">Ajuste</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>` : '<div class="rp-empty">Sin pares de ROI de NWU todavía.</div>';

        /* ── Global ── */
        const g = r.global;
        const globalBlock = `
            <div class="rp-global ${g.nwu == null ? 'rp-global-empty' : ''}">
              <div class="rp-global-main">${pct(g.nwu)}</div>
              <div class="rp-global-sub">
                NWU global ponderada por píxeles ·
                ${g.slicesUsed} corte${g.slicesUsed !== 1 ? 's' : ''} ·
                lesión ${hu(g.lesionMean)} UH (n=${g.lesionCount}) ·
                contralateral ${hu(g.contraMean)} UH (n=${g.contraCount})
              </div>
            </div>`;

        /* ── Volumen ── */
        const v = r.volume;
        const volBlock = v ? `
            <div class="rp-kv"><span>Volumen por planimetría</span>
                <strong>${v.mL.toFixed(2)} mL</strong></div>
            <div class="rp-kv"><span>Cortes con lesión</span>
                <strong>${v.sliceCount}</strong></div>
            <div class="rp-kv"><span>Área total de ROI</span>
                <strong>${mm2(v.totalAreaMm2)} mm²</strong></div>
            <div class="rp-kv"><span>Espaciado entre cortes</span>
                <strong>${hu(v.spacing?.mean, 2)} mm</strong>
                <span class="rp-dim">${v.spacing?.source === 'ImagePositionPatient'
                    ? 'de ImagePositionPatient' : `de ${v.spacing?.source}`}</span></div>
            ${v.warnings.map(w => `<div class="rp-alert">${this._esc(w)}</div>`).join('')}
        ` : '<div class="rp-empty">Trazá ROI de lesión para calcular el volumen.</div>';

        /* ── ABC/2 ── */
        const a = r.abc;
        const abcBlock = `
            <div class="rp-kv"><span>A (mayor diámetro)</span>
                <strong>${hu(a.aMm)} mm</strong>
                ${a.aSlice != null ? `<span class="rp-dim">corte ${a.aSlice + 1}</span>` : ''}</div>
            <div class="rp-kv"><span>B (perpendicular a A)</span>
                <strong>${hu(a.bMm)} mm</strong>
                ${a.bSlice != null ? `<span class="rp-dim">corte ${a.bSlice + 1}</span>` : ''}</div>
            <div class="rp-kv"><span>C (derivada de los cortes)</span>
                <strong>${hu(a.cMm)} mm</strong>
                ${a.sliceCount ? `<span class="rp-dim">${a.sliceCount} × ${hu(a.spacingMm, 2)} mm</span>` : ''}</div>
            <div class="rp-kv rp-kv-total"><span>ABC/2</span>
                <strong>${a.mL != null ? a.mL.toFixed(2) + ' mL' : '—'}</strong></div>
            ${r.largestSlice != null ? `<div class="rp-hint">
                Medí A y B en el corte de mayor área: <strong>corte ${r.largestSlice + 1}</strong>
                (${mm2(r.largestArea)} mm²).</div>` : ''}
            ${(a.aMm == null || a.bMm == null)
                ? '<div class="rp-hint">Usá la herramienta <strong>B</strong> y arrastrá dos veces: ' +
                  'el primer trazo es A, el segundo B.</div>' : ''}`;

        /* ── Desviación de la línea media ── */
        const septBlock = r.septa.length
            ? r.septa.map(s => `<div class="rp-kv"><span>Corte ${s.sliceIndex + 1}</span>
                 <strong>${hu(Math.abs(s.shiftMm))} mm</strong></div>`).join('')
            : '<div class="rp-empty">Marcá el septum pellucidum (herramienta J) para medir la desviación.</div>';

        /* ── Avisos de exactitud del estudio ── */
        const frame = vp?.state.frame;
        const accWarn = [];
        if (frame?.rescaleInterceptMissing) {
            accWarn.push('Este estudio NO tiene RescaleIntercept: se asume 0. Verificá las UH ' +
                         'contra otra herramienta antes de medir.');
        }
        if (frame?.pixelSpacing?.[0] === 1 && frame?.pixelSpacing?.[1] === 1) {
            accWarn.push('PixelSpacing no encontrado: las áreas y los volúmenes están en ' +
                         'unidades de píxel, no en mm.');
        }
        if (!ResearchMode.isActive()) {
            accWarn.push('El modo investigación está DESACTIVADO: el procesamiento de imagen ' +
                         'no está bloqueado y las mediciones se marcarán como no controladas.');
        }
        if (frame && frame.pixelPaddingValue == null) {
            accWarn.push('Sin PixelPaddingValue en el DICOM: no se puede excluir el padding ' +
                         'fuera del FOV automáticamente.');
        }

        body.innerHTML = `
            ${accWarn.map(w => `<div class="rp-alert">${this._esc(w)}</div>`).join('')}

            <div class="rp-section">
              <div class="rp-section-title">Corte actual (${slice + 1})</div>
              <div class="rp-kv"><span>Línea media</span><strong>${midStatus}</strong></div>
              <div class="rp-actions">
                <button class="rp-btn" id="rpEstimateMidlineInline">Estimar</button>
                <button class="rp-btn" id="rpMidlineManualInline">Definir a mano</button>
                <button class="rp-btn" id="rpRemirrorInline" title="Rehace las ROI espejo de este corte sobre la línea media actual">Rehacer espejo</button>
              </div>
              <div class="rp-actions">
                <span class="rp-dim">ROI de lesión:</span>
                <button class="rp-btn ${NwuTools.lesionShape === 'freehand' ? 'active' : ''}" data-nwu-shape="freehand">Libre</button>
                <button class="rp-btn ${NwuTools.lesionShape === 'ellipse' ? 'active' : ''}" data-nwu-shape="ellipse">Elipse</button>
              </div>
            </div>

            <div class="rp-section">
              <div class="rp-section-title">NWU por corte</div>
              ${table}
              ${globalBlock}
            </div>

            <div class="rp-section">
              <div class="rp-section-title">Volumen</div>
              ${volBlock}
            </div>

            <div class="rp-section">
              <div class="rp-section-title">ABC/2</div>
              ${abcBlock}
            </div>

            <div class="rp-section">
              <div class="rp-section-title">Desviación de la línea media</div>
              ${septBlock}
            </div>`;

        // Los botones se reconstruyen en cada refresh: hay que reconectarlos
        body.querySelector('#rpEstimateMidlineInline')?.addEventListener('click', () =>
            ToolHandlers[TOOL_IDS.NWU_MIDLINE].estimate(ViewportLayout.getActive()));
        body.querySelector('#rpMidlineManualInline')?.addEventListener('click', () => {
            ToolState.setTool(TOOL_IDS.NWU_MIDLINE);
            UI.showToast('Marcá la inserción anterior y la posterior de la hoz (2 clics)', 'info', 4000);
        });
        body.querySelector('#rpRemirrorInline')?.addEventListener('click', () => this._remirrorCurrentSlice());
        body.querySelectorAll('[data-nwu-shape]').forEach(btn => {
            btn.addEventListener('click', () => {
                NwuTools.setLesionShape(btn.dataset.nwuShape);
                ToolState.setTool(TOOL_IDS.NWU_LESION);
                this.refresh();
            });
        });
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
};
