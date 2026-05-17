'use strict';

/* ============================================================
   RendererGL — Motor WebGL2 para visualización CT
   Responsabilidades:
   - Inicializar contexto WebGL2
   - Subir pixel data como R16I texture (una vez por frame)
   - Subir color map como RGBA 256x1 texture
   - Aplicar windowing, pan, zoom, flip, rotate via uniforms/mat3
   - Renderizar sin CPU per-pixel loop
   ============================================================ */

class RendererGL {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            preserveDrawingBuffer: true, // necesario para export/clipboard
        });
        if (!this.gl) throw new Error('WebGL2 no disponible en este navegador');

        this._program     = null;
        this._vao         = null;
        this._texPixels   = null;
        this._texColormap = null;
        this._uniforms    = {};
        this._currentColorMapId = null;
        this._currentFrameId    = null;

        // FBO intermedio para post-procesamiento (se crea lazy)
        this._fboGray  = null;
        this._texGray  = null;
        this._fboW     = 0;
        this._fboH     = 0;

        // PostProcessor — se inicializa después de _init()
        this.postProcessor = null;

        this._init();
    }

    /* ── Inicializar programa y geometría ─────────────── */
    _init() {
        const gl = this.gl;

        this._program = Shaders.compile(gl, Shaders.VERT, Shaders.FRAG_CT);
        gl.useProgram(this._program);

        // Quad full-screen: 2 triángulos, NDC [-1,1]
        const verts = new Float32Array([-1,-1, 1,-1, -1,1, 1,-1, 1,1, -1,1]);
        const buf   = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        this._vao = gl.createVertexArray();
        gl.bindVertexArray(this._vao);
        const loc = gl.getAttribLocation(this._program, 'a_position');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        // Uniform locations
        const p = this._program;
        this._uniforms = {
            transform:  gl.getUniformLocation(p, 'u_transform'),
            pixels:     gl.getUniformLocation(p, 'u_pixels'),
            colormap:   gl.getUniformLocation(p, 'u_colormap'),
            slope:      gl.getUniformLocation(p, 'u_slope'),
            intercept:  gl.getUniformLocation(p, 'u_intercept'),
            wMin:       gl.getUniformLocation(p, 'u_wMin'),
            wMax:       gl.getUniformLocation(p, 'u_wMax'),
            invert:     gl.getUniformLocation(p, 'u_invert'),
            superRes:   gl.getUniformLocation(p, 'u_superRes'),
            texSize:    gl.getUniformLocation(p, 'u_texSize'),
            toFbo:      gl.getUniformLocation(p, 'u_toFbo'),
            multiWin:   gl.getUniformLocation(p, 'u_multiWin'),
            mwRMin:     gl.getUniformLocation(p, 'u_mwRMin'),
            mwRMax:     gl.getUniformLocation(p, 'u_mwRMax'),
            mwGMin:     gl.getUniformLocation(p, 'u_mwGMin'),
            mwGMax:     gl.getUniformLocation(p, 'u_mwGMax'),
            mwBMin:     gl.getUniformLocation(p, 'u_mwBMin'),
            mwBMax:     gl.getUniformLocation(p, 'u_mwBMax'),
            mwStrength: gl.getUniformLocation(p, 'u_mwStrength'),
        };

        // Textura de pixels (slot 0)
        this._texPixels = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texPixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(this._uniforms.pixels, 0);

        // Textura de color map (slot 1)
        this._texColormap = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._texColormap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(this._uniforms.colormap, 1);

        // Cargar grayscale por defecto
        this.uploadColormap('grayscale');

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0, 0, 0, 1);

        // Inicializar PostProcessor (tiene su propio VAO y shaders)
        try {
            this.postProcessor = new PostProcessor(gl);
        } catch (e) {
            console.warn('PostProcessor init failed:', e.message);
        }
    }

    /* ── Subir pixel data (solo cuando cambia el frame) ── */
    uploadFrame(frame) {
        if (this._currentFrameId === frame.sopInstanceUID) return;
        this._currentFrameId = frame.sopInstanceUID;

        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texPixels);
        // R16I: 16-bit signed integer, 1 canal
        gl.texImage2D(
            gl.TEXTURE_2D, 0,
            gl.R16I,                    // internal format
            frame.cols, frame.rows, 0,
            gl.RED_INTEGER,             // format
            gl.SHORT,                   // type (Int16)
            frame.pixelData
        );
    }

    /* ── Subir color map (solo cuando cambia) ──────────── */
    uploadColormap(id) {
        if (this._currentColorMapId === id) return;
        this._currentColorMapId = id;

        const gl   = this.gl;
        const rgba = Colormap.get(id);  // Uint8Array 256*4
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._texColormap);
        gl.texImage2D(
            gl.TEXTURE_2D, 0,
            gl.RGBA, 256, 1, 0,
            gl.RGBA, gl.UNSIGNED_BYTE,
            rgba
        );
    }

    /* ── Render principal ──────────────────────────────── */
    render(frame, state) {
        if (!frame) return;
        const gl = this.gl;

        this.resize();
        this.uploadFrame(frame);
        this.uploadColormap(state.colorMapId || 'grayscale');

        const filtersActive = this.postProcessor && PostProcessor.isActive(state);

        // Si hay filtros activos: renderizar a FBO intermedio, luego PostProcessor al canvas
        // Si no: fast path directo al canvas (comportamiento original)
        if (filtersActive) {
            // Forzar re-upload del frame: el PostProcessor puede haber dejado
            // TEXTURE0 apuntando a sus propias texturas internas.
            this._currentFrameId = null;
            this._currentColorMapId = null;
            this._ensureFboGray();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboGray);
            gl.viewport(0, 0, this._fboW, this._fboH);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }

        // Re-bind explícito: PostProcessor usa TEXTURE2/3 pero puede haber
        // cambiado el active unit activo, restauramos slots 0 y 1.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texPixels);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._texColormap);

        gl.useProgram(this._program);
        gl.bindVertexArray(this._vao);

        const preset = WINDOWING_PRESETS[state.presetId] || WINDOWING_PRESETS.brain;
        const ww = state.windowWidth  ?? preset.width;
        const wc = state.windowCenter ?? preset.center;
        const wMin = wc - ww / 2;
        const wMax = wc + ww / 2;

        gl.uniform1f(this._uniforms.slope,     frame.rescaleSlope);
        gl.uniform1f(this._uniforms.intercept, frame.rescaleIntercept);
        gl.uniform1f(this._uniforms.wMin, wMin);
        gl.uniform1f(this._uniforms.wMax, wMax);
        gl.uniform1i(this._uniforms.invert,    state.isInverted        ? 1 : 0);
        gl.uniform1i(this._uniforms.superRes,  state.isSuperResEnabled ? 1 : 0);
        // Cuando va a FBO: deshabilitar colormap para que FRAG_CT emita grises puros
        gl.uniform1i(this._uniforms.toFbo, filtersActive ? 1 : 0);
        // Multi-window RGB blending (Brain/Stroke/Subdural — Karki et al.)
        const mw = state.isMultiWindowEnabled;
        gl.uniform1i(this._uniforms.multiWin,   mw ? 1 : 0);
        if (mw) {
            const s = state.multiWindowStrength ?? 0.85;
            gl.uniform1f(this._uniforms.mwRMin,    -5.0);   // Brain WL35 WW80
            gl.uniform1f(this._uniforms.mwRMax,    75.0);
            gl.uniform1f(this._uniforms.mwGMin,    28.0);   // Stroke WL32 WW8
            gl.uniform1f(this._uniforms.mwGMax,    36.0);
            gl.uniform1f(this._uniforms.mwBMin,   -32.5);   // Subdural WL75 WW215
            gl.uniform1f(this._uniforms.mwBMax,   182.5);
            gl.uniform1f(this._uniforms.mwStrength, s);
        }
        gl.uniform2f(this._uniforms.texSize, frame.cols, frame.rows);

        const mat = this._buildTransform(frame, state);
        gl.uniformMatrix3fv(this._uniforms.transform, false, mat);

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        if (filtersActive) {
            // Devolver renderizado al canvas via PostProcessor
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.postProcessor.process(
                this._texGray,
                this._texColormap,
                state,
                this.canvas.width,
                this.canvas.height
            );
        }
    }

    /* ── FBO para renderizado intermedio (grises) ──────── */
    _ensureFboGray() {
        if (typeof Capabilities !== 'undefined' && Capabilities.isIOS) return;
        const gl  = this.gl;
        const w   = this.canvas.width;
        const h   = this.canvas.height;
        if (this._fboGray && this._fboW === w && this._fboH === h) return;

        this._fboW = w; this._fboH = h;
        gl.getExtension('EXT_color_buffer_float');

        if (this._texGray) gl.deleteTexture(this._texGray);
        this._texGray = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._texGray);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);

        if (!this._fboGray) this._fboGray = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboGray);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                gl.TEXTURE_2D, this._texGray, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        // No limpiar _currentFrameId — el frame ya fue subido antes de llamar a _ensureFboGray
    }

    /* ── Construir mat3 de transform ───────────────────── */
    _buildTransform(frame, state) {
        const zoom   = state.zoom     ?? 1;
        const panX   = state.panX     ?? 0;
        const panY   = state.panY     ?? 0;
        const flipH  = state.flipH    ?? false;
        const flipV  = state.flipV    ?? false;
        const rotDeg = state.rotation ?? 0;
        const rot    = rotDeg * Math.PI / 180;

        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const iw = frame.cols;
        const ih = frame.rows;

        // Para 90°/270°: las dimensiones efectivas de display se invierten
        const is90 = (rotDeg === 90 || rotDeg === 270);
        const effW = is90 ? ih : iw;
        const effH = is90 ? iw : ih;
        const baseZoom = Math.min(cw / effW, ch / effH);

        // Con rotación 90°/270° se intercambian sxAbs y syAbs para evitar distorsión
        // en canvas no cuadrados. La textura X/Y se muestran en ejes de pantalla opuestos.
        const sxAbs = is90
            ? ch / (baseZoom * ih * zoom)   // usa dimensión Y de imagen para eje X
            : cw / (baseZoom * iw * zoom);
        const syAbs = is90
            ? cw / (baseZoom * iw * zoom)   // usa dimensión X de imagen para eje Y
            : ch / (baseZoom * ih * zoom);

        const sx = sxAbs * (flipH ? -1 : 1);
        const sy = syAbs * (flipV ? -1 : 1);

        // Shader usa ángulo negativo (-rot) para rotar la textura (= imagen gira positivo)
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);

        // Pan en espacio textura, compensando flip Y rotation.
        // Derivado de T = -M·(panX/cw, -panY/ch) donde M es la matriz rotación-escala.
        // crot/srot = rotación positiva (como se ve en pantalla)
        const crot = Math.cos(rot);   // = cos(-rot) también
        const srot = Math.sin(rot);   // = -sin(-rot)

        const fxSign = flipH ? -1 : 1;
        const fySign = flipV ? -1 : 1;

        const tx = -fxSign * sxAbs * (crot * panX / cw + srot * panY / ch);
        const ty =  fySign * syAbs * (crot * panY / ch - srot * panX / cw);

        return new Float32Array([
            cos * sx, -sin * sy, 0,
            sin * sx,  cos * sy, 0,
            tx,        ty,       1,
        ]);
    }

    /* ── Ajustar viewport al tamaño del canvas ─────────── */
    resize() {
        const { canvas, gl } = this;
        const w = canvas.offsetWidth  | 0;
        const h = canvas.offsetHeight | 0;
        // Si el canvas no está en el DOM (offscreen para thumbnails), no tocar
        if (w === 0 || h === 0) return;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width  = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    }

    /* ── Render thumbnail para el strip ─────────────────── */
    renderThumbnail(frame, thumbCanvas) {
        // Renderizar en el canvas principal con W/L de brain,
        // luego copiar a thumbCanvas con drawImage + scaling
        const tmpState = {
            zoom: 1, panX: 0, panY: 0,
            flipH: false, flipV: false, rotation: 0,
            isInverted: false, colorMapId: 'grayscale',
            windowWidth:  WINDOWING_PRESETS.brain.width,
            windowCenter: WINDOWING_PRESETS.brain.center,
        };

        // Guardar tamaño actual
        const origW = this.canvas.width, origH = this.canvas.height;
        this.canvas.width  = THUMB_SIZE;
        this.canvas.height = THUMB_SIZE;
        this.gl.viewport(0, 0, THUMB_SIZE, THUMB_SIZE);
        this.render(frame, tmpState);

        // Copiar al thumbCanvas
        const ctx = thumbCanvas.getContext('2d');
        ctx.drawImage(this.canvas, 0, 0, THUMB_SIZE, THUMB_SIZE);

        // Restaurar tamaño
        this.canvas.width  = origW;
        this.canvas.height = origH;
        this.gl.viewport(0, 0, origW, origH);
    }

    /* ── Destruir recursos ─────────────────────────────── */
    destroy() {
        const gl = this.gl;
        gl.deleteTexture(this._texPixels);
        gl.deleteTexture(this._texColormap);
        gl.deleteProgram(this._program);
    }
}
