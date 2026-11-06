'use strict';

/* ============================================================
   publicar — sube la versión, comprueba y deja el commit listo.

   Uso:
     node scripts/publicar.js            solo comprueba, no toca nada
     node scripts/publicar.js 1.7.1      sube a 1.7.1, commit y etiqueta
     node scripts/publicar.js patch      1.7.0 → 1.7.1
     node scripts/publicar.js minor      1.7.0 → 1.8.0

   El push NUNCA se hace solo. Al terminar dice el comando exacto.

   Por qué existe: la versión vive en CUATRO sitios que tienen que
   coincidir, y uno de ellos —CACHE_VERSION en sw.js— es el que decide
   si a quien ya tiene la app abierta le llega la actualización. Si se
   olvida, el despliegue "funciona" pero nadie recibe nada: el service
   worker sigue sirviendo la versión vieja desde su caché, y eso no da
   ningún error que mirar.
   ============================================================ */

const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const leer = (r) => fs.readFileSync(path.join(RAIZ, r), 'utf8');
const escribir = (r, s) => fs.writeFileSync(path.join(RAIZ, r), s, 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: RAIZ, encoding: 'utf8' }).trim();

/* Los cuatro sitios donde vive la versión. */
const SITIOS = [
    { archivo: 'package.json', re: /("version":\s*")([^"]+)(")/,              que: 'package.json' },
    { archivo: 'js/config.js', re: /(APP_VERSION\s*=\s*')([^']+)(')/,          que: 'APP_VERSION' },
    { archivo: 'js/config.js', re: /(CACHE_NAME\s*=\s*'tac-viewer-v)([^']+)(')/, que: 'CACHE_NAME' },
    { archivo: 'sw.js',        re: /(CACHE_VERSION\s*=\s*'v)([^']+)(')/,       que: 'CACHE_VERSION' },
];

function versionActual() {
    return JSON.parse(leer('package.json')).version;
}

/* ── Comprobaciones: lo que de verdad rompe un despliegue ──── */

function comprobar() {
    const problemas = [];
    const v = versionActual();

    for (const s of SITIOS) {
        const m = s.re.exec(leer(s.archivo));
        if (!m) problemas.push(`no se encontró ${s.que} en ${s.archivo}`);
        else if (m[2] !== v) problemas.push(`${s.que} va por ${m[2]} y package.json por ${v}`);
    }

    const html = leer('index.html');
    const sw   = leer('sw.js');

    // Todo lo que el HTML referencia tiene que existir
    const refs = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map(m => m[1]);
    for (const r of new Set(refs)) {
        if (!fs.existsSync(path.join(RAIZ, r))) {
            problemas.push(`index.html referencia "${r}", que no existe`);
        }
    }

    // Y tiene que estar en la caché del service worker, o la app no
    // funcionará sin conexión — que es media razón de ser de una PWA.
    const bloque = /const\s+ASSETS\s*=\s*\[([\s\S]*?)\n\];/.exec(sw);
    if (!bloque) {
        problemas.push('no se encontró el array ASSETS en sw.js');
    } else {
        const assets = [...bloque[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
        for (const r of new Set(refs)) {
            if (/^(js|css|lib)\//.test(r) && !assets.includes(r)) {
                problemas.push(`"${r}" está en index.html pero NO en los ASSETS de sw.js`);
            }
        }
        for (const a of new Set(assets)) {
            if (!a.endsWith('/') && !fs.existsSync(path.join(RAIZ, a))) {
                problemas.push(`sw.js precachea "${a}", que no existe ` +
                               `(un solo 404 hace fallar la instalación entera)`);
            }
        }
    }

    return { problemas, version: v };
}

/* ── Pruebas ───────────────────────────────────────────────── */

function pruebas() {
    try {
        const salida = execFileSync('npm', ['test'], {
            cwd: RAIZ, encoding: 'utf8', shell: true, stdio: 'pipe',
        });
        const pass = /pass (\d+)/.exec(salida)?.[1];
        const fail = /fail (\d+)/.exec(salida)?.[1];
        return { ok: fail === '0', pass, fail };
    } catch (e) {
        const t = (e.stdout || '') + (e.stderr || '');
        return { ok: false, pass: /pass (\d+)/.exec(t)?.[1], fail: /fail (\d+)/.exec(t)?.[1] };
    }
}

/* ── Subir la versión ──────────────────────────────────────── */

function siguiente(actual, arg) {
    const [ma, mi, pa] = actual.split('.').map(Number);
    if (arg === 'patch') return `${ma}.${mi}.${pa + 1}`;
    if (arg === 'minor') return `${ma}.${mi + 1}.0`;
    if (arg === 'major') return `${ma + 1}.0.0`;
    if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
    throw new Error(`"${arg}" no es una versión ni patch/minor/major.`);
}

function aplicar(nueva) {
    const tocados = new Set();
    for (const s of SITIOS) {
        const txt = leer(s.archivo);
        const m = s.re.exec(txt);
        // Ya está en la versión pedida: no es un fallo. Pasa al publicar una
        // versión cuyo número ya se había subido a mano antes del commit.
        if (m && m[2] === nueva) continue;
        const nuevo = txt.replace(s.re, (_, a, __, c) => a + nueva + c);
        if (nuevo === txt) throw new Error(`no se pudo actualizar ${s.que} en ${s.archivo}`);
        escribir(s.archivo, nuevo);
        tocados.add(s.archivo);
    }
    return [...tocados];
}

/* ════════════════════════════════════════════════════════════ */

const arg = process.argv[2];

// Estado del repositorio
let sucio = [];
try { sucio = git('status', '--porcelain').split('\n').filter(Boolean); }
catch { console.error('Esto no es un repositorio git.'); process.exit(1); }

console.log('');
const previo = comprobar();
if (previo.problemas.length) {
    console.log(`  Versión actual: ${previo.version}`);
    console.log('\n  PROBLEMAS:\n');
    previo.problemas.forEach(p => console.log('   · ' + p));
    console.log('');
    if (arg) { console.log('  No se sube la versión hasta arreglarlos.\n'); process.exit(1); }
} else {
    console.log(`  Versión actual: ${previo.version} — los cuatro sitios coinciden,`);
    console.log('  nada referenciado falta y el service worker los precachea todos.');
}

if (!arg) {
    console.log('');
    console.log(`  ${sucio.length} archivos con cambios sin confirmar.`);
    console.log('  Para publicar:  node scripts/publicar.js <version|patch|minor>');
    console.log('');
    process.exit(previo.problemas.length ? 1 : 0);
}

/* ── Publicar ──────────────────────────────────────────────── */

const nueva = siguiente(previo.version, arg);
console.log(`\n  ${previo.version} → ${nueva}\n`);

console.log('  pruebas...');
const t = pruebas();
console.log(`    ${t.pass} pasan, ${t.fail} fallan`);
if (!t.ok) {
    console.error('\n  No se publica con pruebas en rojo.\n');
    process.exit(1);
}

const tocados = aplicar(nueva);
console.log(tocados.length
    ? `  versión escrita en: ${tocados.join(', ')}`
    : `  la versión ya estaba en ${nueva} en los cuatro sitios`);

const post = comprobar();
if (post.problemas.length) {
    console.error('\n  Tras subir la versión algo no cuadra:\n');
    post.problemas.forEach(p => console.error('   · ' + p));
    console.error('\n  Revisalo; los archivos quedaron modificados.\n');
    process.exit(1);
}

git('add', '-A');
git('commit', '-m', `v${nueva}`);
git('tag', '-a', `v${nueva}`, '-m', `TACV ${nueva}`);

console.log('');
console.log(`  commit y etiqueta v${nueva} creados en local.`);
console.log('');
console.log('  Revisá antes de publicar:');
console.log('      git show --stat HEAD');
console.log('');
console.log('  Y cuando estés conforme:');
console.log('      git push origin main --follow-tags');
console.log('');
console.log('  GitHub Pages republica solo en un par de minutos. A quien tenga');
console.log(`  la app abierta le saldrá el aviso de nueva versión, porque`);
console.log(`  CACHE_VERSION pasó a v${nueva}.`);
console.log('');
