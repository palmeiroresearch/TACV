'use strict';

/* ============================================================
   Detect Worker — ejecuta el análisis de asimetría fuera del
   hilo de interfaz.

   Mantiene los frames de la serie entre mensajes para poder
   regenerar el overlay de un corte sin volver a transferir
   megabytes de pixel data. El mapa de asimetría NO se cachea: se
   recalcula al pedir el overlay (unos 25 ms a 512²), que sale más
   barato que guardar 30 Float32Array de 1 MB cada uno.
   ============================================================ */

importScripts('research-core.js');
importScripts('detect-core.js');

let STATE = null;   // { frames, midlines, threshold, opts, result }

self.addEventListener('message', (e) => {
    const { id, cmd } = e.data || {};
    try {
        switch (cmd) {

            /* ── Analizar la serie ───────────────────────────── */
            case 'analyze': {
                const { frames, midlines, slices, threshold, opts } = e.data;
                const t0 = performance.now();
                const result = DetectCore.analyzeSeries({ frames, midlines, slices, threshold, opts });
                STATE = { frames, midlines, threshold, opts };

                // Los contornos se quedan aquí: son cientos de puntos por corte
                // y por candidato, y el hilo principal solo los necesita del
                // corte que está mirando. Se piden con 'contours'.
                const strip = (c) => ({
                    ...c,
                    perSlice: c.perSlice.map(s => ({
                        sliceIndex: s.sliceIndex,
                        detectedVoxels: s.detectedVoxels,
                        gapMm: s.gapMm, volumeMm3: s.volumeMm3,
                        nwu: s.nwu,
                        lesion: s.lesion, mirror: s.mirror,
                    })),
                });

                STATE.result = result;
                self.postMessage({
                    id, ok: true,
                    ms: Math.round(performance.now() - t0),
                    result: {
                        ...result,
                        ischemia:   result.ischemia.map(strip),
                        hemorrhage: result.hemorrhage.map(strip),
                    },
                });
                break;
            }

            /* ── Overlay de un corte ─────────────────────────── */
            case 'overlay': {
                if (!STATE) { self.postMessage({ id, ok: false, error: 'Sin análisis previo' }); break; }
                const { z, mode } = e.data;
                const frame = STATE.frames[z];
                const midline = STATE.midlines?.[z];
                if (!frame || !midline) {
                    self.postMessage({ id, ok: true, empty: true });
                    break;
                }
                const ov = DetectCore.renderOverlay({
                    frame, midline, mode,
                    opts: { ...STATE.opts, ...(e.data.opts || {}) },
                });
                self.postMessage(
                    { id, ok: true, z, mode, empty: ov.empty,
                      width: ov.width, height: ov.height, rgba: ov.rgba },
                    [ov.rgba.buffer]
                );
                break;
            }

            /* ── Contornos de un corte ───────────────────────── */
            case 'contours': {
                if (!STATE?.result) { self.postMessage({ id, ok: false, error: 'Sin análisis previo' }); break; }
                const { z } = e.data;
                const pick = (list, kind) => list.flatMap((c, idx) => {
                    const s = c.perSlice.find(p => p.sliceIndex === z);
                    if (!s) return [];
                    return [{
                        kind, index: idx,
                        contour: s.contour,
                        mirrorContour: s.mirrorContour,
                        meanHu: s.lesion?.mean ?? null,
                        mirrorMeanHu: s.mirror?.mean ?? null,
                        nwu: s.nwu,
                        volumeMl: c.volumeMl,
                        flags: c.flags.map(f => f.code),
                    }];
                });
                self.postMessage({
                    id, ok: true, z,
                    contours: [...pick(STATE.result.ischemia, 'hypodense'),
                               ...pick(STATE.result.hemorrhage, 'hyperdense')],
                });
                break;
            }

            /* ── Sonda ASPECTS ───────────────────────────────── */
            case 'probe': {
                if (!STATE) { self.postMessage({ id, ok: false, error: 'Sin análisis previo' }); break; }
                const { z, seed } = e.data;
                const frame = STATE.frames[z];
                const midline = STATE.midlines?.[z];
                if (!frame || !midline) {
                    self.postMessage({ id, ok: false, error: 'Corte sin línea media' });
                    break;
                }
                self.postMessage({
                    id, ok: true,
                    probe: DetectCore.aspectsProbe(frame, seed, midline,
                                                   STATE.threshold, STATE.opts),
                });
                break;
            }

            case 'reset':
                STATE = null;
                self.postMessage({ id, ok: true });
                break;

            default:
                self.postMessage({ id, ok: false, error: `Comando desconocido: ${cmd}` });
        }
    } catch (err) {
        self.postMessage({ id, ok: false, error: err.message, stack: err.stack });
    }
});
