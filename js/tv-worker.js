'use strict';

/* ============================================================
   TV Worker — Total Variation denoising (Chambolle dual projection)
   Chambolle 2004 / Tseng 2008 — convergencia garantizada.
   TV preserva HU exactamente (proyector); no alucina estructuras.
   Opera sobre Float32Array normalizado [0,1] post-windowing.
   ============================================================ */

function tvDenoise(data, width, height, lambda, iterations) {
    const N  = width * height;
    const px = new Float32Array(N);
    const py = new Float32Array(N);
    const tau = 0.249; // paso temporal: < 1/4 garantiza convergencia

    for (let iter = 0; iter < iterations; iter++) {
        // Actualizar variables duales (px, py) — proyección al bola unidad
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i   = y * width + x;

                // Divergencia de (px, py) en i
                const divX = x > 0 ? px[i] - px[i - 1] : px[i];
                const divY = y > 0 ? py[i] - py[i - width] : py[i];

                // Imagen primal implícita: u = f + lambda * div(p)
                const u_i = data[i] + lambda * (divX + divY);

                // Gradiente de u en dirección +x y +y
                const gx = x < width  - 1 ? (data[i + 1]     - u_i) : 0.0;
                const gy = y < height - 1 ? (data[i + width]  - u_i) : 0.0;

                // Paso del dual + proyección a bola L2 ≤ 1
                const nx = px[i] + tau * gx;
                const ny = py[i] + tau * gy;
                const norm = Math.sqrt(nx * nx + ny * ny);
                const s    = norm > 1.0 ? norm : 1.0;
                px[i] = nx / s;
                py[i] = ny / s;
            }
        }
    }

    // Reconstruir imagen denoised: u* = f + lambda * div(p*)
    const result = new Float32Array(N);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i    = y * width + x;
            const divX = x > 0 ? px[i] - px[i - 1] : px[i];
            const divY = y > 0 ? py[i] - py[i - width] : py[i];
            result[i]  = Math.min(1.0, Math.max(0.0, data[i] + lambda * (divX + divY)));
        }
    }
    return result;
}

self.addEventListener('message', (e) => {
    const { float32Data, width, height, lambda, iterations } = e.data;
    const t0     = performance.now();
    const result = tvDenoise(float32Data, width, height, lambda, iterations);
    const ms     = Math.round(performance.now() - t0);
    self.postMessage({ result, width, height, ms }, [result.buffer]);
});
