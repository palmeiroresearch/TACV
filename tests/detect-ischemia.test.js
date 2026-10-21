'use strict';

/* Mapa de asimetría, candidatos hipodensos, sectores y sonda ASPECTS. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const DC     = require('../js/detect-core.js');
const RC     = globalThis.ResearchCore;
const { headPhantom, headSeries, expectedCylinderMl } = require('./helpers/head-phantom.js');

const SP = [0.5, 0.5];
const TH = { huMin: 0, huMax: 60 };

const analyze = (n, cfg, seriesOpts = {}, opts = {}) => {
    const { frames, midlines } = headSeries(n, cfg, seriesOpts);
    return { ...DC.analyzeSeries({ frames, midlines, threshold: TH, opts }), frames, midlines };
};

/* ── Reflexión precalculada ─────────────────────────────────── */

test('mirrorCoeffs coincide con ResearchCore.reflectPointOverLine', () => {
    // El detector usa una matriz precalculada por velocidad; tiene que dar
    // exactamente lo mismo que la función validada de la fase anterior.
    const mid = { anterior: { x: 128, y: 12 }, posterior: { x: 112, y: 244 } };
    const C = DC.mirrorCoeffs(mid, SP);
    for (const [x, y] of [[180, 128], [60, 200], [128, 50], [200, 30], [10, 10]]) {
        const ref = RC.reflectPointOverLine({ x: x + 0.5, y: y + 0.5 },
                                            mid.anterior, mid.posterior, SP);
        const X = (x + 0.5) * SP[1] - C.ax, Y = (y + 0.5) * SP[0] - C.ay;
        const mx = (C.ax + C.r11 * X + C.r12 * Y) / SP[1];
        const my = (C.ay + C.r21 * X + C.r22 * Y) / SP[0];
        assert.ok(Math.abs(mx - ref.x) < 1e-9, `x: ${mx} vs ${ref.x}`);
        assert.ok(Math.abs(my - ref.y) < 1e-9, `y: ${my} vs ${ref.y}`);
    }
});

test('mirrorCoeffs devuelve null con línea media degenerada', () => {
    assert.equal(DC.mirrorCoeffs({ anterior: { x: 5, y: 5 }, posterior: { x: 5, y: 5 } }, SP), null);
});

/* ── Mapa de asimetría ──────────────────────────────────────── */

test('la asimetría de una cabeza simétrica es exactamente cero', () => {
    const { frame, midline } = headPhantom({ noiseSd: 0 });
    const bm = DC.brainMask(frame);
    const { asym } = DC.asymmetryMap(frame, bm.eroded, midline);

    let worst = 0, n = 0;
    for (let i = 0; i < asym.length; i++) {
        if (Number.isNaN(asym[i])) continue;
        worst = Math.max(worst, Math.abs(asym[i])); n++;
    }
    assert.ok(n > 8000, `píxeles comparables = ${n}`);
    assert.equal(worst, 0, `asimetría máxima = ${worst}`);
});

test('la asimetría excluye la banda de la línea media', () => {
    const { frame, midline } = headPhantom();
    const bm = DC.brainMask(frame);
    const { asym } = DC.asymmetryMap(frame, bm.eroded, midline);
    // Un píxel justo sobre la línea media no debe tener asimetría definida:
    // la hoz y el seno longitudinal generan asimetría espuria ahí.
    const i = Math.round(midline.anterior.y + 40) * frame.cols + Math.round(midline.anterior.x);
    assert.ok(Number.isNaN(asym[i]), 'la banda central queda sin comparar');
});

