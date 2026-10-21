'use strict';

/* Morfología, máscara de cerebro y componentes conexas 3D. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const DC     = require('../js/detect-core.js');
const { headPhantom } = require('./helpers/head-phantom.js');

/* ── Morfología ─────────────────────────────────────────────── */

test('discOffsets respeta el PixelSpacing anisotrópico', () => {
    // 2 mm con 0.5 mm/col y 1 mm/fila → radio 4 px en x, 2 px en y
    const offs = DC.discOffsets(2, [1, 0.5]);
    const maxX = Math.max(...offs.map(o => o[0]));
    const maxY = Math.max(...offs.map(o => o[1]));
    assert.equal(maxX, 4);
    assert.equal(maxY, 2);
});

test('discOffsets con radio 0 devuelve solo el centro', () => {
    const offs = DC.discOffsets(0, [1, 1]);
    assert.equal(offs.length, 1);
    // Comparado por valor y no con deepEqual: el bucle produce -0, que es
    // === 0 pero no deepStrictEqual a 0.
    assert.ok(offs[0][0] === 0 && offs[0][1] === 0);
});

test('erode encoge y dilate crece', () => {
    const rows = 21, cols = 21;
    const m = new Uint8Array(rows * cols);
    for (let y = 5; y <= 15; y++) for (let x = 5; x <= 15; x++) m[y * cols + x] = 1;

    const offs = DC.discOffsets(1, [1, 1]);
    const er = DC.erode(m, rows, cols, offs);
    const di = DC.dilate(m, rows, cols, offs);

    const count = (a) => a.reduce((s, v) => s + v, 0);
    assert.ok(count(er) < count(m));
    assert.ok(count(di) > count(m));
    assert.equal(er[5 * cols + 5], 0, 'la esquina se erosiona');
    assert.equal(er[10 * cols + 10], 1, 'el centro sobrevive');
    assert.equal(di[4 * cols + 10], 1, 'la dilatación sale del borde');
});

test('erode trata el exterior de la imagen como fondo', () => {
    // Un cuadrado pegado al borde debe erosionarse por ese lado
    const rows = 11, cols = 11;
    const m = new Uint8Array(rows * cols).fill(1);
    const er = DC.erode(m, rows, cols, DC.discOffsets(1, [1, 1]));
    assert.equal(er[0], 0);
    assert.equal(er[5 * cols + 5], 1);
});

test('close rellena un hueco sin crecer el contorno', () => {
    const rows = 21, cols = 21;
    const m = new Uint8Array(rows * cols);
    for (let y = 5; y <= 15; y++) for (let x = 5; x <= 15; x++) m[y * cols + x] = 1;
    m[10 * cols + 10] = 0;                              // hueco de 1 px

    const cl = DC.close(m, rows, cols, DC.discOffsets(1, [1, 1]));
    assert.equal(cl[10 * cols + 10], 1, 'el hueco se rellena');
    assert.equal(cl[4 * cols + 10], 0, 'el contorno exterior no crece');
});

/* ── Componente conexa mayor ────────────────────────────────── */

test('largestComponent descarta las islas pequeñas', () => {
    const rows = 20, cols = 20;
    const m = new Uint8Array(rows * cols);
    for (let y = 2; y <= 10; y++) for (let x = 2; x <= 10; x++) m[y * cols + x] = 1;  // 81 px
    m[18 * cols + 18] = 1;                                                            // isla

    const { mask, count } = DC.largestComponent(m, rows, cols);
    assert.equal(count, 81);
    assert.equal(mask[18 * cols + 18], 0);
    assert.equal(mask[5 * cols + 5], 1);
});

test('largestComponent usa 4-conectividad, no 8', () => {
    // Dos bloques unidos solo por una diagonal: deben quedar separados,
    // porque con 8-conectividad el cerebro puentearía al cuero cabelludo
    // a través de una diagonal de un píxel en la tabla ósea.
    const rows = 12, cols = 12;
    const m = new Uint8Array(rows * cols);
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) m[y * cols + x] = 1;  // 16
    for (let y = 5; y <= 9; y++) for (let x = 5; x <= 9; x++) m[y * cols + x] = 1;  // 25
    const { count } = DC.largestComponent(m, rows, cols);
    assert.equal(count, 25);
});

test('largestComponent con máscara vacía no revienta', () => {
    const { count } = DC.largestComponent(new Uint8Array(100), 10, 10);
    assert.equal(count, 0);
});

/* ── Máscara de cerebro sobre fantoma ───────────────────────── */

test('brainMask aísla el parénquima y excluye hueso y aire', () => {
    const { frame } = headPhantom();
    const bm = DC.brainMask(frame);

    assert.ok(bm.ok, 'debe considerarse analizable');
    // Elipse de parénquima π·88·65 ≈ 17 970 px, menos ~5 px de erosión
    // en todo el perímetro (~485 px) → unos 15 600.
    assert.ok(bm.count > 12000 && bm.count < 18000, `píxeles de cerebro = ${bm.count}`);

    const at = (x, y) => bm.eroded[y * frame.cols + x];
    assert.equal(at(128, 128), 1, 'el centro del cerebro está dentro');
    assert.equal(at(2, 2), 0, 'el aire está fuera');
    assert.equal(at(128, 34), 0, 'el cráneo anterior está fuera');
});

test('brainMask marca ok=false cuando no hay cerebro', () => {
    const { frame } = headPhantom({ semiAP: 8, semiLR: 8, skullPx: 3 });
    assert.equal(DC.brainMask(frame).ok, false);
});

