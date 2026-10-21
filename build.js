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
    'js/research-core.js',
    'js/detect-core.js',
    'js/measurement-store.js',
    'js/tool-state.js',
    'js/tools-basic.js',
    'js/tools-measure.js',
    'js/tools-annotate.js',
    'js/research-mode.js',
    'js/tools-nwu.js',
    'js/detector.js',
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
    'js/research-panel.js',
    'js/detector-panel.js',
    'js/export.js',
    'js/case-library.js',
    'js/loupe.js',
    'js/ui.js',
    'js/app.js',
];

const CSS_FILES = [
    'css/main.css',
    'css/layout.css',
    'css/toolbar.css',
    'css/thumbnail.css',
    'css/panels.css',
    'css/research.css',
    'css/detector.css',
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
    // Workers: se cargan dinámicamente, no entran en el bundle.
    copyFile('js/dicom.worker.js',           'js/dicom.worker.js');
    copyFile('js/tv-worker.js',              'js/tv-worker.js');
    copyFile('js/detect-worker.js',          'js/detect-worker.js');
    // detect-worker.js hace importScripts de estos dos:
    copyFile('js/research-core.js',          'js/research-core.js');
    copyFile('js/detect-core.js',            'js/detect-core.js');

    // dicom.worker.js hace importScripts de estas tres rutas relativas. Sin
    // copiarlas, el worker falla y dist/ no puede abrir ningún DICOM, aunque
    // las mismas librerías sí estén dentro de app.min.js para el hilo principal.
    copyFile('lib/dicom-parser.min.js',      'lib/dicom-parser.min.js');
    copyFile('lib/pako.min.js',              'lib/pako.min.js');
    copyFile('js/dicom-parser-bridge.js',    'js/dicom-parser-bridge.js');

    // Fuentes: app.min.css queda en la raíz de dist, así que sus url('fonts/…')
    // resuelven a dist/fonts/, no a dist/css/fonts/. Se copian a ambos sitios
    // para servir tanto al bundle como a una carga sin minificar.
    for (const f of ['inter-latin.woff2', 'inter-latin-ext.woff2']) {
        copyFile(`css/fonts/${f}`, `fonts/${f}`);
        copyFile(`css/fonts/${f}`, `css/fonts/${f}`);
    }

    for (const ic of ['icon-192.png', 'icon-512.png',
                     'icon-maskable-192.png', 'icon-maskable-512.png',
                     'apple-touch-icon.png', 'favicon-32.png', 'favicon-16.png']) {
        copyFile(`icons/${ic}`, `icons/${ic}`);
    }
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

    // Normalizar saltos de línea antes de sustituir. Un index.html guardado con
    // CRLF (VS Code en Windows lo hace sin avisar) rompía el regex de abajo
    // porque `-->\n` no casa con `-->\r\n`: el bundle se generaba pero
    // dist/index.html seguía cargando los 39 scripts sueltos, que en dist no
    // existen. Fallaba en silencio y solo se veía como 404 al abrir dist/.
    html = html.replace(/\r\n/g, '\n');

    // Reemplazar todos los <link rel="stylesheet"> por uno solo
    const cssRe = /(\s*<link rel="stylesheet"[^>]+>\n?)+/;
    if (!cssRe.test(html)) fail('no se encontraron los <link rel="stylesheet">');
    html = html.replace(cssRe, '\n    <link rel="stylesheet" href="app.min.css">\n');

    // Reemplazar todos los <script defer src="..."> por el bundle.
    // Los workers siguen siendo archivos aparte: los carga new Worker().
    const jsRe = /(\s*<!-- Scripts[^\n]*-->\s*)([\s\S]*?)(<\/body>)/;
    if (!jsRe.test(html)) fail('no se encontró el bloque de <script> antes de </body>');
    html = html.replace(jsRe,
        '\n    <!-- Bundle de producción -->\n' +
        '    <script defer src="app.min.js"></script>\n</body>');

    // Comprobar el resultado en vez de confiar en que el regex hizo su trabajo
    const sueltos = (html.match(/<script defer src="(?:js|lib)\//g) || []).length;
    if (sueltos) fail(`quedan ${sueltos} <script> sueltos en dist/index.html`);
    if (!html.includes('app.min.js')) fail('dist/index.html no referencia app.min.js');
    if (!html.includes('app.min.css')) fail('dist/index.html no referencia app.min.css');

    fs.writeFileSync(path.join(DIST, 'index.html'), html);
}

function fail(msg) {
    throw new Error(`generateIndexHtml: ${msg}`);
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
