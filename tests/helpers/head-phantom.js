'use strict';

/* ============================================================
   Generador de fantomas de TC craneal para las pruebas del
   detector.

   Produce DicomFrames sintéticos con geometría y UH conocidas:
   cráneo elíptico, parénquima, ventrículos, y opcionalmente
   lesiones hipodensas, blobs hiperdensos con rampa de volumen
   parcial, artefacto de reborde en la tabla interna y ruido
   reproducible.

   La línea media es exacta por construcción y se devuelve junto
   al frame, así que las pruebas no dependen de la estimación
   automática salvo cuando eso es lo que se está probando.
   ============================================================ */

const INTERCEPT = -1024;

/** Generador congruente lineal: ruido reproducible entre ejecuciones. */
function lcg(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Ruido gaussiano por Box-Muller sobre el LCG. */
function gaussian(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {object} cfg
 * @param {number} [cfg.tiltDeg=0]   inclinación de la línea media en grados
 * @param {object} [cfg.lesion]      {side:±1, ap:0, lat:40, radiusPx:20, hu:28, rampPx:0}
 * @param {object[]} [cfg.blobs]     [{side, ap, lat, radiusPx, hu, rampPx}]
 * @param {number} [cfg.rimHu=0]     UH que se SUMAN en la banda interna del cráneo
 * @param {number} [cfg.noiseSd=0]   SD del ruido gaussiano en UH
 */
function headPhantom(cfg = {}) {
    const {
        rows = 256, cols = 256,
        pixelSpacing = [0.5, 0.5],
        tiltDeg = 0,
        cx = 128, cy = 128,
        semiAP = 95, semiLR = 72,
        skullPx = 7,
        huBrain = 35, huCsf = 5, huSkull = 900, huAir = -1000,
        ventricles = true,
        lesion = null,
        blobs = [],
        rimHu = 0, rimPx = 4,
        noiseSd = 0,
        seed = 1,
        z = 0, thickness = 5,
        sopInstanceUID = null,
    } = cfg;

    const [rs, cs] = pixelSpacing;
    const t = tiltDeg * Math.PI / 180;
    // tilt 0 → eje antero-posterior a lo largo de +y (filas)
    const ux = Math.sin(t),  uy = Math.cos(t);    // û: anterior → posterior
    const vx = Math.cos(t),  vy = -Math.sin(t);   // v̂: lateral

    const rand = lcg(seed);
    const pixelData = new Int16Array(rows * cols);

    // Centro de un elemento colocado en coordenadas (ap, lat) del marco del fantoma
    const place = (ap, lat) => ({
        x: cx + ux * ap + vx * lat,
        y: cy + uy * ap + vy * lat,
    });

    const brainAP = semiAP - skullPx;
    const brainLR = semiLR - skullPx;

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const dx = (x + 0.5) - cx;
            const dy = (y + 0.5) - cy;
            const s = dx * ux + dy * uy;     // antero-posterior
            const l = dx * vx + dy * vy;     // lateral

            const rHead  = Math.hypot(s / semiAP,  l / semiLR);
            const rBrain = Math.hypot(s / brainAP, l / brainLR);

            let hu;
            if (rHead > 1)       hu = huAir;
            else if (rBrain > 1) hu = huSkull;
            else {
                hu = huBrain;

                // Ventrículos: dos elipses paraventriculares simétricas
                if (ventricles) {
                    for (const side of [-1, 1]) {
                        const c = place(-5, side * 16);
                        const vdx = (x + 0.5) - c.x, vdy = (y + 0.5) - c.y;
                        const vs = vdx * ux + vdy * uy;
                        const vl = vdx * vx + vdy * vy;
                        if (Math.hypot(vs / 24, vl / 8) <= 1) hu = huCsf;
                    }
                }

                // Artefacto de reborde en la tabla interna: añade UH en una
                // banda justo por dentro del hueso. Es la causa real de falsos
                // positivos de hemorragia y lo que justifica la erosión.
                if (rimHu) {
                    const inset = (1 - rBrain) * Math.min(brainAP, brainLR);
                    if (inset < rimPx) hu += rimHu;
                }

                // Lesión hipodensa
                if (lesion) {
                    const c = place(lesion.ap ?? 0, (lesion.side ?? 1) * (lesion.lat ?? 40));
                    const d = Math.hypot((x + 0.5) - c.x, (y + 0.5) - c.y);
                    const R = lesion.radiusPx ?? 20;
                    const ramp = lesion.rampPx ?? 0;
                    if (d <= R) hu = lesion.hu;
                    else if (ramp > 0 && d <= R + ramp) {
                        const f = (d - R) / ramp;
                        hu = lesion.hu + f * (hu - lesion.hu);
                    }
                }

                // Blobs hiperdensos, con rampa de volumen parcial opcional
                for (const b of blobs) {
                    const c = place(b.ap ?? 0, (b.side ?? 1) * (b.lat ?? 35));
                    const d = Math.hypot((x + 0.5) - c.x, (y + 0.5) - c.y);
                    const R = b.radiusPx ?? 10;
                    const ramp = b.rampPx ?? 0;
                    if (d <= R) hu = b.hu;
                    else if (ramp > 0 && d <= R + ramp) {
                        const f = (d - R) / ramp;
                        hu = b.hu + f * (hu - b.hu);
                    }
                }

                if (noiseSd) hu += gaussian(rand) * noiseSd;
            }

            pixelData[y * cols + x] = Math.max(-32768, Math.min(32767, Math.round(hu - INTERCEPT)));
        }
    }

    const anterior  = place(-brainAP * 0.94, 0);
    const posterior = place( brainAP * 0.94, 0);

    return {
        frame: {
            pixelData, rows, cols,
            rescaleSlope: 1, rescaleIntercept: INTERCEPT,
            pixelSpacing, sliceThickness: thickness,
            imagePosition: [-64, -64, z],
            imageOrientation: [1, 0, 0, 0, 1, 0],
            sliceLocation: z,
            sopInstanceUID: sopInstanceUID || `phantom-z${z}`,
            instanceNumber: Math.round(z / (thickness || 1)) + 1,
            pixelPaddingValue: null, pixelPaddingRangeLimit: null,
            modality: 'CT',
        },
        midline: { anterior, posterior, source: 'manual', confidence: 1 },
        geometry: { cx, cy, ux, uy, vx, vy, semiAP, semiLR, brainAP, brainLR, place },
    };
}

