# TACV

Visor DICOM que corre entero en el navegador, pensado para TAC de cráneo.
Además de leer estudios, sirve como **instrumento de medición** para
investigación en ictus isquémico: calcula *net water uptake* (NWU), volumen
planimétrico, desviación de la línea media y ABC/2, con trazabilidad completa
de cada medida.

**→ [tacv.palmeiromed.com](https://tacv.palmeiromed.com)**

Funciona sin conexión una vez cargado. No hay servidor: todo el procesamiento
ocurre en el navegador y **ninguna imagen de paciente sale del equipo**.

---

## Lo primero, porque condiciona todo lo demás

**TACV no es un producto sanitario y no está certificado como tal.** No emite
diagnósticos ni los sugiere. Las cifras que produce son medidas sobre píxeles,
y la interpretación es siempre de quien lee el estudio.

Esto no es una fórmula de descargo: está construido así. El análisis automático
de asimetría, por ejemplo, habla de «región hipodensa de 14,2 mL, ΔUH −7,2» y
nunca de «infarto»; y viene **desactivado de fábrica** en la barra de
herramientas, para que nadie se lo encuentre sin haberlo activado a propósito.

---

## Qué hace

### Visor

Carga de carpetas o archivos sueltos, reconstrucción multiplanar, ventana/nivel
con presets, mediciones básicas (distancia, ángulo, Cobb, ROI), anotaciones,
biblioteca de casos que recuerda la carpeta entre sesiones, y exportación a PNG
o informe HTML.

El post-procesado (interpolación, denoising, CLAHE, superresolución) se hace en
WebGL2 y es **solo de visualización**: nunca toca los valores que se miden.

### Medición para investigación

- **NWU** — ROI en la lesión, ROI espejo generada automáticamente al otro lado
  de la línea media, y `NWU = (1 − lesión/contralateral) × 100`. La reflexión
  es métrica, no en píxeles: respeta el espaciado real aunque sea anisótropo.
- **Volumen planimétrico** con el espaciado deducido de `ImagePositionPatient`,
  y aviso si los cortes son irregulares o se solapan.
- **Desviación de la línea media** desde el septum pellucidum, perpendicular.
- **ABC/2** con la C derivada del número real de cortes con lesión.
- **Exportación CSV y JSON** con código de caso anonimizado, lector, fecha,
  versión de la app, metadatos técnicos del equipo y todas las ROI con sus
  coordenadas. El JSON vuelve a importarse para superponer las ROI y hacer una
  segunda lectura o una auditoría.

Todas las estadísticas se calculan sobre los **valores originales del píxel**
convertidos a unidades Hounsfield (`valor × RescaleSlope + RescaleIntercept`),
nunca sobre lo que se ve en pantalla, y excluyen el `PixelPaddingValue`.

### Modo investigación

Un interruptor que desactiva y bloquea todo el procesamiento que altera valores
de píxel, deja la ventana/nivel libre, muestra un indicador permanente, impide
que el service worker actualice la app sin confirmación, y sella cada medición
con la versión exacta y la marca de modo investigación.

Mientras está activo, el análisis automático queda **bloqueado por completo**:
ver una región marcada antes de medirla contamina la medición, y la ROI deja de
ser una observación independiente.

### Análisis automático de asimetría (en estudio)

Propone regiones hipodensas e hiperdensas comparando cada hemisferio con su
espejo, con sectores y sondas tipo ASPECTS. Exige confirmar la línea media
antes de ejecutarse: tres grados de error bastan para fabricar un mapa de
asimetría falso en un cerebro perfectamente simétrico.

**El detector propone; no mide.** Toda región aceptada se vuelve a medir por el
mismo camino validado que una ROI dibujada a mano.

---

## Desarrollo

Sin dependencias en tiempo de ejecución. `dicom-parser` y `pako` van en `lib/`
y la única dependencia de desarrollo es `esbuild`, solo para el bundle.

```bash
npm test            # 184 pruebas (node --test), sin navegador
npm run build       # bundle minificado en dist/  (opcional: se despliega sin empaquetar)
npm run publicar    # comprueba que todo cuadra antes de una versión
```

### Estructura

```
js/research-core.js    toda la matemática de medición, sin DOM y con pruebas
js/detect-core.js      morfología, mapas de asimetría, trazado de contornos
js/dicom-parser-bridge.js   lectura de píxeles y metadatos
js/viewport*.js        render WebGL2 y disposición
js/*-panel.js          paneles de interfaz
sw.js                  service worker: caché agresiva, primero la caché
```

`research-core.js` y `detect-core.js` son módulos puros: funcionan igual bajo
Node que en el navegador, y por eso toda la matemática se puede probar sin
abrir una ventana. Las pruebas incluyen un fantoma sintético de cabeza donde el
NWU esperado se conoce de antemano.

### Publicar

```bash
npm run publicar patch        # sube la versión, corre las pruebas, commit y etiqueta
git push origin main --follow-tags
```

La versión vive en cuatro sitios que deben coincidir —`package.json`,
`APP_VERSION`, `CACHE_NAME` y `CACHE_VERSION` de `sw.js`—. El script lo
comprueba, y también que todo lo que referencia `index.html` exista y esté en
la caché del service worker. Si `CACHE_VERSION` se queda atrás, el despliegue
parece correcto pero nadie recibe la actualización: el service worker sigue
sirviendo la versión vieja y no hay ningún error que mirar.

---

## Privacidad

No hay servidor, ni analítica, ni telemetría. Las imágenes se leen con la API
de archivos del navegador y los fotogramas parseados se guardan en IndexedDB,
en el equipo. La exportación de investigación excluye nombre e identificador de
paciente por construcción: usa un código derivado del `StudyInstanceUID`.

---

## Estado

En uso de prueba en un servicio de urgencias. La parte de investigación está
implementada y verificada; el análisis automático de asimetría está en estudio
y desactivado de fábrica.

No hay licencia declarada todavía, lo que significa que se reservan todos los
derechos. Si querés usarlo o colaborar, abrí un *issue*.
