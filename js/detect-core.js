'use strict';

/* ============================================================
   DetectCore — Análisis automático de asimetría.

   Propone regiones candidatas de hipodensidad (isquemia) e
   hiperdensidad (hemorragia) y mide asimetría por regiones.
   NO MIDE NADA REPORTABLE: toda cifra que acabe en un informe se
   vuelve a medir con ResearchCore.maskStats sobre las UH
   originales. Aquí solo se decide DÓNDE mirar.

   Como research-core.js: sin DOM, sin estado global, determinista,
   y con cola CommonJS para que `node --test` pruebe este mismo
   código y no una copia.

   Depende de ResearchCore (toHU, isPadding, reflectPointOverLine,
   maskStats, sliceSpacing, nwu).
   ============================================================ */

const DetectCore = {

    /* ════════════════════════════════════════════════════════
       Parámetros por defecto

       Viven aquí y no en config.js a propósito: este módulo tiene
       que poder probarse solo, sin cargar la configuración de la
       app. La interfaz los lee de aquí.
       ════════════════════════════════════════════════════════ */

    DEFAULTS: Object.freeze({
        /* ── Máscara de cerebro ── */
        brainHuMin:   -20,   // por debajo: aire, grasa
        brainHuMax:   150,   // por encima: hueso y calcificación gruesa. Deja
                             // dentro la sangre aguda (45-100 UH); lo que quede
                             // por encima se recupera rellenando agujeros.
        closeMm:      2.0,   // cierre morfológico: notches del contorno
        erodeMm:      2.5,   // erosión del borde: mata el volumen parcial de la tabla interna
        minBrainPx:   2000,  // por debajo, el corte no tiene cerebro utilizable

        /* ── Mapa de asimetría ── */
        smoothMm:     1.5,   // promediado simétrico en ambos lados
        midlineBandMm: 3.0,  // banda a excluir a cada lado de la línea media (hoz, seno)

        /* ── Candidatos ── */
        candidateMinPx:   12,   // se descartan los componentes 2D más pequeños
                                // que esto en cada corte. A SD 4 UH hay ~0,6 %
                                // de píxeles sanos por encima de 45 UH, y los
                                // sueltos encadenan el candidato a través de
                                // cortes vacíos, inflando el volumen.
                                //
                                // Se filtra por TAMAÑO DE COMPONENTE y no con
                                // una apertura morfológica a propósito: una
                                // apertura borraría también estructuras finas
                                // pero reales —la corona de volumen parcial de
                                // una calcificación, un reborde subdural— que
                                // son delgadas y muy extensas, es decir
                                // componentes grandes.
        candidateCloseMm: 1.0,  // cierre de la máscara de candidatos: el ruido
                                // rechaza píxeles sueltos dentro de la lesión y
                                // deja la frontera dentada, lo que subestima el
                                // volumen en torno a un 8 %
        ischDilateMm:     0,    // Compensaría el encogimiento del promediado: en
                                // la frontera, la asimetría suavizada mezcla
                                // lesión y tejido sano y no llega al umbral, así
                                // que el candidato sale erosionado y el volumen
                                // queda ~7 % corto.
                                //
                                // POR DEFECTO DESACTIVADO, y es deliberado:
                                // dilatar mete tejido sano dentro del contorno y
                                // arrastra la media de UH (medido: la NWU pasaba
                                // de 42,3 % a 34,8 % en el fantoma). Una región
                                // algo pequeña da una media CORRECTA; una algo
                                // grande da una media FALSA. Para una herramienta
                                // cuyo objeto es la exactitud de las UH, quedarse
                                // corto es el lado seguro del error.

        /* ── Isquemia instaurada ── */
        ischAsymHu:   -8,    // asimetría mínima para considerar candidato
        ischHuMin:    15,    // rango de parénquima: excluye LCR…
        ischHuMax:    45,    // …y sangre
        ischMinVolMl: 1.0,

        /* ── Hemorragia ── */
        hemHuMin:     45,
        hemHuMax:     95,
        hemMinVolMl:  0.5,
        calcHuMin:    100,   // por encima, sospecha de calcificación
        extraAxialMm: 6.0,   // grosor por debajo del cual un componente pegado al borde
                             // sugiere colección extraaxial

        /* ── Isquemia precoz por sectores ── */
        angBins:      6,
        radBins:      3,
        sectorMinPx:  60,    // sector con menos píxeles: no se evalúa
        sectorDeltaHu: -2.0, // ΔUH para marcar un sector
        sectorZ:      3.0,   // y además |z| mínimo: a 2-6 UH el ΔUH solo no basta

        /* ── Sonda ASPECTS ── */
        probeRadiusMm: 5.0,

        /* ── Overlay ── */
        overlayClipHu: 15,   // |ΔUH| a partir del cual el color va saturado
        overlayFloorHu: 6,   // por debajo de esto no se pinta nada.
                             // NO se usa sectorDeltaHu (−2 UH) a propósito: ese
                             // umbral es para MEDIAS de cientos de píxeles, donde
                             // el ruido ya se ha promediado. Píxel a píxel, con
                             // SD 4 UH y promediado 3×3, la asimetría del ruido
                             // ronda 1,9 UH de SD, así que un suelo de 2 UH
                             // pintaría un tercio de un cerebro normal.
        overlayBothSides: false, // Por defecto solo se tiñe el lado HIPODENSO.
                             // La asimetría es antisimétrica: pintar los dos
                             // lados colorea de rojo tejido sano solo por estar
                             // enfrente de la lesión.
    }),

    /* ════════════════════════════════════════════════════════
       1. Morfología binaria
       ════════════════════════════════════════════════════════ */

    /**
     * Desplazamientos de un disco de radio `radiusMm` en índices de píxel.
     * Con PixelSpacing anisotrópico el disco métrico es una elipse en píxeles.
     */
    discOffsets(radiusMm, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        const rx = Math.max(0, Math.round(radiusMm / cs));
        const ry = Math.max(0, Math.round(radiusMm / rs));
        const offs = [];
        for (let dy = -ry; dy <= ry; dy++) {
            for (let dx = -rx; dx <= rx; dx++) {
                const nx = rx ? dx / rx : 0;
                const ny = ry ? dy / ry : 0;
                if (nx * nx + ny * ny <= 1.0001) offs.push([dx, dy]);
            }
        }
        return offs;
    },

    /** Erosión. Fuera de la imagen cuenta como 0, así que el borde se erosiona. */
    erode(mask, rows, cols, offsets) {
        const out = new Uint8Array(rows * cols);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (!mask[i]) continue;
                let keep = 1;
                for (let k = 0; k < offsets.length; k++) {
                    const nx = x + offsets[k][0];
                    const ny = y + offsets[k][1];
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || !mask[ny * cols + nx]) {
                        keep = 0; break;
                    }
                }
                out[i] = keep;
            }
        }
        return out;
    },

    /** Dilatación. */
    dilate(mask, rows, cols, offsets) {
        const out = new Uint8Array(rows * cols);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (!mask[y * cols + x]) continue;
                for (let k = 0; k < offsets.length; k++) {
                    const nx = x + offsets[k][0];
                    const ny = y + offsets[k][1];
                    if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) out[ny * cols + nx] = 1;
                }
            }
        }
        return out;
    },

    /** Cierre: rellena huecos sin crecer el contorno exterior. */
    close(mask, rows, cols, offsets) {
        return this.erode(this.dilate(mask, rows, cols, offsets), rows, cols, offsets);
    },

    /** Apertura: elimina moteado sin encoger lo que sobrevive. */
    open(mask, rows, cols, offsets) {
        return this.dilate(this.erode(mask, rows, cols, offsets), rows, cols, offsets);
    },

    /**
     * Elimina los componentes conexos de menos de `minPx` píxeles, 4-conectividad.
     * Filtra el moteado del ruido sin tocar estructuras finas pero extensas.
     */
    removeSmallComponents(mask, rows, cols, minPx) {
        if (!minPx || minPx <= 1) return mask;
        const n = rows * cols;
        const out = new Uint8Array(n);
        const seen = new Uint8Array(n);
        const stack = new Int32Array(n);
        const members = new Int32Array(n);

        for (let start = 0; start < n; start++) {
            if (!mask[start] || seen[start]) continue;
            let sp = 0, size = 0;
            stack[sp++] = start; seen[start] = 1;
            while (sp > 0) {
                const i = stack[--sp];
                members[size++] = i;
                const x = i % cols, y = (i - x) / cols;
                if (x > 0        && mask[i - 1]    && !seen[i - 1])    { seen[i - 1] = 1;    stack[sp++] = i - 1; }
                if (x < cols - 1 && mask[i + 1]    && !seen[i + 1])    { seen[i + 1] = 1;    stack[sp++] = i + 1; }
                if (y > 0        && mask[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; stack[sp++] = i - cols; }
                if (y < rows - 1 && mask[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; stack[sp++] = i + cols; }
            }
            if (size >= minPx) for (let k = 0; k < size; k++) out[members[k]] = 1;
        }
        return out;
    },

    /**
     * Rellena los agujeros cerrados de una máscara.
     *
     * Inundación del complemento desde el borde de la imagen: lo que no se
     * alcanza desde fuera es un agujero. Necesario porque una calcificación
     * densa o un hematoma muy coagulado quedan por encima del umbral de
     * parénquima y abren un agujero en la máscara; sin rellenarlo, la erosión
     * se come la corona de volumen parcial que los rodea — justo la señal que
     * el detector de hemorragia tiene que ver.
     */
    fillHoles(mask, rows, cols) {
        const n = rows * cols;
        const outside = new Uint8Array(n);
        const stack = new Int32Array(n);
        let sp = 0;

        const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
        for (let x = 0; x < cols; x++) { push(x); push((rows - 1) * cols + x); }
        for (let y = 0; y < rows; y++) { push(y * cols); push(y * cols + cols - 1); }

        while (sp > 0) {
            const i = stack[--sp];
            const x = i % cols, y = (i - x) / cols;
            if (x > 0)        push(i - 1);
            if (x < cols - 1) push(i + 1);
            if (y > 0)        push(i - cols);
            if (y < rows - 1) push(i + cols);
        }

        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = (mask[i] || !outside[i]) ? 1 : 0;
        return out;
    },

    /**
     * Componente conexa mayor, 4-conectividad.
     * 4 y no 8 a propósito: con 8 el cerebro puede puentear al cuero cabelludo
     * por una diagonal de un píxel que atraviesa la tabla ósea.
     */
    largestComponent(mask, rows, cols) {
        const n = rows * cols;
        const seen = new Uint8Array(n);
        const stack = new Int32Array(n);
        let best = null, bestSize = 0;

        for (let start = 0; start < n; start++) {
            if (!mask[start] || seen[start]) continue;
            let sp = 0, size = 0;
            const members = [];
            stack[sp++] = start;
            seen[start] = 1;

            while (sp > 0) {
                const i = stack[--sp];
                members.push(i);
                size++;
                const x = i % cols, y = (i - x) / cols;
                if (x > 0        && mask[i - 1]    && !seen[i - 1])    { seen[i - 1] = 1;    stack[sp++] = i - 1; }
                if (x < cols - 1 && mask[i + 1]    && !seen[i + 1])    { seen[i + 1] = 1;    stack[sp++] = i + 1; }
                if (y > 0        && mask[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; stack[sp++] = i - cols; }
                if (y < rows - 1 && mask[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; stack[sp++] = i + cols; }
            }
            if (size > bestSize) { bestSize = size; best = members; }
        }

        const out = new Uint8Array(n);
        if (best) for (const i of best) out[i] = 1;
        return { mask: out, count: bestSize };
    },

    /* ════════════════════════════════════════════════════════
       2. Máscara de cerebro
       ════════════════════════════════════════════════════════ */

    /**
     * Máscara de parénquima utilizable para analizar.
     *
     * La erosión del borde no es cosmética: el volumen parcial en la tabla
     * interna produce píxeles de 60-90 UH que caen justo en el rango de sangre
     * aguda, y un reborde de LCR que se lee como hipodensidad. Sin erosionar,
     * es la mayor fuente de falsos positivos de todo el detector.
     *
     * @returns {{mask:Uint8Array, eroded:Uint8Array, count:number, ok:boolean}}
     */
    brainMask(frame, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };
        const { pixelData, rows, cols } = frame;
        const slope     = frame.rescaleSlope ?? 1;
        const intercept = frame.rescaleIntercept ?? 0;
        const pad       = frame.pixelPaddingValue ?? null;
        const padLim    = frame.pixelPaddingRangeLimit ?? null;
        const spacing   = frame.pixelSpacing || [1, 1];

        const n = rows * cols;
        const raw0 = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const raw = pixelData[i];
            if (ResearchCore.isPadding(raw, pad, padLim)) continue;
            const hu = ResearchCore.toHU(raw, slope, intercept);
            if (hu >= o.brainHuMin && hu < o.brainHuMax) raw0[i] = 1;
        }

        const big    = this.largestComponent(raw0, rows, cols);
        // Rellenar antes de erosionar: si no, una calcificación o un hematoma
        // denso es un agujero y la erosión borra su corona de volumen parcial.
        const filled = this.fillHoles(big.mask, rows, cols);
        const closed = this.close(filled, rows, cols, this.discOffsets(o.closeMm, spacing));
        const eroded = this.erode(closed, rows, cols, this.discOffsets(o.erodeMm, spacing));

        let count = 0;
        for (let i = 0; i < n; i++) if (eroded[i]) count++;

        return { mask: closed, eroded, count, ok: count >= o.minBrainPx };
    },

    /* ════════════════════════════════════════════════════════
       3. Mapa de asimetría
       ════════════════════════════════════════════════════════ */

    /**
     * Coeficientes de la reflexión sobre la línea media, precalculados.
     *
     * Llamar a ResearchCore.reflectPointOverLine por píxel cuesta una
     * reconstrucción completa de la geometría de la recta y un objeto nuevo
     * en cada iteración. La reflexión es una transformación afín fija, así que
     * se calcula una vez por corte: R = 2ûûᵀ − I. Algebraicamente idéntico
     * (hay una prueba que lo comprueba a 1e-9).
     */
    mirrorCoeffs(midline, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        const ax = midline.anterior.x * cs,  ay = midline.anterior.y * rs;
        const bx = midline.posterior.x * cs, by = midline.posterior.y * rs;
        let ux = bx - ax, uy = by - ay;
        const L = Math.hypot(ux, uy);
        if (!L) return null;
        ux /= L; uy /= L;
        return {
            ax, ay, cs, rs,
            r11: 2 * ux * ux - 1, r12: 2 * ux * uy,
            r21: 2 * ux * uy,     r22: 2 * uy * uy - 1,
            nx: -uy, ny: ux,          // normal unitaria: distancia con signo
        };
    },

    /**
     * A(p) = HU̅(p) − HU̅(espejo(p)), con promediado simétrico.
     *
     * El espejo se muestrea por VECINO MÁS CERCANO, nunca interpolando:
     * interpolar altera valores, que es precisamente lo que este proyecto
     * no hace. El promediado se aplica igual a los dos lados, así que
     * cancela ruido en vez de sesgarlo.
     *
     * Devuelve NaN donde no se puede comparar (fuera de máscara, espejo
     * fuera de máscara, o dentro de la banda de la línea media).
     */
    asymmetryMap(frame, mask, midline, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };
        const { pixelData, rows, cols } = frame;
        const slope     = frame.rescaleSlope ?? 1;
        const intercept = frame.rescaleIntercept ?? 0;
        const spacing   = frame.pixelSpacing || [1, 1];
        const n = rows * cols;

        // HU promediado dentro de la máscara
        const offs = this.discOffsets(o.smoothMm, spacing);
        const smooth = new Float32Array(n).fill(NaN);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (!mask[i]) continue;
                let sum = 0, cnt = 0;
                for (let k = 0; k < offs.length; k++) {
                    const nx = x + offs[k][0];
                    const ny = y + offs[k][1];
                    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
                    const j = ny * cols + nx;
                    if (!mask[j]) continue;
                    sum += ResearchCore.toHU(pixelData[j], slope, intercept);
                    cnt++;
                }
                if (cnt) smooth[i] = sum / cnt;
            }
        }

        // Diferencia contra el espejo
        const asym = new Float32Array(n).fill(NaN);
        const mirrorIdx = new Int32Array(n).fill(-1);
        const C = this.mirrorCoeffs(midline, spacing);
        if (!C) return { asym, smooth, mirrorIdx };

        const [sRs, sCs] = spacing;
        for (let y = 0; y < rows; y++) {
            const Y = (y + 0.5) * sRs - C.ay;
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (!mask[i] || Number.isNaN(smooth[i])) continue;

                const X = (x + 0.5) * sCs - C.ax;

                // Excluir la banda de la línea media: hoz, seno longitudinal
                // y vasos interhemisféricos generan asimetría espuria.
                if (Math.abs(X * C.nx + Y * C.ny) < o.midlineBandMm) continue;

                const mx = Math.floor((C.ax + C.r11 * X + C.r12 * Y) / sCs);
                const my = Math.floor((C.ay + C.r21 * X + C.r22 * Y) / sRs);
                if (mx < 0 || mx >= cols || my < 0 || my >= rows) continue;
                const j = my * cols + mx;
                if (!mask[j] || Number.isNaN(smooth[j])) continue;

                asym[i] = smooth[i] - smooth[j];
                mirrorIdx[i] = j;
            }
        }

        return { asym, smooth, mirrorIdx };
    },

    /* ════════════════════════════════════════════════════════
       4. Componentes conexas en 3D
       ════════════════════════════════════════════════════════ */

    /**
     * Etiquetado 3D con 6-conectividad sobre máscaras por corte.
     *
     * Los candidatos son dispersos, así que en vez de un array de etiquetas
     * de slices×rows×cols (decenas de MB) se guarda una lista de vóxeles y
     * solo dos mapas de corte: el actual y el anterior.
     *
     * @param {Array<Uint8Array|null>} masks  una por corte, índice = z
     * @returns {Array<{voxels:Array, size:number}>} componentes
     */
    components3D(masks, rows, cols) {
        const n = rows * cols;
        const parent = [];              // union-find sobre la lista de vóxeles
        const vox = [];                 // {z, y, x}
        let prevMap = null;

        const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

        for (let z = 0; z < masks.length; z++) {
            const m = masks[z];
            const curMap = new Int32Array(n).fill(-1);
            if (m) {
                for (let y = 0; y < rows; y++) {
                    for (let x = 0; x < cols; x++) {
                        const i = y * cols + x;
                        if (!m[i]) continue;
                        const id = vox.length;
                        vox.push({ z, y, x });
                        parent.push(id);
                        curMap[i] = id;

                        if (x > 0 && curMap[i - 1] >= 0)    union(curMap[i - 1], id);
                        if (y > 0 && curMap[i - cols] >= 0) union(curMap[i - cols], id);
                        if (prevMap && prevMap[i] >= 0)     union(prevMap[i], id);
                    }
                }
            }
            prevMap = curMap;
        }

        const byRoot = new Map();
        for (let id = 0; id < vox.length; id++) {
            const r = find(id);
            if (!byRoot.has(r)) byRoot.set(r, []);
            byRoot.get(r).push(vox[id]);
        }

        return [...byRoot.values()]
            .map(voxels => ({ voxels, size: voxels.length }))
            .sort((a, b) => b.size - a.size);
    },

    /* ════════════════════════════════════════════════════════
       5. Medidas de un componente
       ════════════════════════════════════════════════════════ */

    /**
     * Estadísticas de un componente 3D, medidas sobre UH ORIGINALES.
     * El espaciado entre cortes se toma de ResearchCore.sliceSpacing, que
     * proyecta ImagePositionPatient sobre la normal del corte.
     */
    componentStats(component, frames, spacingInfo, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };

        // Vóxeles agrupados por corte
        const bySlice = new Map();
        for (const v of component.voxels) {
            if (!bySlice.has(v.z)) bySlice.set(v.z, []);
            bySlice.get(v.z).push(v);
        }
        const slices = [...bySlice.keys()].sort((a, b) => a - b);

        const gapOf = (z) => {
            const sp = spacingInfo?.mean;
            return (sp != null && Number.isFinite(sp)) ? sp : (frames[z]?.sliceThickness ?? 1);
        };

        let mm3 = 0, sum = 0, cnt = 0, min = Infinity, max = -Infinity;
        const values = [];
        const perSlice = [];

        for (const z of slices) {
            const f = frames[z];
            if (!f) continue;
            const [rs, cs] = f.pixelSpacing || [1, 1];
            const slope     = f.rescaleSlope ?? 1;
            const intercept = f.rescaleIntercept ?? 0;
            const vs = bySlice.get(z);

            let sSum = 0;
            for (const v of vs) {
                const hu = ResearchCore.toHU(f.pixelData[v.y * f.cols + v.x], slope, intercept);
                values.push(hu);
                sSum += hu;
                sum += hu; cnt++;
                if (hu < min) min = hu;
                if (hu > max) max = hu;
            }
            const areaMm2 = vs.length * cs * rs;
            const gap = gapOf(z);
            mm3 += areaMm2 * gap;
            perSlice.push({ sliceIndex: z, pixels: vs.length, areaMm2, gapMm: gap,
                            meanHu: vs.length ? sSum / vs.length : null });
        }

        const st = ResearchCore.computeStats(values);

        return {
            ...st,
            voxels: cnt,
            volumeMm3: mm3,
            volumeMl: mm3 / 1000,
            sliceRange: slices.length ? [slices[0], slices[slices.length - 1]] : null,
            sliceCount: slices.length,
            perSlice,
        };
    },

    /** Centroide de un componente, en índices de píxel del corte central. */
    componentCentroid(component) {
        let sx = 0, sy = 0, sz = 0;
        for (const v of component.voxels) { sx += v.x; sy += v.y; sz += v.z; }
        const n = component.voxels.length || 1;
        return { x: sx / n, y: sy / n, z: Math.round(sz / n) };
    },

    /**
     * Contorno del componente en un corte, como polígono.
     * Marching squares sobre la máscara del componente: lo que se necesita
     * para pintar el candidato y, si el usuario lo acepta, convertirlo en ROI.
     */
    componentContour(component, sliceIndex, rows, cols) {
        const m = new Uint8Array(rows * cols);
        let any = false;
        for (const v of component.voxels) {
            if (v.z === sliceIndex) { m[v.y * cols + v.x] = 1; any = true; }
        }
        if (!any) return null;
        return this.traceContourEdges(m, rows, cols);
    },

    /**
     * Contorno exterior siguiendo BORDES de píxel, no centros.
     *
     * Un contorno trazado por los centros de los píxeles del borde queda medio
     * píxel por dentro, y en una lesión de 20 px de radio eso son casi un 10 %
     * de área perdida. Aquí se recorren las aristas entre píxel dentro y píxel
     * fuera, que en la convención de este proyecto (ix = 0 es el BORDE del
     * píxel 0) caen en coordenadas enteras: el área del polígono resultante es
     * exactamente el número de píxeles.
     *
     * Devuelve el bucle más largo (contorno exterior); los agujeros producen
     * bucles aparte y se descartan, así que un candidato con una isla sana
     * dentro queda como una sola región, que es lo deseable para una lesión.
     */
    traceContourEdges(mask, rows, cols) {
        const at = (x, y) => (x >= 0 && x < cols && y >= 0 && y < rows) ? mask[y * cols + x] : 0;

        // Aristas dirigidas, con el interior siempre al mismo lado
        const edges = new Map();           // "x,y" de inicio → [ex, ey]
        const addEdge = (sx, sy, ex, ey) => { edges.set(sx + ',' + sy, [ex, ey]); };

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (!at(x, y)) continue;
                if (!at(x, y - 1)) addEdge(x + 1, y,     x,     y);      // arriba  → −x
                if (!at(x - 1, y)) addEdge(x,     y,     x,     y + 1);  // izqda   → +y
                if (!at(x, y + 1)) addEdge(x,     y + 1, x + 1, y + 1);  // abajo   → +x
                if (!at(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y);      // dcha    → −y
            }
        }
        if (!edges.size) return null;

        // Encadenar en bucles
        let best = null;
        const used = new Set();
        for (const startKey of edges.keys()) {
            if (used.has(startKey)) continue;
            const loop = [];
            let key = startKey;
            while (edges.has(key) && !used.has(key)) {
                used.add(key);
                const [cx, cy] = key.split(',');
                loop.push({ x: +cx, y: +cy });
                const [ex, ey] = edges.get(key);
                key = ex + ',' + ey;
            }
            if (loop.length >= 4 && (!best || loop.length > best.length)) best = loop;
        }
        if (!best) return null;

        // Quitar vértices colineales (la escalera tiene tramos rectos largos):
        // no cambia el área en absoluto.
        const noCollinear = [];
        for (let i = 0; i < best.length; i++) {
            const p = best[(i - 1 + best.length) % best.length];
            const c = best[i];
            const q = best[(i + 1) % best.length];
            const cross = (c.x - p.x) * (q.y - c.y) - (c.y - p.y) * (q.x - c.x);
            if (cross !== 0) noCollinear.push(c);
        }
        const poly = noCollinear.length >= 3 ? noCollinear : best;

        // Suavizar la escalera. La tolerancia de medio píxel mantiene el error
        // de área por debajo del 1 %: los recortes y los añadidos se compensan.
        return this.simplifyPolygon(poly, 0.5);
    },

    /**
     * Contorno exterior de una máscara binaria, seguimiento de Moore.
     * Devuelve el polígono en coordenadas de imagen (bordes de píxel), que es
     * la convención que usan las ROI de este proyecto.
     */
    traceContour(mask, rows, cols) {
        // Primer píxel de la máscara en orden de barrido
        let sx = -1, sy = -1;
        for (let y = 0; y < rows && sy < 0; y++) {
            for (let x = 0; x < cols; x++) {
                if (mask[y * cols + x]) { sx = x; sy = y; break; }
            }
        }
        if (sy < 0) return null;

        const at = (x, y) => (x >= 0 && x < cols && y >= 0 && y < rows) ? mask[y * cols + x] : 0;

        // 8 vecinos en orden horario empezando arriba
        const N = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
        const pts = [];
        let cx = sx, cy = sy, dir = 0;
        const maxSteps = rows * cols * 4;

        for (let step = 0; step < maxSteps; step++) {
            pts.push({ x: cx + 0.5, y: cy + 0.5 });
            let found = false;
            // Empezar a buscar desde la dirección anterior girada a la izquierda
            for (let k = 0; k < 8; k++) {
                const d = (dir + 6 + k) % 8;
                const nx = cx + N[d][0], ny = cy + N[d][1];
                if (at(nx, ny)) { cx = nx; cy = ny; dir = d; found = true; break; }
            }
            if (!found) break;                                  // píxel aislado
            if (cx === sx && cy === sy && pts.length > 2) break; // vuelta completa
        }

        // Simplificar: un contorno de píxel a píxel tiene cientos de puntos
        return this.simplifyPolygon(pts, 0.75);
    },

    /** Simplificación Ramer-Douglas-Peucker, tolerancia en píxeles. */
    simplifyPolygon(pts, tol = 0.75) {
        if (pts.length <= 4) return pts;

        const perp = (p, a, b) => {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (!len) return Math.hypot(p.x - a.x, p.y - a.y);
            return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
        };

        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];

        while (stack.length) {
            const [i0, i1] = stack.pop();
            let worst = -1, wd = tol;
            for (let i = i0 + 1; i < i1; i++) {
                const d = perp(pts[i], pts[i0], pts[i1]);
                if (d > wd) { wd = d; worst = i; }
            }
            if (worst > 0) {
                keep[worst] = 1;
                stack.push([i0, worst], [worst, i1]);
            }
        }

        const out = [];
        for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
        return out.length >= 3 ? out : pts;
    },

    /* ════════════════════════════════════════════════════════
       6. Medición de un candidato

       Las cifras de un candidato se miden SOBRE SU CONTORNO con
       ResearchCore.maskStats, no sobre el conjunto de vóxeles
       detectados. Así el número que muestra el detector es
       idéntico al que sale si el usuario acepta la región y se
       convierte en ROI: misma función, mismos umbrales, mismo
       rasterizador. El recuento de vóxeles se informa aparte,
       como `detectedVoxels`, para que la diferencia sea visible.
       ════════════════════════════════════════════════════════ */

    /**
     * @param {object} component       de components3D
     * @param {Array} frames
     * @param {object} spacingInfo     de ResearchCore.sliceSpacing
     * @param {(z:number)=>object} midlineFor  línea media de cada corte
     * @param {object} threshold       {huMin, huMax} de exclusión del estudio
     */
    measureCandidate(component, frames, spacingInfo, midlineFor, threshold = {}, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };

        const bySlice = new Map();
        for (const v of component.voxels) {
            if (!bySlice.has(v.z)) bySlice.set(v.z, []);
            bySlice.get(v.z).push(v);
        }
        const slices = [...bySlice.keys()].sort((a, b) => a - b);

        const perSlice = [];
        let mm3 = 0;

        for (const z of slices) {
            const f = frames[z];
            if (!f) continue;

            const contour = this.componentContour(component, z, f.rows, f.cols);
            if (!contour || contour.length < 3) continue;

            const lesion = ResearchCore.maskStats({
                pixelData: f.pixelData, rows: f.rows, cols: f.cols,
                slope: f.rescaleSlope, intercept: f.rescaleIntercept,
                pixelSpacing: f.pixelSpacing,
                padding: f.pixelPaddingValue ?? null,
                paddingRangeLimit: f.pixelPaddingRangeLimit ?? null,
                huMin: threshold.huMin ?? null,
                huMax: threshold.huMax ?? null,
                bbox: ResearchCore.polygonBounds(contour),
                inside: (x, y) => ResearchCore.pointInPolygon(x + 0.5, y + 0.5, contour),
            });

            // Espejo contralateral: mismo contorno reflejado, igual que hace
            // la herramienta de NWU, de modo que las cifras coincidan.
            const mid = midlineFor ? midlineFor(z) : null;
            let mirror = null, mirrorContour = null;
            if (mid?.anterior && mid?.posterior) {
                mirrorContour = ResearchCore.reflectPolygon(
                    contour, mid.anterior, mid.posterior, f.pixelSpacing);
                mirror = ResearchCore.maskStats({
                    pixelData: f.pixelData, rows: f.rows, cols: f.cols,
                    slope: f.rescaleSlope, intercept: f.rescaleIntercept,
                    pixelSpacing: f.pixelSpacing,
                    padding: f.pixelPaddingValue ?? null,
                    paddingRangeLimit: f.pixelPaddingRangeLimit ?? null,
                    huMin: threshold.huMin ?? null,
                    huMax: threshold.huMax ?? null,
                    bbox: ResearchCore.polygonBounds(mirrorContour),
                    inside: (x, y) => ResearchCore.pointInPolygon(x + 0.5, y + 0.5, mirrorContour),
                });
            }

            const gap = (spacingInfo?.mean != null && Number.isFinite(spacingInfo.mean))
                ? spacingInfo.mean
                : (f.sliceThickness ?? 1);
            const vol = (lesion.areaTotalMm2 ?? 0) * gap;
            mm3 += vol;

            perSlice.push({
                sliceIndex: z,
                detectedVoxels: bySlice.get(z).length,
                contour, mirrorContour,
                lesion, mirror,
                gapMm: gap, volumeMm3: vol,
                nwu: ResearchCore.nwu(lesion.mean, mirror?.mean),
            });
        }

        if (!perSlice.length) return null;

        // Agregado ponderado por número de píxeles medidos
        const pooled = ResearchCore.nwuWeighted(perSlice.map(s => ({
            lesionMean:  s.lesion.mean,  lesionCount: s.lesion.count,
            contraMean:  s.mirror?.mean, contraCount: s.mirror?.count ?? 0,
        })));

        const allLesionValues = [];
        let minHu = Infinity, maxHu = -Infinity;
        for (const s of perSlice) {
            if (s.lesion.min != null && s.lesion.min < minHu) minHu = s.lesion.min;
            if (s.lesion.max != null && s.lesion.max > maxHu) maxHu = s.lesion.max;
            if (s.lesion.mean != null) allLesionValues.push(s.lesion.mean);
        }

        const centroid = this.componentCentroid(component);
        const refSlice = frames[centroid.z] || frames[perSlice[0].sliceIndex];
        const mid = midlineFor ? midlineFor(centroid.z) : null;
        const sideMm = (mid?.anterior && mid?.posterior)
            ? ResearchCore.perpendicularDistanceMm(
                  { x: centroid.x + 0.5, y: centroid.y + 0.5 },
                  mid.anterior, mid.posterior, refSlice?.pixelSpacing)
            : null;

        return {
            detectedVoxels: component.size,
            volumeMm3: mm3,
            volumeMl: mm3 / 1000,
            meanHu:   pooled.lesionMean,
            contraMeanHu: pooled.contraMean,
            nwu:      pooled.nwu,
            minHu: Number.isFinite(minHu) ? minHu : null,
            maxHu: Number.isFinite(maxHu) ? maxHu : null,
            measuredPixels: pooled.lesionCount,
            sliceRange: [perSlice[0].sliceIndex, perSlice[perSlice.length - 1].sliceIndex],
            sliceCount: perSlice.length,
            centroid,
            sideMm,
            perSlice,
            threshold: { huMin: threshold.huMin ?? null, huMax: threshold.huMax ?? null },
        };
    },

    /* ════════════════════════════════════════════════════════
       7. Detector de hemorragia (hiperdensidad)

       Basado en densidad absoluta, no en asimetría: una hemorragia
       bilateral o que cruza la línea media existe y un método por
       asimetría no la vería.
       ════════════════════════════════════════════════════════ */

    hemorrhageMasks(frames, slices, maskOf, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };
        const masks = new Array(frames.length).fill(null);
        for (const z of slices) {
            const f = frames[z];
            const bm = maskOf(z);
            if (!f || !bm) continue;
            const slope     = f.rescaleSlope ?? 1;
            const intercept = f.rescaleIntercept ?? 0;
            const n = f.rows * f.cols;
            const m = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                if (!bm[i]) continue;
                const hu = ResearchCore.toHU(f.pixelData[i], slope, intercept);
                if (hu >= o.hemHuMin && hu <= o.hemHuMax) m[i] = 1;
            }
            masks[z] = this._closeCandidates(m, f, bm, o);
        }
        return masks;
    },

    /**
     * Cierra la máscara de candidatos y la recorta a la máscara de cerebro.
     * Sin esto, el ruido deja píxeles sueltos rechazados dentro de la lesión y
     * una frontera dentada, y el contorno pierde en torno a un 8 % de área.
     */
    _closeCandidates(m, frame, brainMask, o) {
        let out = m;
        const { rows, cols, pixelSpacing } = frame;

        // Primero fuera el moteado: el cierre NO lo quita (dilatar y erosionar
        // devuelve el píxel aislado tal cual), así que sin este filtro el
        // candidato se encadena por el ruido a través de cortes vacíos.
        out = this.removeSmallComponents(out, rows, cols, o.candidateMinPx);

        // Cierre después: tapa los huecos que el ruido dejó DENTRO de la lesión
        // y alisa la frontera dentada. Sin fillHoles: rellenar agujeros aquí
        // sería demasiado agresivo — un candidato anular (una colección que
        // abraza la tabla interna) se volvería un disco macizo.
        const closeOffs = o.candidateCloseMm
            ? this.discOffsets(o.candidateCloseMm, pixelSpacing) : [];
        if (closeOffs.length > 1) out = this.close(out, rows, cols, closeOffs);

        if (out === m) out = Uint8Array.from(m);
        for (let i = 0; i < out.length; i++) if (!brainMask[i]) out[i] = 0;
        return out;
    },

    /**
     * Banda periférica del cerebro: todo lo que está a menos de `mm` del borde
     * de la máscara. Sirve para distinguir una colección que abraza la tabla
     * interna de un hematoma con núcleo profundo.
     */
    peripheralBand(brainMask, rows, cols, mm, pixelSpacing) {
        const n = rows * cols;
        const outside = new Uint8Array(n);
        for (let i = 0; i < n; i++) outside[i] = brainMask[i] ? 0 : 1;
        const grown = this.dilate(outside, rows, cols, this.discOffsets(mm, pixelSpacing));
        const band = new Uint8Array(n);
        for (let i = 0; i < n; i++) band[i] = (brainMask[i] && grown[i]) ? 1 : 0;
        return band;
    },

    /* ════════════════════════════════════════════════════════
       8. Detector de isquemia instaurada (hipodensidad)
       ════════════════════════════════════════════════════════ */

    ischemiaMasks(frames, slices, maskOf, asymOf, mirrorIdxOf, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };
        const masks = new Array(frames.length).fill(null);
        for (const z of slices) {
            const f = frames[z];
            const bm = maskOf(z);
            const asym = asymOf(z);
            const mi = mirrorIdxOf ? mirrorIdxOf(z) : null;
            if (!f || !bm || !asym) continue;
            const slope     = f.rescaleSlope ?? 1;
            const intercept = f.rescaleIntercept ?? 0;
            const n = f.rows * f.cols;
            const m = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                if (!bm[i]) continue;
                const a = asym[i];
                if (Number.isNaN(a) || a > o.ischAsymHu) continue;
                const hu = ResearchCore.toHU(f.pixelData[i], slope, intercept);
                if (hu < o.ischHuMin || hu > o.ischHuMax) continue;

                // El lado de referencia tiene que ser parénquima normal.
                // Sin esta comprobación, el tejido SANO enfrentado a una
                // hemorragia contralateral se lee como hipodenso —
                // la asimetría es real pero la lectura es la contraria.
                if (mi) {
                    const j = mi[i];
                    if (j < 0) continue;
                    const huM = ResearchCore.toHU(f.pixelData[j], slope, intercept);
                    if (huM < o.ischHuMin || huM > o.ischHuMax) continue;
                }
                m[i] = 1;
            }
            let out = this._closeCandidates(m, f, bm, o);
            if (o.ischDilateMm > 0) {
                out = this.dilate(out, f.rows, f.cols,
                                  this.discOffsets(o.ischDilateMm, f.pixelSpacing));
                for (let i = 0; i < out.length; i++) if (!bm[i]) out[i] = 0;
            }
            masks[z] = out;
        }
        return masks;
    },

    /* ════════════════════════════════════════════════════════
       9. Isquemia precoz por sectores

       A 2-6 UH la asimetría está por debajo del ruido píxel a
       píxel, así que se mide por regiones. El marco es polar sobre
       la línea media: el espejo de (s, t) es (s, −t), así que
       θ → −θ y los bins de |θ| × r son mirror-congruentes POR
       CONSTRUCCIÓN. No hace falta reflejar polígonos ni interpolar.
       ════════════════════════════════════════════════════════ */

    /** Etiquetas de lado a partir de ImageOrientationPatient. */
    sideLabelsFromOrientation(imageOrientation) {
        // Axial estándar: fila = [1,0,0] = +X del paciente = izquierda del paciente.
        // Columna de imagen creciente → lado izquierdo del paciente.
        const iop = imageOrientation;
        if (!iop || iop.length < 6) {
            return { pos: 'lado +', neg: 'lado −', assumed: true };
        }
        const rowX = iop[0];
        if (Math.abs(rowX) > 0.7) {
            return rowX > 0
                ? { pos: 'izquierdo', neg: 'derecho', assumed: false }
                : { pos: 'derecho', neg: 'izquierdo', assumed: false };
        }
        return { pos: 'lado +', neg: 'lado −', assumed: true };
    },

    /**
     * @param {boolean} [withLabels] devuelve además un mapa por píxel con el
     *        índice del sector al que pertenece (−1 fuera), para pintar.
     */
    sectorMap(frame, mask, midline, opts = {}, withLabels = false) {
        const o = { ...this.DEFAULTS, ...opts };
        const { pixelData, rows, cols } = frame;
        const slope     = frame.rescaleSlope ?? 1;
        const intercept = frame.rescaleIntercept ?? 0;
        const [rs, cs]  = frame.pixelSpacing || [1, 1];

        const A = midline.anterior, P = midline.posterior;
        // Marco en mm
        const ax = A.x * cs, ay = A.y * rs;
        const px = P.x * cs, py = P.y * rs;
        const ox = (ax + px) / 2, oy = (ay + py) / 2;
        let ux = px - ax, uy = py - ay;
        const ulen = Math.hypot(ux, uy);
        if (!ulen) return { sectors: [], warnings: ['Línea media degenerada.'] };
        ux /= ulen; uy /= ulen;
        const vx = -uy, vy = ux;          // perpendicular

        const nAng = o.angBins, nRad = o.radBins;
        const PI = Math.PI;

        // ── Pasada 1: radio máximo por bin angular ──────────────
        // Histograma de 1 mm y percentil 98: robusto frente a una esquirla
        // de máscara que inflaría el radio y comprimiría todas las bandas.
        const HB = 400;
        const hist = Array.from({ length: nAng }, () => new Uint32Array(HB));
        const histN = new Uint32Array(nAng);

        const geomOf = (x, y) => {
            const dx = (x + 0.5) * cs - ox;
            const dy = (y + 0.5) * rs - oy;
            const s = dx * ux + dy * uy;
            const t = dx * vx + dy * vy;
            return { s, t, r: Math.hypot(s, t), th: Math.atan2(t, s) };
        };

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (!mask[y * cols + x]) continue;
                const g = geomOf(x, y);
                if (Math.abs(g.t) < o.midlineBandMm) continue;
                const ab = Math.min(nAng - 1, Math.floor(Math.abs(g.th) / (PI / nAng)));
                const rb = Math.min(HB - 1, Math.round(g.r));
                hist[ab][rb]++; histN[ab]++;
            }
        }

        const rMax = new Float64Array(nAng);
        for (let a = 0; a < nAng; a++) {
            if (!histN[a]) { rMax[a] = 0; continue; }
            const target = histN[a] * 0.98;
            let cum = 0, k = 0;
            for (; k < HB; k++) { cum += hist[a][k]; if (cum >= target) break; }
            rMax[a] = Math.max(1, k);
        }

        // ── Pasada 2: acumular UH por (lado, binAngular, binRadial) ──
        const slots = nAng * nRad * 2;
        const sum   = new Float64Array(slots);
        const sumSq = new Float64Array(slots);
        const cnt   = new Uint32Array(slots);
        const slotOf = (side, a, r) => ((side === 1 ? 1 : 0) * nAng + a) * nRad + r;
        const pixLabels = withLabels ? new Int16Array(rows * cols).fill(-1) : null;

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (!mask[i]) continue;
                const g = geomOf(x, y);
                if (Math.abs(g.t) < o.midlineBandMm) continue;
                const a = Math.min(nAng - 1, Math.floor(Math.abs(g.th) / (PI / nAng)));
                if (!rMax[a]) continue;
                const rb = Math.min(nRad - 1, Math.floor(g.r / rMax[a] * nRad));
                const side = g.t >= 0 ? 1 : -1;
                const hu = ResearchCore.toHU(pixelData[i], slope, intercept);
                const sl = slotOf(side, a, rb);
                sum[sl] += hu; sumSq[sl] += hu * hu; cnt[sl]++;
                // Índice del PAR de sectores (no del lado): es lo que se pinta
                if (pixLabels) pixLabels[i] = a * nRad + rb;
            }
        }

        // ── Pares de sectores ────────────────────────────────────
        const statOf = (sl) => {
            const n = cnt[sl];
            if (!n) return { mean: null, std: null, count: 0 };
            const mean = sum[sl] / n;
            const varr = Math.max(0, sumSq[sl] / n - mean * mean);
            return { mean, std: Math.sqrt(varr), count: n };
        };

        const labels = this.sideLabelsFromOrientation(frame.imageOrientation);
        const sectors = [];

        for (let a = 0; a < nAng; a++) {
            for (let r = 0; r < nRad; r++) {
                const pos = statOf(slotOf(1, a, r));
                const neg = statOf(slotOf(-1, a, r));
                const usable = pos.count >= o.sectorMinPx && neg.count >= o.sectorMinPx;

                let deltaHu = null, z = null, nwu = null, hypodenseSide = null;
                if (usable) {
                    const lo = pos.mean <= neg.mean ? pos : neg;
                    const hi = pos.mean <= neg.mean ? neg : pos;
                    hypodenseSide = pos.mean <= neg.mean ? 'pos' : 'neg';
                    deltaHu = lo.mean - hi.mean;            // ≤ 0 por construcción
                    const se = Math.sqrt(lo.std * lo.std / lo.count + hi.std * hi.std / hi.count);
                    z = se > 0 ? deltaHu / se : null;
                    nwu = ResearchCore.nwu(lo.mean, hi.mean);
                }

                sectors.push({
                    angBin: a, radBin: r,
                    angFromDeg: Math.round(a * 180 / nAng),
                    angToDeg:   Math.round((a + 1) * 180 / nAng),
                    radMaxMm:   rMax[a],
                    pos, neg, usable,
                    deltaHu, z, nwu, hypodenseSide,
                    hypodenseLabel: hypodenseSide
                        ? (hypodenseSide === 'pos' ? labels.pos : labels.neg) : null,
                    flagged: !!(usable && deltaHu <= o.sectorDeltaHu &&
                                z != null && Math.abs(z) >= o.sectorZ),
                });
            }
        }

        const warnings = [];
        if (labels.assumed) {
            warnings.push('Sin ImageOrientationPatient utilizable: no se puede decir qué lado ' +
                          'es el derecho y el izquierdo del paciente.');
        }
        const unusable = sectors.filter(s => !s.usable).length;
        if (unusable) {
            warnings.push(`${unusable} de ${sectors.length} sectores sin píxeles suficientes ` +
                          `(mínimo ${o.sectorMinPx} por lado); no se evalúan.`);
        }

        return {
            sectors,
            frame: { origin: { x: ox / cs, y: oy / rs }, u: [ux, uy], v: [vx, vy] },
            sideLabels: labels,
            flaggedCount: sectors.filter(s => s.flagged).length,
            pixelLabels: pixLabels,
            warnings,
        };
    },

    /* ════════════════════════════════════════════════════════
       12. Overlay

       Se genera a resolución de IMAGEN, no de canvas: el que lo
       pinta lo coloca con la misma transformación afín que usa el
       render, derivada de tres puntos de imageToCanvas. Así queda
       alineado con cualquier zoom, desplazamiento, volteo y
       rotación sin tocar el renderer WebGL.
       ════════════════════════════════════════════════════════ */

    /**
     * @param {object} req
     * @param {object} req.frame
     * @param {object} req.midline
     * @param {'asymmetry'|'sectors'} [req.mode='asymmetry']
     * @returns {{rgba:Uint8ClampedArray, width:number, height:number, empty:boolean}}
     */
    renderOverlay(req) {
        const { frame, midline, mode = 'asymmetry' } = req;
        const o = { ...this.DEFAULTS, ...(req.opts || {}) };
        const { rows, cols } = frame;
        const rgba = new Uint8ClampedArray(rows * cols * 4);
        const out = { rgba, width: cols, height: rows, empty: true };
        if (!midline?.anterior || !midline?.posterior) return out;

        const bm = this.brainMask(frame, o);
        if (!bm.ok) return out;

        const clip  = o.overlayClipHu;

        // Azul = hipodenso respecto al contralateral; rojo = hiperdenso.
        const paint = (i, v, floor, aMul = 1) => {
            if (!o.overlayBothSides && v > 0) return;
            const m = Math.abs(v);
            if (m < floor) return;
            const t = Math.min(1, (m - floor) / Math.max(0.001, clip - floor));
            const a = Math.round(255 * Math.min(1, 0.18 + 0.72 * t) * aMul);
            if (v < 0) { rgba[i * 4] = 40;  rgba[i * 4 + 1] = 130; rgba[i * 4 + 2] = 255; }
            else       { rgba[i * 4] = 255; rgba[i * 4 + 1] = 90;  rgba[i * 4 + 2] = 40; }
            rgba[i * 4 + 3] = a;
            out.empty = false;
        };

        if (mode === 'sectors') {
            const sm = this.sectorMap(frame, bm.eroded, midline, o, true);
            const labels = sm.pixelLabels;
            if (!labels) return out;
            const nRad = o.radBins;
            for (let i = 0; i < labels.length; i++) {
                const L = labels[i];
                if (L < 0) continue;
                const s = sm.sectors[L];
                if (!s?.usable || s.deltaHu == null) continue;
                // Solo se tiñen los sectores marcados; el resto quedaría como
                // un mosaico de colores que no significa nada.
                if (!s.flagged) continue;
                // Umbral regional: aquí ΔUH es una media de cientos de píxeles
                paint(i, s.deltaHu, Math.abs(o.sectorDeltaHu), 0.85);
            }
            out.sectors = sm.sectors;
            return out;
        }

        const { asym } = this.asymmetryMap(frame, bm.eroded, midline, o);
        for (let i = 0; i < asym.length; i++) {
            const a = asym[i];
            if (!Number.isNaN(a)) paint(i, a, o.overlayFloorHu);
        }
        return out;
    },

    /* ════════════════════════════════════════════════════════
       10. Sonda ASPECTS

       Aproximación por sonda circular estandarizada, NO
       segmentación de territorio completo. Menos exhaustiva que
       delinear la región entera, y bastante más reproducible entre
       lectores — que es lo que importa para comparar.
       ════════════════════════════════════════════════════════ */

    aspectsProbe(frame, seed, midline, threshold = {}, opts = {}) {
        const o = { ...this.DEFAULTS, ...opts };
        const [rs, cs] = frame.pixelSpacing || [1, 1];
        const rx = o.probeRadiusMm / cs;
        const ry = o.probeRadiusMm / rs;

        const probe = ResearchCore.polygonFromEllipse(seed.x, seed.y, rx, ry, 72);
        const mirror = ResearchCore.reflectPolygon(
            probe, midline.anterior, midline.posterior, frame.pixelSpacing);

        const measure = (poly) => ResearchCore.maskStats({
            pixelData: frame.pixelData, rows: frame.rows, cols: frame.cols,
            slope: frame.rescaleSlope, intercept: frame.rescaleIntercept,
            pixelSpacing: frame.pixelSpacing,
            padding: frame.pixelPaddingValue ?? null,
            paddingRangeLimit: frame.pixelPaddingRangeLimit ?? null,
            huMin: threshold.huMin ?? null,
            huMax: threshold.huMax ?? null,
            bbox: ResearchCore.polygonBounds(poly),
            inside: (x, y) => ResearchCore.pointInPolygon(x + 0.5, y + 0.5, poly),
        });

        const a = measure(probe);
        const b = measure(mirror);

        let deltaHu = null, z = null;
        if (a.mean != null && b.mean != null && a.count && b.count) {
            deltaHu = a.mean - b.mean;
            const se = Math.sqrt(a.std * a.std / a.count + b.std * b.std / b.count);
            z = se > 0 ? deltaHu / se : null;
        }

        return {
            probe, mirror,
            probeStats: a, mirrorStats: b,
            deltaHu, z,
            nwu: ResearchCore.nwu(a.mean, b.mean),
            radiusMm: o.probeRadiusMm,
            flagged: !!(deltaHu != null && deltaHu <= o.sectorDeltaHu &&
                        z != null && Math.abs(z) >= o.sectorZ),
        };
    },

    /* ════════════════════════════════════════════════════════
       11. Análisis de una serie completa
       ════════════════════════════════════════════════════════ */

    /**
     * @param {object} req
     * @param {Array}  req.frames
     * @param {object} req.midlines   mapa z → {anterior, posterior, source, confidence}
     * @param {Array<number>} [req.slices]  cortes a analizar (por defecto todos)
     * @param {object} [req.threshold]      exclusión de UH para medir
     * @param {object} [req.opts]
     */
    analyzeSeries(req) {
        const frames = req.frames || [];
        const o = { ...this.DEFAULTS, ...(req.opts || {}) };
        const threshold = req.threshold || {};
        const slices = (req.slices && req.slices.length)
            ? req.slices.filter(z => frames[z])
            : frames.map((_, i) => i);

        const warnings = [];
        const spacing = ResearchCore.sliceSpacing(frames, slices);
        warnings.push(...spacing.warnings);

        const midlineFor = (z) => (req.midlines && req.midlines[z]) || null;

        // ── Máscaras y asimetría por corte ──────────────────────
        const brain = new Array(frames.length).fill(null);
        const asym  = new Array(frames.length).fill(null);
        const mirrorIdx = new Array(frames.length).fill(null);
        const perSlice = [];
        let noMidline = 0, lowConfidence = 0;

        for (const z of slices) {
            const f = frames[z];
            const bm = this.brainMask(f, o);
            brain[z] = bm;

            const mid = midlineFor(z);
            const entry = {
                sliceIndex: z,
                brainPixels: bm.count,
                brainOk: bm.ok,
                midlineSource: mid?.source ?? null,
                midlineConfidence: mid?.confidence ?? null,
                analyzed: false,
            };

            if (!bm.ok) { perSlice.push(entry); continue; }
            if (!mid?.anterior || !mid?.posterior) { noMidline++; perSlice.push(entry); continue; }
            if (mid.source !== 'manual' && mid.source !== 'confirmed' &&
                (mid.confidence ?? 0) < 0.4) lowConfidence++;

            const am = this.asymmetryMap(f, bm.eroded, mid, o);
            asym[z] = am.asym;
            mirrorIdx[z] = am.mirrorIdx;
            entry.analyzed = true;

            const sm = this.sectorMap(f, bm.eroded, mid, o);
            entry.sectors = sm.sectors;
            entry.sectorsFlagged = sm.flaggedCount;
            entry.sideLabels = sm.sideLabels;
            entry.sectorWarnings = sm.warnings;

            perSlice.push(entry);
        }

        const analyzed = perSlice.filter(s => s.analyzed).map(s => s.sliceIndex);
        if (noMidline) {
            warnings.push(`${noMidline} corte(s) sin línea media definida: no se analizaron.`);
        }
        if (lowConfidence) {
            warnings.push(`${lowConfidence} corte(s) con línea media estimada de baja ` +
                          `confianza. Confirmala o corregila antes de fiarte del resultado.`);
        }
        if (!analyzed.length) {
            return { hemorrhage: [], ischemia: [], perSlice, spacing, analyzed: [],
                     warnings: [...warnings, 'Ningún corte analizable.'] };
        }

        const maskOf = (z) => brain[z]?.eroded || null;
        const asymOf = (z) => asym[z] || null;
        const mirrorOf = (z) => mirrorIdx[z] || null;

        // ── Isquemia instaurada ─────────────────────────────────
        const ischMasks = this.ischemiaMasks(frames, analyzed, maskOf, asymOf, mirrorOf, o);
        const ischComps = this.components3D(ischMasks, frames[analyzed[0]].rows, frames[analyzed[0]].cols);

        const ischemia = [];
        for (const c of ischComps) {
            const m = this.measureCandidate(c, frames, spacing, midlineFor, threshold, o);
            if (!m || m.volumeMl < o.ischMinVolMl) continue;
            ischemia.push({
                kind: 'hypodense',
                ...m,
                asymMeanHu: this._meanAsym(c, asym, frames),
                hemisphereLabel: this._sideLabel(m.sideMm, frames[m.centroid.z]),
                flags: this._ischemiaFlags(m, o),
            });
        }

        // ── Hemorragia ──────────────────────────────────────────
        const hemMasks = this.hemorrhageMasks(frames, analyzed, maskOf, o);
        const hemComps = this.components3D(hemMasks, frames[analyzed[0]].rows, frames[analyzed[0]].cols);

        // Banda periférica por corte, para distinguir extraaxial
        const bands = new Array(frames.length).fill(null);
        for (const z of analyzed) {
            const f = frames[z];
            bands[z] = this.peripheralBand(brain[z].eroded, f.rows, f.cols,
                                           o.extraAxialMm, f.pixelSpacing);
        }

        const hemorrhage = [];
        for (const c of hemComps) {
            // Sin umbrales de exclusión: aquí la densidad alta ES la señal
            const m = this.measureCandidate(c, frames, spacing, midlineFor, {}, o);
            if (!m || m.volumeMl < o.hemMinVolMl) continue;

            let inBand = 0;
            for (const v of c.voxels) if (bands[v.z]?.[v.y * frames[v.z].cols + v.x]) inBand++;
            const peripheralFraction = c.size ? inBand / c.size : 0;

            hemorrhage.push({
                kind: 'hyperdense',
                ...m,
                peripheralFraction,
                hemisphereLabel: this._sideLabel(m.sideMm, frames[m.centroid.z]),
                flags: this._hemorrhageFlags(m, peripheralFraction, o),
            });
        }

        // Calcificación fisiológica: contrapartida simétrica de densidad similar
        this._markSymmetricPairs(hemorrhage, frames, midlineFor);

        warnings.push(
            'Método por asimetría: una lesión bilateral y simétrica, o que cruza la línea ' +
            'media, es invisible para el detector de isquemia por construcción.',
            'No se intenta detectar hemorragia subaracnoidea.',
            'La fosa posterior y la base del cráneo dan artefacto de endurecimiento del haz: ' +
            'la asimetría ahí es poco fiable.',
            'El detector mide densidad, no cronología: un infarto antiguo, la leucoaraiosis ' +
            'asimétrica y un quiste aracnoideo dan la misma firma que un infarto agudo.'
        );

        return { hemorrhage, ischemia, perSlice, spacing, analyzed, warnings,
                 params: { ...o, threshold } };
    },

    /** Asimetría media del componente, en UH. Solo informativa. */
    _meanAsym(component, asym, frames) {
        let sum = 0, n = 0;
        for (const v of component.voxels) {
            const arr = asym[v.z];
            const f = frames[v.z];
            if (!arr || !f) continue;
            const a = arr[v.y * f.cols + v.x];
            if (!Number.isNaN(a)) { sum += a; n++; }
        }
        return n ? sum / n : null;
    },

    _sideLabel(sideMm, frame) {
        if (sideMm == null) return null;
        const labels = this.sideLabelsFromOrientation(frame?.imageOrientation);
        return sideMm >= 0 ? labels.pos : labels.neg;
    },

    _ischemiaFlags(m, o) {
        const flags = [];
        if (m.nwu == null) {
            flags.push({ code: 'sin-contralateral',
                         text: 'No se pudo medir la región contralateral: NWU no calculable.' });
        }
        if (m.maxHu != null && m.maxHu > o.hemHuMin) {
            flags.push({ code: 'densidad-mixta',
                         text: `Contiene píxeles de hasta ${m.maxHu.toFixed(0)} UH: ` +
                               `puede haber componente hemorrágico o calcio.` });
        }
        if (m.sliceCount === 1) {
            flags.push({ code: 'un-corte',
                         text: 'Presente en un solo corte: el volumen depende del espaciado.' });
        }
        return flags;
    },

    _hemorrhageFlags(m, peripheralFraction, o) {
        const flags = [];
        if (m.maxHu != null && m.maxHu >= o.calcHuMin) {
            flags.push({ code: 'posible-calcificacion',
                         text: `Máximo ${m.maxHu.toFixed(0)} UH, por encima de ${o.calcHuMin}: ` +
                               `posible calcificación (pineal, plexos coroideos, hoz, ganglios basales).` });
        }
        if (peripheralFraction > 0.8) {
            flags.push({ code: 'sugiere-extraaxial',
                         text: `${Math.round(peripheralFraction * 100)} % del volumen está en los ` +
                               `${o.extraAxialMm} mm periféricos: sugiere colección extraaxial ` +
                               `más que hematoma parenquimatoso.` });
        }
        if (m.sliceCount === 1) {
            flags.push({ code: 'un-corte',
                         text: 'Presente en un solo corte: el volumen depende del espaciado.' });
        }
        return flags;
    },

    /**
     * Marca pares de candidatos hiperdensos que son espejo uno del otro con
     * densidad parecida: patrón típico de calcificación fisiológica bilateral
     * de ganglios basales o plexos coroideos.
     */
    _markSymmetricPairs(candidates, frames, midlineFor) {
        for (let i = 0; i < candidates.length; i++) {
            for (let j = i + 1; j < candidates.length; j++) {
                const a = candidates[i], b = candidates[j];
                if (a.sideMm == null || b.sideMm == null) continue;
                if (Math.sign(a.sideMm) === Math.sign(b.sideMm)) continue;

                const f = frames[a.centroid.z];
                const mid = midlineFor(a.centroid.z);
                if (!f || !mid?.anterior) continue;

                const refl = ResearchCore.reflectPointOverLine(
                    { x: a.centroid.x, y: a.centroid.y },
                    mid.anterior, mid.posterior, f.pixelSpacing);
                const dist = ResearchCore.distanceMm(
                    refl, { x: b.centroid.x, y: b.centroid.y }, f.pixelSpacing);
                const dHu = (a.meanHu != null && b.meanHu != null)
                    ? Math.abs(a.meanHu - b.meanHu) : Infinity;

                if (dist < 12 && dHu < 15) {
                    const text = 'Tiene contrapartida simétrica de densidad similar en el ' +
                                 'hemisferio contralateral: patrón de calcificación fisiológica.';
                    a.flags.push({ code: 'contrapartida-simetrica', text });
                    b.flags.push({ code: 'contrapartida-simetrica', text });
                }
            }
        }
    },
};

/* Exportación dual: global de navegador + CommonJS para node --test.
   En Node hay que colgar ResearchCore de globalThis porque los métodos de
   arriba lo resuelven por cadena de ámbitos, igual que en el navegador. */
if (typeof module !== 'undefined' && module.exports) {
    if (typeof globalThis.ResearchCore === 'undefined') {
        globalThis.ResearchCore = require('./research-core.js');
    }
    module.exports = DetectCore;
}
