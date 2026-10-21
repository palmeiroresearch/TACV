'use strict';

/* ============================================================
   Fantoma sintético con UH conocidas.

   Imagen 256×256, PixelSpacing [0.5, 0.5], slope 1, intercept −1024
   (es decir: valor almacenado = UH + 1024, como un TC real).

   Geometría: línea media INCLINADA. La ROI de lesión se traza sobre un
   disco uniforme de 28 UH; la ROI contralateral se obtiene por reflexión
   sobre esa línea media y cae sobre un disco uniforme de 33 UH.

   Dentro de la ROI de lesión se incrustan además una calcificación
   (300 UH) y una lámina de LCR (−10 UH). Los discos son más grandes que
   las ROI, de modo que las diferencias de rasterización en el borde caen
   siempre dentro de la zona uniforme: con los umbrales [0, 60] aplicados,
   las medias deben ser EXACTAMENTE 28 y 33 UH.

   NWU esperada = (1 − 28/33) × 100 = 15,1515… %
   ============================================================ */

const test   = require('node:test');
const assert = require('node:assert/strict');
const RC     = require('../js/research-core.js');

const ROWS = 256, COLS = 256;
const PIXEL_SPACING = [0.5, 0.5];
const SLOPE = 1, INTERCEPT = -1024;

const HU_LESION  = 28;
const HU_CONTRA  = 33;
const HU_BG      = -10;    // fondo tipo LCR: fuera del umbral inferior
const HU_CALC    = 300;    // calcificación: fuera del umbral superior

const DISC_R = 26;         // discos uniformes
const ROI_R  = 20;         // ROI, más pequeña que el disco
const CALC_R = 3;
const CSF_R  = 2;

/* Línea media inclinada (no vertical, para ejercitar la reflexión real) */
const MIDLINE_A = { x: 128, y: 12 };
const MIDLINE_B = { x: 112, y: 244 };

/** Centro de la lesión, claramente en un hemisferio. */
const C_LESION = { x: 180, y: 128 };

function buildPhantom({ huLesion = HU_LESION, huContra = HU_CONTRA,
                        withPatches = true } = {}) {
    // El centro contralateral se OBTIENE por reflexión: si la reflexión
    // estuviese mal, el fantoma y la ROI espejo se desalinearían y las
    // medias dejarían de ser exactas.
    const cContra = RC.reflectPointOverLine(C_LESION, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    const csfCenter = { x: C_LESION.x + 10, y: C_LESION.y };

    const pixelData = new Int16Array(ROWS * COLS);
    const store = (hu) => hu - INTERCEPT;   // inverso de raw·slope + intercept

    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            let hu = HU_BG;

            if (Math.hypot(x - cContra.x,  y - cContra.y)  <= DISC_R) hu = huContra;
            if (Math.hypot(x - C_LESION.x, y - C_LESION.y) <= DISC_R) hu = huLesion;

            if (withPatches) {
                if (Math.hypot(x - C_LESION.x,  y - C_LESION.y)  <= CALC_R) hu = HU_CALC;
                if (Math.hypot(x - csfCenter.x, y - csfCenter.y) <= CSF_R)  hu = HU_BG;
            }

            pixelData[y * COLS + x] = store(hu);
        }
    }

    return {
        frame: {
            pixelData, rows: ROWS, cols: COLS,
            rescaleSlope: SLOPE, rescaleIntercept: INTERCEPT,
            pixelSpacing: PIXEL_SPACING,
            sliceThickness: 5,
            imagePosition: [-64, -64, 0],
            imageOrientation: [1, 0, 0, 0, 1, 0],
        },
        cContra,
    };
}

/** Mide una ROI poligonal con el mismo rasterizador que usa la app. */
function measure(frame, pts, huMin, huMax) {
    return RC.maskStats({
        pixelData: frame.pixelData, rows: frame.rows, cols: frame.cols,
        slope: frame.rescaleSlope, intercept: frame.rescaleIntercept,
        pixelSpacing: frame.pixelSpacing,
        huMin, huMax,
        bbox: RC.polygonBounds(pts),
        inside: (x, y) => RC.pointInPolygon(x + 0.5, y + 0.5, pts),
    });
}

/* ════════════════════════════════════════════════════════════ */

