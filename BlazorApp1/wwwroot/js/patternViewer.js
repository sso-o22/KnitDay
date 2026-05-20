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

    // 페이지별 canvas 요소 관리
    let pageCanvases = []; // [{pdfCanvas, annoCanvas, pdfCtx, annoCtx}]
    let _scrollEl = null;
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;
    let _renderQueue = Promise.resolve();

    async function ensurePdfJs() {
        if (window.pdfjsLib) return;
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        document.head.appendChild(s);
        await new Promise(r => s.onload = r);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
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

    function redrawPage(pageIdx) {
        const c = pageCanvases[pageIdx];
        if (!c || !c.annoCtx) return;
        const pageNum = pageIdx + 1;
        c.annoCtx.clearRect(0, 0, c.annoCanvas.width, c.annoCanvas.height);
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (p.points.length === 0) return;
            c.annoCtx.beginPath();
            c.annoCtx.lineWidth = p.size * (currentZoom / p.originZoom);
            c.annoCtx.lineCap = 'round';
            c.annoCtx.lineJoin = 'round';
            c.annoCtx.strokeStyle = p.color;
            c.annoCtx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            c.annoCtx.moveTo(p.points[0].x * currentZoom, p.points[0].y * currentZoom);
            for (let i = 1; i < p.points.length; i++)
                c.annoCtx.lineTo(p.points[i].x * currentZoom, p.points[i].y * currentZoom);
            c.annoCtx.stroke();
        });
        c.annoCtx.globalCompositeOperation = 'source-over';
    }

    async function renderOnePage(pageNum, zoom) {
        const idx = pageNum - 1;
        const c = pageCanvases[idx];
        if (!c || !pdfDoc) return;
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: zoom });
        c.pdfCanvas.width = c.annoCanvas.width = viewport.width;
        c.pdfCanvas.height = c.annoCanvas.height = viewport.height;
        await page.render({ canvasContext: c.pdfCtx, viewport }).promise;
        redrawPage(idx);
        addPageHandlers(idx);
    }

    function addPageHandlers(idx) {
        const c = pageCanvases[idx];
        if (!c || c._handlersAdded) return;
        c._handlersAdded = true;
        const anno = c.annoCanvas;

        function onDown(e) {
            if (_tool === 'ruler') {
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown', pos.x, pos.y);
                if (e.touches) e.preventDefault();
                return;
            }
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            currentPageNum = idx + 1;
            isDrawing = true;
            currentPath = {
                page: currentPageNum, color: _color, size: _size,
                isEraser: _isEraser, originZoom: currentZoom,
                points: [{ x: pos.x / currentZoom, y: pos.y / currentZoom }]
            };
            c.annoCtx.beginPath();
            c.annoCtx.moveTo(pos.x, pos.y);
            c.annoCtx.lineWidth = _size;
            c.annoCtx.lineCap = 'round';
            c.annoCtx.lineJoin = 'round';
            c.annoCtx.strokeStyle = _isEraser ? 'rgba(0,0,0,1)' : _color;
            c.annoCtx.globalCompositeOperation = _isEraser ? 'destination-out' : 'source-over';
        }

        function onMove(e) {
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove', pos.x, pos.y);
                return;
            }
            if (!isDrawing || (_tool !== 'pen' && _tool !== 'eraser')) return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            if (currentPath) currentPath.points.push({ x: pos.x / currentZoom, y: pos.y / currentZoom });
            c.annoCtx.lineTo(pos.x, pos.y);
            c.annoCtx.stroke();
        }

        function onUp(e) {
            if (_tool === 'ruler') {
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchEnd');
                return;
            }
            if (!isDrawing) return;
            isDrawing = false;
            c.annoCtx.globalCompositeOperation = 'source-over';
            if (currentPath) { paths.push(currentPath); currentPath = null; }
        }

        anno.addEventListener('mousedown', onDown);
        anno.addEventListener('mousemove', onMove);
        anno.addEventListener('mouseup', onUp);
        anno.addEventListener('touchstart', onDown, { passive: false });
        anno.addEventListener('touchmove', onMove, { passive: false });
        anno.addEventListener('touchend', onUp);
    }

    function setupScrollTracking() {
        if (!_scrollEl || _scrollEl._scrollTracked) return;
        _scrollEl._scrollTracked = true;

        // 스크롤 위치로 현재 페이지 추적
        _scrollEl.addEventListener('scroll', () => {
            const containers = _scrollEl.querySelectorAll('.page-container');
            let visiblePage = 1;
            for (let i = 0; i < containers.length; i++) {
                const rect = containers[i].getBoundingClientRect();
                const scrollRect = _scrollEl.getBoundingClientRect();
                if (rect.top <= scrollRect.top + scrollRect.height / 2) {
                    visiblePage = i + 1;
                }
            }
            if (visiblePage !== currentPageNum) {
                currentPageNum = visiblePage;
                if (dotNetRef) dotNetRef.invokeMethodAsync('UpdatePageFromJS', currentPageNum);
            }
        }, { passive: true });

        // PC: Ctrl+휠 = 확대/축소, 일반 휠 = 스크롤
        _scrollEl.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newZoom = Math.min(3.0, Math.max(0.5, currentZoom + delta));
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', Math.round(newZoom * 10) / 10);
            }
        }, { passive: false });

        // 모바일: 핀치 줌
        _scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                _pinchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                _pinchStartZoom = currentZoom;
            }
        }, { passive: true });

        _scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler') { e.preventDefault(); return; }
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const scale = dist / _pinchStartDist;
                const newZoom = Math.min(3.0, Math.max(0.5, _pinchStartZoom * scale));
                const rounded = Math.round(newZoom * 10) / 10;
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', rounded);
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

            // 페이지별 컨테이너 생성
            const wrapper = document.getElementById('pdf-wrapper');
            if (!wrapper) return totalPages;
            wrapper.innerHTML = '';
            pageCanvases = [];

            for (let i = 0; i < totalPages; i++) {
                const container = document.createElement('div');
                container.className = 'page-container';
                container.style.cssText = 'position:relative; display:inline-block; margin-bottom:12px;';

                const pdfCanvas = document.createElement('canvas');
                pdfCanvas.style.display = 'block';

                const annoCanvas = document.createElement('canvas');
                annoCanvas.style.cssText = 'position:absolute; top:0; left:0;';
                annoCanvas.style.cursor = 'crosshair';

                container.appendChild(pdfCanvas);
                container.appendChild(annoCanvas);
                wrapper.appendChild(container);

                const pdfCtx = pdfCanvas.getContext('2d');
                const annoCtx = annoCanvas.getContext('2d');
                pageCanvases.push({ pdfCanvas, annoCanvas, pdfCtx, annoCtx, _handlersAdded: false });
            }

            _scrollEl = wrapper.parentElement;
            setupScrollTracking();

            // 모든 페이지 렌더링
            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, zoom);
            }
            return totalPages;
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            currentZoom = zoom;
            for (let i = 1; i <= totalPages; i++) {
                pageCanvases[i-1]._handlersAdded = false;
                await renderOnePage(i, zoom);
            }
        },

        // 특정 페이지로 스크롤
        scrollToPage(pageNum) {
            const wrapper = document.getElementById('pdf-wrapper');
            if (!wrapper) return;
            const containers = wrapper.querySelectorAll('.page-container');
            if (containers[pageNum - 1]) {
                containers[pageNum - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        },

        setTool(color, size, isEraser, tool) {
            if (isDrawing) {
                isDrawing = false;
                if (currentPath) { paths.push(currentPath); currentPath = null; }
            }
            _color = color; _size = size; _isEraser = isEraser;
            if (tool !== undefined) _tool = tool;
            // 커서 업데이트
            const cursor = tool === 'pen' ? 'crosshair' : tool === 'eraser' ? 'cell' : tool === 'ruler' ? 'crosshair' : 'default';
            pageCanvases.forEach(c => { if (c.annoCanvas) c.annoCanvas.style.cursor = cursor; });
        },

        undo() {
            paths.pop();
            pageCanvases.forEach((_, i) => redrawPage(i));
        },

        getRect() {
            // ruler용 — 현재 페이지 canvas 기준
            const idx = currentPageNum - 1;
            const c = pageCanvases[idx];
            if (!c) return [0, 0, 0, 0];
            const r = c.annoCanvas.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        },

        clearAnnotations() {
            paths = [];
            pageCanvases.forEach((_, i) => redrawPage(i));
        },

        dispose() {
            pdfDoc = null; paths = []; pageCanvases = [];
            isDrawing = false; currentPath = null;
        },

        preventScroll() {}
    };
})();