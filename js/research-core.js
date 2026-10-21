'use strict';

/* ============================================================
   ResearchCore — Cálculo puro para mediciones de investigación.

   Este módulo NO toca el DOM, el canvas, WebGL ni ningún estado
   global. Todas sus funciones son deterministas y dependen solo
   de sus argumentos. Es el único sitio del proyecto donde se
   convierte a UH, se excluye padding y se aplican umbrales, de
   modo que las ROI existentes (elipse, rectángulo, libre) y las
   nuevas de NWU comparten exactamente el mismo rasterizador.

   Se carga como global de navegador (<script defer>, igual que el
   resto del proyecto) y también se exporta como módulo CommonJS
   para que `node --test` pruebe el código real que corre en
   producción, no una copia.

   Convenios:
   - Coordenadas de imagen: x = columna, y = fila, en índices de
     píxel. Origen (0,0) en el centro del píxel superior izquierdo.
   - pixelSpacing es SIEMPRE [rowSpacing, colSpacing] en mm,
     igual que el tag DICOM x00280030 — es decir [mm/fila, mm/col]
     = [mm por unidad de y, mm por unidad de x].
   ============================================================ */

const ResearchCore = {

    /* ════════════════════════════════════════════════════════
       1. Conversión a Unidades Hounsfield
       ════════════════════════════════════════════════════════ */

    /**
     * Valor almacenado → UH. Única definición en el proyecto.
     * @param {number} raw       valor del píxel tal como está almacenado
     * @param {number} slope     RescaleSlope (x00281053)
     * @param {number} intercept RescaleIntercept (x00281052)
     */
    toHU(raw, slope, intercept) {
        return raw * (slope ?? 1) + (intercept ?? 0);
    },

    /**
     * ¿Es este valor almacenado padding fuera del FOV?
     * Se compara contra el valor ALMACENADO, no contra UH — así lo
     * define la norma DICOM (PS3.3 C.7.5.1.1.2).
     * @param {number} raw
     * @param {number|null} padding    PixelPaddingValue (x00280120)
     * @param {number|null} rangeLimit PixelPaddingRangeLimit (x00280121)
     */
    isPadding(raw, padding, rangeLimit) {
        if (padding == null) return false;
        if (rangeLimit == null) return raw === padding;
        // Con RangeLimit, el padding es un intervalo cerrado.
        const lo = Math.min(padding, rangeLimit);
        const hi = Math.max(padding, rangeLimit);
        return raw >= lo && raw <= hi;
    },

    /* ════════════════════════════════════════════════════════
       2. Estadística descriptiva
       ════════════════════════════════════════════════════════ */

    /**
     * Estadísticas sobre un conjunto de valores ya en UH.
     * Precisión completa: el redondeo es responsabilidad de quien
     * muestra el dato, nunca de quien lo calcula.
     * @param {ArrayLike<number>} values
     * @returns {{mean:number|null, std:number|null, median:number|null,
     *            min:number|null, max:number|null, count:number}}
     */
    computeStats(values) {
        const n = values.length;
        if (!n) return { mean: null, std: null, median: null, min: null, max: null, count: 0 };

        let sum = 0, min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const mean = sum / n;

        // Desviación estándar poblacional (divide por n, no n-1): la ROI
        // ES la población de interés, no una muestra de ella.
        let sq = 0;
        for (let i = 0; i < n; i++) {
            const d = values[i] - mean;
            sq += d * d;
        }
        const std = Math.sqrt(sq / n);

        // Mediana sobre una copia ordenada — no mutar la entrada.
        const sorted = Float64Array.from(values).sort();
        const mid = n >> 1;
        const median = (n % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

        return { mean, std, median, min, max, count: n };
    },

    /* ════════════════════════════════════════════════════════
       3. Rasterizador único de ROI
       ════════════════════════════════════════════════════════ */

    /**
     * Recorre una región, convierte a UH, excluye padding y aplica
     * umbrales. Es el único camino por el que se miden UH en la app.
     *
     * @param {object} o
     * @param {ArrayLike<number>} o.pixelData  valores almacenados
     * @param {number} o.rows
     * @param {number} o.cols
     * @param {number} [o.slope=1]
     * @param {number} [o.intercept=0]
     * @param {number|null} [o.padding]        PixelPaddingValue
     * @param {number|null} [o.paddingRangeLimit]
     * @param {number|null} [o.huMin]          excluir UH < huMin
     * @param {number|null} [o.huMax]          excluir UH > huMax
     * @param {[number,number]} [o.pixelSpacing=[1,1]]
     * @param {{x0:number,y0:number,x1:number,y1:number}} o.bbox  en índices de píxel, inclusivo
     * @param {(x:number,y:number)=>boolean} o.inside  test de pertenencia; recibe
     *        índices ENTEROS de píxel. Cada tipo de ROI mantiene su propio
     *        convenio (centro de píxel, etc.) para no alterar qué píxeles
     *        entraban antes en cada herramienta.
     * @returns {object} estadísticas + contadores de exclusión + áreas
     */
    maskStats(o) {
        const {
            pixelData, rows, cols,
            slope = 1, intercept = 0,
            padding = null, paddingRangeLimit = null,
            huMin = null, huMax = null,
            pixelSpacing = [1, 1],
            bbox, inside,
        } = o;

        const [rs, cs] = pixelSpacing || [1, 1];

        const x0 = Math.max(0, Math.floor(bbox.x0));
        const x1 = Math.min(cols - 1, Math.ceil(bbox.x1));
        const y0 = Math.max(0, Math.floor(bbox.y0));
        const y1 = Math.min(rows - 1, Math.ceil(bbox.y1));

        const capacity = Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1));
        const values = new Float64Array(capacity);

        let n = 0;
        let inMask = 0, excludedPadding = 0, excludedLow = 0, excludedHigh = 0;

        for (let y = y0; y <= y1; y++) {
            const row = y * cols;
            for (let x = x0; x <= x1; x++) {
                if (!inside(x, y)) continue;
                inMask++;

                const raw = pixelData[row + x];
                if (this.isPadding(raw, padding, paddingRangeLimit)) { excludedPadding++; continue; }

                const hu = this.toHU(raw, slope, intercept);
                if (huMin != null && hu < huMin) { excludedLow++;  continue; }
                if (huMax != null && hu > huMax) { excludedHigh++; continue; }

                values[n++] = hu;
            }
        }

        const stats = this.computeStats(values.subarray(0, n));
        const pixelAreaMm2 = cs * rs;

        return {
            ...stats,
            areaMm2:         n * pixelAreaMm2,       // área de los píxeles MEDIDOS
            areaTotalMm2:    inMask * pixelAreaMm2,  // área encerrada por la ROI
            pixelsInMask:    inMask,
            excludedPadding,
            excludedLow,
            excludedHigh,
            excludedTotal:   excludedPadding + excludedLow + excludedHigh,
            thresholdHuMin:  huMin,
            thresholdHuMax:  huMax,
        };
    },

    /* ════════════════════════════════════════════════════════
       4. Geometría
       ════════════════════════════════════════════════════════ */

    /** Test punto-en-polígono por cruce de rayos (ray casting). */
    pointInPolygon(x, y, pts) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y;
            const xj = pts[j].x, yj = pts[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    },

    /** Caja contenedora de un polígono, en índices de píxel. */
    polygonBounds(pts) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) {
            if (p.x < x0) x0 = p.x;
            if (p.x > x1) x1 = p.x;
            if (p.y < y0) y0 = p.y;
            if (p.y > y1) y1 = p.y;
        }
        return { x0, y0, x1, y1 };
    },

    /** Área de un polígono por la fórmula del cordón (shoelace), en mm². */
    polygonAreaMm2(pts, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        let acc = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            acc += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
        }
        return Math.abs(acc / 2) * cs * rs;
    },

    /**
     * Muestrea una elipse alineada con los ejes como polígono.
     * La ROI espejo de NWU es siempre un polígono: reflejar una elipse
     * sobre una línea media inclinada da una elipse ROTADA, y el
     * renderer de elipse del proyecto no tiene campo de rotación.
     * Muestrear evita tocar ese camino de código.
     */
    polygonFromEllipse(cx, cy, rx, ry, n = 180) {
        const pts = new Array(n);
        for (let i = 0; i < n; i++) {
            const t = (i / n) * Math.PI * 2;
            pts[i] = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
        }
        return pts;
    },

    /**
     * Refleja un punto sobre la recta que pasa por a y b.
     *
     * La reflexión se hace en espacio MÉTRICO (mm), no en índices de
     * píxel: con PixelSpacing anisotrópico el espejo anatómicamente
     * correcto es el métrico. Con spacing isotrópico —el caso normal
     * en TC axial— ambos coinciden exactamente.
     */
    reflectPointOverLine(p, a, b, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        // A mm
        const px = p.x * cs, py = p.y * rs;
        const ax = a.x * cs, ay = a.y * rs;
        const bx = b.x * cs, by = b.y * rs;

        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return { x: p.x, y: p.y };   // línea degenerada: identidad

        const t = ((px - ax) * dx + (py - ay) * dy) / len2;
        const projX = ax + t * dx;
        const projY = ay + t * dy;

        // Reflejado = 2·proyección − original, y de vuelta a índices de píxel
        return {
            x: (2 * projX - px) / cs,
            y: (2 * projY - py) / rs,
        };
    },

    /** Refleja un polígono completo. Conserva forma y área métrica. */
    reflectPolygon(pts, a, b, pixelSpacing = [1, 1]) {
        return pts.map(p => this.reflectPointOverLine(p, a, b, pixelSpacing));
    },

    /** Traslada un polígono en índices de píxel. */
    translatePolygon(pts, dx, dy) {
        return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    },

    /** Distancia euclídea en mm entre dos puntos de imagen. */
    distanceMm(p1, p2, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        const dx = (p2.x - p1.x) * cs;
        const dy = (p2.y - p1.y) * rs;
        return Math.hypot(dx, dy);
    },

    /**
     * Distancia perpendicular CON SIGNO de un punto a la recta a→b, en mm.
     * El signo indica de qué lado de la línea media cae el punto: útil para
     * la desviación del septum (hacia qué hemisferio se desplaza).
     */
    perpendicularDistanceMm(p, a, b, pixelSpacing = [1, 1]) {
        const [rs, cs] = pixelSpacing;
        const px = p.x * cs, py = p.y * rs;
        const ax = a.x * cs, ay = a.y * rs;
        const bx = b.x * cs, by = b.y * rs;

        const dx = bx - ax, dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len === 0) return null;

        // Producto cruzado 2D / longitud = distancia con signo
        return ((px - ax) * dy - (py - ay) * dx) / len;
    },

    /* ════════════════════════════════════════════════════════
       5. Captación neta de agua (NWU)
       ════════════════════════════════════════════════════════ */

    /**
     * NWU (%) = (1 − media UH lesión / media UH contralateral) × 100
     * Devuelve null si no se puede calcular (sin píxeles, o contralateral
     * con media 0 → división indefinida). Nunca devuelve Infinity ni NaN.
     */
    nwu(meanLesion, meanContra) {
        if (meanLesion == null || meanContra == null) return null;
        if (!Number.isFinite(meanLesion) || !Number.isFinite(meanContra)) return null;
        if (meanContra === 0) return null;
        return (1 - meanLesion / meanContra) * 100;
    },

    /**
     * NWU global ponderada por número de píxeles.
     *
     * Se agrupan las medias de todos los cortes en una media ponderada por
     * sus recuentos y se aplica la fórmula a los valores agrupados. Eso es
     * equivalente a medir una sola ROI que abarcase todos los cortes, que es
     * lo que significa «global»; promediar las NWU por corte sin ponderar
     * daría más peso a cortes con pocos píxeles.
     *
     * @param {Array<{lesionMean:number, lesionCount:number,
     *                contraMean:number, contraCount:number}>} perSlice
     */
    nwuWeighted(perSlice) {
        let lSum = 0, lN = 0, cSum = 0, cN = 0, used = 0;

        for (const s of perSlice || []) {
            if (s?.lesionMean == null || s?.contraMean == null) continue;
            if (!(s.lesionCount > 0) || !(s.contraCount > 0))   continue;
            lSum += s.lesionMean * s.lesionCount;  lN += s.lesionCount;
            cSum += s.contraMean * s.contraCount;  cN += s.contraCount;
            used++;
        }

        if (!used || !lN || !cN) {
            return { nwu: null, lesionMean: null, contraMean: null,
                     lesionCount: 0, contraCount: 0, slicesUsed: 0 };
        }

        const lesionMean = lSum / lN;
        const contraMean = cSum / cN;
        return {
            nwu: this.nwu(lesionMean, contraMean),
            lesionMean, contraMean,
            lesionCount: lN, contraCount: cN,
            slicesUsed: used,
        };
    },

    /* ════════════════════════════════════════════════════════
       6. Geometría entre cortes
       ════════════════════════════════════════════════════════ */

    /** Producto vectorial de dos vectores 3D. */
    _cross(u, v) {
        return [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
    },

    /**
     * Normal del plano de corte a partir de ImageOrientationPatient
     * (x00200037 = [rowX,rowY,rowZ, colX,colY,colZ]).
     * Sin ese tag cae a [0,0,1], que es el eje Z del paciente — correcto
     * para TC axial, pero se avisa de que es una suposición.
     */
    sliceNormal(imageOrientation) {
        const iop = imageOrientation;
        if (!iop || iop.length < 6) return { normal: [0, 0, 1], assumed: true };
        const n = this._cross(iop.slice(0, 3), iop.slice(3, 6));
        const len = Math.hypot(n[0], n[1], n[2]);
        if (!len) return { normal: [0, 0, 1], assumed: true };
        return { normal: [n[0] / len, n[1] / len, n[2] / len], assumed: false };
    },

    /**
     * Espaciado real entre cortes consecutivos.
     *
     * Proyecta ImagePositionPatient sobre la normal del corte en vez de
     * fiarse de SliceThickness: SliceThickness es el grosor del haz, no la
     * distancia entre centros de corte, y difieren en cuanto hay solapamiento
     * o huecos. Avisa de ambas situaciones.
     *
     * @param {Array<object>} frames  DicomFrames (se usan imagePosition,
     *        imageOrientation, sliceLocation, sliceThickness)
     * @param {Array<number>} [indices] subconjunto de índices a considerar
     */
    sliceSpacing(frames, indices) {
        const idxs = (indices && indices.length ? indices : frames.map((_, i) => i))
            .filter(i => frames[i]);

        if (idxs.length < 2) {
            const f = frames[idxs[0]];
            return {
                spacings: [], mean: f?.sliceThickness ?? null, sd: 0,
                min: null, max: null,
                irregular: false, overlap: false, positionsAssumed: true,
                source: 'sliceThickness',
                warnings: idxs.length ? ['Un solo corte: se usa SliceThickness como espaciado.'] : [],
            };
        }

        const { normal, assumed } = this.sliceNormal(frames[idxs[0]].imageOrientation);
        const warnings = [];

        // Posición de cada corte a lo largo de la normal
        let source = 'ImagePositionPatient';
        let missingPos = false;
        const projected = idxs.map(i => {
            const f  = frames[i];
            const ip = f.imagePosition;
            if (!ip || ip.length < 3) {
                missingPos = true;
                return { index: i, pos: f.sliceLocation ?? null };
            }
            return { index: i, pos: ip[0] * normal[0] + ip[1] * normal[1] + ip[2] * normal[2] };
        });

        if (missingPos) {
            source = 'SliceLocation';
            warnings.push('Falta ImagePositionPatient en algún corte: se usa SliceLocation.');
        }
        if (projected.some(p => p.pos == null)) {
            return {
                spacings: [], mean: frames[idxs[0]].sliceThickness ?? null, sd: 0,
                min: null, max: null, irregular: false, overlap: false,
                positionsAssumed: true, source: 'sliceThickness',
                warnings: [...warnings, 'Sin posición utilizable: se usa SliceThickness.'],
            };
        }
        if (assumed) {
            warnings.push('Falta ImageOrientationPatient: se asume adquisición axial (normal Z).');
        }

        projected.sort((a, b) => a.pos - b.pos);

        const spacings = [];
        for (let k = 1; k < projected.length; k++) {
            spacings.push(Math.abs(projected[k].pos - projected[k - 1].pos));
        }

        const mean = spacings.reduce((a, b) => a + b, 0) / spacings.length;
        const sd   = Math.sqrt(spacings.reduce((a, s) => a + (s - mean) ** 2, 0) / spacings.length);
        const min  = Math.min(...spacings);
        const max  = Math.max(...spacings);

        // Irregular si algún espaciado se desvía más del 10 % de la media,
        // con un suelo de 0,05 mm para no marcar ruido de redondeo del tag.
        const tol = Math.max(0.05, mean * 0.10);
        const irregular = spacings.some(s => Math.abs(s - mean) > tol);
        if (irregular) {
            warnings.push(
                `Cortes no equidistantes: espaciado entre ${min.toFixed(2)} y ${max.toFixed(2)} mm ` +
                `(media ${mean.toFixed(2)} mm). El volumen puede estar sesgado.`
            );
        }

        // Solapamiento: el espaciado entre centros es menor que el grosor del haz
        const thickness = frames[idxs[0]].sliceThickness ?? null;
        const overlap = thickness != null && min < thickness - 0.01;
        if (overlap) {
            warnings.push(
                `Cortes solapados: espaciado mínimo ${min.toFixed(2)} mm < SliceThickness ` +
                `${thickness} mm. El volumen por planimetría se sobreestima.`
            );
        }

        return { spacings, mean, sd, min, max, irregular, overlap,
                 positionsAssumed: assumed, source, warnings };
    },

    /* ════════════════════════════════════════════════════════
       7. Volumen
       ════════════════════════════════════════════════════════ */

    /**
     * Volumen por planimetría: Σ (área de la ROI en el corte × espaciado local).
     *
     * El espaciado local de cada corte es la semisuma de los huecos a sus
     * vecinos (regla trapezoidal), lo que maneja correctamente el espaciado
     * irregular. Los extremos usan su único hueco.
     *
     * @param {Array<{sliceIndex:number, areaMm2:number}>} rois
     * @param {Array<object>} frames
     */
    planimetricVolume(rois, frames) {
        if (!rois?.length) return null;

        // Una ROI por corte: si hay varias, se suman sus áreas
        const bySlice = new Map();
        for (const r of rois) {
            const a = r.areaMm2 ?? 0;
            bySlice.set(r.sliceIndex, (bySlice.get(r.sliceIndex) ?? 0) + a);
        }

        const indices = [...bySlice.keys()].sort((a, b) => a - b);
        const sp = this.sliceSpacing(frames, indices);
        const warnings = [...sp.warnings];

        // Posición de cada corte con lesión a lo largo de la normal
        const { normal } = this.sliceNormal(frames[indices[0]]?.imageOrientation);
        const posOf = (i) => {
            const f = frames[i];
            const ip = f?.imagePosition;
            if (ip && ip.length >= 3) {
                return ip[0] * normal[0] + ip[1] * normal[1] + ip[2] * normal[2];
            }
            return f?.sliceLocation ?? null;
        };

        const nodes = indices
            .map(i => ({ index: i, area: bySlice.get(i), pos: posOf(i) }))
            .filter(nd => nd.pos != null)
            .sort((a, b) => a.pos - b.pos);

        const fallbackGap = sp.mean ?? frames[indices[0]]?.sliceThickness ?? 1;

        let mm3 = 0;
        const perSlice = [];

        if (nodes.length === 0) {
            // Sin posiciones: usar SliceThickness para cada corte
            for (const i of indices) {
                const gap  = frames[i]?.sliceThickness ?? 1;
                const area = bySlice.get(i);
                mm3 += area * gap;
                perSlice.push({ sliceIndex: i, areaMm2: area, gapMm: gap, volumeMm3: area * gap });
            }
            warnings.push('Sin posiciones de corte: se usa SliceThickness por corte.');
        } else if (nodes.length === 1) {
            const gap = frames[nodes[0].index]?.sliceThickness ?? fallbackGap;
            mm3 = nodes[0].area * gap;
            perSlice.push({ sliceIndex: nodes[0].index, areaMm2: nodes[0].area,
                            gapMm: gap, volumeMm3: mm3 });
            warnings.push('Lesión en un solo corte: el volumen depende de SliceThickness.');
        } else {
            for (let k = 0; k < nodes.length; k++) {
                const prevGap = k > 0                ? Math.abs(nodes[k].pos - nodes[k - 1].pos) : null;
                const nextGap = k < nodes.length - 1 ? Math.abs(nodes[k + 1].pos - nodes[k].pos) : null;
                const gap = (prevGap != null && nextGap != null)
                    ? (prevGap + nextGap) / 2
                    : (prevGap ?? nextGap);
                const vol = nodes[k].area * gap;
                mm3 += vol;
                perSlice.push({ sliceIndex: nodes[k].index, areaMm2: nodes[k].area,
                                gapMm: gap, volumeMm3: vol });
            }

            // ¿Hay cortes sin ROI en medio del rango? Entonces la lesión está
            // interpolada sobre huecos no medidos y el dato debe advertirse.
            const contiguous = nodes.every((nd, k) =>
                k === 0 || nd.index === nodes[k - 1].index + 1 ||
                          nd.index === nodes[k - 1].index - 1);
            if (!contiguous) {
                warnings.push('Hay cortes sin ROI dentro del rango de la lesión: ' +
                              'el volumen interpola sobre cortes no medidos.');
            }
        }

        const totalAreaMm2 = [...bySlice.values()].reduce((a, b) => a + b, 0);

        return {
            mm3,
            mL: mm3 / 1000,
            sliceCount: indices.length,
            totalAreaMm2,
            spacing: sp,
            perSlice: perSlice.sort((a, b) => a.sliceIndex - b.sliceIndex),
            warnings,
        };
    },

    /**
     * ABC/2 — estimación elipsoidal.
     * A y B son los diámetros mayor y menor (perpendiculares) medidos en el
     * corte de mayor área; C es la extensión craneocaudal.
     * @returns {{mm3:number, mL:number}}
     */
    abc2(aMm, bMm, cMm) {
        const mm3 = (aMm * bMm * cMm) / 2;
        return { mm3, mL: mm3 / 1000 };
    },

    /**
     * Deriva C (extensión craneocaudal, mm) de los cortes con lesión.
     * C = (nº de cortes con lesión) × espaciado medio. Se usa el espaciado
     * real, no SliceThickness, por lo dicho en sliceSpacing().
     */
    deriveC(sliceIndices, frames) {
        if (!sliceIndices?.length) return { cMm: null, warnings: ['Sin cortes con lesión.'] };
        const sp = this.sliceSpacing(frames, sliceIndices);
        const gap = sp.mean ?? frames[sliceIndices[0]]?.sliceThickness ?? null;
        if (gap == null) return { cMm: null, warnings: ['No se pudo determinar el espaciado.'] };
        return {
            cMm: sliceIndices.length * gap,
            spacingMm: gap,
            sliceCount: sliceIndices.length,
            warnings: sp.warnings,
        };
    },

    /* ════════════════════════════════════════════════════════
       8. Estimación automática de la línea media
       ════════════════════════════════════════════════════════ */

    /**
     * Propone los dos extremos de la línea media (inserción anterior y
     * posterior de la hoz) en un corte axial de cráneo.
     *
     * Método, determinista y sin dependencias:
     *   1. Máscara de cabeza (UH > umbral, excluyendo padding).
     *   2. Centroide y momentos centrales de segundo orden en espacio mm.
     *   3. El autovector del autovalor mayor es el eje antero-posterior
     *      (la cabeza es más larga en AP que en transverso en axial).
     *   4. Se recorre ese eje desde el centroide hacia los dos lados hasta
     *      salir de la máscara; se retrocede un margen para caer en la tabla
     *      interna, donde se inserta la hoz.
     *
     * Es una PROPUESTA: el usuario siempre puede arrastrar los extremos o
     * definirlos a mano desde cero.
     *
     * @param {object} frame DicomFrame
     * @param {object} [opt]
     * @returns {{anterior:{x,y}, posterior:{x,y}, confidence:number,
     *            eccentricity:number, centroid:{x,y}} | null}
     */
    estimateMidline(frame, opt = {}) {
        const {
            pixelData, rows, cols,
            rescaleSlope: slope = 1, rescaleIntercept: intercept = 0,
            pixelSpacing = [1, 1],
            pixelPaddingValue = null, pixelPaddingRangeLimit = null,
        } = frame || {};
        if (!pixelData || !rows || !cols) return null;

        const headHuMin = opt.headHuMin ?? -200;   // incluye parénquima, LCR y hueso
        const insetMm   = opt.insetMm   ?? 4;      // retroceso desde la tabla interna
        const [rs, cs]  = pixelSpacing;

        // ── 1 + 2. Máscara y momentos, en un solo recorrido ─────────
        let n = 0, sx = 0, sy = 0;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            for (let x = 0; x < cols; x++) {
                const raw = pixelData[row + x];
                if (this.isPadding(raw, pixelPaddingValue, pixelPaddingRangeLimit)) continue;
                if (this.toHU(raw, slope, intercept) < headHuMin) continue;
                n++; sx += x; sy += y;
            }
        }
        if (n < 100) return null;   // no hay cabeza reconocible en este corte

        const cxPx = sx / n, cyPx = sy / n;

        // Momentos centrales en mm: con spacing anisotrópico el eje principal
        // en índices de píxel no es el eje principal anatómico.
        let mxx = 0, myy = 0, mxy = 0;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            const dy = (y - cyPx) * rs;
            for (let x = 0; x < cols; x++) {
                const raw = pixelData[row + x];
                if (this.isPadding(raw, pixelPaddingValue, pixelPaddingRangeLimit)) continue;
                if (this.toHU(raw, slope, intercept) < headHuMin) continue;
                const dx = (x - cxPx) * cs;
                mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
            }
        }
        mxx /= n; myy /= n; mxy /= n;

        // ── 3. Autovectores de la matriz de covarianza 2×2 ──────────
        const tr   = mxx + myy;
        const det  = mxx * myy - mxy * mxy;
        const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1   = tr / 2 + disc;   // autovalor mayor
        const l2   = tr / 2 - disc;

        // Autovector de l1, en mm
        let vx, vy;
        if (Math.abs(mxy) > 1e-9) { vx = l1 - myy; vy = mxy; }
        else                      { vx = (mxx >= myy) ? 1 : 0; vy = (mxx >= myy) ? 0 : 1; }
        const vlen = Math.hypot(vx, vy) || 1;
        vx /= vlen; vy /= vlen;

        // Excentricidad: cuán definido está el eje. Una cabeza casi circular
        // en este corte (vértex, base) da un eje poco fiable.
        const eccentricity = (l1 > 0) ? Math.sqrt(Math.max(0, 1 - l2 / l1)) : 0;

        // ── 4. Recorrer el eje hasta salir de la máscara ────────────
        // Paso de medio píxel en la dimensión más fina, en mm.
        const step = Math.min(cs, rs) / 2;
        const inHead = (xPx, yPx) => {
            const xi = Math.round(xPx), yi = Math.round(yPx);
            if (xi < 0 || xi >= cols || yi < 0 || yi >= rows) return false;
            const raw = pixelData[yi * cols + xi];
            if (this.isPadding(raw, pixelPaddingValue, pixelPaddingRangeLimit)) return false;
            return this.toHU(raw, slope, intercept) >= headHuMin;
        };

        // El eje está en mm; convertir el paso a incrementos de índice
        const walk = (sign) => {
            const dxPx = (sign * vx * step) / cs;
            const dyPx = (sign * vy * step) / rs;
            let x = cxPx, y = cyPx;
            let lastInside = { x, y };
            const maxSteps = Math.ceil(Math.hypot(cols, rows) * 2 / (step / Math.max(cs, rs)) ) + 4;
            for (let k = 0; k < maxSteps; k++) {
                const nx = x + dxPx, ny = y + dyPx;
                if (!inHead(nx, ny)) break;
                x = nx; y = ny;
                lastInside = { x, y };
            }
            // Retroceder insetMm desde el borde hacia el centro
            const backPx = insetMm / step;
            return {
                x: lastInside.x - dxPx * backPx,
                y: lastInside.y - dyPx * backPx,
            };
        };

        const endA = walk(+1);
        const endB = walk(-1);

        // Convenio: en TC axial DICOM la fila 0 es anterior, así que el extremo
        // con menor y es la inserción anterior de la hoz. El usuario puede
        // intercambiarlos; para la reflexión el orden es irrelevante.
        const anterior  = endA.y <= endB.y ? endA : endB;
        const posterior = endA.y <= endB.y ? endB : endA;

        const lengthMm = this.distanceMm(anterior, posterior, pixelSpacing);
        // Confianza: eje bien definido Y longitud plausible para un cráneo
        const lengthOk = lengthMm > 80 && lengthMm < 260;
        const confidence = Math.max(0, Math.min(1, eccentricity)) * (lengthOk ? 1 : 0.3);

        return {
            anterior, posterior,
            centroid: { x: cxPx, y: cyPx },
            eccentricity, lengthMm, confidence,
        };
    },
};

/* Exportación dual: global de navegador + módulo CommonJS para node --test.
   Las pruebas ejercitan exactamente este código, no una copia. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResearchCore;
}
