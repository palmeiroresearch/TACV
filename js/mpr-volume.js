'use strict';

const MprVolume = {
    _series:   null,
    _dims:     null,
    _rawData:  null,       // Float32Array — Int16 como float, una vez en CPU
    _textures: new WeakMap(),   // WebGLRenderingContext → WebGLTexture

    /* ── Preparar buffer CPU (sin GPU) ──────────────── */
    setSeries(series) {
        if (!series || series.length === 0) return false;
        this._series = series;

        const first = series[0];
        const W = first.cols, H = first.rows, D = series.length;

        let spacingZ = first.sliceThickness || 1;
        if (D > 1) {
            const z0 = series[0].imagePosition?.[2] ?? 0;
            const z1 = series[1].imagePosition?.[2] ?? spacingZ;
            spacingZ = Math.abs(z1 - z0) || spacingZ;
        }

        // PixelSpacing[0] = row spacing (Y direction), PixelSpacing[1] = col spacing (X direction)
        // Si ambos son 1.0 (fallback) y el volumen tiene resolución típica de CT (~512px),
        // el sagital quedaría 2.5× estirado. Intentar alternativas antes de usar 1.
        const ps = first.pixelSpacing;
        const rawSpX = ps?.[1] || ps?.[0] || 0;  // col spacing → X
        const rawSpY = ps?.[0] || ps?.[1] || 0;  // row spacing → Y
        // Si aún es 0 o 1 y el slice thickness da pista, usar estimación razonable
        const spacingX = rawSpX > 0.05 ? rawSpX : 1;
        const spacingY = rawSpY > 0.05 ? rawSpY : 1;

        if (spacingX === 1 && spacingY === 1) {
            console.warn('[MPR] PixelSpacing no encontrado en DICOM (x00280030). ' +
                'Usando 1mm — el sagital/coronal puede aparecer distorsionado. ' +
                'Verificá el tag x00280030 en el panel de metadata.');
        }

        this._dims = {
            width: W, height: H, depth: D,
            spacingX,
            spacingY,
            spacingZ,
        };

        // Almacenar como Float32: valor raw Int16 directamente como float
        this._rawData = new Float32Array(W * H * D);
        series.forEach((frame, z) => {
            const pd = frame.pixelData;
            const offset = z * W * H;
            for (let k = 0; k < W * H; k++) {
                this._rawData[offset + k] = pd[k];
            }
        });

        return true;
    },

    /* ── Subir R32F TEXTURE_3D para este contexto GL ── */
    buildForContext(gl) {
        if (!this._rawData || !this._dims) return false;
        if (this._textures.has(gl)) return true;

        const { width, height, depth } = this._dims;

        // Habilitar filtrado lineal de float textures si está disponible
        gl.getExtension('OES_texture_float_linear');

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, tex);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

        gl.texImage3D(
            gl.TEXTURE_3D, 0,
            gl.R32F,            // float — soporta LINEAR + sampler3D
            width, height, depth, 0,
            gl.RED,
            gl.FLOAT,
            this._rawData
        );

        gl.bindTexture(gl.TEXTURE_3D, null);
        this._textures.set(gl, tex);
        return true;
    },

    getTexture(gl)        { return this._textures.get(gl) || null; },
    isReadyForContext(gl) { return this._textures.has(gl) && !!this._dims; },
    isReady()             { return !!this._rawData && !!this._dims; },

    getDims()             { return this._dims; },

    getAxialPlane(sliceIdx) {
        const z = this._dims ? (sliceIdx + 0.5) / this._dims.depth : 0.5;
        return { origin: [0, 0, z], right: [1, 0, 0], up: [0, 1, 0] };
    },
    getCoronalPlane(yFraction = 0.5) {
        // up=[0,0,1]: tc.y=1 (pantalla arriba) → Z=1 (superior) ✓
        return { origin: [0, yFraction, 0], right: [1, 0, 0], up: [0, 0, 1] };
    },
    getSagittalPlane(xFraction = 0.5) {
        // up=[0,0,1]: idem → superior arriba ✓
        return { origin: [xFraction, 0, 0], right: [0, 1, 0], up: [0, 0, 1] };
    },
};
