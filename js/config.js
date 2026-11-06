'use strict';

/* Versión de la app. Se sella en cada medición exportada, así que debe
   subirse en todo despliegue: es parte de la trazabilidad del estudio.
   Debe coincidir con CACHE_VERSION en sw.js. */
const APP_VERSION = '1.7.0';
const CACHE_NAME  = 'tac-viewer-v1.7.0';

/* ── Windowing presets ──────────────────────────────────── */
const WINDOWING_PRESETS = {
    brain:       { width: 80,   center: 40,   label: 'Cerebro' },
    bone:        { width: 2000, center: 400,  label: 'Hueso' },
    softTissue:  { width: 400,  center: 50,   label: 'Tejido blando' },
    lung:        { width: 1500, center: -600, label: 'Pulmón' },
    subdural:    { width: 200,  center: 75,   label: 'Subdural' },
    hemorrhage:  { width: 100,  center: 50,   label: 'Hemorragia IC' },
    stroke:      { width: 40,   center: 40,   label: 'Stroke' },
    temporal:    { width: 2800, center: 600,  label: 'Temporal' },
};

const DEFAULT_PRESET = 'brain';

/* ── Tool IDs ───────────────────────────────────────────── */
const TOOL_IDS = {
    POINTER:    'pointer',
    WINDOWING:  'windowing',
    PAN:        'pan',
    ZOOM:       'zoom',
    PROBE:      'probe',
    DISTANCE:   'distance',
    ANGLE:      'angle',
    ELLIPSE:    'ellipse',
    RECTANGLE:  'rectangle',
    ARROW:      'arrow',
    TEXT:       'text',
    COBB:       'cobb',
    FREEHAND:   'freehand',
    /* ── Investigación: NWU, volumen y efecto de masa ── */
    NWU_MIDLINE: 'nwu_midline',   // 2 clics: inserción anterior y posterior de la hoz
    NWU_LESION:  'nwu_lesion',    // traza la ROI de lesión → genera la espejo
    NWU_SEPTUM:  'nwu_septum',    // 1 clic en el septum pellucidum
    NWU_AB:      'nwu_ab',        // A y B para el ayudante ABC/2
    /* ── Análisis automático de asimetría ── */
    ASPECTS_SEED: 'aspects_seed', // 1 clic: sonda ASPECTS + su espejo
};

/* ── Keyboard shortcuts ─────────────────────────────────── */
const SHORTCUTS = {
    's': TOOL_IDS.POINTER,
    'w': TOOL_IDS.WINDOWING,
    'h': TOOL_IDS.PAN,
    'z': TOOL_IDS.ZOOM,
    'p': TOOL_IDS.PROBE,
    'd': TOOL_IDS.DISTANCE,
    'a': TOOL_IDS.ANGLE,
    'e': TOOL_IDS.ELLIPSE,
    'r': TOOL_IDS.RECTANGLE,
    'f': TOOL_IDS.ARROW,
    't': TOOL_IDS.TEXT,
    'c': TOOL_IDS.COBB,
    'g': TOOL_IDS.FREEHAND,
    'l': TOOL_IDS.NWU_MIDLINE,
    'n': TOOL_IDS.NWU_LESION,
    'j': TOOL_IDS.NWU_SEPTUM,
    'b': TOOL_IDS.NWU_AB,
    'k': TOOL_IDS.ASPECTS_SEED,
};

/* ── Investigación ──────────────────────────────────────── */

// Umbral de exclusión por defecto para las ROI de NWU. Editable en el panel:
// por debajo de 0 UH se excluye LCR, por encima de 60 UH calcificación o sangre.
const NWU_DEFAULTS = {
    huMin: 0,
    huMax: 60,
};

// Filtros y realces que generan o alteran valores de píxel. El modo
// investigación los desactiva y los bloquea. La ventana/nivel NO está aquí:
// solo cambia cómo se mapea a gris, no el valor medido.
const RESEARCH_BLOCKED_FILTERS = [
    'bicubicEnabled',    // interpolación bicúbica
    'usmEnabled',        // unsharp masking
    'bilateralEnabled',  // denoising bilateral
    'anisoEnabled',      // difusión anisotrópica
    'claheEnabled',      // CLAHE
    'retinexEnabled',    // multi-scale Retinex
    'tvEnabled',         // Total Variation denoising
    'isSuperResEnabled', // superresolución
];

// Botones de la toolbar que hay que deshabilitar visualmente, por clave de estado
const RESEARCH_BLOCKED_BUTTONS = {
    tvEnabled:         'btnTV',
    isSuperResEnabled: 'btnSuperRes',
};

/* ── Personalización de la barra ────────────────────────── */