test('la asimetría es antisimétrica entre los dos hemisferios', () => {
    const { frame, midline } = headPhantom({ lesion: { side: 1, lat: 40, radiusPx: 18, hu: 20 } });
    const bm = DC.brainMask(frame);
    const { asym } = DC.asymmetryMap(frame, bm.eroded, midline);
    const C = DC.mirrorCoeffs(midline, SP);

    let checked = 0;
    for (let y = 40; y < 220; y += 7) {
        for (let x = 40; x < 220; x += 7) {
            const i = y * frame.cols + x;
            if (Number.isNaN(asym[i])) continue;
            const X = (x + 0.5) * SP[1] - C.ax, Y = (y + 0.5) * SP[0] - C.ay;
            const mx = Math.floor((C.ax + C.r11 * X + C.r12 * Y) / SP[1]);
            const my = Math.floor((C.ay + C.r21 * X + C.r22 * Y) / SP[0]);
            const j = my * frame.cols + mx;
            if (Number.isNaN(asym[j])) continue;
            assert.ok(Math.abs(asym[i] + asym[j]) < 1e-4,
                      `A(p)=${asym[i]} A(espejo)=${asym[j]}`);
            checked++;
        }
    }
    assert.ok(checked > 100, `pares comprobados = ${checked}`);
});

/* ── Candidatos hipodensos ──────────────────────────────────── */

test('cabeza simétrica sin lesión: CERO candidatos', () => {
    // La prueba de falsos positivos. Es la más importante de todas: un
    // detector que marca algo en un cerebro normal no sirve para cribar.
    const r = analyze(5, { noiseSd: 0 });
    assert.equal(r.ischemia.length, 0);
    assert.equal(r.hemorrhage.length, 0);
});

test('cabeza simétrica con ruido realista: CERO candidatos', () => {
    const r = analyze(5, { noiseSd: 4 });
    assert.equal(r.ischemia.length, 0, 'sin falsos positivos de isquemia');
    assert.equal(r.hemorrhage.length, 0, 'sin falsos positivos de hemorragia');
});

test('detecta una lesión hipodensa instaurada con el volumen y las UH correctos', () => {
    const r = analyze(5, {
        noiseSd: 4, lesion: { side: 1, lat: 40, ap: 0, radiusPx: 20, hu: 20 },
    }, { lesionSlices: [1, 2, 3] });

    assert.equal(r.ischemia.length, 1, `candidatos = ${r.ischemia.length}`);
    const c = r.ischemia[0];

    // UH medidas sobre los valores originales: el fantoma vale 20 exactos
    assert.ok(Math.abs(c.meanHu - 20) < 1.0, `media = ${c.meanHu}`);
    assert.ok(Math.abs(c.contraMeanHu - 35) < 1.0, `contralateral = ${c.contraMeanHu}`);
    assert.ok(Math.abs(c.nwu - (1 - 20 / 35) * 100) < 3, `NWU = ${c.nwu}`);

    // Volumen: subestima ~7 % porque la asimetría promediada no alcanza el
    // umbral en la frontera. Es el lado seguro del error y está documentado.
    const exp = expectedCylinderMl(20, SP, 3, 5);
    const err = (c.volumeMl - exp) / exp;
    assert.ok(err > -0.15 && err < 0.02,
              `volumen ${c.volumeMl.toFixed(3)} mL vs ${exp.toFixed(3)} esperado (${(err*100).toFixed(1)} %)`);

    assert.deepEqual([...c.sliceRange], [1, 3]);
    assert.equal(c.sliceCount, 3);
});

test('el candidato no se sale de los cortes donde está la lesión', () => {
    const r = analyze(5, {
        noiseSd: 4, lesion: { side: 1, lat: 40, radiusPx: 20, hu: 20 },
    }, { lesionSlices: [2] });
    assert.equal(r.ischemia.length, 1);
    assert.deepEqual([...r.ischemia[0].sliceRange], [2, 2]);
    assert.ok(r.ischemia[0].flags.some(f => f.code === 'un-corte'));
});

test('una lesión por debajo del volumen mínimo se descarta', () => {
    const r = analyze(3, {
        noiseSd: 4, lesion: { side: 1, lat: 40, radiusPx: 5, hu: 20 },
    }, { lesionSlices: [1] });
    // π·5²·0.25 mm² × 5 mm = 98 mm³ = 0.098 mL, muy por debajo de 1 mL
    assert.equal(r.ischemia.length, 0);
});

