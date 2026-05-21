'use strict';

class MprViewport extends Viewport {
    constructor(cell, id, plane) {
        super(cell, id);
        this.mprPlane       = plane;
        this._mprProgram    = null;
        this._mprUniforms   = {};
        this._sliceFraction = 0.5;
        this._cineInterval  = null;
        this._cineDir       = 1;
        this._mprProjMode   = 0;   // 0=thin, 1=MIP, 2=MinIP, 3=Average
        this._mprSlabN      = 1;

        const labelRow = document.createElement('div');
        labelRow.className = 'viewport-label-row';

        const label = document.createElement('div');
        label.className   = 'viewport-label';
        label.textContent = { axial: 'Axial', coronal: 'Coronal', sagital: 'Sagital' }[plane] || plane;
        labelRow.appendChild(label);

        if (plane !== 'axial') {
            const cineBtn = document.createElement('button');
            cineBtn.className   = 'mpr-cine-btn';
            cineBtn.textContent = '▶';
            cineBtn.title       = 'Cine — recorrer plano';
            cineBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMprCine(); });
            labelRow.appendChild(cineBtn);
            this._cineBtnEl = cineBtn;

            // Modo MIP selector
            const modeSelect = document.createElement('select');
            modeSelect.className = 'mpr-mode-select';
            modeSelect.title = 'Modo de proyección';
            [['Thin', 0], ['MIP', 1], ['MinIP', 2], ['Avg', 3]].forEach(([label, val]) => {
                const opt = document.createElement('option');
                opt.value = val; opt.textContent = label;
                modeSelect.appendChild(opt);
            });
            modeSelect.addEventListener('change', (e) => {
                e.stopPropagation();
                this._mprProjMode = parseInt(e.target.value);
                this.render();
            });
            labelRow.appendChild(modeSelect);
            this._modeSelectEl = modeSelect;

            // Slab thickness slider (oculto cuando Thin)
            const slabLabel = document.createElement('span');
            slabLabel.className = 'mpr-slab-label';
            slabLabel.textContent = 'Slab: ';

            const slabInput = document.createElement('input');
            slabInput.type = 'range'; slabInput.min = 1; slabInput.max = 40; slabInput.value = 1;
            slabInput.className = 'mpr-slab-slider';
            slabInput.title = 'Grosor del slab (voxels)';
            slabInput.addEventListener('input', (e) => {
                e.stopPropagation();
                this._mprSlabN = parseInt(e.target.value);
                slabVal.textContent = e.target.value;
                this.render();
            });
            const slabVal = document.createElement('span');
            slabVal.className = 'mpr-slab-val'; slabVal.textContent = '1';

            const slabRow = document.createElement('div');
            slabRow.className = 'mpr-slab-row hidden';
            slabRow.appendChild(slabLabel);
            slabRow.appendChild(slabInput);
            slabRow.appendChild(slabVal);

            modeSelect.addEventListener('change', () => {
                slabRow.classList.toggle('hidden', this._mprProjMode === 0);
                if (this._mprProjMode === 0) { this._mprSlabN = 1; slabInput.value = 1; slabVal.textContent = '1'; }
            });

