'use strict';

/* Reflexión geométrica de la ROI sobre una línea media INCLINADA.
   Es el punto donde la herramienta NWU puede fallar de forma silenciosa:
   una reflexión mal planteada funciona con la línea media vertical y
   produce espejos desplazados en cuanto la cabeza está rotada. */

const test   = require('node:test');
const assert = require('node:assert/strict');
const RC     = require('../js/research-core.js');

/* Línea media inclinada ~23° respecto de la vertical. */
const A = { x: 128, y: 20 };
const B = { x: 36,  y: 236 };

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('un punto SOBRE la línea media se refleja en sí mismo', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const p = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        const r = RC.reflectPointOverLine(p, A, B);
        assert.ok(near(r.x, p.x), `x: ${r.x} vs ${p.x}`);
        assert.ok(near(r.y, p.y), `y: ${r.y} vs ${p.y}`);
    }
});

test('reflejar dos veces devuelve el punto original (involución)', () => {
    const p  = { x: 200, y: 90 };
    const r1 = RC.reflectPointOverLine(p,  A, B);
    const r2 = RC.reflectPointOverLine(r1, A, B);
    assert.ok(near(r2.x, p.x));
    assert.ok(near(r2.y, p.y));
});

test('la distancia perpendicular se conserva con el signo invertido', () => {
    const p  = { x: 210, y: 140 };
    const d1 = RC.perpendicularDistanceMm(p, A, B);
    const r  = RC.reflectPointOverLine(p, A, B);
    const d2 = RC.perpendicularDistanceMm(r, A, B);
    assert.ok(near(d1, -d2, 1e-9), `${d1} vs ${-d2}`);
    assert.ok(Math.abs(d1) > 1, 'el punto de prueba debe estar fuera de la línea');
});

test('el reflejado cae en el hemisferio contralateral', () => {
    const p = { x: 210, y: 140 };
    const r = RC.reflectPointOverLine(p, A, B);
    const sp = Math.sign(RC.perpendicularDistanceMm(p, A, B));
    const sr = Math.sign(RC.perpendicularDistanceMm(r, A, B));
    assert.equal(sp, -sr);
});

test('la reflexión conserva distancias entre puntos (es una isometría)', () => {
    const p = { x: 180, y: 70 };
    const q = { x: 205, y: 130 };
    const d  = RC.distanceMm(p, q);
    const dr = RC.distanceMm(
        RC.reflectPointOverLine(p, A, B),
        RC.reflectPointOverLine(q, A, B)
    );
    assert.ok(near(d, dr, 1e-9));
});

test('reflectPolygon conserva el área sobre línea media inclinada', () => {
    const poly = RC.polygonFromEllipse(200, 120, 25, 15, 180);
    const mir  = RC.reflectPolygon(poly, A, B);
    const a1 = RC.polygonAreaMm2(poly, [0.5, 0.5]);
    const a2 = RC.polygonAreaMm2(mir,  [0.5, 0.5]);
    assert.ok(Math.abs(a1 - a2) < 1e-9, `${a1} vs ${a2}`);
    assert.equal(poly.length, mir.length);
});

test('reflectPolygon conserva el área también con spacing anisotrópico', () => {
    const ps   = [1.0, 0.5];
    const poly = RC.polygonFromEllipse(200, 120, 25, 15, 180);
    const mir  = RC.reflectPolygon(poly, A, B, ps);
    assert.ok(Math.abs(RC.polygonAreaMm2(poly, ps) - RC.polygonAreaMm2(mir, ps)) < 1e-9);
});

test('con spacing isotrópico, reflexión métrica y en píxeles coinciden', () => {
    const p  = { x: 210, y: 140 };
    const r1 = RC.reflectPointOverLine(p, A, B, [1, 1]);
    const r2 = RC.reflectPointOverLine(p, A, B, [0.42, 0.42]);
    assert.ok(near(r1.x, r2.x, 1e-9));
    assert.ok(near(r1.y, r2.y, 1e-9));
});

test('con spacing anisotrópico la reflexión métrica difiere de la de píxeles', () => {
    // Confirma que el spacing se tiene realmente en cuenta: si se ignorase,
    // el espejo quedaría desplazado en estudios no isotrópicos.
    const p   = { x: 210, y: 140 };
    const iso = RC.reflectPointOverLine(p, A, B, [1, 1]);
    const ani = RC.reflectPointOverLine(p, A, B, [2, 0.5]);
    assert.ok(Math.hypot(iso.x - ani.x, iso.y - ani.y) > 1);
});

test('línea media vertical: la reflexión es el espejo en x', () => {
    const V1 = { x: 100, y: 0 }, V2 = { x: 100, y: 400 };
    const r = RC.reflectPointOverLine({ x: 130, y: 55 }, V1, V2);
    assert.ok(near(r.x, 70));
    assert.ok(near(r.y, 55));
});

test('línea media horizontal: la reflexión es el espejo en y', () => {
    const H1 = { x: 0, y: 100 }, H2 = { x: 400, y: 100 };
    const r = RC.reflectPointOverLine({ x: 55, y: 130 }, H1, H2);
    assert.ok(near(r.x, 55));
    assert.ok(near(r.y, 70));
});

test('línea media degenerada (dos puntos iguales) no produce NaN', () => {
    const r = RC.reflectPointOverLine({ x: 30, y: 40 }, { x: 10, y: 10 }, { x: 10, y: 10 });
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
    assert.equal(r.x, 30);
    assert.equal(r.y, 40);
});

test('perpendicularDistanceMm usa mm, no píxeles', () => {
    const V1 = { x: 100, y: 0 }, V2 = { x: 100, y: 400 };
    // 10 px a la derecha, con 0.5 mm/px en columna → 5 mm
    const d = RC.perpendicularDistanceMm({ x: 110, y: 50 }, V1, V2, [0.5, 0.5]);
    assert.ok(near(Math.abs(d), 5));
});

test('perpendicularDistanceMm devuelve null con línea degenerada', () => {
    assert.equal(
        RC.perpendicularDistanceMm({ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 5, y: 5 }),
        null
    );
});

test('polygonFromEllipse aproxima el área analítica de la elipse', () => {
    const rx = 30, ry = 18;
    const poly = RC.polygonFromEllipse(100, 100, rx, ry, 360);
    const analytic = Math.PI * rx * ry;             // en px²
    const sampled  = RC.polygonAreaMm2(poly, [1, 1]);
    assert.ok(Math.abs(sampled - analytic) / analytic < 1e-4);
});