test('la lesión se detecta igual con la línea media inclinada 20°', () => {
    const recto = analyze(5, {
        noiseSd: 4, tiltDeg: 0, lesion: { side: 1, lat: 40, radiusPx: 20, hu: 20 },
    }, { lesionSlices: [1, 2, 3] });
    const torcido = analyze(5, {
        noiseSd: 4, tiltDeg: 20, lesion: { side: 1, lat: 40, radiusPx: 20, hu: 20 },
    }, { lesionSlices: [1, 2, 3] });

    assert.equal(recto.ischemia.length, 1);
    assert.equal(torcido.ischemia.length, 1);
    const rel = Math.abs(torcido.ischemia[0].volumeMl - recto.ischemia[0].volumeMl) /
                recto.ischemia[0].volumeMl;
    assert.ok(rel < 0.12, `volumen difiere ${(rel * 100).toFixed(1)} % con la inclinación`);
    assert.ok(Math.abs(torcido.ischemia[0].meanHu - recto.ischemia[0].meanHu) < 1.5);
});

test('una hipodensidad BILATERAL SIMÉTRICA es invisible — límite del método', () => {
    // Todo método por asimetría es ciego a esto, por construcción. La prueba
    // fija el límite para que nadie lo descubra con un paciente delante.
    const r = analyze(5, {
        noiseSd: 4,
        blobs: [{ side: -1, lat: 40, radiusPx: 20, hu: 20 },
                { side:  1, lat: 40, radiusPx: 20, hu: 20 }],
    }, { blobSlices: [1, 2, 3] });
    assert.equal(r.ischemia.length, 0);
    assert.ok(r.warnings.some(w => /bilateral y simétrica/i.test(w)),
              'y el aviso tiene que estar en la salida');
});

test('el tejido SANO enfrentado a una hemorragia no se marca como isquemia', () => {
    // Regresión de un falso positivo real: el parénquima normal comparado con
    // una hemorragia contralateral sale hipodenso. La asimetría es cierta pero
    // la lectura es la contraria, así que se exige que el lado de referencia
    // sea parénquima normal.
    const r = analyze(5, {
        noiseSd: 4, blobs: [{ side: -1, lat: 30, ap: -10, radiusPx: 12, hu: 60, rampPx: 3 }],
    }, { blobSlices: [1, 2, 3] });
    assert.equal(r.hemorrhage.length, 1, 'la hemorragia sí se ve');
    assert.equal(r.ischemia.length, 0, 'y no genera una isquemia espuria enfrente');
});

/* ── Sectores ───────────────────────────────────────────────── */

test('sectorMap sobre cabeza simétrica: los 18 pares con ΔUH cero', () => {
    const { frame, midline } = headPhantom({ noiseSd: 0 });
    const bm = DC.brainMask(frame);
    const sm = DC.sectorMap(frame, bm.eroded, midline);

    assert.equal(sm.sectors.length, 18, 'angBins 6 × radBins 3');
    const usable = sm.sectors.filter(s => s.usable);
    assert.equal(usable.length, 18, 'todos evaluables');
    assert.equal(sm.flaggedCount, 0, 'ninguno marcado');
    for (const s of usable) {
        assert.equal(s.deltaHu, 0, `ΔUH del sector ${s.angBin}/${s.radBin} = ${s.deltaHu}`);
    }
});

test('sectorMap con ruido: ningún sector marcado y |z| por debajo del umbral', () => {
    const { frame, midline } = headPhantom({ noiseSd: 4 });
    const bm = DC.brainMask(frame);
    const sm = DC.sectorMap(frame, bm.eroded, midline);
    assert.equal(sm.flaggedCount, 0);
    const zmax = Math.max(...sm.sectors.filter(s => s.usable).map(s => Math.abs(s.z ?? 0)));
    assert.ok(zmax < DC.DEFAULTS.sectorZ, `|z| máximo = ${zmax.toFixed(2)}`);
});

