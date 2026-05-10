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

        const rows = u16('x00280010') || 512;
        const cols = u16('x00280011') || 512;
        const bitsAlloc    = u16('x00280100') || 16;
        const pixelRep     = u16('x00280103') || 0; // 0=unsigned, 1=signed
        const slope        = f('x00281053') ?? 1;
        const intercept    = f('x00281052') ?? -1024;
        const pixelSpacing = ds('x00280030') || ds('x00181164') || [1, 1];
        const imgPos       = ds('x00200032') || [0, 0, 0];
        const sliceLoc     = f('x00201041') ?? (imgPos[2] || 0);
        const instanceNum  = i('x00200013') ?? 0;

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
            pixelSpacing,           // [rowSpacing, colSpacing] mm/px
            imagePosition:    imgPos,
            sliceLocation:    sliceLoc,
            sliceThickness:   f('x00180050') ?? 1,
            instanceNumber:   instanceNum,
            windowCenter:     wc,
            windowWidth:      ww,
            pixelData,              // Int16Array (siempre signed Int16)
            allTags,
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
