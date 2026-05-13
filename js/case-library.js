'use strict';

/* ============================================================
   CaseLibrary — Biblioteca de estudios DICOM
   Estrategia dual:
     Desktop Chrome/Edge: showDirectoryPicker() → FSA lazy traversal
     Mobile/Firefox/Safari: <input webkitdirectory> → FileList agrupada
   Indexación: solo el header del primer archivo por serie principal
   (sin pixel data, stopTag x7fe00010 + slice 128KB max)
   ============================================================ */

const CaseLibrary = (() => {

    let _index         = [];   // [{folderName, patientName, studyDate, studyDateFmt, seriesDesc, sliceCount, _handle?}]
    let _rootDir       = null; // FileSystemDirectoryHandle con permiso confirmado esta sesión
    let _storedHandle  = null; // Handle restaurado de IDB, permiso pendiente de confirmar
    let _sesFiles      = null; // Map<folderName, File[]> (webkitdirectory, session only)

    // Cache LRU de frames ya parseados — evita re-leer disco y re-parsear DICOM
    const CACHE_MAX  = 5;
    const _frameCache = new Map();  // folderName → DicomFrame[] (insertion order = LRU)

    function _cacheGet(key) {
        if (!_frameCache.has(key)) return null;
        const v = _frameCache.get(key);          // promover a MRU: re-insertar al final
        _frameCache.delete(key); _frameCache.set(key, v);
        return v;
    }
    function _cacheSet(key, frames) {
        _frameCache.delete(key);                 // re-insertar al final si ya existe
        if (_frameCache.size >= CACHE_MAX) {     // evictar el más antiguo (first entry)
            _frameCache.delete(_frameCache.keys().next().value);
        }
        _frameCache.set(key, frames);
    }

    /* ── Init ─────────────────────────────────────────── */
    function init() {
        const modal = document.getElementById('caseLibraryModal');
        modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });

        document.getElementById('clClose')?.addEventListener('click', close);
        document.getElementById('clSearch')?.addEventListener('input', (e) =>
            _renderList(e.target.value));
        document.getElementById('btnClOpenFolder')?.addEventListener('click', _openFolder);
        document.getElementById('btnClRefresh')?.addEventListener('click', _refresh);

        document.getElementById('clDirInput')?.addEventListener('change', (e) => {
            if (e.target.files?.length) _indexFromFileList(e.target.files);
        });

        Storage.loadLibraryIndex().then(cached => {
            if (cached?.length) { _index = cached; _renderList(''); }
        });

        // Restaurar handle de sesión anterior — si ya tiene permiso, listo; si no, se pide al cargar
        Storage.loadRootHandle().then(async (handle) => {
            if (!handle) return;
            try {
                const perm = await handle.queryPermission({ mode: 'read' });
                if (perm === 'granted') _rootDir = handle;
                else                    _storedHandle = handle;
            } catch { _storedHandle = handle; }
        });
    }

    /* ── Open / Close / Toggle ────────────────────────── */
    function open() {
        document.getElementById('caseLibraryModal')?.classList.remove('hidden');
        setTimeout(() => document.getElementById('clSearch')?.focus(), 80);
    }

    function close() {
        document.getElementById('caseLibraryModal')?.classList.add('hidden');
    }

    function toggle() {
        document.getElementById('caseLibraryModal')?.classList.contains('hidden')
            ? open() : close();
    }

    /* ── Abrir carpeta ────────────────────────────────── */
    async function _openFolder() {
        if (window.showDirectoryPicker) {
            try {
                const handle = await window.showDirectoryPicker({ mode: 'read' });
                _rootDir = handle;
                Storage.saveRootHandle(handle);
                await _indexFromDirHandle(handle);
            } catch (e) {
                if (e.name !== 'AbortError') UI.showToast('Error al abrir la carpeta', 'error');
            }
        } else {
            document.getElementById('clDirInput')?.click();
        }
    }

    /* ── Reindexar (reusar handle guardado si es posible) */
    async function _refresh() {
        if (_rootDir) { await _indexFromDirHandle(_rootDir); return; }

        const candidate = _storedHandle || await Storage.loadRootHandle();
        if (candidate) {
            try {
                let perm = await candidate.queryPermission({ mode: 'read' });
                if (perm !== 'granted') perm = await candidate.requestPermission({ mode: 'read' });
                if (perm === 'granted') {
                    _rootDir = candidate;
                    _storedHandle = null;
                    await _indexFromDirHandle(_rootDir);
                    return;
                }
            } catch {}
        }
        _openFolder();
    }

    /* ── Indexar via File System Access API ───────────── */
    async function _indexFromDirHandle(rootHandle) {
        let total = 0;
        for await (const [, h] of rootHandle.entries()) {
            if (h.kind === 'directory') total++;
        }

        const entries = [];
        let done = 0;
        _showProgress(0, total);

        for await (const [folderName, patientHandle] of rootHandle.entries()) {
            if (patientHandle.kind !== 'directory') continue;
            try {
                const entry = await _indexOnePatientFSA(folderName, patientHandle);
                if (entry) entries.push(entry);
            } catch {}
            _showProgress(++done, total);
        }

        _finalize(entries);
    }

    async function _indexOnePatientFSA(folderName, patientHandle) {
        // Nivel 2: Study UID (normalmente 1 carpeta)
        let studyHandle = null;
        for await (const [, h] of patientHandle.entries()) {
            if (h.kind === 'directory') { studyHandle = h; break; }
        }
        if (!studyHandle) return null;

        // Nivel 3: Series — la que tiene más archivos es la CT principal
        let mainHandle = null, maxCount = 0;
        for await (const [, sh] of studyHandle.entries()) {
            if (sh.kind !== 'directory') continue;
            let n = 0;
            for await (const _ of sh.entries()) n++;
            if (n > maxCount) { maxCount = n; mainHandle = sh; }
        }
        if (!mainHandle || maxCount < 2) return null;

        // Primer archivo de la serie principal → header only
        let firstFile = null;
        for await (const [, fh] of mainHandle.entries()) {
            if (fh.kind === 'file') { firstFile = await fh.getFile(); break; }
        }
        if (!firstFile) return null;

        const meta = DicomBridge.parseHeaderOnly(await firstFile.slice(0, 131072).arrayBuffer());
        return _makeEntry(folderName, meta, maxCount, mainHandle);
    }

    /* ── Indexar via webkitdirectory FileList ─────────── */
    async function _indexFromFileList(fileList) {
        _sesFiles = new Map();

        // Agrupar por paciente/serie según webkitRelativePath
        // Estructura esperada: root/patient/study/series/file.dcm (5 partes)
        const byPatient = new Map();
        for (const file of fileList) {
            const parts = (file.webkitRelativePath || file.name).split('/');
            if (parts.length < 5) continue;
            const patientKey = parts[1];
            const seriesKey  = parts.slice(1, 4).join('/');
            if (!byPatient.has(patientKey)) byPatient.set(patientKey, new Map());
            if (!byPatient.get(patientKey).has(seriesKey))
                byPatient.get(patientKey).set(seriesKey, []);
            byPatient.get(patientKey).get(seriesKey).push(file);
        }

        const total = byPatient.size;
        let done = 0;
        const entries = [];
        _showProgress(0, total);

        for (const [patientKey, seriesMap] of byPatient) {
            let mainFiles = null, maxCount = 0;
            for (const [, files] of seriesMap) {
                if (files.length > maxCount) { maxCount = files.length; mainFiles = files; }
            }
            if (mainFiles && maxCount >= 2) {
                _sesFiles.set(patientKey, mainFiles);
                const meta = DicomBridge.parseHeaderOnly(
                    await mainFiles[0].slice(0, 131072).arrayBuffer());
                entries.push(_makeEntry(patientKey, meta, maxCount, null));
            }
            _showProgress(++done, total);
        }

        _finalize(entries);
    }

    /* ── Cargar caso en el viewer ─────────────────────── */
    async function _loadCase(entry) {
        close();

        // ── Cache hit: 0 I/O, 0 parsing, activación instantánea ──
        const cached = _cacheGet(entry.folderName);
        if (cached) {
            activateFrames(cached);  // función global en app.js (no re-parsea)
            return;
        }

        // ── Cache miss: colectar File[] ───────────────────────────
        let files = null;

        if (entry._handle) {
            files = [];
            for await (const [, fh] of entry._handle.entries()) {
                if (fh.kind === 'file') files.push(await fh.getFile());
            }
        } else if (_sesFiles?.has(entry.folderName)) {
            files = _sesFiles.get(entry.folderName);
        } else if (_rootDir) {
            try { files = await _collectFromRoot(_rootDir, entry.folderName); } catch {}
        } else if (_storedHandle) {
            try {
                const perm = await _storedHandle.requestPermission({ mode: 'read' });
                if (perm === 'granted') {
                    _rootDir = _storedHandle;
                    _storedHandle = null;
                    files = await _collectFromRoot(_rootDir, entry.folderName);
                }
            } catch {}
        }

        if (!files?.length) {
            UI.showToast('Sin acceso a los archivos — usa el botón Reindexar (⟳)', 'warning');
            return;
        }

        // ── Parsear, cachear y activar ────────────────────────────
        document.getElementById('welcomeScreen')?.remove();
        UI.showLoadingBar();

        const allFrames = await DicomLoader.loadFiles(files, {
            onProgress:    (loaded, total) => UI.updateLoadingBar(loaded, total),
            onFrameLoaded: (frame, idx) => {
                if (idx === 0) { const vp = ViewportLayout.getActive(); if (vp) vp.loadFrame(frame, 0, 1); }
            },
        });

        UI.hideLoadingBar();

        if (allFrames?.length) _cacheSet(entry.folderName, allFrames);
        activateFrames(allFrames);
    }

    async function _collectFromRoot(rootHandle, folderName) {
        const patientHandle = await rootHandle.getDirectoryHandle(folderName);
        let studyHandle = null;
        for await (const [, h] of patientHandle.entries()) {
            if (h.kind === 'directory') { studyHandle = h; break; }
        }
        if (!studyHandle) return [];

        let mainHandle = null, maxCount = 0;
        for await (const [, sh] of studyHandle.entries()) {
            if (sh.kind !== 'directory') continue;
            let n = 0;
            for await (const _ of sh.entries()) n++;
            if (n > maxCount) { maxCount = n; mainHandle = sh; }
        }
        if (!mainHandle) return [];

        const files = [];
        for await (const [, fh] of mainHandle.entries()) {
            if (fh.kind === 'file') files.push(await fh.getFile());
        }
        return files;
    }

    /* ── Render ───────────────────────────────────────── */
    function _renderList(filter) {
        const body  = document.getElementById('clBody');
        const count = document.getElementById('clCount');
        if (!body) return;

        if (!_index.length) {
            body.innerHTML = '<div class="cl-empty">Abra una carpeta de casos para comenzar.</div>';
            if (count) count.textContent = '';
            return;
        }

        const q = (filter || '').trim().toLowerCase();
        const filtered = q
            ? _index.filter(e =>
                e.patientName.toLowerCase().includes(q) ||
                e.studyDateFmt.includes(q) ||
                e.studyDate.includes(q))
            : _index;

        if (count) {
            count.textContent = filtered.length === _index.length
                ? `${_index.length} estudios`
                : `${filtered.length} de ${_index.length}`;
        }

        if (!filtered.length) {
            body.innerHTML = `<div class="cl-empty">Sin resultados para "<strong>${_esc(filter)}</strong>"</div>`;
            return;
        }

        body.innerHTML = filtered.map(e => `
            <div class="cl-case">
                <div class="cl-case-info">
                    <div class="cl-case-name">${_esc(e.patientName)}</div>
                    <div class="cl-case-meta">${e.studyDateFmt || '—'}${e.seriesDesc ? ' · ' + _esc(e.seriesDesc) : ''} · ${e.sliceCount} sl</div>
                </div>
                <button class="cl-case-open">Abrir</button>
            </div>`).join('');

        body.querySelectorAll('.cl-case').forEach((row, i) => {
            const open = row.querySelector('.cl-case-open');
            open?.addEventListener('click', (e) => { e.stopPropagation(); _loadCase(filtered[i]); });
            row.addEventListener('dblclick', () => _loadCase(filtered[i]));
        });
    }

    /* ── Progress bar ─────────────────────────────────── */
    function _showProgress(done, total) {
        const body = document.getElementById('clBody');
        if (!body) return;
        const pct = total ? Math.round(done / total * 100) : 0;
        body.innerHTML = `
            <div class="cl-progress">
                <div class="cl-progress-msg">Indexando ${done} / ${total} casos...</div>
                <div class="cl-progress-bar">
                    <div class="cl-progress-fill" style="width:${pct}%"></div>
                </div>
            </div>`;
    }

    /* ── Helpers ──────────────────────────────────────── */
    function _makeEntry(folderName, meta, sliceCount, handle) {
        return {
            folderName,
            patientName:  _fmtName(meta?.patientName || folderName),
            studyDate:    meta?.studyDate || '',
            studyDateFmt: _fmtDate(meta?.studyDate || ''),
            seriesDesc:   meta?.seriesDesc || '',
            sliceCount,
            _handle: handle,  // FileSystemDirectoryHandle (in-memory solo, no serializable)
        };
    }

    function _finalize(entries) {
        _index = entries.sort((a, b) => b.studyDate.localeCompare(a.studyDate));
        // Persistir solo datos serializables (sin _handle)
        Storage.saveLibraryIndex(_index.map(({ _handle, ...rest }) => rest));
        _renderList(document.getElementById('clSearch')?.value || '');
    }

    function _fmtName(dicomPN) {
        if (!dicomPN) return 'Anónimo';
        return dicomPN.split('^')
            .map(s => s.trim()).filter(Boolean)
            .map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
            .join(' ');
    }

    function _fmtDate(d) {
        if (!d || d.length < 8) return '';
        return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
    }

    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    return Object.freeze({ init, open, close, toggle });
})();
