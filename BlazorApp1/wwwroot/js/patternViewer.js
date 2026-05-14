window.patternViewer = (() => {
    let pdfDoc = null, pdfCanvas = null, annoCanvas = null;
    let pdfCtx = null, annoCtx = null, dotNetRef = null;
    let isDrawing = false;
    let paths = [];
    let currentPath = null;
    let currentZoom = 1.0;
    let currentPageNum = 1;
    let _color = '#000000';
    let _size = 4;
    let _isEraser = false;
    let _tool = 'select';

    async function ensurePdfJs() {
        if (window.pdfjsLib) return;
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        document.head.appendChild(s);
        await new Promise(r => s.onload = r);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    function getCanvases() {
        pdfCanvas = document.getElementById('pdf-canvas');
        annoCanvas = document.getElementById('anno-canvas');
        if (pdfCanvas) pdfCtx = pdfCanvas.getContext('2d');
        if (annoCanvas) annoCtx = annoCanvas.getContext('2d');
    }

    function redrawPaths() {
        if (!annoCtx) return;
        annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
        paths.filter(p => p.page === currentPageNum).forEach(p => {
            if (p.points.length === 0) return;
            annoCtx.beginPath();
            annoCtx.lineWidth = p.size * (currentZoom / p.originZoom);
            annoCtx.lineCap = 'round';
            annoCtx.lineJoin = 'round';
            annoCtx.strokeStyle = p.color;
            annoCtx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            annoCtx.moveTo(p.points[0].x * currentZoom, p.points[0].y * currentZoom);
            for (let i = 1; i < p.points.length; i++)
                annoCtx.lineTo(p.points[i].x * currentZoom, p.points[i].y * currentZoom);
            annoCtx.stroke();
        });
        annoCtx.globalCompositeOperation = 'source-over';
    }

    function getCanvasPos(e) {
        const rect = annoCanvas.getBoundingClientRect();
        const scaleX = annoCanvas.width / rect.width;
        const scaleY = annoCanvas.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * scaleX,
            y: (src.clientY - rect.top) * scaleY
        };
    }

    // ── 캔버스 이벤트 핸들러 ──────────────────────────────
    function onDown(e) {
        if (_tool !== 'pen' && _tool !== 'eraser') return;
        if (e.touches) e.preventDefault();
        const pos = getCanvasPos(e);
        isDrawing = true;
        currentPath = {
            page: currentPageNum, color: _color, size: _size,
            isEraser: _isEraser, originZoom: currentZoom,
            points: [{ x: pos.x / currentZoom, y: pos.y / currentZoom }]
        };
        annoCtx.beginPath();
        annoCtx.moveTo(pos.x, pos.y);
        annoCtx.lineWidth = _size;
        annoCtx.lineCap = 'round';
        annoCtx.lineJoin = 'round';
        annoCtx.strokeStyle = _isEraser ? 'rgba(0,0,0,1)' : _color;
        annoCtx.globalCompositeOperation = _isEraser ? 'destination-out' : 'source-over';
    }

    function onMove(e) {
        if (!isDrawing) return;
        if (e.touches) e.preventDefault();
        const pos = getCanvasPos(e);
        if (currentPath) currentPath.points.push({ x: pos.x / currentZoom, y: pos.y / currentZoom });
        annoCtx.lineTo(pos.x, pos.y);
        annoCtx.stroke();
    }

    function onUp(e) {
        if (!isDrawing) return;
        isDrawing = false;
        if (currentPath) { paths.push(currentPath); currentPath = null; }
    }

    return {
        init(ref) { dotNetRef = ref; },

        async loadPdfFromStream(streamRef, zoom) {
            await ensurePdfJs();
            const bytes = new Uint8Array(await streamRef.arrayBuffer());
            pdfDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
            await this.renderPage(1, zoom);
            return pdfDoc.numPages;
        },

        async renderPage(pageNum, zoom) {
            if (!pdfDoc) return;
            currentPageNum = pageNum;
            currentZoom = zoom;
            getCanvases();
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: zoom });
            pdfCanvas.width = annoCanvas.width = viewport.width;
            pdfCanvas.height = annoCanvas.height = viewport.height;
            await page.render({ canvasContext: pdfCtx, viewport }).promise;
            redrawPaths();

            // 이벤트 중복 방지
            if (!annoCanvas._eventsRegistered) {
                annoCanvas._eventsRegistered = true;

                // 마우스
                annoCanvas.addEventListener('mousedown', onDown);
                annoCanvas.addEventListener('mousemove', onMove);
                annoCanvas.addEventListener('mouseup', onUp);

                // 터치 — pen/eraser일 때만 preventDefault
                annoCanvas.addEventListener('touchstart', onDown, { passive: false });
                annoCanvas.addEventListener('touchmove', onMove, { passive: false });
                annoCanvas.addEventListener('touchend', onUp);

                // 휠로 페이지 이동
                const scrollEl = annoCanvas.closest('[style*="overflow"]') || document.querySelector('[style*="overflow:auto"]');
                if (scrollEl) {
                    scrollEl.addEventListener('wheel', (e) => {
                        e.preventDefault();
                        if (!dotNetRef) return;
                        if (e.deltaY > 0) dotNetRef.invokeMethodAsync('NextPageFromJS');
                        else dotNetRef.invokeMethodAsync('PrevPageFromJS');
                    }, { passive: false });
                }
            }
        },

        setTool(color, size, isEraser, tool) {
            _color = color;
            _size = size;
            _isEraser = isEraser;
            if (tool !== undefined) _tool = tool;
        },

        // Blazor 마우스 이벤트용 (ruler, select 도구 지원)
        startDraw(x, y, color, size, isEraser) {
            getCanvases();
            isDrawing = true;
            currentPath = {
                page: currentPageNum, color, size, isEraser,
                originZoom: currentZoom,
                points: [{ x: x / currentZoom, y: y / currentZoom }]
            };
            annoCtx.beginPath();
            annoCtx.moveTo(x, y);
            annoCtx.lineWidth = size;
            annoCtx.lineCap = 'round';
            annoCtx.lineJoin = 'round';
            annoCtx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : color;
            annoCtx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
        },

        draw(x, y) {
            if (!isDrawing) return;
            if (currentPath) currentPath.points.push({ x: x / currentZoom, y: y / currentZoom });
            annoCtx.lineTo(x, y);
            annoCtx.stroke();
        },

        endDraw() {
            if (!isDrawing) return;
            isDrawing = false;
            if (currentPath) { paths.push(currentPath); currentPath = null; }
        },

        undo() { paths.pop(); redrawPaths(); },

        getRect() {
            const el = document.getElementById('canvas-container');
            if (!el) return [0, 0, 0, 0];
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        },

        clearAnnotations() {
            getCanvases();
            paths = [];
            if (annoCtx) annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
        },

        dispose() { pdfDoc = null; }
    };
})();
