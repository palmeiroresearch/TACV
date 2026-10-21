'use strict';

/* Integración de analyzeSeries: trazabilidad, acoplamiento con el camino de
   medición validado, y los casos en los que el detector debe negarse. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const DC     = require('../js/detect-core.js');
const RC     = globalThis.ResearchCore;
const { headSeries, expectedCylinderMl } = require('./helpers/head-phantom.js');

const SP = [0.5, 0.5];
const TH = { huMin: 0, huMax: 60 };

const LESION = { side: 1, lat: 40, ap: 0, radiusPx: 20, hu: 20 };

function withLesion(n = 5, extra = {}, seriesOpts = { lesionSlices: [1, 2, 3] }) {
    const { frames, midlines } = headSeries(n, { noiseSd: 4, lesion: LESION, ...extra }, seriesOpts);
    return { frames, midlines,
             result: DC.analyzeSeries({ frames, midlines, threshold: TH }) };
}

/* ══════════════════════════════════════════════════════════════
   La propiedad que sostiene todo el diseño
   ══════════════════════════════════════════════════════════════ */

test('la cifra del detector es IDÉNTICA a la de la ROI aceptada', () => {
    // El detector no mide: propone. Cuando el usuario acepta una región, su
    // contorno pasa a ser una ROI que se mide con ResearchCore.maskStats. Si
    // las dos cifras no coincidieran, el usuario vería un número cambiar al
    // aceptar, y eso haría el detector inservible para cuantificar.
    const { frames, result } = withLesion();
    assert.equal(result.ischemia.length, 1);
    const c = result.ischemia[0];

    for (const s of c.perSlice) {
        const f = frames[s.sliceIndex];

        // Medición independiente, exactamente como la haría una ROI libre
        const mine = RC.maskStats({
            pixelData: f.pixelData, rows: f.rows, cols: f.cols,
            slope: f.rescaleSlope, intercept: f.rescaleIntercept,
            pixelSpacing: f.pixelSpacing,
            padding: f.pixelPaddingValue ?? null,
            paddingRangeLimit: f.pixelPaddingRangeLimit ?? null,
            huMin: TH.huMin, huMax: TH.huMax,
            bbox: RC.polygonBounds(s.contour),
            inside: (x, y) => RC.pointInPolygon(x + 0.5, y + 0.5, s.contour),
        });

        assert.equal(mine.count, s.lesion.count, `corte ${s.sliceIndex}: nº de píxeles`);
        assert.equal(mine.mean,  s.lesion.mean,  `corte ${s.sliceIndex}: media`);
        assert.equal(mine.std,   s.lesion.std,   `corte ${s.sliceIndex}: SD`);
        assert.equal(mine.median, s.lesion.median, `corte ${s.sliceIndex}: mediana`);
        assert.equal(mine.areaMm2, s.lesion.areaMm2, `corte ${s.sliceIndex}: área`);
    }
});

test('la ROI espejo del detector coincide con la de la herramienta de NWU', () => {
    const { frames, midlines, result } = withLesion();
    const c = result.ischemia[0];

    for (const s of c.perSlice) {
        const f = frames[s.sliceIndex];
        const esperado = RC.reflectPolygon(s.contour, midlines[s.sliceIndex].anterior,
                                           midlines[s.sliceIndex].posterior, f.pixelSpacing);
        assert.equal(s.mirrorContour.length, esperado.length);
        for (let i = 0; i < esperado.length; i++) {
            assert.ok(Math.abs(s.mirrorContour[i].x - esperado[i].x) < 1e-12);
            assert.ok(Math.abs(s.mirrorContour[i].y - esperado[i].y) < 1e-12);
        }
    }
});

test('el área del contorno es exactamente el recuento de píxeles', () => {
    // Trazar por bordes de píxel y no por centros: con centros se perdía casi
    // un 10 % de área en una lesión de 20 px de radio.
    const rows = 120, cols = 120;
    for (const R of [5, 10, 20, 35]) {
        const m = new Uint8Array(rows * cols);
        let n = 0;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (Math.hypot(x + 0.5 - 60, y + 0.5 - 60) <= R) { m[y * cols + x] = 1; n++; }
            }
        }
        const comp = DC.components3D([m], rows, cols)[0];
        const poly = DC.componentContour(comp, 0, rows, cols);
        const area = RC.polygonAreaMm2(poly, [1, 1]);
        assert.equal(area, n, `r=${R}: área ${area} vs ${n} píxeles`);
    }
});

test('el NWU global del candidato es la media ponderada de sus cortes', () => {
    const { result } = withLesion();
    const c = result.ischemia[0];
    const esperado = RC.nwuWeighted(c.perSlice.map(s => ({
        lesionMean: s.lesion.mean, lesionCount: s.lesion.count,
        contraMean: s.mirror.mean, contraCount: s.mirror.count,
    })));
    assert.ok(Math.abs(c.nwu - esperado.nwu) < 1e-12);
    assert.ok(Math.abs(c.meanHu - esperado.lesionMean) < 1e-12);
    assert.equal(c.measuredPixels, esperado.lesionCount);
});

