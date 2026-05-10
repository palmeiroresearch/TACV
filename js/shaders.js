'use strict';

/* ============================================================
   GLSL Shaders para TAC Viewer (WebGL2)
   ============================================================ */

const Shaders = {

    /* ── Vertex shader compartido ─────────────────────── */
    VERT: `#version 300 es
precision highp float;

in vec2 a_position;   // NDC quad [-1,1]
out vec2 v_texcoord;  // [0,1] con flip Y para WebGL → imagen

uniform mat3 u_transform; // pan + zoom + flip + rotate en espacio textura

void main() {
    // Convertir NDC [-1,1] → texcoord [0,1]
    vec2 tc = a_position * 0.5 + 0.5;
    // Aplicar transform (centrado en 0.5,0.5)
    vec2 centered = tc - 0.5;
    vec2 transformed = (u_transform * vec3(centered, 1.0)).xy + 0.5;
    v_texcoord = transformed;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`,

    /* ── Fragment shader — CT windowing + color map ────── */
    FRAG_CT: `#version 300 es
precision highp float;
precision highp isampler2D;

in  vec2 v_texcoord;
out vec4 fragColor;

uniform isampler2D u_pixels;
uniform sampler2D  u_colormap;
uniform float u_slope;
uniform float u_intercept;
uniform float u_wMin;
uniform float u_wMax;
uniform bool  u_invert;
uniform bool  u_superRes;   // Super-resolución CT-compatible (PMC10225926)
uniform vec2  u_texSize;    // vec2(cols, rows) de la textura fuente

// Muestreo seguro de raw Int16 con bounds check
float sampleRaw(vec2 tc) {
    if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0)
        return -1024.0;
    return float(texture(u_pixels, tc).r);
}

void main() {
    if (v_texcoord.x < 0.0 || v_texcoord.x > 1.0 ||
        v_texcoord.y < 0.0 || v_texcoord.y > 1.0) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float raw;

    if (u_superRes) {
        // Interpolación CT-compatible (PMC10225926)
        // Cada pixel fuente se divide en 2 sub-pixels que promedian al valor original:
        //   p_izq = v0 + (v_prev - v_next) / 4
        //   p_der = v0 - (v_prev - v_next) / 4   →  (p_izq + p_der)/2 = v0 ✓
        vec2 texel    = 1.0 / u_texSize;
        vec2 pixCoord = v_texcoord * u_texSize;
        vec2 pxCenter = (floor(pixCoord) + 0.5) / u_texSize;
        // subFrac ∈ [-0.5, 0.5]: posición dentro del pixel fuente
        vec2 subFrac  = (v_texcoord - pxCenter) * u_texSize;

        float v0      = sampleRaw(pxCenter);
        float v_left  = sampleRaw(pxCenter + vec2(-texel.x,  0.0));
        float v_right = sampleRaw(pxCenter + vec2( texel.x,  0.0));
        float v_up    = sampleRaw(pxCenter + vec2( 0.0, -texel.y));
        float v_down  = sampleRaw(pxCenter + vec2( 0.0,  texel.y));

        // δ = (vecino_anterior - vecino_siguiente) / 4
        float delta_x = (v_left  - v_right) * 0.25;
        float delta_y = (v_up    - v_down)  * 0.25;

        // Sub-pixel izquierdo/superior: +δ; derecho/inferior: -δ
        raw = v0
            + (subFrac.x < 0.0 ? 1.0 : -1.0) * delta_x
            + (subFrac.y < 0.0 ? 1.0 : -1.0) * delta_y;
    } else {
        raw = float(texture(u_pixels, v_texcoord).r);
    }

    float hu   = raw * u_slope + u_intercept;
    float gray = clamp((hu - u_wMin) / (u_wMax - u_wMin), 0.0, 1.0);
    if (u_invert) gray = 1.0 - gray;

    fragColor = texture(u_colormap, vec2(gray, 0.5));
}`,

    /* ── Fragment shader — MPR (R32F sampler3D) ─── */
    FRAG_MPR: `#version 300 es
precision highp float;
precision highp sampler3D;

in  vec2 v_texcoord;
out vec4 fragColor;

uniform sampler3D u_volume;      // R32F: valores raw Int16 como float
uniform sampler2D u_colormap;
uniform float u_slope;
uniform float u_intercept;
uniform float u_wMin;
uniform float u_wMax;
uniform bool  u_invert;

uniform vec3 u_planeOrigin;
uniform vec3 u_planeRight;
uniform vec3 u_planeUp;

void main() {
    vec3 volCoord = u_planeOrigin
        + v_texcoord.x * u_planeRight
        + v_texcoord.y * u_planeUp;

    // Negro fuera del volumen (letterbox borders + fuera del FOV)
    if (any(lessThan(volCoord, vec3(0.0))) || any(greaterThan(volCoord, vec3(1.0)))) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float raw = texture(u_volume, volCoord).r;
    float hu  = raw * u_slope + u_intercept;

    float gray = clamp((hu - u_wMin) / (u_wMax - u_wMin), 0.0, 1.0);
    if (u_invert) gray = 1.0 - gray;

    fragColor = texture(u_colormap, vec2(gray, 0.5));
}`,

    /* ── Compila un programa WebGL2 ─────────────────── */
    compile(gl, vertSrc, fragSrc) {
        const vert = this._compileShader(gl, gl.VERTEX_SHADER,   vertSrc);
        const frag = this._compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
        const prog = gl.createProgram();
        gl.attachShader(prog, vert);
        gl.attachShader(prog, frag);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error('Shader link error: ' + gl.getProgramInfoLog(prog));
        }
        gl.deleteShader(vert);
        gl.deleteShader(frag);
        return prog;
    },

    _compileShader(gl, type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s));
        }
        return s;
    },
};
