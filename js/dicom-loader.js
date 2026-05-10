'use strict';

/* ============================================================
   DicomLoader — FileAPI + Worker pool para cargar series DICOM
   sin bloquear el UI thread.
   ============================================================ */

const DicomLoader = {
    WORKER_COUNT: 4,
    _workers: [],
    _pending: new Map(),  // id → { resolve, reject }
    _idCounter: 0,
    _onProgress: null,
    _onFrameLoaded: null,

    /* ── Inicializar pool de workers ─────────────────── */
    init() {
        for (let i = 0; i < this.WORKER_COUNT; i++) {
            const w = new Worker('js/dicom.worker.js');
            w.onmessage = (e) => this._onWorkerMessage(e);
            w.onerror   = (e) => console.error('Worker error:', e);
            this._workers.push({ worker: w, busy: false });
        }
    },

    /* ── Cargar lista de Files ──────────────────────── */
    async loadFiles(files, { onProgress, onFrameLoaded } = {}) {
        this._onProgress    = onProgress;
        this._onFrameLoaded = onFrameLoaded;

        // Filtrar solo .dcm o sin extensión (DICOM no siempre tiene extensión)
        const dcmFiles = Array.from(files).filter(f =>
            f.name.toLowerCase().endsWith('.dcm') ||
            f.name.toLowerCase().endsWith('.dicom') ||
            !f.name.includes('.')
        );

        if (!dcmFiles.length) {
            UI.showToast('No se encontraron archivos DICOM (.dcm)', 'warning');
            return [];
        }

        let loaded = 0;
        const total = dcmFiles.length;
        const frames = new Array(total).fill(null);

        return new Promise((resolve) => {
            const checkDone = () => {
                if (loaded === total) {
                    const valid = frames.filter(Boolean);
                    // Ordenar por instanceNumber
                    valid.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
                    resolve(valid);
                }
            };

            dcmFiles.forEach((file, idx) => {
                this._readFile(file).then(buffer => {
                    this._dispatchToWorker(buffer, file.name).then(frame => {
                        frames[idx] = frame;
                        loaded++;
                        onProgress && onProgress(loaded, total);
                        onFrameLoaded && onFrameLoaded(frame, loaded - 1);
                        checkDone();
                    }).catch(err => {
                        console.warn(`Error en ${file.name}:`, err);
                        loaded++;
                        onProgress && onProgress(loaded, total);
                        checkDone();
                    });
                });
            });
        });
    },

    /* ── Leer File → ArrayBuffer ─────────────────────── */
    _readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error(`Error leyendo ${file.name}`));
            reader.readAsArrayBuffer(file);
        });
    },

    /* ── Enviar a un worker disponible ───────────────── */
    _dispatchToWorker(buffer, filename) {
        return new Promise((resolve, reject) => {
            const id = this._idCounter++;
            this._pending.set(id, { resolve, reject });
            const slot = this._getFreeWorker();
            slot.busy = true;
            slot.worker.postMessage({ id, buffer, filename }, [buffer]);
        });
    },

    /* ── Respuesta del worker ────────────────────────── */
    _onWorkerMessage(e) {
        const { id, frame, error } = e.data;
        const cb = this._pending.get(id);
        this._pending.delete(id);
        // Marcar worker libre
        const slot = this._workers.find(w => w.busy);
        if (slot) slot.busy = false;

        if (error) {
            cb?.reject(new Error(error));
        } else {
            cb?.resolve(frame);
        }
    },

    _getFreeWorker() {
        // Round-robin simple
        const free = this._workers.find(w => !w.busy);
        if (free) return free;
        // Si todos están ocupados, usar el primero (la promesa esperará)
        return this._workers[this._idCounter % this.WORKER_COUNT];
    },

    /* ── Setup drag-drop global ──────────────────────── */
    setupDragDrop(onFiles) {
        const zone = document.getElementById('dropZone');

        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.remove('hidden');
        });
        document.addEventListener('dragleave', (e) => {
            if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
                zone.classList.add('hidden');
            }
        });
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.add('hidden');
            const files = this._extractFilesFromDrop(e.dataTransfer);
            if (files.length) onFiles(files);
        });

        // File input click
        document.getElementById('fileInput').addEventListener('change', (e) => {
            if (e.target.files.length) {
                onFiles(e.target.files);
                e.target.value = '';
            }
        });

        // Botones de apertura
        ['btnOpenFiles', 'btnWelcomeOpen'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', () =>
                document.getElementById('fileInput').click()
            );
        });
    },

    /* ── Extraer archivos de DataTransfer (incluyendo carpetas) ── */
    _extractFilesFromDrop(dataTransfer) {
        const files = [];
        if (dataTransfer.items) {
            for (const item of dataTransfer.items) {
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry?.();
                    if (entry && entry.isDirectory) {
                        // carpeta → leer recursivo (se maneja via FileList directo)
                    }
                    const f = item.getAsFile();
                    if (f) files.push(f);
                }
            }
        } else {
            for (const f of dataTransfer.files) files.push(f);
        }
        return files;
    },
};
