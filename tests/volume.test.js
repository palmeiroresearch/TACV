'use strict';

/* Espaciado entre cortes, volumen por planimetría con espaciado irregular
   y ayudante ABC/2. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const RC     = require('../js/research-core.js');

/* Construye una serie axial: ImageOrientationPatient estándar (fila +X,
   columna +Y) → normal = +Z, y ImagePositionPatient en las z indicadas. */
function axialSeries(zs, sliceThickness = 5) {
    return zs.map((z, i) => ({
        imagePosition:    [-120, -120, z],
        imageOrientation: [1, 0, 0, 0, 1, 0],
        sliceLocation:    z,
        sliceThickness,
        pixelSpacing:     [0.5, 0.5],
        instanceNumber:   i + 1,
    }));
}

/* ── Normal del corte ───────────────────────────────────────── */

test('sliceNormal deriva +Z de una orientación axial', () => {
    const r = RC.sliceNormal([1, 0, 0, 0, 1, 0]);
    assert.deepEqual(r.normal.map(v => Math.round(v)), [0, 0, 1]);
    assert.equal(r.assumed, false);
});

test('sliceNormal avisa cuando falta ImageOrientationPatient', () => {
    const r = RC.sliceNormal(null);
    assert.deepEqual(r.normal, [0, 0, 1]);
    assert.equal(r.assumed, true);
});

test('sliceNormal maneja una adquisición inclinada (gantry tilt)', () => {
    // Columna inclinada 30° en el plano YZ
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const r = RC.sliceNormal([1, 0, 0, 0, c, s]);
    assert.equal(r.assumed, false);
    assert.ok(Math.abs(Math.hypot(...r.normal) - 1) < 1e-12, 'debe estar normalizada');
    // La normal ya no es +Z puro
    assert.ok(Math.abs(r.normal[1]) > 0.4);
});

/* ── Espaciado ──────────────────────────────────────────────── */

test('sliceSpacing usa ImagePositionPatient, no SliceThickness', () => {
    // SliceThickness dice 5 mm pero los centros están a 2.5 mm
    const frames = axialSeries([0, 2.5, 5, 7.5], 5);
    const sp = RC.sliceSpacing(frames);
    assert.equal(sp.source, 'ImagePositionPatient');
    assert.ok(Math.abs(sp.mean - 2.5) < 1e-12);
    assert.equal(sp.irregular, false);
});

test('sliceSpacing detecta cortes no equidistantes', () => {
    const frames = axialSeries([0, 5, 10, 18, 23], 5);   // un hueco de 8 mm
    const sp = RC.sliceSpacing(frames);
    assert.equal(sp.irregular, true);
    assert.equal(sp.min, 5);
    assert.equal(sp.max, 8);
    assert.ok(sp.warnings.some(w => /no equidistantes/i.test(w)));
});

test('sliceSpacing no marca irregular por ruido de redondeo del tag', () => {
    const frames = axialSeries([0, 5.001, 9.999, 15.0], 5);
    assert.equal(RC.sliceSpacing(frames).irregular, false);
});

test('sliceSpacing detecta solapamiento', () => {
    const frames = axialSeries([0, 3, 6, 9], 5);   // 3 mm de paso, 5 mm de grosor
    const sp = RC.sliceSpacing(frames);
    assert.equal(sp.overlap, true);
    assert.ok(sp.warnings.some(w => /solapados/i.test(w)));
});

test('sliceSpacing no marca solapamiento cuando paso = grosor', () => {
    assert.equal(RC.sliceSpacing(axialSeries([0, 5, 10], 5)).overlap, false);
});

test('sliceSpacing ordena los cortes por posición, no por índice', () => {
    const frames = axialSeries([10, 0, 5, 15]);   // desordenados
    const sp = RC.sliceSpacing(frames);
    assert.deepEqual(sp.spacings.map(s => Math.round(s)), [5, 5, 5]);
    assert.equal(sp.irregular, false);
});

