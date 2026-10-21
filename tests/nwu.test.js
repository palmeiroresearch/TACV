'use strict';

/* Fórmula de NWU, agregación global ponderada y exclusión por umbral. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const RC     = require('../js/research-core.js');

test('NWU = (1 − lesión/contralateral) × 100', () => {
    // El caso de referencia del estudio
    assert.ok(Math.abs(RC.nwu(28, 33) - 15.151515151515152) < 1e-12);
});

test('NWU es 0 cuando ambas ROI miden lo mismo', () => {
    assert.equal(RC.nwu(33, 33), 0);
});

test('NWU negativa si la lesión es MÁS densa que el lado sano', () => {
    // Hemorragia o artefacto: el signo debe conservarse, no truncarse a 0
    assert.ok(RC.nwu(40, 33) < 0);
    assert.ok(Math.abs(RC.nwu(66, 33) - (-100)) < 1e-12);
});

test('NWU con lesión a 0 UH da 100 %', () => {
    assert.equal(RC.nwu(0, 33), 100);
});

test('NWU devuelve null en lugar de Infinity si el contralateral es 0', () => {
    assert.equal(RC.nwu(28, 0), null);
});

test('NWU devuelve null con entradas no medibles', () => {
    assert.equal(RC.nwu(null, 33), null);
    assert.equal(RC.nwu(28, null), null);
    assert.equal(RC.nwu(undefined, undefined), null);
    assert.equal(RC.nwu(NaN, 33), null);
    assert.equal(RC.nwu(28, Infinity), null);
});

/* ── NWU global ponderada ───────────────────────────────────── */

test('NWU global con un solo corte coincide con la del corte', () => {
    const g = RC.nwuWeighted([
        { lesionMean: 28, lesionCount: 500, contraMean: 33, contraCount: 500 },
    ]);
    assert.ok(Math.abs(g.nwu - RC.nwu(28, 33)) < 1e-12);
    assert.equal(g.slicesUsed, 1);
});

test('NWU global pondera por número de píxeles, no por corte', () => {
    // Corte grande: 28/33. Corte pequeño: 20/40 (NWU 50 %).
    // Sin ponderar daría (15.15 + 50)/2 = 32.6 %; ponderado debe quedar
    // mucho más cerca del corte grande.
    const perSlice = [
        { lesionMean: 28, lesionCount: 9000, contraMean: 33, contraCount: 9000 },
        { lesionMean: 20, lesionCount: 100,  contraMean: 40, contraCount: 100  },
    ];
    const g = RC.nwuWeighted(perSlice);

    const pooledL = (28 * 9000 + 20 * 100) / 9100;
    const pooledC = (33 * 9000 + 40 * 100) / 9100;
    assert.ok(Math.abs(g.lesionMean - pooledL) < 1e-12);
    assert.ok(Math.abs(g.contraMean - pooledC) < 1e-12);
    assert.ok(Math.abs(g.nwu - RC.nwu(pooledL, pooledC)) < 1e-12);

    const unweighted = (RC.nwu(28, 33) + RC.nwu(20, 40)) / 2;
    assert.ok(Math.abs(g.nwu - unweighted) > 5, 'debe diferir de la media simple');
    assert.ok(g.nwu < 20, 'el corte grande debe dominar');
});

test('NWU global equivale a medir una sola ROI que abarque los cortes', () => {
    // Dos cortes con la misma lesión homogénea: la global debe ser idéntica
    // a la de cada corte, sea cual sea el reparto de píxeles.
    const g = RC.nwuWeighted([
        { lesionMean: 28, lesionCount: 1234, contraMean: 33, contraCount: 1234 },
        { lesionMean: 28, lesionCount: 77,   contraMean: 33, contraCount: 77   },
    ]);
    assert.ok(Math.abs(g.nwu - RC.nwu(28, 33)) < 1e-12);
    assert.equal(g.lesionCount, 1311);
});

test('NWU global ignora cortes no medibles sin invalidar el resto', () => {
    const g = RC.nwuWeighted([
        { lesionMean: 28,   lesionCount: 500, contraMean: 33, contraCount: 500 },
        { lesionMean: null, lesionCount: 0,   contraMean: 33, contraCount: 400 },  // ROI vacía
        { lesionMean: 30,   lesionCount: 0,   contraMean: 33, contraCount: 400 },  // sin píxeles
    ]);
    assert.equal(g.slicesUsed, 1);
    assert.ok(Math.abs(g.nwu - RC.nwu(28, 33)) < 1e-12);
});

