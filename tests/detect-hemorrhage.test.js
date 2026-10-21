'use strict';

/* Candidatos hiperdensos, marcas de confusor y el papel de la erosión. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const DC     = require('../js/detect-core.js');
const { headSeries } = require('./helpers/head-phantom.js');

const SP = [0.5, 0.5];
const TH = { huMin: 0, huMax: 60 };

const analyze = (n, cfg, seriesOpts = {}, opts = {}) => {
    const { frames, midlines } = headSeries(n, cfg, seriesOpts);
    return DC.analyzeSeries({ frames, midlines, threshold: TH, opts });
};

const codes = (c) => c.flags.map(f => f.code);

/* ── Detección básica ───────────────────────────────────────── */

test('detecta un hematoma de 60 UH con el volumen y las UH correctos', () => {
    const r = analyze(5, {
        noiseSd: 4,
        blobs: [{ side: -1, lat: 30, ap: -10, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });

    assert.equal(r.hemorrhage.length, 1, `candidatos = ${r.hemorrhage.length}`);
    const c = r.hemorrhage[0];

    assert.ok(Math.abs(c.meanHu - 58) < 4, `media = ${c.meanHu}`);
    assert.deepEqual([...c.sliceRange], [1, 3]);

    // El umbral [45,95] recorta la rampa en hu=45, es decir en r≈13,8 px:
    // π·13,8²·0,25 mm² × 3 cortes × 5 mm ≈ 2,24 mL
    assert.ok(Math.abs(c.volumeMl - 2.24) < 0.25, `volumen = ${c.volumeMl.toFixed(3)} mL`);
    assert.deepEqual(codes(c).filter(x => x !== 'un-corte'), []);
});

test('la hemorragia se mide por densidad absoluta, no por asimetría', () => {
    // Lo contrario que la isquemia: un hematoma BILATERAL sí se ve, porque el
    // detector no compara hemisferios. Es la diferencia de diseño clave.
    const r = analyze(5, {
        noiseSd: 4,
        blobs: [{ side: -1, lat: 30, radiusPx: 11, hu: 60, rampPx: 3 },
                { side:  1, lat: 30, radiusPx: 11, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    assert.equal(r.hemorrhage.length, 2, 'los dos hematomas se detectan');
});

test('un hematoma por debajo del volumen mínimo se descarta', () => {
    const r = analyze(3, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, radiusPx: 4, hu: 60, rampPx: 2 }],
    }, { blobSlices: [1] });
    // π·4²·0,25 × 5 mm ≈ 63 mm³ = 0,06 mL, muy por debajo de 0,5 mL
    assert.equal(r.hemorrhage.length, 0);
});

test('el parénquima normal no produce candidatos hiperdensos', () => {
    assert.equal(analyze(5, { noiseSd: 4 }).hemorrhage.length, 0);
});

test('la detección de hemorragia no se degrada con la línea media torcida', () => {
    // Al no depender de la asimetría, un error de línea media no la afecta.
    const base = analyze(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });

    const { frames, midlines } = headSeries(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    for (const z of Object.keys(midlines)) {
        const m = midlines[z];
        const cx = (m.anterior.x + m.posterior.x) / 2, cy = (m.anterior.y + m.posterior.y) / 2;
        const a = 8 * Math.PI / 180;
        const rot = (p) => ({ x: cx + Math.cos(a) * (p.x - cx) - Math.sin(a) * (p.y - cy),
                              y: cy + Math.sin(a) * (p.x - cx) + Math.cos(a) * (p.y - cy) });
        midlines[z] = { ...m, anterior: rot(m.anterior), posterior: rot(m.posterior) };
    }
    const torcido = DC.analyzeSeries({ frames, midlines, threshold: TH });

    assert.equal(torcido.hemorrhage.length, base.hemorrhage.length);
    const rel = Math.abs(torcido.hemorrhage[0].volumeMl - base.hemorrhage[0].volumeMl) /
                base.hemorrhage[0].volumeMl;
    assert.ok(rel < 0.02, `volumen difiere ${(rel * 100).toFixed(2)} %`);
});

/* ── Confusores ─────────────────────────────────────────────── */

test('una calcificación densa se detecta y se marca como tal', () => {
    // Un núcleo de 150 UH con rampa de volumen parcial: la corona cae en el
    // rango de sangre y el contorno encierra el núcleo denso, así que el
    // máximo delata que no es sangre.
    const r = analyze(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, ap: -10, radiusPx: 10, hu: 150, rampPx: 5 }],
    }, { blobSlices: [1, 2, 3] });

    assert.equal(r.hemorrhage.length, 1);
    const c = r.hemorrhage[0];
    assert.ok(c.maxHu >= DC.DEFAULTS.calcHuMin, `máximo = ${c.maxHu}`);
    assert.ok(codes(c).includes('posible-calcificacion'));
    const f = c.flags.find(x => x.code === 'posible-calcificacion');
    assert.ok(/calcificaci/i.test(f.text) && /pineal|plexos/i.test(f.text));
});

