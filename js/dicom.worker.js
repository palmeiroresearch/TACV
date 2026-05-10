/* ============================================================
   Web Worker — Parseo DICOM en background thread
   Recibe: { id, buffer: ArrayBuffer, filename: string }
   Envía:  { id, frame: DicomFrame } | { id, error: string }
   ============================================================ */

// Importar dicom-parser y el bridge en el worker
importScripts('../lib/dicom-parser.min.js');
importScripts('../lib/pako.min.js');
importScripts('dicom-parser-bridge.js');

self.onmessage = function(e) {
    const { id, buffer, filename } = e.data;
    try {
        const frame = DicomBridge.parse(buffer, filename);
        // Transferir el ArrayBuffer del pixelData de vuelta zero-copy
        self.postMessage({ id, frame }, [frame.pixelData.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