            cell.appendChild(slabRow);
            this._slabRowEl = slabRow;
        }

        cell.appendChild(labelRow);

        if (plane !== 'axial' && this.renderer) {
            this._initMprShader();
            this._initMprClickNav();
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
                slabN:       gl.getUniformLocation(p, 'u_slabN'),
                projMode:    gl.getUniformLocation(p, 'u_projMode'),
                slabStep:    gl.getUniformLocation(p, 'u_slabStep'),
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

        // buildForContext verifica internamente si la textura está vigente (version)
        // y la re-sube si hay una serie nueva. Siempre llamarlo — es idempotente.
        if (!MprVolume.isReady()) return;
        if (!MprVolume.buildForContext(this.renderer.gl)) return;

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

        // Thick MPR / MIP
        gl.uniform1i(this._mprUniforms.slabN,    this._mprSlabN);
        gl.uniform1i(this._mprUniforms.projMode, this._mprProjMode);
        gl.uniform3fv(this._mprUniforms.slabStep, this._computeSlabStep());

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        OverlayRenderer.render(this);
    }

    setSliceFraction(f) {
        this._sliceFraction = Math.max(0.01, Math.min(0.99, f));
        this.render();
        if (typeof ViewportLayout !== 'undefined') {
            ViewportLayout.getAll().forEach(vp => { if (vp !== this) vp.render(); });
        }
    }

    /* ── Cine MPR ─────────────────────────────────────── */
    startMprCine() {
        if (this._cineInterval) return;
        if (this._cineBtnEl) { this._cineBtnEl.textContent = '⏸'; }
        this._cineInterval = setInterval(() => {
            this._sliceFraction += this._cineDir * 0.025;
            if (this._sliceFraction >= 0.99) { this._sliceFraction = 0.99; this._cineDir = -1; }
            if (this._sliceFraction <= 0.01) { this._sliceFraction = 0.01; this._cineDir =  1; }
            this.render();
            ViewportLayout.getAll().forEach(vp => { if (vp !== this) vp.render(); });
        }, 1000 / 12);
    }

    stopMprCine() {
        if (!this._cineInterval) return;
        clearInterval(this._cineInterval);
        this._cineInterval = null;
        if (this._cineBtnEl) { this._cineBtnEl.textContent = '▶'; }
    }

    toggleMprCine() { this._cineInterval ? this.stopMprCine() : this.startMprCine(); }

    /* ── Navegación por click (A5) ────────────────────── */
    _initMprClickNav() {
        let downX = 0, downY = 0;
        const gc = this.glCanvas;
        gc.addEventListener('mousedown', (e) => { if (e.button === 0) { downX = e.clientX; downY = e.clientY; } });
        gc.addEventListener('mouseup',   (e) => {
            if (e.button !== 0) return;
            if (Math.hypot(e.clientX - downX, e.clientY - downY) < 6) {
                this._navigateToClick(e.clientX, e.clientY);
            }
        });
    }

    _navigateToClick(clientX, clientY) {
        if (!MprVolume.isReady()) return;
        const dims = MprVolume.getDims();
        const cw   = this.glCanvas.offsetWidth  || this.glCanvas.width;
        const ch   = this.glCanvas.offsetHeight || this.glCanvas.height;
        if (!cw || !ch || !dims) return;

        const rect = this.glCanvas.getBoundingClientRect();
        const cx   = clientX - rect.left;
        const cy   = clientY - rect.top;

        const physW = this.mprPlane === 'coronal'
            ? dims.width  * dims.spacingX
            : dims.height * dims.spacingY;
        const physH = dims.depth * dims.spacingZ;

        const zoom     = this.state.zoom ?? 1;
        const panX     = this.state.panX ?? 0;
        const panY     = this.state.panY ?? 0;
        const baseZoom = Math.min(cw / physW, ch / physH);
        const sx = cw / (baseZoom * physW * zoom);
        const sy = ch / (baseZoom * physH * zoom);
        const tx = -panX / (baseZoom * physW * zoom);
        const ty = -panY / (baseZoom * physH * zoom);

        const tcX = sx * (cx / cw - 0.5) + tx + 0.5;
        const tcY = sy * (cy / ch - 0.5) + ty + 0.5;

        // Y maps to Z (depth) → navigate axial
        // Con zAscending=false el shader usa up=[0,0,-1], por lo que tcY=1 (arriba)
        // corresponde a Z=0 (serie[0] = superior) → hay que invertir para el índice.
        const zFrac = Math.max(0.01, Math.min(0.99, tcY));
        const zAsc  = MprVolume.getDims()?.zAscending ?? true;
        const series = SeriesPanel.getSeries();
        if (series.length > 0) {
            const sliceIdx = zAsc ? zFrac : (1 - zFrac);
            SeriesPanel.jumpTo(Math.round(sliceIdx * (series.length - 1)));
        }

        // X maps to the other horizontal plane
        const xFrac      = Math.max(0.01, Math.min(0.99, tcX));
        const otherPlane = this.mprPlane === 'coronal' ? 'sagital' : 'coronal';
        const otherVp    = ViewportLayout.getAll().find(v => v instanceof MprViewport && v.mprPlane === otherPlane);
        if (otherVp) otherVp.setSliceFraction(xFrac);
    }

    _getPlaneData() {
        const f = this._sliceFraction;
        switch (this.mprPlane) {
            case 'coronal':  return MprVolume.getCoronalPlane(f);
            case 'sagital':  return MprVolume.getSagittalPlane(f);
            default:         return MprVolume.getAxialPlane(0);
        }
    }

    _computeSlabStep() {
        const dims = MprVolume.getDims();
        if (!dims) return new Float32Array([0, 0, 0]);
        // Normal direction in texture space (1 voxel step)
        if (this.mprPlane === 'coronal') {
            return new Float32Array([0, 1 / dims.height, 0]);
        } else {
            return new Float32Array([1 / dims.width, 0, 0]);
        }
    }
}