test('fantoma: la NWU es exactamente 15,15 % con los umbrales aplicados', () => {
    const { frame } = buildPhantom();

    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    const sL = measure(frame, lesionRoi, 0, 60);
    const sC = measure(frame, mirrorRoi, 0, 60);

    // Medias exactas: solo posible si los umbrales excluyeron exactamente
    // la calcificación y el LCR, y la ROI espejo cayó dentro del disco de 33 UH.
    assert.equal(sL.mean, 28, `media lesión = ${sL.mean}`);
    assert.equal(sC.mean, 33, `media contralateral = ${sC.mean}`);
    assert.equal(sL.std, 0, 'la lesión medida debe ser uniforme');
    assert.equal(sC.std, 0, 'el contralateral medido debe ser uniforme');

    const nwu = RC.nwu(sL.mean, sC.mean);
    assert.ok(Math.abs(nwu - 15.151515151515152) < 1e-12, `NWU = ${nwu}`);
    assert.ok(Math.abs(nwu - 15.15) < 0.01, `NWU = ${nwu}`);
});

test('fantoma: la mediana coincide con la media en región uniforme', () => {
    const { frame } = buildPhantom();
    const roi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const s = measure(frame, roi, 0, 60);
    assert.equal(s.median, 28);
    assert.equal(s.min, 28);
    assert.equal(s.max, 28);
});

test('fantoma: sin umbrales la media está contaminada', () => {
    // Confirma que la calcificación y el LCR están realmente DENTRO de la ROI
    // (si no, el test anterior pasaría por casualidad).
    const { frame } = buildPhantom();
    const roi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const s = measure(frame, roi, null, null);

    assert.notEqual(s.mean, 28);
    assert.ok(s.mean > 28, `la calcificación debe subir la media: ${s.mean}`);
    assert.ok(s.max === 300, 'la calcificación está dentro de la ROI');
    assert.ok(s.min === -10, 'el LCR está dentro de la ROI');

    // Y la NWU resultante estaría equivocada en varios puntos porcentuales
    const nwuMal = RC.nwu(s.mean, 33);
    assert.ok(Math.abs(nwuMal - 15.1515) > 1, `NWU sin umbral = ${nwuMal}`);
});

test('fantoma: se informa cuántos píxeles se excluyeron en cada ROI', () => {
    const { frame } = buildPhantom();
    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    const sL = measure(frame, lesionRoi, 0, 60);
    const sC = measure(frame, mirrorRoi, 0, 60);

    assert.ok(sL.excludedHigh > 0, 'calcificación excluida');
    assert.ok(sL.excludedLow  > 0, 'LCR excluido');
    assert.equal(sL.excludedPadding, 0);
    // Los píxeles encerrados son los medidos más los excluidos
    assert.equal(sL.pixelsInMask, sL.count + sL.excludedTotal);

    // La ROI contralateral es uniforme: no debe excluir nada
    assert.equal(sC.excludedTotal, 0);
    assert.equal(sC.pixelsInMask, sC.count);
});

test('fantoma: la ROI espejo tiene la misma área que la lesión', () => {
    const { frame } = buildPhantom();
    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    // Área geométrica: idéntica por construcción (la reflexión es una isometría)
    const aGeoL = RC.polygonAreaMm2(lesionRoi, PIXEL_SPACING);
    const aGeoM = RC.polygonAreaMm2(mirrorRoi, PIXEL_SPACING);
    assert.ok(Math.abs(aGeoL - aGeoM) < 1e-9);

    // Área rasterizada: puede diferir en unos pocos píxeles de borde según
    // dónde caigan los centros de píxel. Tolerancia del 1 %.
    const sL = measure(frame, lesionRoi, null, null);
    const sM = measure(frame, mirrorRoi, null, null);
    const rel = Math.abs(sL.pixelsInMask - sM.pixelsInMask) / sL.pixelsInMask;
    assert.ok(rel < 0.01, `área rasterizada difiere ${(rel * 100).toFixed(2)} %`);
});

test('fantoma: la ROI espejo cae en el hemisferio contralateral', () => {
    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    const sideOf = (pts) => {
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        return Math.sign(RC.perpendicularDistanceMm(
            { x: cx, y: cy }, MIDLINE_A, MIDLINE_B, PIXEL_SPACING));
    };
    assert.equal(sideOf(lesionRoi), -sideOf(mirrorRoi));
});

