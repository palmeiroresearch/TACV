'use strict';

/* ============================================================
   analizar-equipo — qué hay que saber de un tomógrafo antes de
   medir con sus imágenes.

   Uso:  node scripts/analizar-equipo.js "E:\casos\PACIENTE 1234-26"
         node scripts/analizar-equipo.js "E:\casos"          (varios)

   Para qué sirve: el NWU es una diferencia de medias de pocas
   unidades Hounsfield. Si el ruido del equipo es mayor que la
   diferencia que se busca, la cifra no significa nada; y si dos
   estudios se reconstruyeron con kernels distintos, no son
   comparables entre sí aunque lo parezcan.

   Nada de esto se ve mirando las imágenes. Sale de los metadatos
   y de medir el ruido en una zona homogénea.

   No modifica ningún archivo: solo lee.
   ============================================================ */

const fs   = require('node:fs');
const path = require('node:path');

/* ── Lector mínimo de DICOM Parte 10 ────────────────────────
   No se usa el bridge del visor porque hace falta el META header
   (grupo 0002), que es donde vive la transfer syntax — justo el dato
   más importante aquí, y el bridge no lo expone. */

const VR_CON_LONGITUD_LARGA = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

function leerDicom(buf) {
    if (buf.length < 132 || buf.toString('ascii', 128, 132) !== 'DICM') {
        throw new Error('no tiene preámbulo DICM (¿no es Parte 10?)');
    }
    const tags = {};
    let p = 132;
    let explicito = true;          // el grupo 0002 siempre es explícito
    let finMeta = null;

    while (p + 8 <= buf.length) {
        const grupo = buf.readUInt16LE(p);
        const elem  = buf.readUInt16LE(p + 2);
        const tag = ((grupo << 16) | elem) >>> 0;
        let vr = null, lon, cab;

        if (explicito) {
            vr = buf.toString('ascii', p + 4, p + 6);
            if (VR_CON_LONGITUD_LARGA.has(vr)) {
                lon = buf.readUInt32LE(p + 8); cab = 12;
            } else {
                lon = buf.readUInt16LE(p + 6); cab = 8;
            }
        } else {
            lon = buf.readUInt32LE(p + 4); cab = 8;
        }

        if (lon === 0xFFFFFFFF) break;              // longitud indefinida: se para
        const ini = p + cab;
        if (ini + lon > buf.length) break;
        tags[tag] = { vr, ini, lon };

        // (0002,0000) dice cuánto ocupa el META; después cambia la sintaxis
        if (tag === 0x00020000) {
            finMeta = ini + lon + buf.readUInt32LE(ini);
        }
        p = ini + lon + (lon % 2);                  // los elementos van a byte par

        if (finMeta !== null && p >= finMeta && explicito) {
            const ts = cadena(buf, tags[0x00020010]);
            // Solo esta transfer syntax usa VR implícito
            if (ts === '1.2.840.10008.1.2') explicito = false;
            finMeta = null;
        }
    }
    return { buf, tags };
}

