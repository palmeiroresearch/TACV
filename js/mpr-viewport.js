'use strict';

class MprViewport extends Viewport {
    constructor(cell, id, plane) {
        super(cell, id);
        this.mprPlane       = plane;
        this._mprProgram    = null;
        this._mprUniforms   = {};
        this._sliceFraction = 0.5;

        const label = document.createElement('div');
        label.className   = 'viewport-label';
        label.textContent = { axial: 'Axial', coronal: 'Coronal', sagital: 'Sagital' }[plane] || plane;
        cell.appendChild(label);

        if (plane !== 'axial' && this.renderer) {
            this._initMprShader();
        }
    }

    _initMprShader() {
        try {
            const gl = this.renderer.gl;
            this._mprProgram = Shaders.compile(gl, Shaders.VERT, Shaders.FRAG_MPR);
            const p = this._mprProgram;
            this._mprUniforms = {
                transform:   gl.getUniformLocation(p, 'u_transform'),
                volume:      gl.getUniformLocation(p, 'u_volume'),
                colormap:    gl.getUniformLocation(p, 'u_colormap'),
                slope:       gl.getUniformLocation(p, 'u_slope'),
                intercept:   gl.getUniformLocation(p, 'u_intercept'),
                wMin:        gl.getUniformLocation(p, 'u_wMin'),
                wMax:        gl.getUniformLocation(p, 'u_wMax'),
                invert:      gl.getUniformLocation(p, 'u_invert'),
                planeOrigin: gl.getUniformLocation(p, 'u_planeOrigin'),
                planeRight:  gl.getUniformLocation(p, 'u_planeRight'),
                planeUp:     gl.getUniformLocation(p, 'u_planeUp'),
            };
        } catch (e) {
            console.error('MPR shader error:', e);
        }
    }

    /* ── Transform con aspecto físico (mm) — igual que renderer-gl pero en mm ── */
    _buildMprTransform() {
        const dims = MprVolume.getDims();
        const identity = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
        if (!dims) return identity;

        const rdr = this.renderer;
        const cw  = rdr.canvas.width  || rdr.canvas.offsetWidth;
        const ch  = rdr.canvas.height || rdr.canvas.offsetHeight;
        if (!cw || !ch) return identity;

        const zoom = this.state.zoom ?? 1;
        const panX = this.state.panX ?? 0;
        const panY = this.state.panY ?? 0;

        // Dimensiones físicas (mm) del plano a visualizar
        let physW, physH;
        if (this.mprPlane === 'coronal') {
            physW = dims.width  * dims.spacingX;   // X → derecha-izquierda
            physH = dims.depth  * dims.spacingZ;   // Z → superior-inferior
        } else {                                    // sagital
            physW = dims.height * dims.spacingY;   // Y → anterior-posterior
            physH = dims.depth  * dims.spacingZ;   // Z → superior-inferior
        }

        // Letterbox: escala en px/mm para encajar el plano en el viewport
        const baseZoom = Math.min(cw / physW, ch / physH);

        // Escala en espacio textura (misma lógica que _buildTransform en renderer-gl.js)
        const sx = cw / (baseZoom * physW * zoom);
        const sy = ch / (baseZoom * physH * zoom);

        // Pan en espacio textura
        const tx = -panX / (baseZoom * physW * zoom);
        const ty = -panY / (baseZoom * physH * zoom);

        // mat3 column-major para GLSL
        return new Float32Array([
            sx, 0, 0,
            0, sy, 0,
            tx, ty, 1,
        ]);
    }

    render() {
        if (this.mprPlane === 'axial') {
            super.render();
            return;
        }
        if (!this._mprProgram) return;

        if (!MprVolume.isReadyForContext(this.renderer.gl)) {
            if (!MprVolume.isReady()) return;
            MprVolume.buildForContext(this.renderer.gl);
        }

        const gl  = this.renderer.gl;
        const rdr = this.renderer;

        rdr.resize();
        rdr.uploadColormap(this.state.colorMapId || 'grayscale');

        gl.useProgram(this._mprProgram);
        gl.bindVertexArray(rdr._vao);

        // TEXTURE_3D en slot 2
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_3D, MprVolume.getTexture(gl));
        gl.uniform1i(this._mprUniforms.volume, 2);

        // Color map en slot 1
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, rdr._texColormap);
        gl.uniform1i(this._mprUniforms.colormap, 1);

        // Windowing
        const ww  = this.state.windowWidth;
        const wc  = this.state.windowCenter;
        const ref = SeriesPanel.getSeries()[0];
        gl.uniform1f(this._mprUniforms.slope,     ref?.rescaleSlope     ?? 1);
        gl.uniform1f(this._mprUniforms.intercept, ref?.rescaleIntercept ?? -1024);
        gl.uniform1f(this._mprUniforms.wMin, wc - ww / 2);
        gl.uniform1f(this._mprUniforms.wMax, wc + ww / 2);
        gl.uniform1i(this._mprUniforms.invert, this.state.isInverted ? 1 : 0);

        // Transform con aspecto físico correcto
        gl.uniformMatrix3fv(this._mprUniforms.transform, false, this._buildMprTransform());

        // Plano de corte
        const plane = this._getPlaneData();
        gl.uniform3fv(this._mprUniforms.planeOrigin, plane.origin);
        gl.uniform3fv(this._mprUniforms.planeRight,  plane.right);
        gl.uniform3fv(this._mprUniforms.planeUp,     plane.up);

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        OverlayRenderer.render(this);
    }

    setSliceFraction(f) {
        this._sliceFraction = Math.max(0.01, Math.min(0.99, f));
        this.render();
    }

    _getPlaneData() {
        const f = this._sliceFraction;
        switch (this.mprPlane) {
            case 'coronal':  return MprVolume.getCoronalPlane(f);
            case 'sagital':  return MprVolume.getSagittalPlane(f);
            default:         return MprVolume.getAxialPlane(0);
        }
    }
}
