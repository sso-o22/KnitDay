window.patternViewer = (() => {
    let pdfDoc = null, pdfCanvas = null, annoCanvas = null;
    let pdfCtx = null, annoCtx = null, dotNetRef = null;
    let isDrawing = false;
    let paths = [];
    let currentPath = null;
    let currentZoom = 1.0;
    let currentPageNum = 1;

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
        const pagePaths = paths.filter(p => p.page === currentPageNum);
        pagePaths.forEach(p => {
            annoCtx.beginPath();
            annoCtx.lineWidth = p.size * (currentZoom / p.originZoom);
            annoCtx.lineCap = 'round';
            annoCtx.lineJoin = 'round';
            annoCtx.strokeStyle = p.color;
            annoCtx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            if (p.points.length > 0) {
                const first = p.points[0];
                annoCtx.moveTo(first.x * currentZoom, first.y * currentZoom);
                for (let i = 1; i < p.points.length; i++) {
                    annoCtx.lineTo(p.points[i].x * currentZoom, p.points[i].y * currentZoom);
                }
                annoCtx.stroke();
            }
        });
        annoCtx.globalCompositeOperation = 'source-over';
    }

    // 터치/마우스 공통 좌표 추출
    function getPos(e) {
        const rect = annoCanvas.getBoundingClientRect();
        const scaleX = annoCanvas.width / rect.width;
        const scaleY = annoCanvas.height / rect.height;
        if (e.touches) {
            const t = e.touches[0];
            return {
                x: (t.clientX - rect.left) * scaleX,
                y: (t.clientY - rect.top) * scaleY
            };
        }
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    // Blazor에서 넘겨주는 현재 도구 상태
    let _color = '#e74c3c';
    let _size = 4;
    let _isEraser = false;

    function onPointerDown(e) {
        if (e.touches) e.preventDefault();
        const pos = getPos(e);
        patternViewer.startDraw(pos.x, pos.y, _color, _size, _isEraser);
    }

    function onPointerMove(e) {
        if (e.touches) e.preventDefault();
        if (!isDrawing) return;
        const pos = getPos(e);
        patternViewer.draw(pos.x, pos.y);
    }

    function onPointerUp(e) {
        if (isDrawing) patternViewer.endDraw();
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

            // 터치 & 마우스 이벤트 등록 (중복 방지)
            annoCanvas.removeEventListener('mousedown', onPointerDown);
            annoCanvas.removeEventListener('mousemove', onPointerMove);
            annoCanvas.removeEventListener('mouseup', onPointerUp);
            annoCanvas.removeEventListener('touchstart', onPointerDown);
            annoCanvas.removeEventListener('touchmove', onPointerMove);
            annoCanvas.removeEventListener('touchend', onPointerUp);

            annoCanvas.addEventListener('mousedown', onPointerDown);
            annoCanvas.addEventListener('mousemove', onPointerMove);
            annoCanvas.addEventListener('mouseup', onPointerUp);
            annoCanvas.addEventListener('touchstart', onPointerDown, { passive: false });
            annoCanvas.addEventListener('touchmove', onPointerMove, { passive: false });
            annoCanvas.addEventListener('touchend', onPointerUp);
        },

        setTool(color, size, isEraser) {
            _color = color;
            _size = size;
            _isEraser = isEraser;
        },

        startDraw(x, y, color, size, isEraser) {
            getCanvases();
            isDrawing = true;
            currentPath = {
                page: currentPageNum,
                color: color,
                size: size,
                isEraser: isEraser,
                originZoom: currentZoom,
                points: [{ x: x / currentZoom, y: y / currentZoom }]
            };
            annoCtx.beginPath();
            annoCtx.moveTo(x, y);
            annoCtx.lineWidth = size;
            annoCtx.lineCap = 'round';
            annoCtx.lineJoin = 'round';
            annoCtx.strokeStyle = isEraser ? '#ffffff' : color;
            annoCtx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
        },

        draw(x, y) {
            if (!isDrawing) return;
            if (currentPath) currentPath.points.push({ x: x / currentZoom, y: y / currentZoom });
            annoCtx.lineTo(x, y);
            annoCtx.stroke();
        },

        endDraw() {
            isDrawing = false;
            if (currentPath) {
                paths.push(currentPath);
                currentPath = null;
            }
        },

        undo() {
            paths.pop();
            redrawPaths();
        },

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