test('los sectores detectan una asimetría precoz de 4 UH, invisible píxel a píxel', () => {
    // El umbral por píxel es −8 UH, así que a −4 el detector de candidatos no
    // ve nada; el análisis por regiones sí, que es justo su razón de ser.
    const { frame, midline, geometry } = headPhantom({
        noiseSd: 4, ventricles: false,
        lesion: { side: 1, lat: 40, ap: 0, radiusPx: 28, hu: 31 },
    });
    const bm = DC.brainMask(frame);
    const sm = DC.sectorMap(frame, bm.eroded, midline);

    assert.ok(sm.flaggedCount > 0, `sectores marcados = ${sm.flaggedCount}`);

    // El lado esperado se deriva de la geometría de sectorMap, no se fija a
    // mano: su v̂ es perpendicular a (P−A) y no tiene por qué coincidir en
    // signo con la convención `side` del fantoma.
    const [rs, cs] = SP;
    const c = geometry.place(0, 40);
    const ox = (midline.anterior.x + midline.posterior.x) / 2 * cs;
    const oy = (midline.anterior.y + midline.posterior.y) / 2 * rs;
    const tLesion = (c.x * cs - ox) * sm.frame.v[0] + (c.y * rs - oy) * sm.frame.v[1];
    const expected = tLesion >= 0 ? 'pos' : 'neg';

    const flagged = sm.sectors.filter(s => s.flagged);
    for (const s of flagged) {
        assert.ok(s.deltaHu <= DC.DEFAULTS.sectorDeltaHu);
        assert.ok(Math.abs(s.z) >= DC.DEFAULTS.sectorZ);
        assert.equal(s.hypodenseSide, expected, 'el lado hipodenso es el de la lesión');
    }

    // Y el detector por píxel efectivamente no la ve
    const r = DC.analyzeSeries({
        frames: [frame], midlines: { 0: midline }, threshold: TH,
    });
    assert.equal(r.ischemia.length, 0, 'por píxel a −4 UH no se detecta');
});

test('el score z separa una asimetría real del ruido', () => {
    // Misma ΔUH, distinto ruido: con mucho ruido el z cae y no se marca.
    const mk = (noiseSd) => {
        const { frame, midline } = headPhantom({
            noiseSd, ventricles: false,
            lesion: { side: 1, lat: 40, radiusPx: 28, hu: 31 },
        });
        const bm = DC.brainMask(frame);
        return DC.sectorMap(frame, bm.eroded, midline);
    };
    const limpio = mk(2), sucio = mk(25);
    const zOf = (sm) => Math.max(...sm.sectors.filter(s => s.usable).map(s => Math.abs(s.z ?? 0)));
    assert.ok(zOf(limpio) > zOf(sucio),
              `z limpio ${zOf(limpio).toFixed(1)} debe superar z sucio ${zOf(sucio).toFixed(1)}`);
});

test('sectorMap avisa cuando no puede decir qué lado es cuál', () => {
    const { frame, midline } = headPhantom();
    delete frame.imageOrientation;
    const bm = DC.brainMask(frame);
    const sm = DC.sectorMap(frame, bm.eroded, midline);
    assert.equal(sm.sideLabels.assumed, true);
    assert.ok(sm.warnings.some(w => /derecho y el izquierdo/i.test(w)));
});

test('sideLabelsFromOrientation lee la lateralidad del DICOM', () => {
    assert.equal(DC.sideLabelsFromOrientation([1, 0, 0, 0, 1, 0]).pos, 'izquierdo');
    assert.equal(DC.sideLabelsFromOrientation([-1, 0, 0, 0, 1, 0]).pos, 'derecho');
    assert.equal(DC.sideLabelsFromOrientation(null).assumed, true);
});

test('la t de sectorMap y perpendicularDistanceMm tienen signos opuestos', () => {
    // Pinchado a propósito: es una trampa fácil al leer la salida del detector.
    // sectorMap usa v̂ = (−uy, ux); perpendicularDistanceMm usa el producto
    // cruzado, que da el signo contrario. Quien mezcle los dos invierte el
    // hemisferio en el informe.
    const { frame, midline } = headPhantom();
    const bm = DC.brainMask(frame);
    const sm = DC.sectorMap(frame, bm.eroded, midline);
    const [rs, cs] = SP;
    const ox = (midline.anterior.x + midline.posterior.x) / 2 * cs;
    const oy = (midline.anterior.y + midline.posterior.y) / 2 * rs;

    const p = { x: 180, y: 128 };
    const t = (p.x * cs - ox) * sm.frame.v[0] + (p.y * rs - oy) * sm.frame.v[1];
    const d = RC.perpendicularDistanceMm(p, midline.anterior, midline.posterior, SP);
    assert.ok(Math.abs(Math.abs(t) - Math.abs(d)) < 1e-9, 'misma magnitud');
    assert.equal(Math.sign(t), -Math.sign(d), 'signo opuesto');
});