test('fantoma: desplazar la ROI espejo registra el desplazamiento en mm', () => {
    const { frame } = buildPhantom();
    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    // 6 px a la derecha y 8 abajo → con 0.5 mm/px son 3 y 4 mm → 5 mm
    const moved = RC.translatePolygon(mirrorRoi, 6, 8);
    const offsetMm = RC.distanceMm({ x: 0, y: 0 }, { x: 6, y: 8 }, PIXEL_SPACING);
    assert.ok(Math.abs(offsetMm - 5) < 1e-12);

    // Sigue dentro del disco uniforme (26 − 20 = 6 px de margen > 10 px movidos
    // no: se sale un poco), así que aquí solo se comprueba que el área se conserva
    const sM = measure(frame, moved, 0, 60);
    assert.ok(sM.pixelsInMask > 0);
    assert.ok(Math.abs(RC.polygonAreaMm2(moved, PIXEL_SPACING) -
                       RC.polygonAreaMm2(mirrorRoi, PIXEL_SPACING)) < 1e-9);
});

test('fantoma: el padding fuera del FOV no entra en la medición', () => {
    const { frame } = buildPhantom();
    // Marcar como padding una porción de la ROI de lesión
    const PAD = -2000;
    let padded = 0;
    for (let y = C_LESION.y - 5; y <= C_LESION.y + 5; y++) {
        for (let x = C_LESION.x + 12; x <= C_LESION.x + 16; x++) {
            frame.pixelData[y * COLS + x] = PAD - INTERCEPT > 32767
                ? 32767 : (PAD - INTERCEPT);
            padded++;
        }
    }
    const roi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);

    const sinPad = measure(frame, roi, 0, 60);
    const conPad = RC.maskStats({
        pixelData: frame.pixelData, rows: ROWS, cols: COLS,
        slope: SLOPE, intercept: INTERCEPT, pixelSpacing: PIXEL_SPACING,
        padding: PAD - INTERCEPT,
        huMin: 0, huMax: 60,
        bbox: RC.polygonBounds(roi),
        inside: (x, y) => RC.pointInPolygon(x + 0.5, y + 0.5, roi),
    });

    assert.ok(conPad.excludedPadding > 0, 'se excluyó padding');
    assert.equal(conPad.mean, 28, 'la media vuelve a ser exacta');
    assert.ok(conPad.count < sinPad.count + conPad.excludedPadding + 1);
    assert.ok(padded > 0);
});

/* ── Multicorte: ganglionar + supraganglionar ───────────────── */

test('fantoma multicorte: NWU por corte y global ponderada', () => {
    // Corte ganglionar: 28/33 → 15,15 %
    // Corte supraganglionar: 30/33 → 9,09 %
    const g = buildPhantom({ huLesion: 28, huContra: 33 });
    const s = buildPhantom({ huLesion: 30, huContra: 33 });

    const lesionRoi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const mirrorRoi = RC.reflectPolygon(lesionRoi, MIDLINE_A, MIDLINE_B, PIXEL_SPACING);

    const perSlice = [g, s].map(({ frame }) => {
        const L = measure(frame, lesionRoi, 0, 60);
        const C = measure(frame, mirrorRoi, 0, 60);
        return { lesionMean: L.mean, lesionCount: L.count,
                 contraMean: C.mean, contraCount: C.count };
    });

    assert.ok(Math.abs(RC.nwu(perSlice[0].lesionMean, perSlice[0].contraMean) - 15.151515151515152) < 1e-12);
    assert.ok(Math.abs(RC.nwu(perSlice[1].lesionMean, perSlice[1].contraMean) - (1 - 30 / 33) * 100) < 1e-12);

    const global = RC.nwuWeighted(perSlice);
    assert.equal(global.slicesUsed, 2);
    // Con recuentos casi iguales, la global cae entre las dos por corte
    assert.ok(global.nwu > 9 && global.nwu < 16, `global = ${global.nwu}`);
    assert.ok(Math.abs(global.contraMean - 33) < 1e-9);
});

