'use strict';

/* ── Arrow ───────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.ARROW] = {
    onDown(viewport, pos, drag) {
        drag.data.tail = viewport.canvasToImage(pos.x, pos.y);
    },
    onDrag(viewport, pos, dx, dy, drag) {
        const head = viewport.canvasToImage(pos.x, pos.y);
        viewport.state.liveMeasurement = {
            type: 'arrow', tail: drag.data.tail, head, label: '',
        };
    },
    onUp(viewport, pos, drag) {
        const live = viewport.state.liveMeasurement;
        if (!live) return;
        const dist = Math.hypot(pos.x - drag.startX, pos.y - drag.startY);
        if (dist < 10) { viewport.state.liveMeasurement = null; return; }
        MeasurementStore.add(viewport.state.sliceIndex, {
            type: 'arrow',
            tail: drag.data.tail,
            head: viewport.canvasToImage(pos.x, pos.y),
            label: '',
        });
        viewport.state.liveMeasurement = null;
    },
};

/* ── Text ────────────────────────────────────────────────── */
ToolHandlers[TOOL_IDS.TEXT] = {
    onDown(viewport, pos) {
        const imgPos = viewport.canvasToImage(pos.x, pos.y);
        const rect   = viewport.glCanvas.getBoundingClientRect();
        this._openInput(viewport, pos, imgPos, rect);
    },

    _openInput(viewport, canvasPos, imgPos, rect) {
        const existing = document.getElementById('inlineTextInput');
        if (existing) existing.remove();

        const input = document.createElement('input');
        input.id    = 'inlineTextInput';
        input.type  = 'text';
        input.placeholder = 'Texto...';
        input.style.cssText = `
            position: fixed;
            left: ${rect.left + canvasPos.x}px;
            top:  ${rect.top  + canvasPos.y - 14}px;
            background: rgba(0,0,0,0.7);
            border: 1px solid var(--brand-accent);
            border-radius: 4px;
            color: #FFD700;
            font-size: 13px;
            font-weight: 600;
            padding: 3px 8px;
            min-width: 120px;
            outline: none;
            z-index: 9000;
        `;

        let done = false;
        const finish = (save = true) => {
            if (done) return;
            done = true;
            document.removeEventListener('mousedown', onOutside, true);
            const text = input.value.trim();
            input.remove();
            if (!save || !text) return;
            MeasurementStore.add(viewport.state.sliceIndex, {
                type: 'text', pos: imgPos, text,
            });
            viewport.render();
        };

        const onOutside = (e) => {
            if (e.target !== input) finish(true);
        };

        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') finish(false);
        });

        document.body.appendChild(input);

        // Diferir focus y handler de click externo un tick para que el mousedown
        // actual no dispare onOutside ni robe el foco de vuelta al canvas
        setTimeout(() => {
            input.focus();
            document.addEventListener('mousedown', onOutside, true);
        }, 0);
    },
};
