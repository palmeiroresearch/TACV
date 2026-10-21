'use strict';

/* Conversión a Unidades Hounsfield y exclusión de píxeles no medibles. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const RC     = require('../js/research-core.js');

test('toHU aplica slope e intercept', () => {
    assert.equal(RC.toHU(1024, 1, -1024), 0);       // agua
    assert.equal(RC.toHU(0,    1, -1024), -1024);   // aire
    assert.equal(RC.toHU(1057, 1, -1024), 33);
    assert.equal(RC.toHU(1052, 1, -1024), 28);
});

test('toHU respeta slope distinto de 1', () => {
    // Algunos equipos codifican con slope ≠ 1 (p. ej. 2) para ampliar rango
    assert.equal(RC.toHU(512, 2, -1024), 0);
    assert.equal(RC.toHU(528, 2, -1024), 32);
    assert.equal(RC.toHU(100, 0.5, 0), 50);
});

test('toHU con intercept ausente usa 0, no -1024', () => {
    // Regresión: el bridge usaba -1024 por defecto, lo que restaba 1024 UH
    // a cualquier estudio sin el tag RescaleIntercept.
    assert.equal(RC.toHU(33, 1, undefined), 33);
    assert.equal(RC.toHU(33, undefined, undefined), 33);
    assert.equal(RC.toHU(33, 1, null), 33);
});

test('toHU funciona con valores negativos almacenados (PixelRepresentation=1)', () => {
    // Datos signed: el aire ya viene como -1000 y el intercept es 0
    assert.equal(RC.toHU(-1000, 1, 0), -1000);
    assert.equal(RC.toHU(33, 1, 0), 33);
});

test('isPadding compara el valor ALMACENADO, no las UH', () => {
    assert.equal(RC.isPadding(-2000, -2000, null), true);
    assert.equal(RC.isPadding(-1999, -2000, null), false);
    assert.equal(RC.isPadding(1057, -2000, null), false);
    // Sin PixelPaddingValue no se excluye nada
    assert.equal(RC.isPadding(-2000, null, null), false);
});

test('isPadding con PixelPaddingRangeLimit cubre un intervalo cerrado', () => {
    assert.equal(RC.isPadding(-2000, -2000, -1800), true);
    assert.equal(RC.isPadding(-1900, -2000, -1800), true);
    assert.equal(RC.isPadding(-1800, -2000, -1800), true);
    assert.equal(RC.isPadding(-1799, -2000, -1800), false);
    // El orden de los dos tags no debe importar
    assert.equal(RC.isPadding(-1900, -1800, -2000), true);
});

test('computeStats: media, SD, mediana, mín, máx y recuento', () => {
    const s = RC.computeStats([10, 20, 30, 40]);
    assert.equal(s.count, 4);
    assert.equal(s.mean, 25);
    assert.equal(s.median, 25);          // par: media de los dos centrales
    assert.equal(s.min, 10);
    assert.equal(s.max, 40);
    // SD poblacional de [10,20,30,40] = sqrt(125) ≈ 11.1803
    assert.ok(Math.abs(s.std - Math.sqrt(125)) < 1e-12);
});

test('computeStats: mediana con número impar de valores', () => {
    assert.equal(RC.computeStats([5, 1, 3]).median, 3);
});

test('computeStats: mediana distinta de la media con distribución sesgada', () => {
    // Un valor extremo (calcificación) arrastra la media pero no la mediana:
    // por eso la mediana se reporta junto a la media.
    const s = RC.computeStats([30, 31, 32, 33, 1000]);
    assert.equal(s.median, 32);
    assert.ok(s.mean > 200);
});

test('computeStats con ROI vacía devuelve null, no 0', () => {
    const s = RC.computeStats([]);
    assert.equal(s.count, 0);
    assert.equal(s.mean, null);
    assert.equal(s.median, null);
    // Un 0 silencioso daría NWU = 100 % en vez de "no medible"
});

test('computeStats no muta la entrada', () => {
    const input = [3, 1, 2];
    RC.computeStats(input);
    assert.deepEqual(input, [3, 1, 2]);
});

test('computeStats soporta ROI grandes sin desbordar la pila', () => {
    // Math.min(...values) revienta por encima de ~125k elementos;
    // una ROI de 512×512 son 262144.
    const big = new Float64Array(300000).fill(40);
    big[12345] = -5;
    big[99999] = 900;
    const s = RC.computeStats(big);
    assert.equal(s.count, 300000);
    assert.equal(s.min, -5);
    assert.equal(s.max, 900);
});

/* ── maskStats: el rasterizador único ───────────────────────── */

