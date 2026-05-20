'use strict';

const APP_VERSION = '1.0.0';
const CACHE_NAME  = 'tac-viewer-v1.0.0';

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
