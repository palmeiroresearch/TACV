'use strict';

/* ============================================================
   Integración MeasurementStore ↔ ResearchCore.

   Carga config.js, research-core.js y measurement-store.js tal
   como los carga el navegador (globales, en orden de dependencia)
   dentro de un contexto vm con lo mínimo imprescindible stubbeado.
   Así se verifica el código REAL del store —el que alimenta el
   panel y la exportación— y no una reimplementación.
   ============================================================ */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** Carga los globales del navegador que necesita el store. */
function loadStore() {
    const sandbox = {
        console,
        // El store solo usa Storage para persistir y emitir eventos
        Storage: {
            _saved: [],
            saveMeasurements(id, data) { this._saved.push({ id, data }); return Promise.resolve(); },
            loadMeasurements() { return Promise.resolve(null); },
            dispatch() {},
            on() {},
        },
        setTimeout, clearTimeout,
    };
    const ctx = vm.createContext(sandbox);

    for (const f of ['js/config.js', 'js/research-core.js', 'js/measurement-store.js']) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }

    // Los archivos declaran sus objetos con `const` en el ámbito superior, que
    // en un contexto vm vive en el ámbito léxico global y no como propiedad del
    // sandbox. Hay que leerlos evaluando una expresión en el mismo contexto.
    const api = vm.runInContext(
        '({ MeasurementStore, ResearchCore, NWU_DEFAULTS, RESEARCH_BLOCKED_FILTERS, TOOL_IDS })',
        ctx
    );
    api.MeasurementStore.init('test-session');
    api.Storage = sandbox.Storage;
    return api;
}

/* Frame sintético: cuadrado uniforme de `hu` UH sobre fondo de aire. */
function frameOf(hu, { rows = 64, cols = 64, z = 0, spacing = [0.5, 0.5],
                       thickness = 5, pad = null } = {}) {
    const pixelData = new Int16Array(rows * cols).fill(-1000 + 1024);
    for (let y = 8; y < 56; y++) {
        for (let x = 8; x < 56; x++) pixelData[y * cols + x] = hu + 1024;
    }
    if (pad != null) {
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < cols; x++) pixelData[y * cols + x] = pad;
        }
    }
    return {
        pixelData, rows, cols,
        rescaleSlope: 1, rescaleIntercept: -1024,
        pixelSpacing: spacing,
        sliceThickness: thickness,
        imagePosition: [-16, -16, z],
        imageOrientation: [1, 0, 0, 0, 1, 0],
        sopInstanceUID: 'uid-' + z,
        pixelPaddingValue: pad,
        pixelPaddingRangeLimit: null,
    };
}

const square = (x0, y0, x1, y1) => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

/* ════════════════════════════════════════════════════════════ */

test('las ROI existentes miden sobre los valores originales en UH', () => {
    const { MeasurementStore: MS } = loadStore();
    const f = frameOf(33);

    const ell = MS.computeEllipseStats(f.pixelData, f.rows, f.cols,
        { cx: 32, cy: 32, rx: 10, ry: 10 }, f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));
    const rect = MS.computeRectStats(f.pixelData, f.rows, f.cols,
        { x1: 20, y1: 20, x2: 40, y2: 40 }, f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));
    const free = MS.computeFreehandStats(f.pixelData, f.rows, f.cols,
        square(20, 20, 40, 40), f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));

    for (const [name, s] of [['elipse', ell], ['rect', rect], ['libre', free]]) {
        assert.equal(s.mean, 33, `${name}: media`);
        assert.equal(s.std, 0, `${name}: SD`);
        assert.equal(s.median, 33, `${name}: mediana`);
        assert.ok(s.count > 0, `${name}: recuento`);
        // Alias `area` para los sitios de visualización que ya existían
        assert.equal(s.area, s.areaMm2, `${name}: alias de área`);
    }
});

test('las estadísticas se guardan sin redondear', () => {
    const { MeasurementStore: MS } = loadStore();
    // Mezcla 33 y 34 UH a partes iguales → media 33.5, que un redondeo
    // a entero destruiría y con ella la exactitud de la NWU.
    const f = frameOf(33);
    for (let y = 20; y < 30; y++) {
        for (let x = 20; x < 40; x++) f.pixelData[y * f.cols + x] = 34 + 1024;
    }
    const s = MS.computeRectStats(f.pixelData, f.rows, f.cols,
        { x1: 20, y1: 20, x2: 39, y2: 39 }, f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));
    assert.ok(!Number.isInteger(s.mean), `media redondeada: ${s.mean}`);
    assert.ok(Math.abs(s.mean - 33.5) < 1e-9, `media = ${s.mean}`);
});

