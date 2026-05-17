// build.js — TAC Viewer production build
// Uso: node build.js
// Resultado: dist/ con JS + CSS minificados e index.html actualizado
'use strict';

const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Orden estricto de dependencias (igual que index.html)
const JS_FILES = [
    'js/capabilities.js',
    'lib/dicom-parser.min.js',
    'lib/pako.min.js',
    'js/config.js',
    'js/storage.js',
    'js/colormap.js',
    'js/shaders.js',
    'js/filter-shaders.js',
    'js/dicom-parser-bridge.js',
    'js/dicom-loader.js',
    'js/measurement-store.js',
    'js/tool-state.js',
    'js/tools-basic.js',
    'js/tools-measure.js',
    'js/tools-annotate.js',
    'js/post-processor.js',
    'js/renderer-gl.js',
    'js/overlay-renderer.js',
    'js/viewport.js',
    'js/viewport-layout.js',
    'js/series-panel.js',
    'js/mpr-volume.js',
    'js/mpr-viewport.js',
    'js/series-manager.js',
    'js/metadata-panel.js',
    'js/measurements-panel.js',
    'js/histogram-panel.js',
    'js/export.js',
    'js/case-library.js',
    'js/ui.js',
    'js/app.js',
];

const CSS_FILES = [
    'css/main.css',
    'css/layout.css',
    'css/toolbar.css',
    'css/thumbnail.css',
    'css/panels.css',
];

async function build() {
    fs.mkdirSync(DIST, { recursive: true });
    fs.mkdirSync(path.join(DIST, 'css/fonts'), { recursive: true });
    fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });

    console.log('Building TAC Viewer...');

    // ── JS: concatenar en orden → minificar ──────────────────────
    const jsConcat = JS_FILES
        .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
        .join('\n;\n');

    const tmpJs = path.join(DIST, '_tmp.js');
    fs.writeFileSync(tmpJs, jsConcat);

    const jsResult = await esbuild.build({
        entryPoints: [tmpJs],
        outfile:     path.join(DIST, 'app.min.js'),
        minify:      true,
        target:      ['chrome90', 'firefox90', 'safari15'],
        logLevel:    'silent',
    });
    fs.unlinkSync(tmpJs);

    const jsSizeOrig = JS_FILES.reduce((sum, f) =>
        sum + fs.statSync(path.join(ROOT, f)).size, 0);
    const jsSizeDist = fs.statSync(path.join(DIST, 'app.min.js')).size;
    console.log(`  JS:  ${kb(jsSizeOrig)} → ${kb(jsSizeDist)} (${pct(jsSizeOrig, jsSizeDist)}% smaller)`);

    // ── CSS: concatenar → minificar (sin procesar @font-face urls) ─
    const cssConcat = CSS_FILES
        .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
        .join('\n');

    const tmpCss = path.join(DIST, '_tmp.css');
    fs.writeFileSync(tmpCss, cssConcat);

    await esbuild.build({
        entryPoints: [tmpCss],
        outfile:     path.join(DIST, 'app.min.css'),
        minify:      true,
        loader:      { '.woff2': 'copy' },
        logLevel:    'silent',
    });
    fs.unlinkSync(tmpCss);

    const cssSizeOrig = CSS_FILES.reduce((sum, f) =>
        sum + fs.statSync(path.join(ROOT, f)).size, 0);
    const cssSizeDist = fs.statSync(path.join(DIST, 'app.min.css')).size;
    console.log(`  CSS: ${kb(cssSizeOrig)} → ${kb(cssSizeDist)} (${pct(cssSizeOrig, cssSizeDist)}% smaller)`);

    // ── Copiar assets estáticos ──────────────────────────────────
    copyFile('js/dicom.worker.js',           'js/dicom.worker.js');   // cargado dinámicamente
    copyFile('js/tv-worker.js',              'js/tv-worker.js');       // cargado dinámicamente
    copyFile('css/fonts/inter-latin.woff2',  'css/fonts/inter-latin.woff2');
    copyFile('css/fonts/inter-latin-ext.woff2', 'css/fonts/inter-latin-ext.woff2');
    copyFile('icons/icon-192.png',           'icons/icon-192.png');
    copyFile('icons/icon-512.png',           'icons/icon-512.png');
    copyFile('manifest.json',                'manifest.json');
    copyFile('sw.js',                        'sw.js');
    console.log('  Assets copiados.');

    // ── Generar dist/index.html con referencias al bundle ────────
    generateIndexHtml();
    console.log('  dist/index.html generado.');

    const total = kb(jsSizeDist + cssSizeDist);
    console.log(`\nDist total: ~${total} (JS+CSS). Listo en dist/`);
}

function generateIndexHtml() {
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    // Reemplazar todos los <link rel="stylesheet"> por uno solo
    html = html.replace(
        /(\s*<link rel="stylesheet"[^>]+>\n?)+/,
        '\n    <link rel="stylesheet" href="app.min.css">\n'
    );

    // Reemplazar todos los <script defer src="..."> por dos scripts:
    // el worker sigue siendo inline (cargado por DicomLoader)
    html = html.replace(
        /(\s*<!-- Scripts.*?-->\n)([\s\S]*?)(<\/body>)/,
        `\n    <!-- Bundle de producción -->\n    <script defer src="app.min.js"></script>\n</body>`
    );

    fs.writeFileSync(path.join(DIST, 'index.html'), html);
}

function copyFile(src, dest) {
    const srcPath  = path.join(ROOT, src);
    const destPath = path.join(DIST, dest);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, destPath);
}

function kb(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }
function pct(orig, dist) { return Math.round((1 - dist / orig) * 100); }

build().catch(err => { console.error(err); process.exit(1); });
