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
        this._currentFrameId    = null;  // sopInstanceUID del frame en GPU

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

        gl.useProgram(this._program);
        gl.bindVertexArray(this._vao);

        // Uniforms de windowing
        const preset = WINDOWING_PRESETS[state.presetId] || WINDOWING_PRESETS.brain;
        const ww = state.windowWidth  ?? preset.width;
        const wc = state.windowCenter ?? preset.center;
        const wMin = wc - ww / 2;
        const wMax = wc + ww / 2;

        gl.uniform1f(this._uniforms.slope,     frame.rescaleSlope);
        gl.uniform1f(this._uniforms.intercept, frame.rescaleIntercept);
        gl.uniform1f(this._uniforms.wMin, wMin);
        gl.uniform1f(this._uniforms.wMax, wMax);
        gl.uniform1i(this._uniforms.invert,    state.isInverted     ? 1 : 0);
        gl.uniform1i(this._uniforms.superRes,  state.isSuperResEnabled ? 1 : 0);
        gl.uniform2f(this._uniforms.texSize,   frame.cols, frame.rows);

        // Transform matrix 3x3 (espacio textura centrado en 0.5,0.5)
        const mat = this._buildTransform(frame, state);
        gl.uniformMatrix3fv(this._uniforms.transform, false, mat);

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    /* ── Construir mat3 de transform ───────────────────── */
    _buildTransform(frame, state) {
        const zoom   = state.zoom   ?? 1;
        const panX   = state.panX   ?? 0;
        const panY   = state.panY   ?? 0;
        const flipH  = state.flipH  ?? false;
        const flipV  = state.flipV  ?? false;
        const rot    = (state.rotation ?? 0) * Math.PI / 180;

        const cw = this.canvas.width,  ch = this.canvas.height;
        const iw = frame.cols,          ih = frame.rows;

        // Escala base para encajar la imagen en el canvas (letterbox / pillarbox)
        const baseZoom = Math.min(cw / iw, ch / ih);

        // sx/sy en espacio de textura centrado:
        // Un canvas de 1200×700 con imagen 512×512 → baseZoom≈1.37
        // sx = cw/(baseZoom×iw×zoom) ≈ 1.71  →  textura "desborda" el quad → negro en bordes ✓
        const sx = (cw / (baseZoom * iw * zoom)) * (flipH ? -1 : 1);
        const sy = (ch / (baseZoom * ih * zoom)) * (flipV ? -1 : 1);

        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);

        // Pan en espacio de textura.
        // X: canvas y texcoord crecen en la misma dirección → signo negativo ✓
        // Y: canvas crece hacia abajo, texcoord OpenGL crece hacia arriba → signo POSITIVO
        const tx = -panX / (baseZoom * iw * zoom);
        const ty = +panY / (baseZoom * ih * zoom);

        // mat3 column-major: rotación + escala + pan
        // row vectors for GLSL column-major: [col0 col1 col2]
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
