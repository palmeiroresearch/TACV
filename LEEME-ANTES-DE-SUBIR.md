# Subir a GitHub — TACV v1.6.1

Esta carpeta es **el contenido completo de la app**, ya listo para desplegar.
Comparado archivo a archivo contra lo que ahora mismo sirve
https://tacv.palmeiromed.com/ el 2026-10-21.

## Cómo subirlo

Arrastrá **el contenido de esta carpeta** (no la carpeta `subir` en sí) a la
raíz del repositorio en GitHub y confirmá los cambios. Como va el conjunto
completo, no hay riesgo de quedarse a medias: los archivos que no cambiaron se
sobrescriben con un contenido idéntico y no generan diff.

No borres nada del repositorio: en esta actualización no se elimina ningún
archivo.

### Importante tras subir

La app es una PWA con service worker y **caché agresiva**. `CACHE_VERSION`
sube a `v1.6.1` en `sw.js`, así que a quien ya la tenga abierta le
saldrá el aviso de «Nueva versión disponible». Si estás probando y no te
aparece, forzá recarga con Ctrl+F5, o en DevTools → Application → Service
Workers → Unregister.

## Qué lleva

### Archivos nuevos (15)

- `css/detector.css`
- `css/research.css`
- `icons/apple-touch-icon.png`
- `icons/favicon-16.png`
- `icons/favicon-32.png`
- `icons/icon-maskable-192.png`
- `icons/icon-maskable-512.png`
- `js/detect-core.js`
- `js/detect-worker.js`
- `js/detector-panel.js`
- `js/detector.js`
- `js/research-core.js`
- `js/research-mode.js`
- `js/research-panel.js`
- `js/tools-nwu.js`

### Archivos modificados (15)

- `icons/icon-192.png`
- `icons/icon-512.png`
- `index.html`
- `js/app.js`
- `js/config.js`
- `js/dicom-parser-bridge.js`
- `js/export.js`
- `js/measurement-store.js`
- `js/measurements-panel.js`
- `js/overlay-renderer.js`
- `js/tools-measure.js`
- `js/ui.js`
- `js/viewport.js`
- `manifest.json`
- `sw.js`

### Sin cambios respecto a producción (31)

Van igualmente para que el despliegue sea el conjunto completo.

- `css/fonts/inter-latin-ext.woff2`
- `css/fonts/inter-latin.woff2`
- `css/layout.css`
- `css/main.css`
- `css/panels.css`
- `css/thumbnail.css`
- `css/toolbar.css`
- `js/capabilities.js`
- `js/case-library.js`
- `js/colormap.js`
- `js/dicom-loader.js`
- `js/dicom.worker.js`
- `js/filter-shaders.js`
- `js/histogram-panel.js`
- `js/loupe.js`
- `js/metadata-panel.js`
- `js/mpr-viewport.js`
- `js/mpr-volume.js`
- `js/post-processor.js`
- `js/renderer-gl.js`
- `js/series-manager.js`
- `js/series-panel.js`
- `js/shaders.js`
- `js/storage.js`
- `js/tool-state.js`
- `js/tools-annotate.js`
- `js/tools-basic.js`
- `js/tv-worker.js`
- `js/viewport-layout.js`
- `lib/dicom-parser.min.js`
- `lib/pako.min.js`

### No comparables por HTTP (15)

Pruebas y herramientas de build: no los sirve el sitio, así que no se pueden
comparar contra producción. Van al repositorio, no al despliegue.

- `CNAME`
- `build.js`
- `package-lock.json`
- `package.json`
- `tests/detect-hemorrhage.test.js`
- `tests/detect-ischemia.test.js`
- `tests/detect-mask.test.js`
- `tests/detect-phantom.test.js`
- `tests/helpers/head-phantom.js`
- `tests/hu.test.js`
- `tests/nwu.test.js`
- `tests/phantom.test.js`
- `tests/reflect.test.js`
- `tests/store.test.js`
- `tests/volume.test.js`

## Comprobaciones antes de subir

```
npm test     # 184 pruebas
npm run build    # opcional: genera dist/, que NO se despliega
```

GitHub Pages sirve el código **sin empaquetar** (los `js/*.js` sueltos que
referencia `index.html`), no `dist/`. Por eso `dist/` no está aquí.
