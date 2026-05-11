'use strict';

/* ============================================================
   PostProcessor — Pipeline de post-procesamiento WebGL2
   ============================================================ */

class PostProcessor {
    constructor(gl) {
        this.gl    = gl;
        this._vao  = null;   // propio — creado después de compilar shaders
        this._w    = 0;
        this._h    = 0;
        this._fbo  = [gl.createFramebuffer(), gl.createFramebuffer()];
        this._tex  = [null, null];
        this._fboSave = gl.createFramebuffer();
        this._texSave = null;
        this._ping = 0;
        this._prog = {};

        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('OES_texture_float_linear');

        // Compilar shaders primero, luego crear VAO con las ubicaciones de atributo correctas
        this._compilePrograms();
        this._vao = this._createVao();
    }

    /* ── VAO propio — garantiza ubicación de a_position correcta ── */
    _createVao() {
        const gl    = this.gl;
        const verts = new Float32Array([-1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1]);
        const buf   = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        const vao  = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // Obtener ubicación de a_position del primer programa de filtro compilado
        const prog = this._prog.blit || Object.values(this._prog)[0];
        const loc  = prog ? gl.getAttribLocation(prog, 'a_position') : 0;
        const attrLoc = loc >= 0 ? loc : 0;
        gl.enableVertexAttribArray(attrLoc);
        gl.vertexAttribPointer(attrLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return vao;
    }

    /* ── Compilar todos los shaders de filtro ──── */
    _compilePrograms() {
        const gl = this.gl;
        const vert = FilterShaders.VERT;
        const c = (frag) => Shaders.compile(gl, vert, frag);
        this._prog = {
            blit:       c(FilterShaders.FRAG_BLIT),
            display:    c(FilterShaders.FRAG_DISPLAY),
            gaussH:     c(FilterShaders.FRAG_GAUSS_H),
            gaussV:     c(FilterShaders.FRAG_GAUSS_V),
            bicubic:    c(FilterShaders.FRAG_BICUBIC),
            usm:        c(FilterShaders.FRAG_USM),
            bilateral:  c(FilterShaders.FRAG_BILATERAL),
            aniso:      c(FilterShaders.FRAG_ANISO),
            claheStats: c(FilterShaders.FRAG_CLAHE_STATS),
            claheEq:    c(FilterShaders.FRAG_CLAHE_EQ),
            retinex:    c(FilterShaders.FRAG_RETINEX),
        };
    }

    /* ── Crear/recrear FBOs si el canvas cambió de tamaño ── */
    _resize(w, h) {
        if (this._w === w && this._h === h) return;
        const gl = this.gl;
        this._w = w; this._h = h;

        const makeTex = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
            return t;
        };

        for (let i = 0; i < 2; i++) {
            if (this._tex[i]) gl.deleteTexture(this._tex[i]);
            this._tex[i] = makeTex();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[i]);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                    gl.TEXTURE_2D, this._tex[i], 0);
        }
        if (this._texSave) gl.deleteTexture(this._texSave);
        this._texSave = makeTex();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboSave);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                gl.TEXTURE_2D, this._texSave, 0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /* ── Helpers de renderizado ────────────────── */

    _pass(progName, srcTex, setup) {
        const gl  = this.gl;
        const idx = this._ping % 2;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[idx]);
        gl.viewport(0, 0, this._w, this._h);
        const prog = this._prog[progName];
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_source'), 0);
        const tsLoc = gl.getUniformLocation(prog, 'u_texSize');
        if (tsLoc) gl.uniform2f(tsLoc, this._w, this._h);
        if (setup) setup(prog);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const out = this._tex[idx];
        this._ping++;
        return out;
    }

    _save(src) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboSave);
        gl.viewport(0, 0, this._w, this._h);
        gl.useProgram(this._prog.blit);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(gl.getUniformLocation(this._prog.blit, 'u_source'), 0);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return this._texSave;
    }

    _gaussBlur(src, sigma) {
        const gl = this.gl;
        const setup = (prog) =>
            gl.uniform1f(gl.getUniformLocation(prog, 'u_sigma'), sigma);
        const afterH = this._pass('gaussH', src, setup);
        return this._pass('gaussV', afterH, setup);
    }

    /* ── Pipeline principal ────────────────────── */
    process(grayTex, colormapTex, state, canvasW, canvasH) {
        this._resize(canvasW, canvasH);
        const gl = this.gl;
        this._ping = 0;
        let current = grayTex;

        // ── 1. Bicubic ──────────────────────────
        if (state.bicubicEnabled) {
            current = this._pass('bicubic', current, null);
        }

        // ── 2. Unsharp Masking ──────────────────
        if (state.usmEnabled) {
            const savedOrig = this._save(current);
            current = this._gaussBlur(current, state.usmRadius || 1.5);
            const blurred  = current;
            const idx = this._ping % 2;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[idx]);
            gl.viewport(0, 0, this._w, this._h);
            const prog = this._prog.usm;
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, savedOrig);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_original'), 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blurred);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_blurred'), 1);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_strength'),  state.usmStrength  ?? 1.0);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_threshold'), state.usmThreshold ?? 0.01);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            current = this._tex[idx];
            this._ping++;
        }

        // ── 3. Bilateral Filter ─────────────────
        if (state.bilateralEnabled) {
            current = this._pass('bilateral', current, (prog) => {
                gl.uniform1f(gl.getUniformLocation(prog, 'u_sigmaS'), state.bilateralSigmaS ?? 2.0);
                gl.uniform1f(gl.getUniformLocation(prog, 'u_sigmaR'), state.bilateralSigmaR ?? 0.1);
            });
        }

        // ── 4. Anisotropic Diffusion ────────────
        if (state.anisoEnabled) {
            const iters  = state.anisoIterations ?? 10;
            const K      = state.anisoK          ?? 0.1;
            const lambda = state.anisoLambda      ?? 0.2;
            const func   = state.anisoFunc        ?? 0;
            for (let i = 0; i < iters; i++) {
                current = this._pass('aniso', current, (prog) => {
                    gl.uniform1f(gl.getUniformLocation(prog, 'u_lambda'), lambda);
                    gl.uniform1f(gl.getUniformLocation(prog, 'u_K'),      K);
                    gl.uniform1i(gl.getUniformLocation(prog, 'u_func'),   func);
                });
            }
        }

        // ── 5. CLAHE ────────────────────────────
        if (state.claheEnabled) {
            const savedOrig = this._save(current);
            const radius    = (state.claheTileSize ?? 64) / 2;
            const statsTex  = this._pass('claheStats', current, (prog) =>
                gl.uniform1f(gl.getUniformLocation(prog, 'u_radius'), radius)
            );
            const idx = this._ping % 2;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[idx]);
            gl.viewport(0, 0, this._w, this._h);
            const prog = this._prog.claheEq;
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, savedOrig);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_source'), 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, statsTex);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_stats'), 1);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_clipLimit'), state.claheClipLimit ?? 2.0);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_strength'),  state.claheStrength  ?? 0.7);
            gl.uniform2f(gl.getUniformLocation(prog, 'u_texSize'), this._w, this._h);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            current = this._tex[idx];
            this._ping++;
        }

        // ── 6. Multi-Scale Retinex ──────────────
        if (state.retinexEnabled) {
            const savedOrig = this._save(current);
            const ratio = Math.min(this._w, this._h) / 512;
            const s0 = Math.max(1.0, (state.retinexSigmaS ?? 15)  * ratio * 0.08);
            const s1 = Math.max(2.0, (state.retinexSigmaM ?? 60)  * ratio * 0.08);
            const s2 = Math.max(3.0, (state.retinexSigmaL ?? 120) * ratio * 0.08);
            const b0 = this._gaussBlur(savedOrig, s0);
            const b1 = this._gaussBlur(savedOrig, s1);
            const b2 = this._gaussBlur(savedOrig, s2);

            const idx = this._ping % 2;
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[idx]);
            gl.viewport(0, 0, this._w, this._h);
            const prog = this._prog.retinex;
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, savedOrig);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_original'), 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b0);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_blur0'), 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, b1);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_blur1'), 2);
            gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, b2);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_blur2'), 3);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_gain'),   state.retinexGain   ?? 0.5);
            gl.uniform1f(gl.getUniformLocation(prog, 'u_offset'), state.retinexOffset ?? 0.5);
            gl.bindVertexArray(this._vao);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            current = this._tex[idx];
            this._ping++;
        }

        // ── Blit final al canvas con colormap ───
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvasW, canvasH);
        const prog = this._prog.display;
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, current);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_source'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, colormapTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_colormap'), 1);
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    /* ── ¿Hay algún filtro activo? ──────────── */
    static isActive(state) {
        return !!(state.bicubicEnabled   ||
                  state.usmEnabled       ||
                  state.bilateralEnabled ||
                  state.anisoEnabled     ||
                  state.claheEnabled     ||
                  state.retinexEnabled);
    }

    destroy() {
        const gl = this.gl;
        this._fbo.forEach(f => gl.deleteFramebuffer(f));
        this._tex.forEach(t => { if (t) gl.deleteTexture(t); });
        if (this._texSave) gl.deleteTexture(this._texSave);
        gl.deleteFramebuffer(this._fboSave);
        Object.values(this._prog).forEach(p => gl.deleteProgram(p));
    }
}