const cadena = (buf, t) => t ? buf.toString('latin1', t.ini, t.ini + t.lon).replace(/\0+$/, '').trim() : null;
const numero = (buf, t) => { const s = cadena(buf, t); const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const u16    = (buf, t) => t && t.lon >= 2 ? buf.readUInt16LE(t.ini) : null;

/* Transfer syntaxes: lo decisivo es si hay pérdida. */
const SINTAXIS = {
    '1.2.840.10008.1.2':        ['Implicit VR Little Endian',     'sin comprimir'],
    '1.2.840.10008.1.2.1':      ['Explicit VR Little Endian',     'sin comprimir'],
    '1.2.840.10008.1.2.2':      ['Explicit VR Big Endian',        'sin comprimir'],
    '1.2.840.10008.1.2.1.99':   ['Deflated Explicit VR LE',       'sin pérdida'],
    '1.2.840.10008.1.2.5':      ['RLE Lossless',                  'sin pérdida'],
    '1.2.840.10008.1.2.4.50':   ['JPEG Baseline',                 'CON PÉRDIDA'],
    '1.2.840.10008.1.2.4.51':   ['JPEG Extended',                 'CON PÉRDIDA'],
    '1.2.840.10008.1.2.4.57':   ['JPEG Lossless (proceso 14)',    'sin pérdida'],
    '1.2.840.10008.1.2.4.70':   ['JPEG Lossless (first-order)',   'sin pérdida'],
    '1.2.840.10008.1.2.4.80':   ['JPEG-LS Lossless',              'sin pérdida'],
    '1.2.840.10008.1.2.4.81':   ['JPEG-LS Near-lossless',         'CON PÉRDIDA'],
    '1.2.840.10008.1.2.4.90':   ['JPEG 2000 Lossless',            'sin pérdida'],
    '1.2.840.10008.1.2.4.91':   ['JPEG 2000',                     'CON PÉRDIDA'],
};

/** Mide el ruido en parches homogéneos de tejido, no en el aire. */
function ruidoTejido(buf, t, rows, cols, slope, intercept, pixelRep) {
    const px = t[0x7FE00010];
    if (!px || px.lon < rows * cols * 2) return null;

    const leer = (i) => {
        const o = px.ini + i * 2;
        const v = pixelRep === 1 ? buf.readInt16LE(o) : buf.readUInt16LE(o);
        return v * slope + intercept;
    };

    // Parches de 9x9 repartidos por el centro de la imagen. Se queda con
    // los que caen en tejido blando (0–60 UH) y son homogéneos: la SD de
    // ESOS es el ruido del equipo, no la variación anatómica.
    const sds = [];
    const L = 9;
    for (let cy = Math.floor(rows * 0.30); cy < rows * 0.70; cy += 11) {
        for (let cx = Math.floor(cols * 0.30); cx < cols * 0.70; cx += 11) {
            const v = [];
            for (let y = cy; y < cy + L && y < rows; y++) {
                for (let x = cx; x < cx + L && x < cols; x++) v.push(leer(y * cols + x));
            }
            if (v.length < L * L) continue;
            const m = v.reduce((a, b) => a + b, 0) / v.length;
            if (m < 20 || m > 50) continue;                 // fuera de tejido blando
            const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
            if (sd > 40) continue;                          // hay un borde dentro
            sds.push(sd);
        }
    }
    if (sds.length < 3) return null;
    sds.sort((a, b) => a - b);
    return { mediana: sds[Math.floor(sds.length / 2)], parches: sds.length };
}

/* ── Recorrido ─────────────────────────────────────────────── */

function buscarDcm(dir, tope = 400, acc = []) {
    if (acc.length >= tope) return acc;
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entradas) {
        if (acc.length >= tope) break;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) buscarDcm(p, tope, acc);
        else if (/\.dcm$/i.test(e.name)) acc.push(p);
    }
    return acc;
}

