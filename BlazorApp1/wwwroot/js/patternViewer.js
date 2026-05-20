window.patternViewer = (() => {
    let pdfDoc = null, dotNetRef = null;
    let currentZoom = 1.0;
    let currentPageNum = 1;
    let totalPages = 0;
    let _color = '#000000';
    let _size = 4;
    let _isEraser = false;
    let _tool = 'select';
    let paths = [];
    let isDrawing = false;
    let currentPath = null;
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;
    let _pageHandlers = {}; // pageNum -> handlers added flag

    async function ensurePdfJs() {
        if (window.pdfjsLib) return;
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        document.head.appendChild(s);
        await new Promise(r => s.onload = r);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    function getAnnoCanvas(pageNum) {
        return document.getElementById('anno-canvas-' + pageNum);
    }
    function getPdfCanvas(pageNum) {
        return document.getElementById('pdf-canvas-' + pageNum);
    }

    function getCanvasPos(annoCanvas, e) {
        const rect = annoCanvas.getBoundingClientRect();
        const scaleX = annoCanvas.width / rect.width;
        const scaleY = annoCanvas.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * scaleX,
            y: (src.clientY - rect.top) * scaleY
        };
    }

    function redrawPage(pageNum) {
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const ctx = anno.getContext('2d');
        ctx.clearRect(0, 0, anno.width, anno.height);
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (p.points.length === 0) return;
            ctx.beginPath();
            ctx.lineWidth = p.size * (currentZoom / p.originZoom);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = p.color;
            ctx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            ctx.moveTo(p.points[0].x * currentZoom, p.points[0].y * currentZoom);
            for (let i = 1; i < p.points.length; i++)
                ctx.lineTo(p.points[i].x * currentZoom, p.points[i].y * currentZoom);
            ctx.stroke();
        });
        ctx.globalCompositeOperation = 'source-over';
    }

    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) return;
        _pageHandlers[pageNum] = true;
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;

        function onDown(e) {
            if (_tool === 'ruler') {
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown', pos.x, pos.y, pageNum);
                if (e.touches) e.preventDefault();
                return;
            }
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            currentPageNum = pageNum;
            isDrawing = true;
            const ctx = anno.getContext('2d');
            currentPath = {
                page: pageNum, color: _color, size: _size,
                isEraser: _isEraser, originZoom: currentZoom,
                points: [{ x: pos.x / currentZoom, y: pos.y / currentZoom }]
            };
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            ctx.lineWidth = _size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = _isEraser ? 'rgba(0,0,0,1)' : _color;
            ctx.globalCompositeOperation = _isEraser ? 'destination-out' : 'source-over';
        }

        function onMove(e) {
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove', pos.x, pos.y);
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum) return;
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            const ctx = anno.getContext('2d');
            if (currentPath) currentPath.points.push({ x: pos.x / currentZoom, y: pos.y / currentZoom });
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        }

        function onUp(e) {
            if (_tool === 'ruler') {
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchEnd');
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum) return;
            isDrawing = false;
            anno.getContext('2d').globalCompositeOperation = 'source-over';
            if (currentPath) { paths.push(currentPath); currentPath = null; }
        }

        anno.addEventListener('mousedown', onDown);
        anno.addEventListener('mousemove', onMove);
        anno.addEventListener('mouseup', onUp);
        anno.addEventListener('touchstart', onDown, { passive: false });
        anno.addEventListener('touchmove', onMove, { passive: false });
        anno.addEventListener('touchend', onUp);
    }

    async function renderOnePage(pageNum, zoom) {
        if (!pdfDoc) return;
        const pdfCanvas = getPdfCanvas(pageNum);
        const annoCanvas = getAnnoCanvas(pageNum);
        if (!pdfCanvas || !annoCanvas) return;
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: zoom });
        pdfCanvas.width = annoCanvas.width = viewport.width;
        pdfCanvas.height = annoCanvas.height = viewport.height;
        // CSS 크기를 내부 해상도와 일치시켜서 ruler 좌표 어긋남 방지
        pdfCanvas.style.width = viewport.width + 'px';
        pdfCanvas.style.height = viewport.height + 'px';
        annoCanvas.style.width = viewport.width + 'px';
        annoCanvas.style.height = viewport.height + 'px';
        annoCanvas.style.cursor = _tool === 'pen' ? 'crosshair' : _tool === 'eraser' ? 'cell' : _tool === 'ruler' ? 'crosshair' : 'default';
        const pdfCtx = pdfCanvas.getContext('2d');
        await page.render({ canvasContext: pdfCtx, viewport }).promise;
        redrawPage(pageNum);
        _pageHandlers[pageNum] = false;
        addPageHandlers(pageNum);
    }

    function setupScrollAndZoom() {
        const scrollEl = document.getElementById('scroll-container');
        if (!scrollEl || scrollEl._bound) return;
        scrollEl._bound = true;

        // 스크롤 → 현재 페이지 추적
        scrollEl.addEventListener('scroll', () => {
            const wrapperRect = scrollEl.getBoundingClientRect();
            const mid = wrapperRect.top + wrapperRect.height / 2;
            let found = 1;
            for (let i = 1; i <= totalPages; i++) {
                const el = document.getElementById('page-container-' + i);
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.top <= mid) found = i;
            }
            if (found !== currentPageNum) {
                currentPageNum = found;
                if (dotNetRef) dotNetRef.invokeMethodAsync('UpdatePageFromJS', found);
            }
        }, { passive: true });

        // PC: Ctrl+휠 = 확대/축소
        scrollEl.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newZoom = Math.round(Math.min(3.0, Math.max(0.5, currentZoom + delta)) * 10) / 10;
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', newZoom);
            }
        }, { passive: false });

        // 모바일: 핀치 줌
        scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                _pinchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                _pinchStartZoom = currentZoom;
            }
        }, { passive: true });

        scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler') { e.preventDefault(); return; }
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const newZoom = Math.round(Math.min(3.0, Math.max(0.5, _pinchStartZoom * dist / _pinchStartDist)) * 10) / 10;
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', newZoom);
            }
        }, { passive: false });
    }

    return {
        init(ref) { dotNetRef = ref; },

        async loadPdfFromStream(streamRef, zoom) {
            await ensurePdfJs();
            const bytes = new Uint8Array(await streamRef.arrayBuffer());
            pdfDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
            totalPages = pdfDoc.numPages;
            currentZoom = zoom;
            _pageHandlers = {};
            // Blazor가 이미 canvas 요소를 DOM에 만들어뒀으므로 바로 렌더링
            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, zoom);
            }
            setupScrollAndZoom();
            return totalPages;
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            currentZoom = zoom;
            _pageHandlers = {};
            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, zoom);
            }
        },

        setTool(color, size, isEraser, tool) {
            if (isDrawing) {
                isDrawing = false;
                if (currentPath) { paths.push(currentPath); currentPath = null; }
            }
            _color = color; _size = size; _isEraser = isEraser;
            if (tool !== undefined) _tool = tool;
            const cursor = tool === 'pen' ? 'crosshair' : tool === 'eraser' ? 'cell' : tool === 'ruler' ? 'crosshair' : 'default';
            for (let i = 1; i <= totalPages; i++) {
                const a = getAnnoCanvas(i);
                if (a) a.style.cursor = cursor;
            }
        },

        undo() {
            paths.pop();
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        },

        // ruler 드래그용: 해당 페이지 anno canvas 기준 rect 반환
        getRect(pageNum) {
            const pg = pageNum || currentPageNum;
            const container = document.getElementById('page-container-' + pg);
            if (!container) return [0, 0, 0, 0];
            const r = container.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        },

        clearAnnotations() {
            paths = [];
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        },

        dispose() {
            pdfDoc = null; paths = []; _pageHandlers = {};
            isDrawing = false; currentPath = null;
        },

        preventScroll() {}
    };
})();