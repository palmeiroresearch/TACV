'use strict';

/* ============================================================
   FilterShaders — GLSL para el pipeline de post-procesamiento
   Todos los shaders de filtro usan el mismo VERT simple (sin
   u_transform) y operan sobre una textura de grises [0,1].
   ============================================================ */

const FilterShaders = {

    /* ── Vertex shader compartido (sin transform) ─── */
    VERT: `#version 300 es
precision highp float;
in  vec2 a_position;
out vec2 v_tc;
void main() {
    v_tc = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`,

    /* ── Blit simple (copia) ─────────────────────── */
    FRAG_BLIT: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
void main() { fragColor = texture(u_source, v_tc); }`,

    /* ── Blit final con colormap ─────────────────── */
    FRAG_DISPLAY: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;    // grises [0,1] en canal R
uniform sampler2D u_colormap;  // LUT 256×1
void main() {
    float g = clamp(texture(u_source, v_tc).r, 0.0, 1.0);
    fragColor = texture(u_colormap, vec2(g, 0.5));
}`,

    /* ── Gaussian — paso horizontal ──────────────── */
    FRAG_GAUSS_H: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2  u_texSize;
uniform float u_sigma;
void main() {
    float dx = 1.0 / u_texSize.x;
    int R = int(u_sigma * 2.5);
    float sum = 0.0, w = 0.0;
    for (int i = -R; i <= R; i++) {
        float fi = float(i);
        float k  = exp(-fi*fi / (2.0*u_sigma*u_sigma));
        sum += texture(u_source, v_tc + vec2(fi*dx, 0.0)).r * k;
        w   += k;
    }
    fragColor = vec4(sum/w, 0.0, 0.0, 1.0);
}`,

    /* ── Gaussian — paso vertical ────────────────── */
    FRAG_GAUSS_V: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2  u_texSize;
uniform float u_sigma;
void main() {
    float dy = 1.0 / u_texSize.y;
    int R = int(u_sigma * 2.5);
    float sum = 0.0, w = 0.0;
    for (int i = -R; i <= R; i++) {
        float fi = float(i);
        float k  = exp(-fi*fi / (2.0*u_sigma*u_sigma));
        sum += texture(u_source, v_tc + vec2(0.0, fi*dy)).r * k;
        w   += k;
    }
    fragColor = vec4(sum/w, 0.0, 0.0, 1.0);
}`,

    /* ── Bicubic Mitchell-Netravali ──────────────── */
    FRAG_BICUBIC: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2 u_texSize;
float cubic(float x) {
    float a = abs(x), B = 0.333, C = 0.333;
    if (a < 1.0) return ((12.0-9.0*B-6.0*C)*a*a*a + (-18.0+12.0*B+6.0*C)*a*a + (6.0-2.0*B)) / 6.0;
    if (a < 2.0) return ((-B-6.0*C)*a*a*a + (6.0*B+30.0*C)*a*a + (-12.0*B-48.0*C)*a + (8.0*B+24.0*C)) / 6.0;
    return 0.0;
}
float smpl(vec2 tc) {
    if (any(lessThan(tc, vec2(0.0))) || any(greaterThan(tc, vec2(1.0)))) return 0.0;
    return texture(u_source, tc).r;
}
void main() {
    vec2 px = v_tc * u_texSize - 0.5;
    vec2 f  = fract(px), p = floor(px);
    float res = 0.0;
    for (int dy = -1; dy <= 2; dy++) {
        float wy = cubic(f.y - float(dy));
        for (int dx = -1; dx <= 2; dx++) {
            float wx = cubic(f.x - float(dx));
            res += wx * wy * smpl((p + vec2(float(dx), float(dy)) + 0.5) / u_texSize);
        }
    }
    fragColor = vec4(clamp(res, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,

    /* ── Unsharp Masking ─────────────────────────── */
    FRAG_USM: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_original;
uniform sampler2D u_blurred;
uniform float u_strength;
uniform float u_threshold;
void main() {
    float orig = texture(u_original, v_tc).r;
    float blr  = texture(u_blurred,  v_tc).r;
    float diff = orig - blr;
    float sh   = abs(diff) > u_threshold ? diff * u_strength : 0.0;
    fragColor = vec4(clamp(orig + sh, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,

    /* ── Bilateral Filter ────────────────────────── */
    FRAG_BILATERAL: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2  u_texSize;
uniform float u_sigmaS;
uniform float u_sigmaR;
void main() {
    vec2 d = 1.0 / u_texSize;
    float c = texture(u_source, v_tc).r;
    float sw = 0.0, sv = 0.0;
    int R = int(min(u_sigmaS * 2.5, 9.0));
    for (int dx = -R; dx <= R; dx++) {
        for (int dy = -R; dy <= R; dy++) {
            vec2 off = vec2(float(dx), float(dy)) * d;
            float v = texture(u_source, v_tc + off).r;
            float ws = exp(-float(dx*dx+dy*dy)/(2.0*u_sigmaS*u_sigmaS));
            float wr = exp(-pow(v-c, 2.0)/(2.0*u_sigmaR*u_sigmaR));
            float w  = ws * wr;
            sw += w; sv += w * v;
        }
    }
    fragColor = vec4(sv / max(sw, 0.0001), 0.0, 0.0, 1.0);
}`,

    /* ── Anisotropic Diffusion — 1 iteración Perona-Malik ── */
    FRAG_ANISO: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2  u_texSize;
uniform float u_lambda;
uniform float u_K;
uniform int   u_func;
float conduct(float g) {
    float r = g / u_K;
    return u_func == 0 ? exp(-r*r) : 1.0/(1.0+r*r);
}
void main() {
    vec2 d = 1.0 / u_texSize;
    float c = texture(u_source, v_tc).r;
    float n = texture(u_source, v_tc + vec2( 0.0,  d.y)).r;
    float s = texture(u_source, v_tc + vec2( 0.0, -d.y)).r;
    float e = texture(u_source, v_tc + vec2( d.x,  0.0)).r;
    float w = texture(u_source, v_tc + vec2(-d.x,  0.0)).r;
    float gN=n-c, gS=s-c, gE=e-c, gW=w-c;
    float res = c + u_lambda*(conduct(abs(gN))*gN + conduct(abs(gS))*gS
                             +conduct(abs(gE))*gE + conduct(abs(gW))*gW);
    fragColor = vec4(clamp(res, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,

    /* ── CLAHE — estadísticas locales ────────────── */
    FRAG_CLAHE_STATS: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform vec2  u_texSize;
uniform float u_radius;
void main() {
    vec2 d = 1.0 / u_texSize;
    int R  = int(u_radius);
    float sum=0.0, sum2=0.0, cnt=0.0;
    for (int dx=-R; dx<=R; dx++) {
        for (int dy=-R; dy<=R; dy++) {
            float v = texture(u_source, v_tc + vec2(float(dx),float(dy))*d).r;
            sum += v; sum2 += v*v; cnt += 1.0;
        }
    }
    float mean = sum/cnt;
    float std  = sqrt(max(0.0, sum2/cnt - mean*mean));
    fragColor = vec4(mean, std, 0.0, 1.0);   // R=media, G=desv std
}`,

    /* ── CLAHE — ecualización ────────────────────── */
    FRAG_CLAHE_EQ: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_source;
uniform sampler2D u_stats;     // R=media G=std
uniform float u_clipLimit;
uniform float u_strength;
void main() {
    float orig = texture(u_source, v_tc).r;
    vec2  st   = texture(u_stats,  v_tc).rg;
    float mean = st.r, std = st.g + 0.001;
    float gain = min(u_clipLimit / std, 5.0);
    float enh  = mean + gain * (orig - mean);
    fragColor  = vec4(mix(orig, clamp(enh, 0.0, 1.0), u_strength), 0.0, 0.0, 1.0);
}`,

    /* ── Multi-Scale Retinex (combina 3 escalas) ── */
    FRAG_RETINEX: `#version 300 es
precision highp float;
in vec2 v_tc; out vec4 fragColor;
uniform sampler2D u_original;
uniform sampler2D u_blur0;    // escala pequeña
uniform sampler2D u_blur1;    // escala media
uniform sampler2D u_blur2;    // escala grande
uniform float u_gain;
uniform float u_offset;
void main() {
    float eps = 0.005;
    float I  = texture(u_original, v_tc).r + eps;
    float lI = log(I);
    float R  = (1.0/3.0) * (
        (lI - log(texture(u_blur0, v_tc).r + eps)) +
        (lI - log(texture(u_blur1, v_tc).r + eps)) +
        (lI - log(texture(u_blur2, v_tc).r + eps))
    );
    fragColor = vec4(clamp(R * u_gain + u_offset, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,
};
