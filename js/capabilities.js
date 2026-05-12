'use strict';

/* ============================================================
   Capabilities — Detección de dispositivo/navegador
   Se ejecuta INMEDIATAMENTE al cargar (antes que cualquier
   otro script). Define el objeto global Capabilities.
   No toca WebGL — solo userAgent + maxTouchPoints.
   ============================================================ */

const Capabilities = (() => {
    const ua      = navigator.userAgent;

    // iOS: iPhone, iPod, iPad clásico, y iPad moderno (reporta MacIntel con touch)
    const isIOS    = /iPad|iPhone|iPod/.test(ua) ||
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // Safari: no es Chrome ni Android
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

    // Cualquier dispositivo táctil
    const isTouch  = navigator.maxTouchPoints > 0;

    // Teléfono: táctil y pantalla pequeña (< 600px en dimensión menor)
    const isMobile = isTouch && Math.min(screen.width, screen.height) < 600;

    // Tablet: táctil pero no phone-size
    const isTablet = isTouch && !isMobile;

    // Agregar clases al <html> para CSS targeting — antes de que el DOM se pinte
    if (isTouch)  document.documentElement.classList.add('is-touch');
    if (isIOS)    document.documentElement.classList.add('is-ios');
    if (isMobile) document.documentElement.classList.add('is-mobile');
    if (isTablet) document.documentElement.classList.add('is-tablet');

    return Object.freeze({ isIOS, isSafari, isTouch, isMobile, isTablet });
})();