// Botones OCULTOS de fábrica. El análisis automático de asimetría es una
// función en estudio y explícitamente no diagnóstica: no debe aparecer en la
// barra de nadie sin que lo haya activado a propósito en «Personalizar barra».
// Que cueste un paso es la intención, no un descuido.
// El panel del servidor también va oculto, por otra razón: en la versión WEB
// no hay pasarela DICOM detrás —un navegador no puede abrir sockets TCP ni
// escuchar en un puerto— y el botón no haría nada. Solo tiene sentido en la
// app de escritorio, que es la que lleva la pasarela dentro.
const TOOLBAR_HIDDEN_BY_DEFAULT = [
    'btn-detector',
    'btn-detector-panel',
    'btn-pacs-panel',
];

// Se sube al cambiar TOOLBAR_HIDDEN_BY_DEFAULT. Los valores de fábrica nuevos
// se aplican UNA vez a quien ya tenía la barra configurada —si no, un usuario
// con `tc-hidden` guardado de antes vería el botón nuevo igualmente—; a partir
// de ahí manda siempre su elección.
//   v2 → añade 'btn-pacs-panel'
const TOOLBAR_DEFAULTS_VERSION = 2;

// Checkboxes del panel de filtros a desmarcar y bloquear
const RESEARCH_FILTER_CHECKBOXES = {
    bicubicEnabled:   'chkBicubic',
    usmEnabled:       'chkUsm',
    bilateralEnabled: 'chkBilateral',
    anisoEnabled:     'chkAniso',
    claheEnabled:     'chkClahe',
    retinexEnabled:   'chkRetinex',
};

/* ── DICOM tag dictionary (para metadata panel) ─────────── */
const DICOM_TAGS = {
    'x00080016': 'SOP Class UID',
    'x00080018': 'SOP Instance UID',
    'x00080020': 'Study Date',
    'x00080021': 'Series Date',
    'x00080022': 'Acquisition Date',
    'x00080023': 'Content Date',
    'x00080030': 'Study Time',
    'x00080050': 'Accession Number',
    'x00080060': 'Modality',
    'x00080070': 'Manufacturer',
    'x00080080': 'Institution Name',
    'x00080090': 'Referring Physician',
    'x00081030': 'Study Description',
    'x0008103e': 'Series Description',
    'x00100010': 'Patient Name',
    'x00100020': 'Patient ID',
    'x00100030': 'Birth Date',
    'x00100040': 'Sex',
    'x00081090': 'Manufacturer Model',
    'x0020000d': 'Study Instance UID',
    'x0020000e': 'Series Instance UID',
    'x00080032': 'Acquisition Time',
    'x00181210': 'Convolution Kernel',
    'x00180088': 'Spacing Between Slices',
    'x00280120': 'Pixel Padding Value',
    'x00280121': 'Pixel Padding Range Limit',
    'x00181030': 'Protocol Name',
    'x00180050': 'Slice Thickness',
    'x00180060': 'kVp',
    'x00181151': 'X-Ray Tube Current',
    'x00181152': 'Exposure',
    'x00181164': 'Image Pixel Spacing',
    'x0018d041': 'Contrast Agent',
    'x00200010': 'Study ID',
    'x00200011': 'Series Number',
    'x00200013': 'Instance Number',
    'x00200032': 'Image Position (Patient)',
    'x00200037': 'Image Orientation (Patient)',
    'x00201041': 'Slice Location',
    'x00280002': 'Samples per Pixel',
    'x00280004': 'Photometric Interpretation',
    'x00280010': 'Rows',
    'x00280011': 'Columns',
    'x00280030': 'Pixel Spacing',
    'x00280100': 'Bits Allocated',
    'x00280101': 'Bits Stored',
    'x00280102': 'High Bit',
    'x00280103': 'Pixel Representation',
    'x00281050': 'Window Center',
    'x00281051': 'Window Width',
    'x00281052': 'Rescale Intercept',
    'x00281053': 'Rescale Slope',
    'x00281054': 'Rescale Type',
};

/* ── Orientación para TAC axial ─────────────────────────── */
const ORIENTATION_AXIAL    = { top: 'P', bottom: 'A', left: 'R', right: 'L' };
const ORIENTATION_CORONAL  = { top: 'H', bottom: 'F', left: 'R', right: 'L' };
const ORIENTATION_SAGITTAL = { top: 'H', bottom: 'F', left: 'A', right: 'P' };

/* ── Measurement colors ─────────────────────────────────── */
const MEASURE_COLOR         = '#FFD700';
const MEASURE_ACTIVE_COLOR  = '#FF6B35';
const MEASURE_TEXT_COLOR    = '#FFFFFF';
const ROI_FILL_COLOR        = 'rgba(0,180,255,0.12)';
const ROI_STROKE_COLOR      = 'rgba(0,200,255,0.9)';

/* ── Render settings ────────────────────────────────────── */
const THUMB_SIZE      = 80;
const MIN_ZOOM        = 0.1;
const MAX_ZOOM        = 20;
const ZOOM_STEP       = 1.12;  // factor por cada tick de scroll
const WL_SENSITIVITY  = 3;     // HU por px de drag para W/L