test('sliceSpacing cae a SliceLocation si falta ImagePositionPatient', () => {
    const frames = axialSeries([0, 5, 10]);
    delete frames[1].imagePosition;
    const sp = RC.sliceSpacing(frames);
    assert.equal(sp.source, 'SliceLocation');
    assert.ok(sp.warnings.some(w => /ImagePositionPatient/.test(w)));
    assert.ok(Math.abs(sp.mean - 5) < 1e-12);
});

test('sliceSpacing avisa si falta ImageOrientationPatient', () => {
    const frames = axialSeries([0, 5, 10]);
    frames.forEach(f => delete f.imageOrientation);
    const sp = RC.sliceSpacing(frames);
    assert.equal(sp.positionsAssumed, true);
    assert.ok(sp.warnings.some(w => /axial/i.test(w)));
});

test('sliceSpacing con un solo corte usa SliceThickness y lo dice', () => {
    const sp = RC.sliceSpacing(axialSeries([0], 5), [0]);
    assert.equal(sp.mean, 5);
    assert.equal(sp.source, 'sliceThickness');
    assert.ok(sp.warnings.some(w => /un solo corte/i.test(w)));
});

test('sliceSpacing solo considera los índices pedidos', () => {
    const frames = axialSeries([0, 5, 10, 15, 20]);
    const sp = RC.sliceSpacing(frames, [0, 2, 4]);   // de 10 en 10
    assert.ok(Math.abs(sp.mean - 10) < 1e-12);
});

/* ── Volumen por planimetría ────────────────────────────────── */

test('volumen con espaciado uniforme: área × espaciado × nº de cortes', () => {
    const frames = axialSeries([0, 5, 10, 15], 5);
    const rois = [0, 1, 2, 3].map(i => ({ sliceIndex: i, areaMm2: 100 }));
    const v = RC.planimetricVolume(rois, frames);
    // Trapezoidal: extremos usan su único hueco (5), centros la semisuma (5)
    assert.ok(Math.abs(v.mm3 - 100 * 5 * 4) < 1e-9);
    assert.ok(Math.abs(v.mL - 2) < 1e-12);
    assert.equal(v.sliceCount, 4);
});

test('volumen con espaciado irregular pondera cada corte por su hueco local', () => {
    // Huecos: 5, 5, 8, 5 → el corte del hueco grande pesa más
    const frames = axialSeries([0, 5, 10, 18, 23], 5);
    const rois = [0, 1, 2, 3, 4].map(i => ({ sliceIndex: i, areaMm2: 100 }));
    const v = RC.planimetricVolume(rois, frames);

    // gaps locales: 5, 5, (5+8)/2=6.5, (8+5)/2=6.5, 5  → suma 28
    assert.ok(Math.abs(v.mm3 - 100 * 28) < 1e-9, `mm3=${v.mm3}`);
    assert.equal(v.spacing.irregular, true);
    assert.ok(v.warnings.some(w => /no equidistantes/i.test(w)));

    // Y difiere de asumir el espaciado medio para todos
    const naive = 100 * v.spacing.mean * 5;
    assert.ok(Math.abs(v.mm3 - naive) > 1e-6);
});

test('volumen con áreas distintas por corte', () => {
    const frames = axialSeries([0, 5, 10], 5);
    const v = RC.planimetricVolume([
        { sliceIndex: 0, areaMm2: 100 },
        { sliceIndex: 1, areaMm2: 200 },
        { sliceIndex: 2, areaMm2: 50  },
    ], frames);
    assert.ok(Math.abs(v.mm3 - (100 + 200 + 50) * 5) < 1e-9);
    assert.ok(Math.abs(v.totalAreaMm2 - 350) < 1e-12);
});

test('volumen de un solo corte depende de SliceThickness y lo advierte', () => {
    const frames = axialSeries([0], 5);
    const v = RC.planimetricVolume([{ sliceIndex: 0, areaMm2: 100 }], frames);
    assert.ok(Math.abs(v.mm3 - 500) < 1e-9);
    assert.ok(v.warnings.some(w => /un solo corte/i.test(w)));
});

