'use strict';

/* ============================================================
   Wrapper sobre dicom-parser. Extrae todo lo necesario
   de un ArrayBuffer DICOM y devuelve un objeto DicomFrame
   normalizado.
   ============================================================ */

const DicomBridge = {

    /**
     * Parsea un ArrayBuffer DICOM y devuelve DicomFrame.
     * @param {ArrayBuffer} buffer
     * @param {string} filename
     * @returns {object} DicomFrame
     */
    parse(buffer, filename) {
        let dataSet;
        try {
            dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
        } catch (e) {
            throw new Error(`DicomParse error [${filename}]: ${e.message}`);
        }

        const s   = (tag)  => this._str(dataSet, tag);
        const f   = (tag)  => this._float(dataSet, tag);
        const i   = (tag)  => this._int(dataSet, tag);
        const u16 = (tag)  => dataSet.uint16(tag);
        const ds  = (tag)  => this._parseDS(s(tag));

        // PixelSpacing necesita lectura robusta: intentar string(), floatString y ds()
        const parsePixelSpacing = () => {
            // Método 1: string con separador backslash DICOM estándar
            const str = s('x00280030');
            if (str) {
                const p = this._parseDS(str);
                if (p && p.length >= 2 && p[0] > 0.01) return p;
            }
            // Método 2: leer como floatString (dicom-parser accede al valor nativo)
            try {
                const row = dataSet.floatString('x00280030', 0);
                const col = dataSet.floatString('x00280030', 1);
                if (row > 0.01 && col > 0.01) return [row, col];
                if (row > 0.01) return [row, row];  // asumir isotropía si solo hay 1 valor
            } catch {}
            // Método 3: ImagerPixelSpacing (algunos equipos lo usan en vez del anterior)
            const str2 = s('x00181164');
            if (str2) {
                const p2 = this._parseDS(str2);
                if (p2 && p2.length >= 2 && p2[0] > 0.01) return p2;
            }
            return null;
        };

        const rows = u16('x00280010') || 512;
        const cols = u16('x00280011') || 512;
        const bitsAlloc    = u16('x00280100') || 16;
        const pixelRep     = u16('x00280103') || 0; // 0=unsigned, 1=signed
        const slope        = f('x00281053') ?? 1;
        // RescaleIntercept ausente → 0, como manda DICOM (PS3.3 C.11.1.1.2).
        // Un default de -1024 restaría 1024 UH a todo estudio sin el tag.
        const rawIntercept = f('x00281052');
        const intercept    = rawIntercept ?? 0;
        const interceptMissing = rawIntercept == null;
        const slopeMissing     = f('x00281053') == null;
        if (interceptMissing) {
            console.warn('[DICOM] Falta RescaleIntercept (x00281052) —', filename,
                '— se asume 0. Verificá las UH antes de medir.');
        }
        const pixelSpacing = parsePixelSpacing() || [1, 1];
        if (pixelSpacing[0] === 1 && pixelSpacing[1] === 1) {
            console.warn('[DICOM] PixelSpacing no encontrado —', filename,
                '— MPR sagital/coronal puede aparecer distorsionado.');
        }
        const imgPos       = ds('x00200032') || [0, 0, 0];
        const imgOrient    = ds('x00200037');   // necesario para la normal del corte
        const sliceLoc     = f('x00201041') ?? (imgPos[2] || 0);
        const instanceNum  = i('x00200013') ?? 0;

        // PixelPaddingValue / RangeLimit: VR es US o SS según PixelRepresentation,
        // así que dataSet.string() no sirve — hay que leer el binario.
        const padding      = this._paddingValue(dataSet, 'x00280120', pixelRep);
        const paddingLimit = this._paddingValue(dataSet, 'x00280121', pixelRep);

        // Window sugerida por el archivo
        const wc = f('x00281050') ?? 40;
        const ww = f('x00281051') ?? 80;

        // Extraer pixel data
        const pixelData = this._extractPixelData(dataSet, rows, cols, bitsAlloc, pixelRep);

        // Todos los tags para el panel de metadata
        const allTags = this._extractAllTags(dataSet);

        return {
            filename,
            sopInstanceUID:   s('x00080018') || filename,
            modality:         s('x00080060') || 'CT',
            studyDate:        s('x00080020') || '',
            studyDesc:        s('x00081030') || '',
            seriesDesc:       s('x0008103e') || '',
            patientName:      s('x00100010') || 'Anónimo',
            patientID:        s('x00100020') || '',
            patientDOB:       s('x00100030') || '',
            patientSex:       s('x00100040') || '',
            institutionName:  s('x00080080') || '',
            rows,
            cols,
            bitsAllocated:    bitsAlloc,
            pixelRepresentation: pixelRep,
            rescaleSlope:     slope,
            rescaleIntercept: intercept,
            rescaleSlopeMissing:     slopeMissing,
            rescaleInterceptMissing: interceptMissing,
            pixelSpacing,           // [rowSpacing, colSpacing] mm/px
            imagePosition:    imgPos,
            imageOrientation: imgOrient,   // [rowX,rowY,rowZ, colX,colY,colZ] o null
            sliceLocation:    sliceLoc,
            sliceThickness:   f('x00180050') ?? 1,
            instanceNumber:   instanceNum,
            windowCenter:     wc,
            windowWidth:      ww,
            pixelData,              // Int16Array (siempre signed Int16)
            allTags,

            /* ── Píxeles fuera del FOV (padding) ── */
            pixelPaddingValue:      padding,
            pixelPaddingRangeLimit: paddingLimit,

            /* ── Identificadores y metadatos técnicos (trazabilidad) ── */
            studyInstanceUID:  s('x0020000d') || '',
            seriesInstanceUID: s('x0020000e') || '',
            seriesNumber:      i('x00200011') ?? null,
            acquisitionTime:   s('x00080032') || '',
            acquisitionDate:   s('x00080022') || '',
            studyTime:         s('x00080030') || '',
            manufacturer:      s('x00080070') || '',
            manufacturerModel: s('x00081090') || '',
            kvp:               f('x00180060') ?? null,
            tubeCurrent:       f('x00181151') ?? null,
            exposure:          f('x00181152') ?? null,
            convolutionKernel: s('x00181210') || '',
            protocolName:      s('x00181030') || '',
            bodyPart:          s('x00180015') || '',
            spacingBetweenSlices: f('x00180088') ?? null,
        };
    },

    /* ── Extraer pixel data como Int16Array ─────────── */
    _extractPixelData(dataSet, rows, cols, bitsAlloc, pixelRep) {
        const el = dataSet.elements['x7fe00010'];
        if (!el) throw new Error('Sin pixel data');

        const totalPixels = rows * cols;
        const byteOffset  = el.dataOffset;
        const byteCount   = el.length;

        const raw = dataSet.byteArray.buffer.slice(byteOffset, byteOffset + byteCount);

        if (bitsAlloc === 16) {
            if (pixelRep === 1) {
                // Signed Int16 — lo que queremos
                return new Int16Array(raw);
            } else {
                // Unsigned Uint16 — convertir a Int16 para HU
                const u = new Uint16Array(raw);
                const s = new Int16Array(totalPixels);
                for (let k = 0; k < totalPixels; k++) s[k] = u[k];
                return s;
            }
        } else if (bitsAlloc === 8) {
            const u = new Uint8Array(raw);
            const s = new Int16Array(totalPixels);
            for (let k = 0; k < totalPixels; k++) s[k] = u[k];
            return s;
        }
        throw new Error(`Bits allocated no soportado: ${bitsAlloc}`);
    },

    /* ── Helpers ─────────────────────────────────────── */
    _str(ds, tag) {
        try { return (ds.string(tag) || '').trim() || null; } catch { return null; }
    },
    _float(ds, tag) {
        try {
            const v = ds.floatString(tag);
            return (v !== undefined && v !== null && !isNaN(v)) ? v : null;
        } catch { return null; }
    },
    _int(ds, tag) {
        try {
            const v = ds.intString(tag);
            return (v !== undefined && v !== null) ? v : null;
        } catch { return null; }
    },
    _parseDS(str) {
        if (!str) return null;
        const parts = str.split('\\').map(Number).filter(v => !isNaN(v));
        return parts.length ? parts : null;
    },

    /* ── PixelPaddingValue / RangeLimit (US o SS según PixelRepresentation) ── */
    // Devuelve el valor ALMACENADO, que es contra lo que hay que comparar
    // el píxel (PS3.3 C.7.5.1.1.2). null si el tag no está.
    _paddingValue(ds, tag, pixelRep) {
        const el = ds.elements[tag];
        if (!el || !el.length) return null;
        try {
            // Con pixelRep=1 (signed) el VR es SS; con 0 (unsigned) es US.
            // Aun así algunos equipos escriben SS con pixelRep=0; si el valor
            // unsigned cae en el rango alto, interpretarlo como signed da el
            // valor correcto para el Int16Array que usamos internamente.
            if (pixelRep === 1) return ds.int16(tag);
            const u = ds.uint16(tag);
            return (u > 32767) ? (u - 65536) : u;
        } catch { return null; }
    },

    /* ── Header-only parse (sin pixel data) ────────── */
    parseHeaderOnly(buffer) {
        try {
            const slice    = buffer.byteLength > 131072 ? buffer.slice(0, 131072) : buffer;
            const byteArray = new Uint8Array(slice);
            const dataSet  = dicomParser.parseDicom(byteArray, { stopTag: 'x7fe00010' });
            const s = (tag) => { try { return (dataSet.string(tag) || '').trim() || null; } catch { return null; } };
            return {
                patientName: s('x00100010') || '',
                studyDate:   s('x00080020') || '',
                studyDesc:   s('x00081030') || '',
                seriesDesc:  s('x0008103e') || '',
                bodyPart:    s('x00180015') || '',
                modality:    s('x00080060') || '',
            };
        } catch { return null; }
    },

    /* ── Extraer todos los tags para metadata panel ─── */
    _extractAllTags(dataSet) {
        const result = {};
        try {
            for (const tag in dataSet.elements) {
                const el = dataSet.elements[tag];
                if (el.items || el.fragments) continue; // skip sequences
                try {
                    const val = dataSet.string(tag);
                    if (val !== undefined) result[tag] = val.trim();
                } catch { /* skip unreadable tags */ }
            }
        } catch { /* best-effort */ }
        return result;
    },
};