test('el área de la elipse se cuenta por píxeles, igual que la ROI libre', () => {
    const { MeasurementStore: MS } = loadStore();
    const f = frameOf(33);
    const s = MS.computeEllipseStats(f.pixelData, f.rows, f.cols,
        { cx: 32, cy: 32, rx: 10, ry: 10 }, f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));
    // Área = píxeles dentro × área de píxel, no π·rx·ry
    assert.ok(Math.abs(s.areaMm2 - s.pixelsInMask * 0.25) < 1e-12);
    // Y queda cerca del valor analítico, sin ser idéntico
    const analytic = Math.PI * 10 * 10 * 0.25;
    assert.ok(Math.abs(s.areaMm2 - analytic) / analytic < 0.05);
});

test('_measureOpts propaga el padding del frame a las ROI existentes', () => {
    const { MeasurementStore: MS } = loadStore();
    const PAD = -2000 + 1024;
    const f = frameOf(33, { pad: PAD });
    // ROI que abarca la franja de padding de las 4 primeras filas
    const s = MS.computeRectStats(f.pixelData, f.rows, f.cols,
        { x1: 10, y1: 0, x2: 50, y2: 20 }, f.pixelSpacing,
        f.rescaleSlope, f.rescaleIntercept, MS._measureOpts(f));
    assert.ok(s.excludedPadding > 0, 'el padding debe excluirse');
    assert.equal(MS._measureOpts(f).padding, PAD);
});

/* ── Línea media ────────────────────────────────────────────── */

test('la línea media se guarda por corte y solo hay una por corte', () => {
    const { MeasurementStore: MS } = loadStore();
    MS.setMidline(3, { x: 32, y: 5 }, { x: 30, y: 60 }, 'manual');
    assert.ok(MS.getMidline(3));
    assert.equal(MS.getMidline(4), null, 'no se filtra a otros cortes');

    // Redefinirla reemplaza, no acumula
    MS.setMidline(3, { x: 33, y: 5 }, { x: 31, y: 60 }, 'auto');
    assert.equal(MS.get(3).filter(m => m.type === 'midline').length, 1);
    assert.equal(MS.getMidline(3).source, 'auto');
    assert.equal(MS.getMidline(3).anterior.x, 33);

    MS.setMidline(7, { x: 32, y: 5 }, { x: 30, y: 60 });
    // join() en vez de deepEqual: los arrays vienen de otro realm de vm y
    // deepStrictEqual compara también el prototipo.
    assert.equal(MS.getAllMidlines().map(m => m.sliceIndex).join(','), '3,7');
});

/* ── Pares de NWU ───────────────────────────────────────────── */

/** Crea un par lesión/espejo como lo hace NwuTools.createPair. */
function makePair(MS, RC, slice, frame, lesionPts, mid, threshold) {
    const mirrorPts = RC.reflectPolygon(lesionPts, mid.anterior, mid.posterior, frame.pixelSpacing);
    const lesion = MS.add(slice, {
        type: 'nwu_roi', role: 'lesion', pairId: 'p' + slice, shape: 'freehand',
        points: lesionPts, threshold: { ...threshold },
        stats: MS.computeNwuRoiStats(frame, lesionPts, threshold),
        researchMode: true, appVersion: '1.5.0',
    });
    const mirror = MS.add(slice, {
        type: 'nwu_roi', role: 'mirror', pairId: 'p' + slice, shape: 'freehand',
        points: mirrorPts, originalPoints: mirrorPts.map(p => ({ ...p })),
        threshold: { ...threshold }, mirrorOf: lesion.id,
        adjusted: false, offsetMm: 0, offsetPx: { dx: 0, dy: 0 },
        stats: MS.computeNwuRoiStats(frame, mirrorPts, threshold),
        researchMode: true, appVersion: '1.5.0',
    });
    return { lesion, mirror };
}

test('getNwuPairs empareja lesión y espejo y los ordena por corte', () => {
    const { MeasurementStore: MS, ResearchCore: RC } = loadStore();
    const f = frameOf(30);
    const mid = { anterior: { x: 32, y: 4 }, posterior: { x: 32, y: 60 } };
    const th = { huMin: 0, huMax: 60 };

    makePair(MS, RC, 5, f, square(36, 24, 44, 40), mid, th);
    makePair(MS, RC, 2, f, square(36, 24, 44, 40), mid, th);

    const pairs = MS.getNwuPairs();
    assert.equal(pairs.length, 2);
    assert.equal(pairs.map(p => p.lesion.sliceIndex).join(','), '2,5');
    for (const p of pairs) {
        assert.equal(p.lesion.role, 'lesion');
        assert.equal(p.mirror.role, 'mirror');
        assert.equal(p.mirror.mirrorOf, p.lesion.id);
    }
});

