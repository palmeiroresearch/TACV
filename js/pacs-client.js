'use strict';

/* ============================================================
   PacsClient — habla con la pasarela DICOM local.

   El navegador NO puede hablar DICOM: DIMSE es TCP crudo y
   recibir un C-MOVE exige escuchar en un puerto. Así que todo
   esto pasa por la pasarela que corre en el proceso Node de la
   app de escritorio, en 127.0.0.1 y con un token de sesión.

   Consecuencia que conviene tener presente: en la versión WEB de
   TACV no hay pasarela detrás y nada de esto funciona. Por eso el
   botón va oculto de fábrica, y por eso `detectar()` distingue
   «no hay pasarela» de «hay pasarela y falla» — son dos
   situaciones distintas y el mensaje al usuario no puede ser el
   mismo.

   Los datos no salen del equipo: la pasarela escucha solo en el
   bucle local y escribe solo en el almacén de casos.
   ============================================================ */

const PacsClient = {

    _url: null,
    _token: null,
    _estado: 'sin-comprobar',   // 'sin-comprobar'|'ausente'|'lista'|'error'
    _ultimoError: null,
    _oyentes: new Set(),

    /* ── Dónde está la pasarela ────────────────────────────── */

    /**
     * El shell de escritorio inyecta `window.TACV_PASARELA = {url, token}`
     * antes de cargar el visor. En desarrollo se teclean a mano una vez y se
     * guardan, para poder abrir el visor suelto contra `npm run server`.
     */
    _cargarDestino() {
        const inyectado = (typeof window !== 'undefined' && window.TACV_PASARELA) || null;
        if (inyectado?.url && inyectado?.token) {
            this._url = String(inyectado.url).replace(/\/+$/, '');
            this._token = String(inyectado.token);
            this._fuenteDestino = 'shell';
            return true;
        }
        try {
            const g = JSON.parse(localStorage.getItem('pacs-pasarela') || 'null');
            if (g?.url && g?.token) {
                this._url = String(g.url).replace(/\/+$/, '');
                this._token = String(g.token);
                this._fuenteDestino = 'manual';
                return true;
            }
        } catch { /* localStorage bloqueado */ }
        this._url = null;
        this._token = null;
        this._fuenteDestino = null;
        return false;
    },

    /** Guarda url+token tecleados a mano (solo para desarrollo). */
    definirDestino(url, token) {
        const limpia = String(url || '').trim().replace(/\/+$/, '');
        const t = String(token || '').trim();
        if (!limpia || !t) throw new Error('Hacen falta la dirección y el token.');
        // Solo el bucle local: esta API no debe apuntarse a ninguna otra parte.
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(limpia)) {
            throw new Error(
                'La pasarela solo puede estar en 127.0.0.1 o localhost. Apuntar a ' +
                'otra máquina sacaría datos de pacientes del equipo.');
        }
        this._url = limpia;
        this._token = t;
        this._fuenteDestino = 'manual';
        try { localStorage.setItem('pacs-pasarela', JSON.stringify({ url: limpia, token: t })); }
        catch { /* sin persistir, vale para esta sesión */ }
    },

    olvidarDestino() {
        try { localStorage.removeItem('pacs-pasarela'); } catch {}
        this._url = this._token = this._fuenteDestino = null;
        this._estado = 'sin-comprobar';
    },

    tieneDestino() { return !!(this._url && this._token); },
    url() { return this._url; },
    fuenteDestino() { return this._fuenteDestino; },
    estado() { return this._estado; },
    ultimoError() { return this._ultimoError; },

    /* ── Eventos ───────────────────────────────────────────── */

    on(cb) { this._oyentes.add(cb); return () => this._oyentes.delete(cb); },
    _avisar() { this._oyentes.forEach(cb => { try { cb(this._estado); } catch {} }); },

    /* ── Transporte ────────────────────────────────────────── */

    async _pedir(metodo, ruta, cuerpo) {
        if (!this.tieneDestino() && !this._cargarDestino()) {
            throw Object.assign(new Error('No hay pasarela configurada.'),
                                { ausente: true });
        }
        let r;
        try {
            r = await fetch(this._url + ruta, {
                method: metodo,
                headers: {
                    'X-TACV-Token': this._token,
                    ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
            });
        } catch (e) {
            // fetch solo rechaza por red: la pasarela no está escuchando
            throw Object.assign(
                new Error(`No responde la pasarela en ${this._url}. ¿Está arrancada?`),
                { ausente: true, causa: e.message });
        }

        let datos = null;
        try { datos = await r.json(); } catch { /* puede no traer cuerpo */ }

        if (!r.ok) {
            const err = new Error(datos?.error || `La pasarela respondió ${r.status}.`);
            err.http = r.status;
            err.codigo = datos?.codigo || null;
            err.intentos = datos?.intentos || null;
            if (r.status === 401) {
                err.message = 'El token de sesión no es válido. Reiniciá la app.';
                err.tokenMalo = true;
            }
            throw err;
        }
        return datos;
    },

    /* ── Comprobación de disponibilidad ────────────────────── */

    /**
     * ¿Hay pasarela? Distingue tres resultados, y la diferencia importa:
     * 'ausente' es lo normal en la web y no es un fallo que reportar;
     * 'error' sí es algo que arreglar.
     */
    async detectar() {
        if (!this.tieneDestino() && !this._cargarDestino()) {
            this._estado = 'ausente';
            this._ultimoError = null;
            this._avisar();
            return this._estado;
        }
        try {
            this._salud = await this._pedir('GET', '/api/salud');
            this._estado = 'lista';
            this._ultimoError = null;
        } catch (e) {
            this._estado = e.ausente ? 'ausente' : 'error';
            this._ultimoError = e.message;
        }
        this._avisar();
        return this._estado;
    },

    salud() { return this._salud || null; },

    /* ── API ───────────────────────────────────────────────── */

    leerAjustes()            { return this._pedir('GET', '/api/ajustes'); },
    guardarAjustes(a)        { return this._pedir('PUT', '/api/ajustes', a); },
    importarClientConfig(ruta) {
        return this._pedir('POST', '/api/ajustes/importar', ruta ? { ruta } : {});
    },
    comprobarAlmacen()       { return this._pedir('GET', '/api/almacen'); },
    echo()                   { return this._pedir('POST', '/api/echo', {}); },
    buscarEstudios(criterios){ return this._pedir('POST', '/api/estudios', criterios); },
    buscarSeries(uid)        { return this._pedir('POST', '/api/series',
                                                  { studyInstanceUID: uid }); },
    descargar(peticion)      { return this._pedir('POST', '/api/descargas', peticion); },
    estadoDescarga(id)       { return this._pedir('GET', `/api/descargas/${id}`); },

    /**
     * Sondea una descarga hasta que termina. El progreso real lo manda el PACS
     * en las respuestas Pending del C-GET/C-MOVE, así que se sondea en vez de
     * calcular nada por nuestra cuenta.
     *
     * @param {string} id
     * @param {function} onProgreso  (estado) => void
     * @param {object} [opts]
     * @param {number} [opts.intervaloMs=500]
     * @param {number} [opts.maxMs=600000]  10 min: un estudio grande por una
     *        red de hospital puede tardar de verdad
     */
    async seguirDescarga(id, onProgreso, { intervaloMs = 500, maxMs = 600000 } = {}) {
        const t0 = Date.now();
        for (;;) {
            const d = await this.estadoDescarga(id);
            onProgreso?.(d);
            if (d.estado !== 'en-curso') return d;
            if (Date.now() - t0 > maxMs) {
                throw new Error(
                    'La descarga lleva demasiado tiempo sin terminar. Mirá si el ' +
                    'servidor sigue respondiendo; lo descargado hasta ahora no se ' +
                    'ha confirmado, así que la biblioteca no verá un caso a medias.');
            }
            await new Promise(r => setTimeout(r, intervaloMs));
        }
    },
};
