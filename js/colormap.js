'use strict';

const Colormap = {
    _maps: {},

    /* ── Genera un Uint8Array de 256*4 bytes (RGBA) ──── */
    _build(fn) {
        const buf = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const [r, g, b] = fn(i / 255);
            buf[i * 4]     = r;
            buf[i * 4 + 1] = g;
            buf[i * 4 + 2] = b;
            buf[i * 4 + 3] = 255;
        }
        return buf;
    },

    init() {
        /* Escala de grises */
        this._maps['grayscale'] = this._build(t => [
            Math.round(t * 255), Math.round(t * 255), Math.round(t * 255)
        ]);

        /* Hot Iron — negro → rojo → amarillo → blanco */
        this._maps['hotIron'] = this._build(t => {
            const r = Math.min(255, Math.round(t * 3 * 255));
            const g = t > 0.333 ? Math.min(255, Math.round((t - 0.333) * 3 * 255)) : 0;
            const b = t > 0.667 ? Math.min(255, Math.round((t - 0.667) * 3 * 255)) : 0;
            return [r, g, b];
        });

        /* Spectrum — azul → cian → verde → amarillo → rojo */
        this._maps['spectrum'] = this._build(t => {
            const h = (1 - t) * 240; // 240° (azul) → 0° (rojo)
            return this._hsvToRgb(h, 1, 1);
        });

        /* Cool-Warm — azul frío → blanco → rojo cálido */
        this._maps['coolWarm'] = this._build(t => {
            if (t < 0.5) {
                const f = t * 2;
                return [
                    Math.round(f * 255),
                    Math.round(f * 255),
                    255
                ];
            } else {
                const f = (t - 0.5) * 2;
                return [
                    255,
                    Math.round((1 - f) * 255),
                    Math.round((1 - f) * 255)
                ];
            }
        });
    },

    /* Devuelve Uint8Array RGBA[1024] para un mapa dado */
    get(id) {
        return this._maps[id] || this._maps['grayscale'];
    },

    /* Ids disponibles */
    ids() { return Object.keys(this._maps); },

    _hsvToRgb(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = v - c;
        let r = 0, g = 0, b = 0;
        if      (h < 60)  { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else              { r = c; g = 0; b = x; }
        return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
    },
};

Colormap.init();