test('una línea media desviada 3° ya produce asimetría espuria medible', () => {
    // Justifica la confirmación obligatoria: sobre una cabeza PERFECTAMENTE
    // simétrica, tres grados de error bastan para marcar un sector.
    const { frame, midline } = headPhantom({ noiseSd: 4 });
    const cx = (midline.anterior.x + midline.posterior.x) / 2;
    const cy = (midline.anterior.y + midline.posterior.y) / 2;
    const rot = (p, a) => {
        const dx = p.x - cx, dy = p.y - cy;
        return { x: cx + Math.cos(a) * dx - Math.sin(a) * dy,
                 y: cy + Math.sin(a) * dx + Math.cos(a) * dy };
    };
    const a = 3 * Math.PI / 180;
    const torcida = { anterior: rot(midline.anterior, a), posterior: rot(midline.posterior, a) };

    const bm = DC.brainMask(frame);
    const buena = DC.sectorMap(frame, bm.eroded, midline);
    const mala  = DC.sectorMap(frame, bm.eroded, torcida);

    const peor = (sm) => Math.min(...sm.sectors.filter(s => s.usable).map(s => s.deltaHu));
    assert.ok(peor(mala) < peor(buena) - 2,
              `ΔUH espuria ${peor(mala).toFixed(2)} vs ${peor(buena).toFixed(2)} con la correcta`);
    assert.ok(mala.flaggedCount > buena.flaggedCount, 'y marca sectores que no existen');
});

/* ── Sonda ASPECTS ──────────────────────────────────────────── */

test('la sonda ASPECTS mide la región y su espejo con el rasterizador exacto', () => {
    const { frame, midline, geometry } = headPhantom({
        noiseSd: 0, ventricles: false,
        lesion: { side: 1, lat: 40, ap: 0, radiusPx: 22, hu: 28 },
    });
    const seed = geometry.place(0, 40);     // centro de la lesión
    const p = DC.aspectsProbe(frame, seed, midline, TH);

    assert.ok(Math.abs(p.probeStats.mean - 28) < 0.01, `sonda = ${p.probeStats.mean}`);
    assert.ok(Math.abs(p.mirrorStats.mean - 35) < 0.01, `espejo = ${p.mirrorStats.mean}`);
    assert.ok(Math.abs(p.deltaHu - (28 - 35)) < 0.01, `ΔUH = ${p.deltaHu}`);
    assert.ok(Math.abs(p.nwu - (1 - 28 / 35) * 100) < 0.01, `NWU = ${p.nwu}`);
    assert.equal(p.radiusMm, 5);
    // Mismo número de píxeles a cada lado: la reflexión es una isometría
    assert.ok(Math.abs(p.probeStats.count - p.mirrorStats.count) <= 2);
});

test('la sonda ASPECTS no marca nada en tejido simétrico', () => {
    const { frame, midline, geometry } = headPhantom({ noiseSd: 4, ventricles: false });
    const p = DC.aspectsProbe(frame, geometry.place(0, 40), midline, TH);
    assert.equal(p.flagged, false);
    assert.ok(Math.abs(p.deltaHu) < 2, `ΔUH = ${p.deltaHu}`);
});

test('la sonda ASPECTS respeta el radio configurado', () => {
    const { frame, midline, geometry } = headPhantom({ noiseSd: 0, ventricles: false });
    const seed = geometry.place(0, 40);
    const chica = DC.aspectsProbe(frame, seed, midline, TH, { probeRadiusMm: 3 });
    const grande = DC.aspectsProbe(frame, seed, midline, TH, { probeRadiusMm: 8 });
    assert.ok(grande.probeStats.count > chica.probeStats.count * 4,
              `${chica.probeStats.count} px con r=3 vs ${grande.probeStats.count} con r=8`);
    // Área ≈ π r²: 8²/3² = 7.1×
    const ratio = grande.probeStats.areaMm2 / chica.probeStats.areaMm2;
    assert.ok(Math.abs(ratio - 64 / 9) / (64 / 9) < 0.1, `razón de áreas = ${ratio.toFixed(2)}`);
});