/**
 * Serie de N cortes idénticos salvo por la z. Con `lesionSlices` se limita la
 * lesión a un subconjunto de cortes, de modo que el volumen esperado es
 * exactamente área × nº de cortes × espaciado.
 */
function headSeries(n, cfg = {}, { gapMm = 5, lesionSlices = null, blobSlices = null } = {}) {
    const frames = [], midlines = {};
    for (let z = 0; z < n; z++) {
        const hasLesion = !lesionSlices || lesionSlices.includes(z);
        const hasBlob   = !blobSlices   || blobSlices.includes(z);
        const p = headPhantom({
            ...cfg,
            z: z * gapMm,
            thickness: cfg.thickness ?? gapMm,
            lesion: hasLesion ? cfg.lesion : null,
            blobs:  hasBlob ? (cfg.blobs || []) : [],
            sopInstanceUID: `phantom-${z}`,
        });
        frames.push(p.frame);
        midlines[z] = p.midline;
    }
    return { frames, midlines };
}

/** Volumen esperado de un cilindro de radio R px en `nSlices` cortes. */
function expectedCylinderMl(radiusPx, pixelSpacing, nSlices, gapMm) {
    const [rs, cs] = pixelSpacing;
    const areaMm2 = Math.PI * radiusPx * radiusPx * rs * cs;
    return (areaMm2 * nSlices * gapMm) / 1000;
}

module.exports = { headPhantom, headSeries, expectedCylinderMl, INTERCEPT };