test('volumen avisa si hay cortes sin ROI dentro del rango de la lesión', () => {
    const frames = axialSeries([0, 5, 10, 15, 20], 5);
    const v = RC.planimetricVolume([
        { sliceIndex: 0, areaMm2: 100 },
        { sliceIndex: 1, areaMm2: 100 },
        { sliceIndex: 4, areaMm2: 100 },   // salta los cortes 2 y 3
    ], frames);
    assert.ok(v.warnings.some(w => /sin ROI/i.test(w)));
});

test('volumen suma varias ROI en el mismo corte', () => {
    const frames = axialSeries([0, 5], 5);
    const v = RC.planimetricVolume([
        { sliceIndex: 0, areaMm2: 60 },
        { sliceIndex: 0, areaMm2: 40 },
        { sliceIndex: 1, areaMm2: 100 },
    ], frames);
    assert.equal(v.sliceCount, 2);
    assert.ok(Math.abs(v.mm3 - 100 * 5 * 2) < 1e-9);
});

test('volumen detalla el hueco usado en cada corte', () => {
    const frames = axialSeries([0, 5, 13], 5);
    const v = RC.planimetricVolume(
        [0, 1, 2].map(i => ({ sliceIndex: i, areaMm2: 10 })), frames);
    assert.equal(v.perSlice.length, 3);
    assert.ok(Math.abs(v.perSlice[0].gapMm - 5) < 1e-12);
    assert.ok(Math.abs(v.perSlice[1].gapMm - 6.5) < 1e-12);   // (5+8)/2
    assert.ok(Math.abs(v.perSlice[2].gapMm - 8) < 1e-12);
});

test('volumen sin ROI devuelve null', () => {
    assert.equal(RC.planimetricVolume([], axialSeries([0, 5])), null);
    assert.equal(RC.planimetricVolume(null, axialSeries([0, 5])), null);
});

/* ── ABC/2 ──────────────────────────────────────────────────── */

test('ABC/2 = A·B·C/2', () => {
    const r = RC.abc2(40, 30, 20);
    assert.equal(r.mm3, 12000);
    assert.equal(r.mL, 12);
});

test('deriveC multiplica el nº de cortes con lesión por el espaciado real', () => {
    // 4 cortes, espaciado real 2.5 mm, aunque SliceThickness diga 5
    const frames = axialSeries([0, 2.5, 5, 7.5], 5);
    const c = RC.deriveC([0, 1, 2, 3], frames);
    assert.ok(Math.abs(c.cMm - 10) < 1e-12);
    assert.ok(Math.abs(c.spacingMm - 2.5) < 1e-12);
    assert.equal(c.sliceCount, 4);
});

test('deriveC propaga los avisos de espaciado', () => {
    const frames = axialSeries([0, 5, 10, 18], 5);
    assert.ok(RC.deriveC([0, 1, 2, 3], frames).warnings.some(w => /no equidistantes/i.test(w)));
});

test('deriveC sin cortes devuelve null', () => {
    assert.equal(RC.deriveC([], axialSeries([0, 5])).cMm, null);
});

test('ABC/2 con C derivada da un volumen coherente con la planimetría', () => {
    // Lesión cilíndrica de radio 10 mm en 4 cortes de 5 mm:
    // planimetría = π·100·20 ≈ 6283 mm³; ABC/2 con A=B=20 y C=20 = 4000 mm³.
    // ABC/2 subestima un cilindro — se comprueba el orden de magnitud y que
    // la relación es la esperada (π/2 ≈ 1.57).
    const frames = axialSeries([0, 5, 10, 15], 5);
    const rois = [0, 1, 2, 3].map(i => ({ sliceIndex: i, areaMm2: Math.PI * 100 }));
    const plan = RC.planimetricVolume(rois, frames);
    const c    = RC.deriveC([0, 1, 2, 3], frames);
    const est  = RC.abc2(20, 20, c.cMm);
    assert.ok(Math.abs(plan.mm3 / est.mm3 - Math.PI / 2) < 1e-9);
});