/* ══════════════════════════════════════════════════════════════
   Cuándo el detector se niega
   ══════════════════════════════════════════════════════════════ */

test('un corte sin línea media no se analiza y se dice en la salida', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION },
                                            { lesionSlices: [1, 2, 3] });
    delete midlines[2];
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });

    assert.ok(!r.analyzed.includes(2), 'el corte 2 queda fuera');
    assert.equal(r.perSlice.find(s => s.sliceIndex === 2).analyzed, false);
    assert.ok(r.warnings.some(w => /sin línea media/i.test(w)));

    // Y el candidato se parte en dos, porque el corte del medio falta
    assert.ok(r.ischemia.length >= 1);
    for (const c of r.ischemia) assert.ok(!c.perSlice.some(s => s.sliceIndex === 2));
});

test('sin ninguna línea media no se analiza nada y se avisa', () => {
    const { frames } = headSeries(3, { noiseSd: 4 });
    const r = DC.analyzeSeries({ frames, midlines: {}, threshold: TH });
    assert.equal(r.analyzed.length, 0);
    assert.equal(r.ischemia.length, 0);
    assert.equal(r.hemorrhage.length, 0);
    assert.ok(r.warnings.some(w => /Ningún corte analizable/i.test(w)));
});

test('una línea media estimada de baja confianza se denuncia', () => {
    const { frames, midlines } = headSeries(3, { noiseSd: 4 });
    for (const z of Object.keys(midlines)) {
        midlines[z] = { ...midlines[z], source: 'auto', confidence: 0.2 };
    }
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.ok(r.warnings.some(w => /baja\s+confianza/i.test(w)),
              `avisos: ${JSON.stringify(r.warnings)}`);
    assert.equal(r.perSlice[0].midlineSource, 'auto');
    assert.equal(r.perSlice[0].midlineConfidence, 0.2);
});

test('una línea media manual no dispara el aviso de confianza', () => {
    const { result } = withLesion();
    assert.ok(!result.warnings.some(w => /baja\s+confianza/i.test(w)));
});

test('un corte sin cerebro utilizable se salta', () => {
    const { frames, midlines } = headSeries(3, { noiseSd: 4 });
    // Dejar el corte 1 en aire
    frames[1].pixelData.fill(-1000 + 1024);
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.ok(!r.analyzed.includes(1));
    assert.equal(r.perSlice.find(s => s.sliceIndex === 1).brainOk, false);
});

/* ══════════════════════════════════════════════════════════════
   Espaciado y volumen
   ══════════════════════════════════════════════════════════════ */

test('el espaciado sale de ImagePositionPatient, no de SliceThickness', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION, thickness: 5 },
                                            { gapMm: 2.5, lesionSlices: [1, 2, 3] });
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.equal(r.spacing.source, 'ImagePositionPatient');
    assert.ok(Math.abs(r.spacing.mean - 2.5) < 1e-9, `espaciado = ${r.spacing.mean}`);

    // Con el mismo SliceThickness de 5 mm, el volumen debe salir a la mitad
    const exp = expectedCylinderMl(20, SP, 3, 2.5);
    const err = Math.abs(r.ischemia[0].volumeMl - exp) / exp;
    assert.ok(err < 0.15, `volumen ${r.ischemia[0].volumeMl.toFixed(3)} vs ${exp.toFixed(3)}`);
});

test('el solapamiento de cortes se propaga a los avisos', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION, thickness: 5 },
                                            { gapMm: 2.5, lesionSlices: [1, 2, 3] });
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.equal(r.spacing.overlap, true);
    assert.ok(r.warnings.some(w => /solapados/i.test(w)));
});

test('el espaciado irregular se detecta y se avisa', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION },
                                            { lesionSlices: [1, 2, 3] });
    // Mover el corte 3 para romper la equidistancia
    frames[3].imagePosition = [-64, -64, 23];
    frames[3].sliceLocation = 23;
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.equal(r.spacing.irregular, true);
    assert.ok(r.warnings.some(w => /no equidistantes/i.test(w)));
});

/* ══════════════════════════════════════════════════════════════
   Trazabilidad de la salida
   ══════════════════════════════════════════════════════════════ */

test('la salida guarda todos los parámetros usados', () => {
    const { result } = withLesion();
    const p = result.params;
    assert.ok(p, 'tiene que haber params para poder reproducir el análisis');
    for (const k of ['ischAsymHu', 'ischHuMin', 'ischHuMax', 'ischMinVolMl',
                     'hemHuMin', 'hemHuMax', 'hemMinVolMl', 'calcHuMin',
                     'erodeMm', 'smoothMm', 'midlineBandMm',
                     'candidateMinPx', 'candidateCloseMm',
                     'sectorDeltaHu', 'sectorZ', 'angBins', 'radBins']) {
        assert.ok(p[k] !== undefined, `falta el parámetro ${k}`);
    }
    assert.equal(p.threshold.huMin, 0);
    assert.equal(p.threshold.huMax, 60);
});