test('getNwuPairs ignora pares incompletos', () => {
    const { MeasurementStore: MS } = loadStore();
    MS.add(1, { type: 'nwu_roi', role: 'lesion', pairId: 'solo', points: square(1, 1, 5, 5) });
    assert.equal(MS.getNwuPairs().length, 0);
});

test('la ROI espejo refleja la lesión al otro lado y mide el otro hemisferio', () => {
    const { MeasurementStore: MS, ResearchCore: RC } = loadStore();
    // Hemisferio derecho a 28 UH, izquierdo a 33 UH, línea media en x=32
    const f = frameOf(33);
    for (let y = 8; y < 56; y++) {
        for (let x = 32; x < 56; x++) f.pixelData[y * f.cols + x] = 28 + 1024;
    }
    const mid = { anterior: { x: 32, y: 4 }, posterior: { x: 32, y: 60 } };
    const th = { huMin: 0, huMax: 60 };

    const { lesion, mirror } = makePair(MS, RC, 0, f, square(36, 24, 48, 40), mid, th);

    assert.equal(lesion.stats.mean, 28, 'la lesión mide el lado hipodenso');
    assert.equal(mirror.stats.mean, 33, 'el espejo mide el lado contralateral');
    assert.equal(mirror.stats.count, lesion.stats.count, 'mismo número de píxeles');
    assert.ok(Math.abs(RC.nwu(lesion.stats.mean, mirror.stats.mean) - 15.151515151515152) < 1e-12);
});

test('recomputeNwuStats vuelve a medir con el umbral nuevo y lo guarda', () => {
    const { MeasurementStore: MS, ResearchCore: RC } = loadStore();
    const f = frameOf(28);
    // Calcificación dentro de la ROI
    for (let y = 30; y < 33; y++) {
        for (let x = 30; x < 35; x++) f.pixelData[y * f.cols + x] = 300 + 1024;
    }
    const mid = { anterior: { x: 32, y: 4 }, posterior: { x: 32, y: 60 } };

    // Primero SIN umbral: la media está contaminada
    makePair(MS, RC, 0, f, square(24, 24, 44, 40), mid, { huMin: null, huMax: null });
    const before = MS.getNwuPairs()[0].lesion.stats.mean;
    assert.ok(before > 28);

    // Aplicar umbral → debe re-medir, no solo re-etiquetar
    const n = MS.recomputeNwuStats([f], { huMin: 0, huMax: 60 });
    assert.equal(n, 2, 'se recalculan lesión y espejo');

    const after = MS.getNwuPairs()[0].lesion;
    assert.equal(after.stats.mean, 28, 'la media vuelve a ser exacta');
    assert.ok(after.stats.excludedHigh > 0);
    // El umbral usado queda guardado en la medición, para la exportación.
    // Se comparan los campos uno a uno: deepStrictEqual falla entre realms
    // de vm distintos porque los objetos no comparten Object.prototype.
    assert.equal(after.threshold.huMin, 0);
    assert.equal(after.threshold.huMax, 60);
    assert.equal(after.stats.thresholdHuMin, 0);
    assert.equal(after.stats.thresholdHuMax, 60);
});

test('mover la ROI espejo no altera la de lesión', () => {
    const { MeasurementStore: MS, ResearchCore: RC } = loadStore();
    const f = frameOf(30);
    const mid = { anterior: { x: 32, y: 4 }, posterior: { x: 32, y: 60 } };
    const { lesion, mirror } = makePair(MS, RC, 0, f, square(36, 24, 44, 40), mid,
                                       { huMin: 0, huMax: 60 });
    const lesionBefore = JSON.stringify(lesion.points);

    const moved = RC.translatePolygon(mirror.points, 6, 8);
    const dx = moved[0].x - mirror.originalPoints[0].x;
    const dy = moved[0].y - mirror.originalPoints[0].y;
    MS.update(mirror.id, {
        points: moved, adjusted: true,
        offsetMm: RC.distanceMm({ x: 0, y: 0 }, { x: dx, y: dy }, f.pixelSpacing),
        offsetPx: { dx, dy },
        stats: MS.computeNwuRoiStats(f, moved, { huMin: 0, huMax: 60 }),
    });

    const p = MS.getNwuPairs()[0];
    assert.equal(JSON.stringify(p.lesion.points), lesionBefore);
    assert.equal(p.mirror.adjusted, true);
    // 6 px × 0.5 mm y 8 px × 0.5 mm → 3 y 4 mm → 5 mm
    assert.ok(Math.abs(p.mirror.offsetMm - 5) < 1e-12);
});

/* ── Septum ─────────────────────────────────────────────────── */