function makeFrame({ rows = 32, cols = 32, fill = 1057 } = {}) {
    return { pixelData: new Int16Array(rows * cols).fill(fill), rows, cols };
}

test('maskStats mide UH sobre los valores originales', () => {
    const f = makeFrame({ fill: 1057 });   // 33 UH con intercept -1024
    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        pixelSpacing: [0.5, 0.5],
        bbox: { x0: 10, y0: 10, x1: 19, y1: 19 },
        inside: () => true,
    });
    assert.equal(r.count, 100);
    assert.equal(r.mean, 33);
    assert.equal(r.std, 0);
    assert.equal(r.areaMm2, 100 * 0.25);
});

test('maskStats excluye padding y lo cuenta', () => {
    const f = makeFrame({ fill: 1057 });
    // Una franja de padding dentro de la ROI
    for (let y = 10; y <= 19; y++) f.pixelData[y * f.cols + 10] = -2000;

    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        padding: -2000,
        bbox: { x0: 10, y0: 10, x1: 19, y1: 19 },
        inside: () => true,
    });
    assert.equal(r.excludedPadding, 10);
    assert.equal(r.count, 90);
    assert.equal(r.mean, 33);              // el padding no contamina la media
    assert.equal(r.pixelsInMask, 100);     // el área encerrada no cambia
});

test('maskStats aplica umbrales de UH y cuenta cada exclusión por separado', () => {
    const f = makeFrame({ fill: 1052 });   // 28 UH
    // 5 píxeles de calcificación (300 UH) y 3 de LCR (-10 UH)
    for (let k = 0; k < 5; k++) f.pixelData[10 * f.cols + 10 + k] = 1324;
    for (let k = 0; k < 3; k++) f.pixelData[11 * f.cols + 10 + k] = 1014;

    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        huMin: 0, huMax: 60,
        bbox: { x0: 10, y0: 10, x1: 19, y1: 19 },
        inside: () => true,
    });
    assert.equal(r.excludedHigh, 5);
    assert.equal(r.excludedLow, 3);
    assert.equal(r.excludedTotal, 8);
    assert.equal(r.count, 92);
    assert.equal(r.mean, 28);              // los umbrales restauran la exactitud
    assert.equal(r.thresholdHuMin, 0);
    assert.equal(r.thresholdHuMax, 60);
});

test('maskStats sin umbrales no excluye nada', () => {
    const f = makeFrame({ fill: 1052 });
    f.pixelData[10 * f.cols + 10] = 1324;  // 300 UH
    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        bbox: { x0: 10, y0: 10, x1: 19, y1: 19 },
        inside: () => true,
    });
    assert.equal(r.excludedTotal, 0);
    assert.equal(r.count, 100);
    assert.ok(r.mean > 28);                // la calcificación sí arrastra la media
});

test('maskStats recorta la caja a los límites de la imagen', () => {
    const f = makeFrame({ rows: 16, cols: 16, fill: 1024 });
    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        bbox: { x0: -50, y0: -50, x1: 500, y1: 500 },
        inside: () => true,
    });
    assert.equal(r.count, 256);            // toda la imagen, sin salirse
    assert.equal(r.mean, 0);
});

test('maskStats respeta el test de pertenencia', () => {
    const f = makeFrame({ rows: 16, cols: 16, fill: 1024 });
    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        bbox: { x0: 0, y0: 0, x1: 15, y1: 15 },
        inside: (x, y) => x === y,         // solo la diagonal
    });
    assert.equal(r.count, 16);
});

test('maskStats calcula el área con PixelSpacing anisotrópico', () => {
    const f = makeFrame({ rows: 16, cols: 16, fill: 1024 });
    const r = RC.maskStats({
        ...f, slope: 1, intercept: -1024,
        pixelSpacing: [1.5, 0.5],          // [fila, columna]
        bbox: { x0: 0, y0: 0, x1: 9, y1: 9 },
        inside: () => true,
    });
    assert.equal(r.count, 100);
    assert.equal(r.areaMm2, 100 * 1.5 * 0.5);
});