test('fantoma: volumen por planimetría de la lesión en dos cortes', () => {
    const { frame } = buildPhantom();
    const roi = RC.polygonFromEllipse(C_LESION.x, C_LESION.y, ROI_R, ROI_R, 180);
    const s = measure(frame, roi, 0, 60);

    const frames = [0, 1].map(i => ({
        ...frame, imagePosition: [-64, -64, i * 5],
    }));
    const v = RC.planimetricVolume([
        { sliceIndex: 0, areaMm2: s.areaTotalMm2 },
        { sliceIndex: 1, areaMm2: s.areaTotalMm2 },
    ], frames);

    assert.ok(Math.abs(v.mm3 - s.areaTotalMm2 * 5 * 2) < 1e-6);
    assert.equal(v.spacing.irregular, false);
    assert.equal(v.spacing.overlap, false);

    // Área esperada ≈ π·20²·0.25 mm² = 314,16 mm²; tolerancia de rasterización
    const expected = Math.PI * ROI_R * ROI_R * 0.25;
    assert.ok(Math.abs(s.areaTotalMm2 - expected) / expected < 0.01);
});

/* ── Estimación automática de la línea media ────────────────── */

test('estimateMidline encuentra el eje de una cabeza sintética inclinada', () => {
    // Elipse de "cabeza" rotada 12°, con borde de hueso, sobre fondo de aire
    const rows = 256, cols = 256;
    const pixelData = new Int16Array(rows * cols).fill(-1000 - INTERCEPT);
    const cx = 128, cy = 128;
    const a = 95, b = 72;                       // semieje AP y transverso
    const th = 12 * Math.PI / 180;
    const cos = Math.cos(th), sin = Math.sin(th);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const dx = x - cx, dy = y - cy;
            // Rotar al marco de la elipse; el eje mayor queda a lo largo de Y (AP)
            const u = ( cos * dx + sin * dy) / b;
            const v = (-sin * dx + cos * dy) / a;
            const r = Math.hypot(u, v);
            if (r <= 1.0) {
                pixelData[y * cols + x] = (r > 0.93 ? 900 : 35) - INTERCEPT;
            }
        }
    }

    const est = RC.estimateMidline({
        pixelData, rows, cols,
        rescaleSlope: 1, rescaleIntercept: INTERCEPT,
        pixelSpacing: [1, 1],
    });

    assert.ok(est, 'debe devolver una estimación');
    assert.ok(est.confidence > 0.4, `confianza = ${est.confidence}`);

    // El eje estimado debe pasar cerca del centro real de la cabeza
    const d = RC.perpendicularDistanceMm({ x: cx, y: cy }, est.anterior, est.posterior, [1, 1]);
    assert.ok(Math.abs(d) < 3, `el eje pasa a ${d} mm del centro`);

    // Y su dirección debe coincidir con el eje AP real (12° de la vertical)
    const vx = est.posterior.x - est.anterior.x;
    const vy = est.posterior.y - est.anterior.y;
    const angle = Math.abs(Math.atan2(vx, vy) * 180 / Math.PI);
    assert.ok(Math.abs(angle - 12) < 6, `ángulo estimado = ${angle}°`);

    // El extremo anterior es el de menor y (convenio axial DICOM)
    assert.ok(est.anterior.y < est.posterior.y);
});

test('estimateMidline devuelve null si no hay cabeza en el corte', () => {
    const pixelData = new Int16Array(64 * 64).fill(-1000 - INTERCEPT);
    assert.equal(RC.estimateMidline({
        pixelData, rows: 64, cols: 64,
        rescaleSlope: 1, rescaleIntercept: INTERCEPT, pixelSpacing: [1, 1],
    }), null);
});

test('estimateMidline baja la confianza con una cabeza casi circular', () => {
    // Corte de vértex: sección casi redonda → eje AP mal definido
    const rows = 160, cols = 160;
    const pixelData = new Int16Array(rows * cols).fill(-1000 - INTERCEPT);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (Math.hypot(x - 80, y - 80) <= 50) pixelData[y * cols + x] = 35 - INTERCEPT;
        }
    }
    const est = RC.estimateMidline({
        pixelData, rows, cols,
        rescaleSlope: 1, rescaleIntercept: INTERCEPT, pixelSpacing: [1, 1],
    });
    assert.ok(est);
    assert.ok(est.confidence < 0.4, `confianza = ${est.confidence}`);
});