test('NWU global sin cortes utilizables devuelve null', () => {
    assert.equal(RC.nwuWeighted([]).nwu, null);
    assert.equal(RC.nwuWeighted(null).nwu, null);
    assert.equal(RC.nwuWeighted([
        { lesionMean: null, lesionCount: 0, contraMean: null, contraCount: 0 },
    ]).nwu, null);
});

/* ── Exclusión por umbral aplicada a ROI reales ─────────────── */

/** Construye un frame con una ROI poligonal cuadrada y relleno controlado. */
function roiFrame(fillHu, patches = []) {
    const rows = 40, cols = 40;
    const pixelData = new Int16Array(rows * cols).fill(fillHu + 1024);
    for (const p of patches) {
        for (let y = p.y0; y <= p.y1; y++) {
            for (let x = p.x0; x <= p.x1; x++) pixelData[y * cols + x] = p.hu + 1024;
        }
    }
    return { pixelData, rows, cols, slope: 1, intercept: -1024 };
}

const square = (x0, y0, x1, y1) => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

function measurePolygon(frame, pts, huMin, huMax) {
    return RC.maskStats({
        ...frame,
        pixelSpacing: [0.5, 0.5],
        huMin, huMax,
        bbox: RC.polygonBounds(pts),
        inside: (x, y) => RC.pointInPolygon(x + 0.5, y + 0.5, pts),
    });
}

test('el umbral excluye LCR y calcificación y restaura la media exacta', () => {
    const pts = square(10, 10, 30, 30);
    const frame = roiFrame(28, [
        { x0: 12, y0: 12, x1: 14, y1: 14, hu: -10 },   // LCR, 9 px
        { x0: 20, y0: 20, x1: 21, y1: 21, hu: 300 },   // calcio, 4 px
    ]);

    const sin = measurePolygon(frame, pts, null, null);
    const con = measurePolygon(frame, pts, 0, 60);

    assert.ok(Math.abs(sin.mean - 28) > 1, 'sin umbral la media está contaminada');
    assert.equal(con.mean, 28, 'con umbral la media es exacta');
    assert.equal(con.excludedLow, 9);
    assert.equal(con.excludedHigh, 4);
    assert.equal(con.count, sin.count - 13);
    assert.equal(con.pixelsInMask, sin.pixelsInMask, 'el área encerrada no cambia');
});

test('el umbral se guarda en el resultado para la exportación', () => {
    const pts = square(10, 10, 20, 20);
    const r = measurePolygon(roiFrame(28), pts, 0, 60);
    assert.equal(r.thresholdHuMin, 0);
    assert.equal(r.thresholdHuMax, 60);
});

test('umbrales editables: otro rango excluye otros píxeles', () => {
    const pts = square(10, 10, 30, 30);
    const frame = roiFrame(28, [{ x0: 12, y0: 12, x1: 14, y1: 14, hu: 45 }]);  // 9 px a 45 UH
    assert.equal(measurePolygon(frame, pts, 0, 60).excludedHigh, 0);
    assert.equal(measurePolygon(frame, pts, 0, 40).excludedHigh, 9);
});

test('NWU sobre par lesión/espejo con umbrales aplicados a ambas ROI', () => {
    const lesion = square(10, 10, 30, 30);
    const mirror = square(10, 10, 30, 30);

    const fL = roiFrame(28, [{ x0: 20, y0: 20, x1: 21, y1: 21, hu: 300 }]);
    const fC = roiFrame(33);

    const sL = measurePolygon(fL, lesion, 0, 60);
    const sC = measurePolygon(fC, mirror, 0, 60);

    assert.equal(sL.mean, 28);
    assert.equal(sC.mean, 33);
    assert.ok(Math.abs(RC.nwu(sL.mean, sC.mean) - 15.151515151515152) < 1e-12);
});

test('una ROI completamente excluida por el umbral da NWU null, no 100 %', () => {
    const pts = square(10, 10, 20, 20);
    const s = measurePolygon(roiFrame(300), pts, 0, 60);   // todo calcificado
    assert.equal(s.count, 0);
    assert.equal(s.mean, null);
    assert.equal(RC.nwu(s.mean, 33), null);
});
