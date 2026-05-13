'use strict';

const Storage = {
    DB_NAME: 'TACViewerDB',
    DB_VERSION: 2,
    _db: null,

    /* ── IndexedDB init ────────────────────────────────── */
    async initDB() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('measurements')) {
                    db.createObjectStore('measurements', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('sessions')) {
                    db.createObjectStore('sessions', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('library')) {
                    db.createObjectStore('library', { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
            req.onerror   = () => reject(req.error);
        });
    },

    _tx(store, mode = 'readonly') {
        return this._db.transaction(store, mode).objectStore(store);
    },

    /* ── Measurements ──────────────────────────────────── */
    async saveMeasurements(sessionId, data) {
        await this.initDB();
        return new Promise((resolve, reject) => {
            const s = this._tx('measurements', 'readwrite');
            const req = s.put({ id: sessionId, data, updatedAt: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    },

    async loadMeasurements(sessionId) {
        await this.initDB();
        return new Promise((resolve) => {
            const req = this._tx('measurements').get(sessionId);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror   = () => resolve(null);
        });
    },

    /* ── Session state ─────────────────────────────────── */
    async saveSession(state) {
        await this.initDB();
        return new Promise((resolve) => {
            const s = this._tx('sessions', 'readwrite');
            s.put({ id: 'current', ...state, savedAt: Date.now() });
            resolve();
        });
    },

    async loadSession() {
        await this.initDB();
        return new Promise((resolve) => {
            const req = this._tx('sessions').get('current');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror   = () => resolve(null);
        });
    },

    /* ── LocalStorage settings ─────────────────────────── */
    KEYS: {
        SETTINGS: 'tacv_settings',
    },

    _defaultSettings() {
        return {
            activePreset: DEFAULT_PRESET,
            activeColorMap: 'grayscale',
            activeLayout: '1x1',
            cineFps: 8,
            metaPanelOpen: true,
        };
    },

    getSettings() {
        try {
            const raw = localStorage.getItem(this.KEYS.SETTINGS);
            return raw ? { ...this._defaultSettings(), ...JSON.parse(raw) } : this._defaultSettings();
        } catch { return this._defaultSettings(); }
    },

    setSetting(key, value) {
        const s = this.getSettings();
        s[key] = value;
        localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(s));
    },

    getSetting(key) {
        return this.getSettings()[key];
    },

    /* ── Case library ─────────────────────────────────── */
    async saveLibraryIndex(cases) {
        await this.initDB();
        return new Promise((resolve) => {
            const req = this._tx('library', 'readwrite').put({ id: 'index', cases, savedAt: Date.now() });
            req.onsuccess = () => resolve();
            req.onerror   = () => resolve();
        });
    },

    async loadLibraryIndex() {
        await this.initDB();
        return new Promise((resolve) => {
            const req = this._tx('library').get('index');
            req.onsuccess = () => resolve(req.result?.cases || null);
            req.onerror   = () => resolve(null);
        });
    },

    async saveRootHandle(handle) {
        await this.initDB();
        return new Promise((resolve) => {
            try {
                const req = this._tx('library', 'readwrite').put({ id: 'rootHandle', handle });
                req.onsuccess = () => resolve();
                req.onerror   = () => resolve();
            } catch { resolve(); }
        });
    },

    async loadRootHandle() {
        await this.initDB();
        return new Promise((resolve) => {
            try {
                const req = this._tx('library').get('rootHandle');
                req.onsuccess = () => resolve(req.result?.handle || null);
                req.onerror   = () => resolve(null);
            } catch { resolve(null); }
        });
    },

    /* ── Custom events ─────────────────────────────────── */
    dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(`tacv:${name}`, { detail }));
    },

    on(name, fn) {
        window.addEventListener(`tacv:${name}`, (e) => fn(e.detail));
    },
};