test('los parámetros pasados sobrescriben los valores por defecto', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION },
                                            { lesionSlices: [1, 2, 3] });
    const laxo = DC.analyzeSeries({ frames, midlines, threshold: TH,
                                    opts: { ischAsymHu: -3 } });
    const estricto = DC.analyzeSeries({ frames, midlines, threshold: TH,
                                        opts: { ischAsymHu: -13 } });
    assert.equal(laxo.params.ischAsymHu, -3);
    assert.ok(laxo.ischemia[0].volumeMl > estricto.ischemia[0].volumeMl,
              'un umbral más laxo da una región más grande');
});

test('cada candidato lleva el umbral con el que se midió', () => {
    const { result } = withLesion();
    const c = result.ischemia[0];
    assert.equal(c.threshold.huMin, 0);
    assert.equal(c.threshold.huMax, 60);
});

test('píxeles detectados y medidos son cosas distintas, y se ve al mover el umbral', () => {
    // Los vóxeles son lo que encontró la asimetría; los medidos, lo que queda
    // dentro del contorno tras aplicar los umbrales de exclusión. Que los dos
    // se informen por separado importa: un umbral estrecho puede dejar una
    // región grande con muy pocos píxeles medidos, y eso hay que poder verlo.
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION },
                                            { lesionSlices: [1, 2, 3] });

    const ancho = DC.analyzeSeries({ frames, midlines, threshold: { huMin: 0, huMax: 60 } });
    // La lesión está a 20 UH: un umbral que empieza en 25 la excluye casi toda
    const estrecho = DC.analyzeSeries({ frames, midlines, threshold: { huMin: 25, huMax: 60 } });

    const a = ancho.ischemia[0], e = estrecho.ischemia[0];
    assert.ok(a.detectedVoxels > 0 && a.measuredPixels > 0);
    assert.equal(e.detectedVoxels, a.detectedVoxels,
                 'el umbral de exclusión no cambia lo que DETECTA la asimetría');
    assert.ok(e.measuredPixels < a.measuredPixels * 0.5,
              `medidos ${e.measuredPixels} vs ${a.measuredPixels} con el umbral ancho`);
    assert.ok(e.perSlice[0].lesion.excludedLow > 0, 'y se cuenta lo excluido');
});

test('los candidatos vienen ordenados de mayor a menor', () => {
    const { frames, midlines } = headSeries(5, {
        noiseSd: 4,
        blobs: [{ side: -1, lat: 30, ap: -20, radiusPx: 14, hu: 60, rampPx: 3 },
                { side: -1, lat: 30, ap:  25, radiusPx: 8,  hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.ok(r.hemorrhage.length >= 2);
    for (let i = 1; i < r.hemorrhage.length; i++) {
        assert.ok(r.hemorrhage[i - 1].detectedVoxels >= r.hemorrhage[i].detectedVoxels);
    }
});

test('el hemisferio se etiqueta a partir de la orientación DICOM', () => {
    const { result } = withLesion();
    const c = result.ischemia[0];
    assert.ok(['izquierdo', 'derecho'].includes(c.hemisphereLabel),
              `etiqueta = ${c.hemisphereLabel}`);
    assert.ok(c.sideMm != null && Math.abs(c.sideMm) > 5,
              `distancia a la línea media = ${c.sideMm}`);
});

test('sin orientación DICOM no se inventa la lateralidad', () => {
    const { frames, midlines } = headSeries(5, { noiseSd: 4, lesion: LESION },
                                            { lesionSlices: [1, 2, 3] });
    frames.forEach(f => { delete f.imageOrientation; });
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    assert.ok(/lado/.test(r.ischemia[0].hemisphereLabel),
              `etiqueta neutra esperada, salió ${r.ischemia[0].hemisphereLabel}`);
});

/* ══════════════════════════════════════════════════════════════
   Rendimiento
   ══════════════════════════════════════════════════════════════ */

test('una serie de 512×512 se analiza en un tiempo razonable', () => {
    const { frames, midlines } = headSeries(6, {
        rows: 512, cols: 512, cx: 256, cy: 256,
        semiAP: 190, semiLR: 144, skullPx: 14, noiseSd: 4,
        lesion: { side: 1, lat: 80, ap: 0, radiusPx: 40, hu: 20 },
    }, { lesionSlices: [2, 3] });

    const t0 = Date.now();
    const r = DC.analyzeSeries({ frames, midlines, threshold: TH });
    const ms = Date.now() - t0;

    assert.equal(r.analyzed.length, 6);
    assert.equal(r.ischemia.length, 1);
    // Presupuesto holgado: en un worker con barra de progreso, una serie real
    // de 30 cortes a 512² debe quedarse en unos pocos segundos.
    assert.ok(ms < 6000, `${ms} ms para 6 cortes de 512²`);
});
