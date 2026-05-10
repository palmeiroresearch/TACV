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

        this._dims = {
            width: W, height: H, depth: D,
            spacingX: first.pixelSpacing?.[1] || 1,
            spacingY: first.pixelSpacing?.[0] || 1,
            spacingZ,
        };

        // Almacenar como Float32: valor raw Int16 directamente como float
        // El shader aplica: hu = raw * slope + intercept
        this._rawData = new Float32Array(W * H * D);
        series.forEach((frame, z) => {
            const pd = frame.pixelData;   // Int16Array
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
        // origin=[0,0,z], right=+X, up=+Y (anterior abajo, posterior arriba en pantalla)
        return { origin: [0, 0, z], right: [1, 0, 0], up: [0, 1, 0] };
    },
    getCoronalPlane(yFraction = 0.5) {
        // Coronal: X=derecha paciente, Z=superior. origin.z=1 + up.z=-1 → superior arriba
        return { origin: [0, yFraction, 1], right: [1, 0, 0], up: [0, 0, -1] };
    },
    getSagittalPlane(xFraction = 0.5) {
        // Sagital: Y=anterior→posterior (izq→der en pantalla), Z=superior. up.z=-1 → superior arriba
        return { origin: [xFraction, 0, 1], right: [0, 1, 0], up: [0, 0, -1] };
    },
};
