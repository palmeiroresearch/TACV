'use strict';

/* ============================================================
   PacsPanel — consultar el PACS y traerse los casos.

   Tres pantallas, en el orden en que hacen falta:

     · conexión   — ¿hay pasarela? ¿responde el servidor? ¿está
                    bien el almacén?
     · búsqueda   — por número de caso, nombre o fecha
     · descarga   — con el progreso que manda el propio PACS

   Dos cosas deliberadas:

   · NUNCA se consulta sin criterios. Una consulta vacía contra
     el PACS de un hospital pide el archivo entero y es la forma
     más rápida de que bloqueen el AE Title. La pasarela también
     lo rechaza; aquí se evita antes para no gastar el viaje.

   · Al terminar una descarga NO se abre el caso: se reindexa la
     biblioteca y se avisa. Abrirlo solo sería decidir por quien
     está delante, que puede estar a mitad de otra lectura.
   ============================================================ */

const PacsPanel = {
    _open: false,
    _vista: 'conexion',      // 'conexion' | 'busqueda' | 'ajustes'
    _estudios: null,
    _series: null,           // {uid, series[]} del estudio desplegado
    _descarga: null,         // estado de la descarga en curso
    _buscando: false,
    _ultimaBusqueda: null,
    // El resultado de cada comprobación vive en el estado, no en el DOM: el
    // panel se repinta entero en cada refresh() y lo escrito a mano se perdía.
    _echo: null,
    _almacen: null,
    _ajustes: null,
    _probando: false,

    init() {
        document.getElementById('btnPacsPanel')
            ?.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
        document.getElementById('ppClose')?.addEventListener('click', () => this.close());
        PacsClient.on(() => { if (this._open) this.refresh(); });
    },

    async open() {
        const panel = document.getElementById('pacsPanel');
        if (!panel) return;
        UI.anchorPanel(panel, ['btnPacsPanel']);
        panel.classList.remove('hidden');
        document.getElementById('btnPacsPanel')?.classList.add('active');
        this._open = true;
        this.refresh();

        // Comprobar en cada apertura: la pasarela puede haberse caído
        await PacsClient.detectar();
        if (PacsClient.estado() === 'lista' && this._vista === 'conexion') {
            this._vista = 'busqueda';
        }
        if (this._open) this.refresh();
    },

    close() {
        document.getElementById('pacsPanel')?.classList.add('hidden');
        document.getElementById('btnPacsPanel')?.classList.remove('active');
        this._open = false;
    },

    toggle() { this._open ? this.close() : this.open(); },

    _esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    /** Nombre DICOM (APELLIDO^NOMBRE) a algo legible, sin perder el original. */
    _nombre(pn) {
        const partes = String(pn || '').split('^').map(s => s.trim()).filter(Boolean);
        if (!partes.length) return '—';
        return partes.map(s => s.charAt(0) + s.slice(1).toLowerCase()).join(' ');
    },

    _fecha(d) {
        if (!d || d.length < 8) return '—';
        return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
    },

    /* ════════════════════════════════════════════════════════
       Pintado
       ════════════════════════════════════════════════════════ */

    refresh() {
        const body = document.getElementById('ppBody');
        if (!body) return;

        const est = PacsClient.estado();
        if (est !== 'lista' || this._vista === 'conexion') {
            body.innerHTML = this._htmlConexion(est);
            this._wireConexion();
            return;
        }
        if (this._vista === 'ajustes') {
            body.innerHTML = this._htmlAjustes();
            this._wireAjustes();
            return;
        }
        body.innerHTML = this._htmlBusqueda();
        this._wireBusqueda();
    },

    /* ── Conexión ──────────────────────────────────────────── */

    _htmlConexion(estado) {
        if (estado === 'ausente') {
            const manual = PacsClient.fuenteDestino() === 'manual';
            return `
              <div class="pp-section">
                <div class="pp-estado ausente">
                  <strong>No hay pasarela DICOM</strong>
                  <p>El navegador no puede hablar DICOM: el protocolo DIMSE es TCP
                     a pelo y recibir imágenes exige escuchar en un puerto. Hace falta
                     la versión de escritorio de TACV, que lleva la pasarela dentro.</p>
                  ${manual ? `<p class="pp-nota">Configurada a mano en
                     ${this._esc(PacsClient.url() || '')}, pero no responde.
                     ¿Está arrancada?</p>` : ''}
                </div>
                <details class="pp-det">
                  <summary>Conectar a una pasarela a mano (desarrollo)</summary>
                  <p class="pp-hint">Con <code>npm run server</code> en TACV-Desktop:
                     la dirección y el token se imprimen al arrancar.</p>
                  <label class="pp-campo"><span>Dirección</span>
                    <input id="ppUrl" type="text" placeholder="http://127.0.0.1:40041"
                           value="${this._esc(PacsClient.url() || '')}"></label>
                  <label class="pp-campo"><span>Token</span>
                    <input id="ppToken" type="password" placeholder="token de sesión"></label>
                  <div class="pp-acciones">
                    <button class="pp-btn primary" id="ppConectar">Conectar</button>
                    ${manual ? `<button class="pp-btn" id="ppOlvidar">Olvidar</button>` : ''}
                  </div>
                </details>
              </div>`;
        }

        if (estado === 'error') {
            return `
              <div class="pp-section">
                <div class="pp-estado error">
                  <strong>La pasarela respondió con un error</strong>
                  <p>${this._esc(PacsClient.ultimoError() || '')}</p>
                </div>
                <div class="pp-acciones">
                  <button class="pp-btn primary" id="ppReintentar">Reintentar</button>
                </div>
              </div>`;
        }

        // 'lista' o 'sin-comprobar': comprobaciones previas
        const s = PacsClient.salud();
        const a = this._ajustes;
        const alm = this._almacen;
        return `
          <div class="pp-section">
            <div class="pp-estado lista">
              <strong>Pasarela lista</strong>
              <p>${this._esc(PacsClient.url() || '')} · solo bucle local${
                  s?.version ? ' · v' + this._esc(s.version) : ''}</p>
            </div>

            <div class="pp-check ${this._echo && !this._echo.ok ? 'mal' : ''}" id="ppCheckServidor">
              <span>Servidor DICOM${a ? ` · ${this._esc(a.calledAeTitle)} en ${
                  this._esc(a.host)}:${a.port}` : ''}</span>
              <strong class="${this._echo ? (this._echo.ok ? 'bien' : 'mal') : 'pendiente'}">${
                  this._echo
                      ? (this._echo.ok ? `responde (${this._echo.ms} ms)` : 'no responde')
                      : (this._probando ? 'comprobando…' : 'sin comprobar')}</strong>
            </div>
            <div class="pp-check ${alm ? (alm.ok ? 'ok' : 'mal') : ''}" id="ppCheckAlmacen">
              <span>Almacén de casos${a ? ' · ' + this._esc(a.raizAlmacen) : ''}</span>
              <strong class="${alm ? (alm.ok ? 'bien' : 'mal') : 'pendiente'}">${
                  alm ? (alm.ok ? 'correcto' : this._esc(alm.error)) : 'sin comprobar'}</strong>
            </div>

            ${this._echo && !this._echo.ok
                ? `<div class="pp-aviso">${this._esc(this._echo.error)}</div>` : ''}

            <div class="pp-acciones">
              <button class="pp-btn primary" id="ppProbar" ${this._probando ? 'disabled' : ''}>
                ${this._probando ? 'Comprobando…' : 'Probar la conexión'}</button>
              <button class="pp-btn" id="ppIrBuscar">Ir a buscar</button>
              <button class="pp-btn" id="ppIrAjustes">Ajustes</button>
            </div>
            <div class="pp-hint">La comprobación manda un C-ECHO, que es lo mínimo que
              se le puede pedir a un PACS. Si eso falla, no tiene sentido intentar nada más.</div>
          </div>`;
    },

    _wireConexion() {
        const q = (id) => document.getElementById(id);

        q('ppConectar')?.addEventListener('click', async () => {
            try {
                PacsClient.definirDestino(q('ppUrl')?.value, q('ppToken')?.value);
            } catch (e) {
                UI.showToast(e.message, 'error', 5000);
                return;
            }
            const est = await PacsClient.detectar();
            if (est === 'lista') {
                UI.showToast('Pasarela conectada', 'success', 2500);
                this._vista = 'busqueda';
                await this._cargarAjustes();
            } else {
                UI.showToast(PacsClient.ultimoError() || 'No respondió.', 'error', 5000);
            }
            this.refresh();
        });

        q('ppOlvidar')?.addEventListener('click', () => {
            PacsClient.olvidarDestino();
            this.refresh();
        });

        q('ppReintentar')?.addEventListener('click', async () => {
            await PacsClient.detectar();
            this.refresh();
        });

        q('ppIrBuscar')?.addEventListener('click', () => {
            this._vista = 'busqueda';
            this.refresh();
        });

        q('ppIrAjustes')?.addEventListener('click', async () => {
            await this._cargarAjustes();
            this._vista = 'ajustes';
            this.refresh();
        });

        q('ppProbar')?.addEventListener('click', () => this._probar());
    },

    async _cargarAjustes() {
        try {
            const r = await PacsClient.leerAjustes();
            this._ajustes = r.ajustes;
            if (r.avisos?.length) {
                UI.showToast('Ajustes con avisos: ' + r.avisos[0], 'warning', 6000);
            }
        } catch (e) {
            this._ajustes = null;
        }
    },

    async _probar() {
        this._probando = true;
        this._echo = null;
        this._almacen = null;
        this.refresh();

        await this._cargarAjustes();

        // 1. C-ECHO. Es lo mínimo que se le puede pedir a un PACS; si esto
        // falla, no tiene sentido intentar nada más.
        let ok = false;
        try {
            const r = await PacsClient.echo();
            this._echo = { ok: true, ms: r.ms, servidor: r.servidor };
            ok = true;
        } catch (e) {
            this._echo = { ok: false, error: e.message };
            UI.showToast(e.message, 'error', 8000);
        }

        // 2. Almacén. Se comprueba igual aunque el C-ECHO falle: saber que la
        // carpeta está mal es útil ahora, no en el intento siguiente.
        try {
            const r = await PacsClient.comprobarAlmacen();
            this._almacen = { ok: true, raiz: r.raiz, convenio: r.convenio };
        } catch (e) {
            this._almacen = { ok: false, error: e.message };
        }

        this._probando = false;
        this.refresh();
        if (ok && this._almacen.ok) {
            UI.showToast('Servidor y almacén correctos', 'success', 2500);
        }
    },

    /* ── Búsqueda ──────────────────────────────────────────── */

    _htmlBusqueda() {
        const b = this._ultimaBusqueda || {};
        return `
          <div class="pp-section">
            <div class="pp-barra">
              <button class="pp-btn pequeno" id="ppVolverConexion">‹ Conexión</button>
              <span class="pp-crumb">${this._ajustes
                  ? this._esc(this._ajustes.calledAeTitle) + ' · ' + this._esc(this._ajustes.host)
                  : 'servidor'}</span>
            </div>

            <div class="pp-form">
              <label class="pp-campo"><span>Nº de caso</span>
                <input id="ppAcc" type="text" placeholder="1956-26"
                       value="${this._esc(b.accessionNumber || '')}"></label>
              <label class="pp-campo"><span>Nombre</span>
                <input id="ppNombre" type="text" placeholder="ADA^IRMA*"
                       value="${this._esc(b.patientName || '')}"></label>
              <label class="pp-campo"><span>Historia</span>
                <input id="ppHc" type="text" placeholder="HC1956"
                       value="${this._esc(b.patientId || '')}"></label>
              <label class="pp-campo"><span>Fecha</span>
                <input id="ppFecha" type="text" placeholder="20260623 o 20260601-20260630"
                       value="${this._esc(b.studyDate || '')}"></label>
            </div>
            <div class="pp-acciones">
              <button class="pp-btn primary" id="ppBuscar" ${this._buscando ? 'disabled' : ''}>
                ${this._buscando ? 'Buscando…' : 'Buscar'}</button>
              <button class="pp-btn" id="ppHoy">Hoy</button>
              <button class="pp-btn" id="ppLimpiar">Limpiar</button>
            </div>
            <div class="pp-hint">Hace falta al menos un criterio. Una consulta vacía le pide
              al PACS el archivo completo, y eso es como se consigue que bloqueen el AE Title.</div>
          </div>

          ${this._htmlDescarga()}
          ${this._htmlResultados()}`;
    },

    _htmlResultados() {
        if (this._estudios === null) return '';
        if (!this._estudios.length) {
            return `<div class="pp-section"><div class="pp-vacio">
                Ningún estudio coincide. Probá con menos criterios o con un comodín:
                <code>ADA*</code>.</div></div>`;
        }

        const filas = this._estudios.map((e, i) => {
            const desplegado = this._series?.uid === e.studyInstanceUID;
            return `
              <div class="pp-fila ${desplegado ? 'abierta' : ''}" data-i="${i}">
                <div class="pp-fila-cab">
                  <div class="pp-fila-txt">
                    <strong>${this._esc(this._nombre(e.patientName))}</strong>
                    <span class="pp-pn">${this._esc(e.patientName)}</span>
                    <span class="pp-meta">${this._esc(e.accessionNumber || '—')} ·
                      ${this._fecha(e.studyDate)} · ${this._esc(e.modalities || '')} ·
                      ${e.numSeries ?? '?'} series · ${e.numInstances ?? '?'} imágenes</span>
                    <span class="pp-desc">${this._esc(e.studyDescription || '')}</span>
                  </div>
                  <div class="pp-fila-acc">
                    <button class="pp-btn pequeno" data-series="${i}">Series</button>
                    <button class="pp-btn pequeno primary" data-bajar="${i}">Descargar</button>
                  </div>
                </div>
                ${desplegado ? this._htmlSeries(i) : ''}
              </div>`;
        }).join('');

        return `
          <div class="pp-section">
            <div class="pp-section-title">
              ${this._estudios.length} estudio${this._estudios.length === 1 ? '' : 's'}
              ${this._truncado ? '<em class="pp-trunc">(lista recortada por el límite)</em>' : ''}
            </div>
            <div class="pp-lista">${filas}</div>
          </div>`;
    },

    _htmlSeries(i) {
        const s = this._series;
        if (!s) return '';
        if (s.cargando) return `<div class="pp-series"><div class="pp-vacio">Cargando series…</div></div>`;
        if (!s.series.length) return `<div class="pp-series"><div class="pp-vacio">Sin series.</div></div>`;
        return `<div class="pp-series">${s.series.map((x, k) => `
            <div class="pp-serie">
              <span class="pp-serie-n">${x.seriesNumber ?? '—'}</span>
              <span class="pp-serie-d">${this._esc(x.seriesDescription || '(sin descripción)')}</span>
              <span class="pp-serie-m">${this._esc(x.modality || '')} ·
                ${x.numInstances ?? '?'} img</span>
              <button class="pp-btn pequeno" data-bajar-serie="${i}" data-serie-k="${k}">
                Descargar</button>
            </div>`).join('')}</div>`;
    },

    _htmlDescarga() {
        const d = this._descarga;
        if (!d) return '';

        if (d.estado === 'en-curso') {
            const p = d.progreso;
            const total = p ? (p.completadas || 0) + (p.restantes || 0) : 0;
            const hechas = p?.completadas || 0;
            const pct = total ? Math.round(100 * hechas / total) : null;
            return `
              <div class="pp-section">
                <div class="pp-descarga en-curso">
                  <div class="pp-descarga-cab">
                    <strong>Descargando${d.metodo ? ' por ' + this._esc(d.metodo) : ''}…</strong>
                    <span>${total ? `${hechas} de ${total}` : 'preparando'}</span>
                  </div>
                  <div class="pp-barra-prog">
                    <div class="pp-barra-prog-in ${pct == null ? 'indet' : ''}"
                         style="${pct == null ? '' : `width:${pct}%`}"></div>
                  </div>
                  ${p?.fallidas ? `<div class="pp-aviso">${p.fallidas} imágenes fallaron
                     en el servidor.</div>` : ''}
                  <div class="pp-hint">Nada se confirma hasta el final: si se corta, la
                    biblioteca no verá un estudio a medias.</div>
                </div>
              </div>`;
        }

        if (d.estado === 'completa') {
            return `
              <div class="pp-section">
                <div class="pp-descarga completa">
                  <strong>Descargado: ${d.instancias} imágenes por ${this._esc(d.metodo || '')}</strong>
                  <p>${this._esc((d.carpetas || []).join(', '))}</p>
                  ${(d.avisos || []).map(a => `<div class="pp-aviso">${this._esc(a)}</div>`).join('')}
                  <div class="pp-acciones">
                    <button class="pp-btn primary" id="ppAbrirBiblioteca">Abrir la biblioteca</button>
                    <button class="pp-btn" id="ppCerrarDescarga">Entendido</button>
                  </div>
                </div>
              </div>`;
        }

        // fallida
        const err = d.error || {};
        return `
          <div class="pp-section">
            <div class="pp-descarga fallida">
              <strong>La descarga falló</strong>
              <p>${this._esc(err.mensaje || 'Sin detalle.')}</p>
              ${err.intentos ? `<ul class="pp-intentos">${err.intentos.map(x =>
                  `<li><b>${this._esc(x.metodo)}</b>: ${this._esc(x.mensaje)}</li>`).join('')}</ul>` : ''}
              <p class="pp-nota">No quedó nada a medias en el almacén.</p>
              <div class="pp-acciones">
                <button class="pp-btn" id="ppCerrarDescarga">Entendido</button>
              </div>
            </div>
          </div>`;
    },

    _wireBusqueda() {
        const q = (id) => document.getElementById(id);

        q('ppVolverConexion')?.addEventListener('click', () => {
            this._vista = 'conexion'; this.refresh();
        });

        q('ppBuscar')?.addEventListener('click', () => this._buscar());
        document.getElementById('ppBody')?.querySelectorAll('.pp-form input')
            .forEach(inp => inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._buscar();
            }));

        q('ppHoy')?.addEventListener('click', () => {
            const d = new Date();
            const s = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
                                      + String(d.getDate()).padStart(2, '0');
            const campo = q('ppFecha');
            if (campo) campo.value = s;
            this._buscar();
        });

        q('ppLimpiar')?.addEventListener('click', () => {
            this._estudios = null; this._series = null; this._ultimaBusqueda = null;
            this.refresh();
        });

        q('ppCerrarDescarga')?.addEventListener('click', () => {
            this._descarga = null; this.refresh();
        });

        q('ppAbrirBiblioteca')?.addEventListener('click', () => {
            this._descarga = null;
            this.close();
            CaseLibrary.open();
        });

        const body = q('ppBody');
        body?.querySelectorAll('[data-series]').forEach(b => {
            b.addEventListener('click', () => this._verSeries(Number(b.dataset.series)));
        });
        body?.querySelectorAll('[data-bajar]').forEach(b => {
            b.addEventListener('click', () => this._bajar(Number(b.dataset.bajar)));
        });
        body?.querySelectorAll('[data-bajar-serie]').forEach(b => {
            b.addEventListener('click', () => this._bajar(
                Number(b.dataset.bajarSerie),
                this._series?.series[Number(b.dataset.serieK)]?.seriesInstanceUID));
        });
    },

    async _buscar() {
        const v = (id) => (document.getElementById(id)?.value || '').trim();
        const criterios = {
            accessionNumber: v('ppAcc'),
            patientName:     v('ppNombre'),
            patientId:       v('ppHc'),
            studyDate:       v('ppFecha'),
        };

        // Un comodín suelto no es un criterio: pediría el archivo entero.
        const util = Object.values(criterios)
            .some(x => x.replace(/[*?]/g, '').trim().length > 0);
        if (!util) {
            UI.showToast('Hace falta al menos un criterio con contenido, no solo un comodín.',
                         'warning', 5000);
            return;
        }

        this._buscando = true;
        this._series = null;
        this.refresh();
        try {
            const r = await PacsClient.buscarEstudios(criterios);
            this._estudios = r.estudios || [];
            this._truncado = !!r.truncado;
            this._ultimaBusqueda = criterios;
            if (this._truncado) {
                UI.showToast(`Más de ${r.limite} resultados: la lista está recortada. ` +
                             `Acotá la búsqueda.`, 'warning', 6000);
            }
        } catch (e) {
            this._estudios = null;
            UI.showToast(e.message, 'error', 8000);
            if (e.ausente) await PacsClient.detectar();
        } finally {
            this._buscando = false;
            this.refresh();
        }
    },

    async _verSeries(i) {
        const e = this._estudios?.[i];
        if (!e) return;
        if (this._series?.uid === e.studyInstanceUID && !this._series.cargando) {
            this._series = null;           // segundo clic: plegar
            this.refresh();
            return;
        }
        this._series = { uid: e.studyInstanceUID, series: [], cargando: true };
        this.refresh();
        try {
            const r = await PacsClient.buscarSeries(e.studyInstanceUID);
            this._series = { uid: e.studyInstanceUID, series: r.series || [], cargando: false };
        } catch (err) {
            this._series = null;
            UI.showToast(err.message, 'error', 8000);
        }
        this.refresh();
    },

    async _bajar(i, seriesInstanceUID) {
        const e = this._estudios?.[i];
        if (!e) return;
        if (this._descarga?.estado === 'en-curso') {
            UI.showToast('Ya hay una descarga en marcha. Se hace una a la vez para no ' +
                         'cargar el servidor del hospital.', 'warning', 5000);
            return;
        }

        // Se manda la fila entera del C-FIND: el nombre y el número de caso son
        // los que dan el nombre de la carpeta, y sin ellos la pasarela no puede
        // saber si el estudio ya estaba descargado.
        const peticion = {
            studyInstanceUID: e.studyInstanceUID,
            seriesInstanceUID: seriesInstanceUID || undefined,
            patientName:     e.patientName,
            patientId:       e.patientId,
            accessionNumber: e.accessionNumber,
            studyDate:       e.studyDate,
        };

        let r;
        try {
            r = await PacsClient.descargar(peticion);
        } catch (err) {
            UI.showToast(err.message, 'error', 9000);
            return;
        }

        if (r.yaEstaba) {
            UI.showToast(`Ya estaba descargado: ${r.instancias} imágenes. ` +
                         `Está en la biblioteca.`, 'info', 6000);
            return;
        }

        this._descarga = { estado: 'en-curso', progreso: null, metodo: null };
        this.refresh();

        try {
            const fin = await PacsClient.seguirDescarga(r.id, (d) => {
                this._descarga = d;
                if (this._open) this.refresh();
            });
            this._descarga = fin;

            if (fin.estado === 'completa') {
                UI.showToast(`${fin.instancias} imágenes descargadas. Reindexando…`,
                             'success', 3000);
                // El acople entre las dos mitades es la carpeta: el caso nuevo
                // aparece al reindexar, el visor no necesita saber del PACS.
                await this._reindexar();
            }
        } catch (err) {
            this._descarga = { estado: 'fallida', error: { mensaje: err.message } };
        }
        this.refresh();
    },

    /**
     * Reindexa la biblioteca para que aparezca el caso recién bajado.
     * Si no se puede (sin permiso de la carpeta todavía), se dice en vez de
     * fallar en silencio: el archivo está en disco y abrirla a mano funciona.
     */
    async _reindexar() {
        try {
            if (typeof CaseLibrary?.rescan === 'function') {
                await CaseLibrary.rescan();
                return true;
            }
        } catch (e) {
            UI.showToast('Descargado, pero la biblioteca no se pudo reindexar sola. ' +
                         'Abrila y pulsá ⟳.', 'warning', 7000);
            return false;
        }
        return false;
    },

    /* ── Ajustes ───────────────────────────────────────────── */

    _htmlAjustes() {
        const a = this._ajustes || {};
        const campo = (id, etiq, valor, extra = '') => `
            <label class="pp-campo"><span>${etiq}</span>
              <input id="${id}" type="text" value="${this._esc(valor ?? '')}" ${extra}></label>`;
        return `
          <div class="pp-section">
            <div class="pp-barra">
              <button class="pp-btn pequeno" id="ppVolverConexion">‹ Conexión</button>
              <span class="pp-crumb">Ajustes de la pasarela</span>
            </div>

            <div class="pp-form dos">
              ${campo('ppAjHost', 'Servidor', a.host)}
              ${campo('ppAjPort', 'Puerto', a.port)}
              ${campo('ppAjCalled', 'AE Title del servidor', a.calledAeTitle)}
              ${campo('ppAjCalling', 'AE Title de este equipo', a.callingAeTitle)}
              ${campo('ppAjDestAe', 'AE de destino (C-MOVE)', a.destinationAeTitle)}
              ${campo('ppAjDestPort', 'Puerto de escucha', a.destinationPort)}
            </div>
            ${campo('ppAjRaiz', 'Carpeta del almacén', a.raizAlmacen)}
            <div class="pp-form dos">
              <label class="pp-campo"><span>Método</span>
                <select id="ppAjMetodo">
                  ${['auto', 'C-GET', 'C-MOVE'].map(m =>
                      `<option value="${m}" ${a.metodo === m ? 'selected' : ''}>${
                        m === 'auto' ? 'automático (C-GET y si no C-MOVE)' : m}</option>`).join('')}
                </select></label>
              ${campo('ppAjLimite', 'Límite de resultados', a.limiteResultados)}
            </div>

            <div class="pp-acciones">
              <button class="pp-btn primary" id="ppAjGuardar">Guardar</button>
              <button class="pp-btn" id="ppAjImportar">Leer del cliente oficial</button>
            </div>
            <div class="pp-hint">El C-MOVE reutiliza el AE Title y el puerto del cliente
              oficial de Xavia, que el servidor ya tiene registrados. Por eso <b>los dos
              programas no pueden estar abiertos a la vez</b>: se pelearían por el puerto.
              Con C-GET no hay ese problema, pero no todos los PACS lo implementan.</div>
          </div>`;
    },

    _wireAjustes() {
        const q = (id) => document.getElementById(id);

        q('ppVolverConexion')?.addEventListener('click', () => {
            this._vista = 'conexion'; this.refresh();
        });

        q('ppAjGuardar')?.addEventListener('click', async () => {
            const a = {
                host: q('ppAjHost')?.value,
                port: q('ppAjPort')?.value,
                calledAeTitle: q('ppAjCalled')?.value,
                callingAeTitle: q('ppAjCalling')?.value,
                destinationAeTitle: q('ppAjDestAe')?.value,
                destinationPort: q('ppAjDestPort')?.value,
                raizAlmacen: q('ppAjRaiz')?.value,
                metodo: q('ppAjMetodo')?.value,
                limiteResultados: q('ppAjLimite')?.value,
            };
            try {
                const r = await PacsClient.guardarAjustes(a);
                this._ajustes = r.ajustes;
                // Las comprobaciones anteriores eran de OTRO servidor y otra
                // carpeta: dejarlas en verde sería mentir.
                this._echo = null;
                this._almacen = null;
                UI.showToast('Ajustes guardados', 'success', 2500);
                this._vista = 'conexion';
                this.refresh();
            } catch (e) {
                UI.showToast(e.message, 'error', 9000);
            }
        });

        q('ppAjImportar')?.addEventListener('click', async () => {
            try {
                const r = await PacsClient.importarClientConfig();
                // Se rellena el formulario pero NO se guarda: los valores pueden
                // estar deducidos y hay que confirmarlos.
                this._ajustes = { ...this._ajustes, ...r.ajustes };
                this.refresh();
                const sin = (r.sinClasificar || []).length;
                UI.showToast(
                    `Leído de ${r.ruta}. Revisá los valores y pulsá Guardar.` +
                    (sin ? ` (${sin} campos no se supieron interpretar)` : ''),
                    'info', 8000);
            } catch (e) {
                UI.showToast(e.message, 'error', 9000);
            }
        });
    },
};