test('la erosión elimina la banda del borde interno', () => {
    const { frame } = headPhantom();
    const bm = DC.brainMask(frame);
    let closed = 0, eroded = 0;
    for (let i = 0; i < bm.mask.length; i++) { closed += bm.mask[i]; eroded += bm.eroded[i]; }
    assert.ok(eroded < closed, 'la erosionada es más pequeña');
    // Con 2.5 mm y 0.5 mm/px son 5 px de erosión: pérdida apreciable pero no masiva
    const lost = (closed - eroded) / closed;
    assert.ok(lost > 0.05 && lost < 0.35, `fracción perdida = ${(lost * 100).toFixed(1)} %`);
});

test('brainMask excluye el padding fuera del FOV', () => {
    const { frame } = headPhantom();
    // Marcar una esquina como padding con un valor que caería en rango de cerebro
    const PAD = 1050;                       // 26 UH con intercept -1024
    for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 20; x++) frame.pixelData[y * frame.cols + x] = PAD;
    }
    const sinPad = DC.brainMask(frame);
    frame.pixelPaddingValue = PAD;
    const conPad = DC.brainMask(frame);

    // La esquina es una isla, así que largestComponent ya la descarta;
    // lo que se comprueba es que declararla padding no rompe nada y que
    // el cerebro sigue siendo el mismo.
    assert.ok(conPad.ok);
    assert.ok(Math.abs(conPad.count - sinPad.count) / sinPad.count < 0.02);
});

/* ── Componentes conexas 3D ─────────────────────────────────── */

function maskWith(rows, cols, pixels) {
    const m = new Uint8Array(rows * cols);
    for (const [x, y] of pixels) m[y * cols + x] = 1;
    return m;
}

test('components3D une a través de los cortes', () => {
    const rows = 10, cols = 10;
    const masks = [
        maskWith(rows, cols, [[3, 3], [4, 3]]),
        maskWith(rows, cols, [[3, 3]]),
        maskWith(rows, cols, [[3, 3]]),
    ];
    const comps = DC.components3D(masks, rows, cols);
    assert.equal(comps.length, 1);
    assert.equal(comps[0].size, 4);
    assert.equal(new Set(comps[0].voxels.map(v => v.z)).size, 3);
});

test('components3D separa lo que no se toca', () => {
    const rows = 10, cols = 10;
    const masks = [
        maskWith(rows, cols, [[1, 1], [8, 8]]),
        maskWith(rows, cols, [[1, 1]]),
    ];
    const comps = DC.components3D(masks, rows, cols);
    assert.equal(comps.length, 2);
    assert.equal(comps[0].size, 2);   // ordenados por tamaño descendente
    assert.equal(comps[1].size, 1);
});

test('components3D usa 6-conectividad, no 26', () => {
    // Vóxeles en diagonal entre cortes: no deben unirse
    const rows = 10, cols = 10;
    const masks = [
        maskWith(rows, cols, [[3, 3]]),
        maskWith(rows, cols, [[4, 4]]),
    ];
    assert.equal(DC.components3D(masks, rows, cols).length, 2);
});

test('components3D salta cortes no analizados', () => {
    const rows = 10, cols = 10;
    const masks = [
        maskWith(rows, cols, [[3, 3]]),
        null,                               // corte sin analizar
        maskWith(rows, cols, [[3, 3]]),
    ];
    const comps = DC.components3D(masks, rows, cols);
    assert.equal(comps.length, 2, 'un hueco rompe la conexión');
});

test('components3D con todo vacío devuelve lista vacía', () => {
    assert.equal(DC.components3D([null, null], 10, 10).length, 0);
});

/* ── Contorno ───────────────────────────────────────────────── */

test('componentContour devuelve un polígono cerrado alrededor del componente', () => {
    const rows = 30, cols = 30;
    const px = [];
    for (let y = 10; y <= 20; y++) for (let x = 10; x <= 20; x++) px.push([x, y]);
    const comps = DC.components3D([maskWith(rows, cols, px)], rows, cols);

    const contour = DC.componentContour(comps[0], 0, rows, cols);
    assert.ok(contour, 'debe haber contorno');
    assert.ok(contour.length >= 4, `puntos = ${contour.length}`);

    // Simplificado: un cuadrado no debe salir con cientos de puntos
    assert.ok(contour.length < 20, `demasiados puntos: ${contour.length}`);

    // El centro cae dentro; una esquina lejana, fuera
    const RC = globalThis.ResearchCore;
    assert.equal(RC.pointInPolygon(15.5, 15.5, contour), true);
    assert.equal(RC.pointInPolygon(2.5, 2.5, contour), false);
});

test('componentContour devuelve null en un corte sin vóxeles', () => {
    const comps = DC.components3D([maskWith(20, 20, [[5, 5]])], 20, 20);
    assert.equal(DC.componentContour(comps[0], 3, 20, 20), null);
});

test('traceContour sobre un píxel aislado no entra en bucle', () => {
    const c = DC.traceContour(maskWith(10, 10, [[5, 5]]), 10, 10);
    assert.ok(c === null || c.length <= 4);
});

test('simplifyPolygon conserva las esquinas y tira los puntos colineales', () => {
    const pts = [];
    for (let x = 0; x <= 20; x++) pts.push({ x, y: 0 });
    for (let y = 1; y <= 20; y++) pts.push({ x: 20, y });
    const simple = DC.simplifyPolygon(pts, 0.5);
    assert.ok(simple.length <= 4, `puntos tras simplificar = ${simple.length}`);
    assert.equal(simple[0].x, 0);
    assert.equal(simple[simple.length - 1].y, 20);
});