function analizar(raiz) {
    const archivos = buscarDcm(raiz);
    if (!archivos.length) {
        console.error(`No se encontró ningún .dcm en ${raiz}`);
        process.exit(1);
    }
    console.log(`\n  ${archivos.length} archivos bajo ${raiz}\n`);

    const porSerie = new Map();
    let fallos = 0;

    for (const f of archivos) {
        let d;
        try { d = leerDicom(fs.readFileSync(f)); } catch { fallos++; continue; }
        const { buf, tags: t } = d;

        const clave = [
            cadena(buf, t[0x00080070]) || '?',          // fabricante
            cadena(buf, t[0x00081090]) || '?',          // modelo
            cadena(buf, t[0x00020010]) || '?',          // transfer syntax
            cadena(buf, t[0x00181210]) || '—',          // kernel
            numero(buf, t[0x00180050]) ?? '?',          // grosor
            numero(buf, t[0x00180060]) ?? '?',          // kVp
        ].join('|');

        if (!porSerie.has(clave)) porSerie.set(clave, { n: 0, ruidos: [], ejemplo: f, tags: t, buf });
        const g = porSerie.get(clave);
        g.n++;

        if (g.ruidos.length < 12) {
            const r = ruidoTejido(buf, t,
                u16(buf, t[0x00280010]) || 512, u16(buf, t[0x00280011]) || 512,
                numero(buf, t[0x00281053]) ?? 1, numero(buf, t[0x00281052]) ?? 0,
                u16(buf, t[0x00280103]) || 0);
            if (r) g.ruidos.push(r.mediana);
        }
    }

    if (fallos) console.log(`  (${fallos} archivos no se pudieron leer)\n`);

    for (const [clave, g] of porSerie) {
        const [fab, mod, ts, kernel, grosor, kvp] = clave.split('|');
        const [nombreTs, perdida] = SINTAXIS[ts] || ['desconocida', '???'];
        const { buf, tags: t } = g;

        console.log('  ' + '─'.repeat(66));
        console.log(`  ${fab}  ${mod}`);
        console.log(`  ${g.n} imágenes`);
        console.log('');
        console.log(`    Transfer syntax   ${nombreTs}`);
        console.log(`                      ${perdida}${perdida === 'CON PÉRDIDA'
            ? '  ← las UH NO son fiables para medir' : ''}`);
        console.log(`    Kernel            ${kernel}`);
        console.log(`    Grosor de corte   ${grosor} mm`);
        console.log(`    kVp               ${kvp}`);
        const spStr = cadena(buf, t[0x00280030]);
        const pxSp = spStr ? spStr.split('\\').map(parseFloat).filter(Number.isFinite) : null;
        console.log(`    Matriz            ${u16(buf, t[0x00280010])} x ${u16(buf, t[0x00280011])}`);
        console.log(`    PixelSpacing      ${pxSp ? pxSp.map(v => v.toFixed(4)).join(' x ') + ' mm' : 'AUSENTE'}`);
        console.log(`    Rescale           pendiente ${numero(buf, t[0x00281053]) ?? 'AUSENTE'}` +
                    `, intercepto ${numero(buf, t[0x00281052]) ?? 'AUSENTE'}`);
        console.log(`    Bits              ${u16(buf, t[0x00280100])} asignados, ` +
                    `representación ${u16(buf, t[0x00280103]) === 1 ? 'con signo' : 'sin signo'}`);
        const pad = t[0x00280120];
        console.log(`    PixelPadding      ${pad ? buf.readInt16LE(pad.ini) : 'no declarado'}`);

        if (g.ruidos.length) {
            const med = g.ruidos.sort((a, b) => a - b)[Math.floor(g.ruidos.length / 2)];
            console.log('');
            console.log(`    RUIDO             ${med.toFixed(1)} UH de desviación típica`);
            console.log(`                      (mediana de ${g.ruidos.length} cortes, en tejido blando)`);
            console.log('');
            // Cuántos píxeles necesita cada ROI para que una diferencia de
            // medias no sea ruido. Comparación de dos medias independientes
            // (lesión contra su espejo), error tipo I del 5 % y potencia del
            // 80 %:  n = 2·(1,96 + 0,84)²·(SD/dif)²  por ROI.
            //
            // Es una COTA INFERIOR optimista: el ruido de un TC está
            // correlacionado entre píxeles vecinos, así que los píxeles de
            // una ROI no son observaciones independientes y hacen falta más
            // de los que dice la fórmula.
            const areaPx = (pxSp && pxSp[0]) ? pxSp[0] * (pxSp[1] || pxSp[0]) : null;
            const paraDetectar = (dif) => Math.ceil(15.7 * (med / dif) ** 2);
            console.log(`    Para distinguir una diferencia del ruido, cada ROI`);
            console.log(`    necesita al menos (cota optimista):`);
            for (const dif of [3, 5, 10]) {
                const n = paraDetectar(dif);
                const mm = areaPx ? `  ≈ ${(n * areaPx).toFixed(0)} mm²` : '';
                console.log(`        ${String(dif).padStart(2)} UH  →  ${String(n).padStart(5)} px${mm}`);
            }
        } else {
            console.log('');
            console.log('    RUIDO             no se pudo medir');
            console.log('                      (sin parches homogéneos de tejido blando:');
            console.log('                       puede que las imágenes estén comprimidas)');
        }
        console.log('');
    }

    console.log('  ' + '─'.repeat(66));
    console.log('');
    console.log('  Qué mirar:');
    console.log('   · «CON PÉRDIDA» invalida cualquier medición de UH. Hay que pedir');
    console.log('     al PACS que entregue sin comprimir.');
    console.log('   · Si aparece más de un bloque, los estudios NO son comparables');
    console.log('     entre sí: kernel o grosor distintos cambian la media de una ROI');
    console.log('     en varias UH. Para una serie de casos, todos deben coincidir.');
    console.log('   · Un ruido alto no impide medir, pero obliga a ROI más grandes.');
    console.log('');
}

const destino = process.argv[2];
if (!destino) {
    console.error('Uso: node scripts/analizar-equipo.js "<carpeta con .dcm>"');
    process.exit(1);
}
analizar(destino);