test('el relleno de agujeros es lo que permite ver la calcificación', () => {
    // Sin rellenar, el núcleo de 150 UH queda por encima del umbral de
    // parénquima y abre un agujero en la máscara; la erosión se come entonces
    // la corona de volumen parcial, que es justo la señal.
    const cfg = { noiseSd: 4,
                  blobs: [{ side: -1, lat: 30, ap: -10, radiusPx: 10, hu: 150, rampPx: 5 }] };
    const { frames, midlines } = headSeries(5, cfg, { blobSlices: [1, 2, 3] });

    const f0 = frames[2];
    const conRelleno = DC.brainMask(f0);
    // Reproducir el comportamiento sin relleno: máscara cruda + erosión
    const slope = f0.rescaleSlope, inter = f0.rescaleIntercept;
    const raw = new Uint8Array(f0.rows * f0.cols);
    for (let i = 0; i < raw.length; i++) {
        const hu = raw0Hu(f0.pixelData[i], slope, inter);
        if (hu >= DC.DEFAULTS.brainHuMin && hu < DC.DEFAULTS.brainHuMax) raw[i] = 1;
    }
    const big = DC.largestComponent(raw, f0.rows, f0.cols);
    const sinRelleno = DC.erode(
        DC.close(big.mask, f0.rows, f0.cols, DC.discOffsets(DC.DEFAULTS.closeMm, f0.pixelSpacing)),
        f0.rows, f0.cols, DC.discOffsets(DC.DEFAULTS.erodeMm, f0.pixelSpacing));

    let conN = 0, sinN = 0;
    for (let i = 0; i < raw.length; i++) { conN += conRelleno.eroded[i]; sinN += sinRelleno[i]; }
    assert.ok(conN > sinN, `con relleno ${conN} px debe superar a ${sinN} sin relleno`);

    function raw0Hu(v, s, i) { return v * s + i; }
});

test('una calcificación bilateral simétrica se marca como fisiológica', () => {
    const r = analyze(5, {
        noiseSd: 4,
        blobs: [{ side: -1, lat: 18, ap: 5, radiusPx: 8, hu: 150, rampPx: 5 },
                { side:  1, lat: 18, ap: 5, radiusPx: 8, hu: 150, rampPx: 5 }],
    }, { blobSlices: [1, 2, 3] });

    assert.equal(r.hemorrhage.length, 2);
    for (const c of r.hemorrhage) {
        assert.ok(codes(c).includes('posible-calcificacion'));
        assert.ok(codes(c).includes('contrapartida-simetrica'),
                  `faltó la marca simétrica en ${codes(c)}`);
    }
    // Y están en hemisferios opuestos
    assert.equal(Math.sign(r.hemorrhage[0].sideMm), -Math.sign(r.hemorrhage[1].sideMm));
});

test('un hematoma unilateral NO se marca como contrapartida simétrica', () => {
    const r = analyze(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    assert.equal(r.hemorrhage.length, 1);
    assert.ok(!codes(r.hemorrhage[0]).includes('contrapartida-simetrica'));
});

/* ── La erosión del borde interno ───────────────────────────── */

test('la erosión del borde elimina el falso positivo del reborde de tabla interna', () => {
    // El volumen parcial en la tabla interna produce píxeles de 60-90 UH, justo
    // en el rango de sangre aguda. Es la mayor fuente de falsos positivos del
    // detector y la razón de ser de la erosión.
    const cfg = { noiseSd: 4, rimHu: 40 };

    const conErosion = analyze(3, cfg);
    assert.equal(conErosion.hemorrhage.length, 0, 'con erosión: ningún falso positivo');

    const sinErosion = analyze(3, cfg, {}, { erodeMm: 0 });
    assert.ok(sinErosion.hemorrhage.length >= 1, 'sin erosión: aparece el falso positivo');

    const c = sinErosion.hemorrhage[0];
    assert.ok(c.volumeMl > 20,
              `el falso positivo es enorme (${c.volumeMl.toFixed(1)} mL): es todo el reborde`);
    assert.ok(c.peripheralFraction > 0.8, `fracción periférica = ${c.peripheralFraction}`);
    assert.ok(codes(c).includes('sugiere-extraaxial'),
              'y al menos queda marcado como periférico');
});

test('la fracción periférica distingue una colección del borde de un hematoma profundo', () => {
    const profundo = analyze(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 25, ap: 0, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    assert.equal(profundo.hemorrhage.length, 1);
    assert.ok(profundo.hemorrhage[0].peripheralFraction < 0.5,
              `profundo: ${profundo.hemorrhage[0].peripheralFraction}`);
    assert.ok(!codes(profundo.hemorrhage[0]).includes('sugiere-extraaxial'));
});

/* ── Límites declarados ─────────────────────────────────────── */

test('la salida declara que no se busca hemorragia subaracnoidea', () => {
    const r = analyze(3, { noiseSd: 4 });
    assert.ok(r.warnings.some(w => /subaracnoidea/i.test(w)),
              'el límite tiene que ir en la salida, no solo en la documentación');
});

test('la salida avisa del artefacto de la base del cráneo', () => {
    const r = analyze(3, { noiseSd: 4 });
    assert.ok(r.warnings.some(w => /endurecimiento del haz/i.test(w)));
});

test('la salida avisa de que mide densidad, no cronología', () => {
    const r = analyze(3, { noiseSd: 4 });
    assert.ok(r.warnings.some(w => /cronolog/i.test(w) && /antiguo/i.test(w)));
});