test('el septum se guarda por corte y solo hay uno por corte', () => {
    const { MeasurementStore: MS } = loadStore();
    MS.setSeptum(2, { x: 35, y: 30 }, 2.5);
    MS.setSeptum(2, { x: 36, y: 30 }, 3.0);
    assert.equal(MS.get(2).filter(m => m.type === 'septum').length, 1);
    assert.equal(MS.getSeptum(2).shiftMm, 3.0);
});

/* ── Volumen a través del store ─────────────────────────────── */

test('computeVolume usa el área encerrada y el espaciado real', () => {
    const { MeasurementStore: MS } = loadStore();
    const frames = [0, 1, 2].map(i => frameOf(30, { z: i * 2.5, thickness: 5 }));
    const pts = square(20, 20, 40, 40);

    const rois = frames.map((f, i) =>
        MS.add(i, { type: 'freehand', points: pts, stats: MS.computeNwuRoiStats(f, pts, {}) }));

    const v = MS.computeVolume(rois, frames);
    const area = rois[0].stats.areaTotalMm2;

    // Espaciado real 2.5 mm, no el SliceThickness de 5
    assert.ok(Math.abs(v.spacing.mean - 2.5) < 1e-12);
    assert.ok(Math.abs(v.mm3 - area * 2.5 * 3) < 1e-6);
    assert.equal(v.sliceCount, 3);
    // Y debe avisar del solapamiento
    assert.equal(v.spacing.overlap, true);
    assert.ok(v.warnings.some(w => /solapados/i.test(w)));
});

test('computeVolume devuelve null sin mediciones', () => {
    const { MeasurementStore: MS } = loadStore();
    assert.equal(MS.computeVolume([], []), null);
});

/* ── Hit testing de los tipos nuevos ────────────────────────── */

test('hitTest encuentra los elementos de investigación', () => {
    const { MeasurementStore: MS } = loadStore();
    // Elementos bien separados: hitTest resuelve el último añadido primero,
    // así que solapar sus zonas haría el test ambiguo.
    MS.setMidline(0, { x: 200, y: 20 }, { x: 196, y: 240 });
    MS.setSeptum(0, { x: 240, y: 130 }, 4);
    MS.add(0, { type: 'nwu_roi', role: 'lesion', pairId: 'p0',
                points: square(40, 40, 90, 90) });
    MS.add(0, { type: 'abc_axis', axis: 'A', p1: { x: 40, y: 200 }, p2: { x: 80, y: 200 },
                distanceMm: 20 });

    assert.equal(MS.hitTest(0, 200, 20)?.type,  'midline');   // extremo anterior
    assert.equal(MS.hitTest(0, 196, 240)?.type, 'midline');   // extremo posterior
    assert.equal(MS.hitTest(0, 240, 130)?.type, 'septum');
    assert.equal(MS.hitTest(0, 65, 65)?.type,   'nwu_roi');   // interior del polígono
    assert.equal(MS.hitTest(0, 40, 200)?.type,  'abc_axis');
    assert.equal(MS.hitTest(0, 400, 400), null, 'zona vacía');
});

test('el radio de selección de una ROI de NWU no roba clics a los vecinos', () => {
    // Regresión: con un margen de contorno de r·2 (16 px), un vértice del
    // polígono capturaba el clic destinado al extremo de la línea media.
    const { MeasurementStore: MS } = loadStore();
    MS.setMidline(0, { x: 32, y: 5 }, { x: 30, y: 60 });
    MS.add(0, { type: 'nwu_roi', role: 'lesion', pairId: 'p0',
                points: square(10, 10, 20, 20) });   // vértice a 13 px del extremo
    assert.equal(MS.hitTest(0, 32, 5)?.type, 'midline');
});

/* ── Persistencia por serie ─────────────────────────────────── */

test('las mediciones de investigación sobreviven al cambio de serie', () => {
    const { MeasurementStore: MS, ResearchCore: RC } = loadStore();
    const f = frameOf(30);
    const mid = { anterior: { x: 32, y: 4 }, posterior: { x: 32, y: 60 } };

    MS.setMidline(0, mid.anterior, mid.posterior, 'manual');
    makePair(MS, RC, 0, f, square(36, 24, 44, 40), mid, { huMin: 0, huMax: 60 });
    const pairsBefore = MS.getNwuPairs().length;

    MS.saveForSeries('serieA');
    MS.loadForSeries('serieB');
    assert.equal(MS.getNwuPairs().length, 0, 'la otra serie empieza vacía');
    assert.equal(MS.getMidline(0), null);

    MS.loadForSeries('serieA');
    assert.equal(MS.getNwuPairs().length, pairsBefore, 'al volver, todo sigue ahí');
    assert.ok(MS.getMidline(0));
    assert.equal(MS.getNwuPairs()[0].lesion.stats.mean, 30);
});
