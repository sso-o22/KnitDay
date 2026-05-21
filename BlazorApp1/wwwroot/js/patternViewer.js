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
    let _pageHandlers = {};
    let _renderTasks = {};   // pageNum -> ongoing renderTask

    // ── PDF.js 로컬 모듈 로드 ──────────────────────────────────
    let _pdfjsReady = null;

    // Blazor GitHub Pages 환경에서 base href를 기준으로 pdfjs 경로를 동적 계산
    function getPdfjsBase() {
        // <base href="/KnitLog/"> 등 index.html의 base 태그를 따름
        const base = document.querySelector('base')
            ? document.querySelector('base').href
            : (window.location.origin + '/');
        return base.replace(/\/$/, ''); // 끝 슬래시 제거
    }

    async function ensurePdfJs() {
        if (_pdfjsReady) return _pdfjsReady;
        _pdfjsReady = (async () => {
            if (!window.pdfjsLib) {
                const base = getPdfjsBase();
                const mod = await import(base + '/pdfjs/build/pdf.mjs');
                window.pdfjsLib = mod;
            }
            const base = getPdfjsBase();
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + '/pdfjs/build/pdf.worker.mjs';
        })();
        return _pdfjsReady;
    }

    // ── 캔버스 헬퍼 ───────────────────────────────────────────
    function getAnnoCanvas(p) { return document.getElementById('anno-canvas-' + p); }
    function getPdfCanvas(p)  { return document.getElementById('pdf-canvas-'  + p); }

    function getCanvasPos(canvas, e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * scaleX,
            y: (src.clientY - rect.top)  * scaleY
        };
    }

    // ── 어노테이션 다시 그리기 ────────────────────────────────
    function redrawPage(pageNum) {
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const ctx = anno.getContext('2d');
        ctx.clearRect(0, 0, anno.width, anno.height);
        const dpr = window.devicePixelRatio || 1;
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (p.points.length === 0) return;
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth   = p.size * dpr * (currentZoom / p.originZoom);
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.strokeStyle = p.color;
            ctx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            ctx.moveTo(p.points[0].x * currentZoom * dpr,
                       p.points[0].y * currentZoom * dpr);
            for (let i = 1; i < p.points.length; i++) {
                ctx.lineTo(p.points[i].x * currentZoom * dpr,
                           p.points[i].y * currentZoom * dpr);
            }
            ctx.stroke();
            ctx.restore();
        });
    }

    // ── 페이지 핸들러 등록 ────────────────────────────────────
    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) return;
        _pageHandlers[pageNum] = true;
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const dpr = window.devicePixelRatio || 1;

        function onDown(e) {
            if (_tool === 'ruler') {
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown',
                    pos.x / dpr, pos.y / dpr, pageNum);
                if (e.touches) e.preventDefault();
                return;
            }
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            currentPageNum = pageNum;
            isDrawing = true;
            currentPath = {
                page: pageNum, color: _color, size: _size,
                isEraser: _isEraser, originZoom: currentZoom,
                points: [{ x: pos.x / (currentZoom * dpr),
                           y: pos.y / (currentZoom * dpr) }]
            };
            const ctx = anno.getContext('2d');
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            ctx.lineWidth   = _size * dpr;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.strokeStyle = _isEraser ? 'rgba(0,0,0,1)' : _color;
            ctx.globalCompositeOperation = _isEraser ? 'destination-out' : 'source-over';
        }

        function onMove(e) {
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove',
                    pos.x / dpr, pos.y / dpr);
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum) return;
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            if (currentPath) currentPath.points.push({
                x: pos.x / (currentZoom * dpr),
                y: pos.y / (currentZoom * dpr)
            });
            const ctx = anno.getContext('2d');
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

        anno.addEventListener('mousedown',  onDown);
        anno.addEventListener('mousemove',  onMove);
        anno.addEventListener('mouseup',    onUp);
        anno.addEventListener('touchstart', onDown, { passive: false });
        anno.addEventListener('touchmove',  onMove, { passive: false });
        anno.addEventListener('touchend',   onUp);
    }

    // ── 단일 페이지 렌더 (고해상도 DPR 지원) ─────────────────
    async function renderOnePage(pageNum, zoom) {
        if (!pdfDoc) return;
        const pdfCanvas  = getPdfCanvas(pageNum);
        const annoCanvas = getAnnoCanvas(pageNum);
        if (!pdfCanvas || !annoCanvas) return;

        // 이전 렌더 작업 취소
        if (_renderTasks[pageNum]) {
            try { _renderTasks[pageNum].cancel(); } catch (_) {}
            _renderTasks[pageNum] = null;
        }

        const page = await pdfDoc.getPage(pageNum);
        const dpr  = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: zoom });

        // 실제 픽셀 크기 (DPR 반영)
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        const bufW = Math.floor(cssW * dpr);
        const bufH = Math.floor(cssH * dpr);

        pdfCanvas.width   = bufW;
        pdfCanvas.height  = bufH;
        annoCanvas.width  = bufW;
        annoCanvas.height = bufH;

        // CSS 크기는 viewport 기준 (선명하게 보임)
        pdfCanvas.style.width  = annoCanvas.style.width  = cssW + 'px';
        pdfCanvas.style.height = annoCanvas.style.height = cssH + 'px';

        // cursor 설정
        const cursor = _tool === 'pen' ? 'crosshair'
                     : _tool === 'eraser' ? 'cell'
                     : _tool === 'ruler'  ? 'crosshair' : 'default';
        annoCanvas.style.cursor = cursor;

        // PDF 렌더 (DPR 스케일 transform 적용)
        const pdfCtx = pdfCanvas.getContext('2d');
        pdfCtx.save();
        pdfCtx.scale(dpr, dpr);
        const renderViewport = page.getViewport({ scale: zoom });
        const task = page.render({ canvasContext: pdfCtx, viewport: renderViewport });
        _renderTasks[pageNum] = task;
        try {
            await task.promise;
        } catch (err) {
            if (err && err.name !== 'RenderingCancelledException') console.warn('render error', err);
            pdfCtx.restore();
            return;
        }
        pdfCtx.restore();
        _renderTasks[pageNum] = null;

        redrawPage(pageNum);
        _pageHandlers[pageNum] = false;
        addPageHandlers(pageNum);
    }

    // ── 스크롤 & 줌 초기화 ───────────────────────────────────
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
                const delta  = e.deltaY > 0 ? -0.1 : 0.1;
                const newZ   = Math.round(Math.min(3.0, Math.max(0.5, currentZoom + delta)) * 10) / 10;
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', newZ);
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
                const newZ = Math.round(
                    Math.min(3.0, Math.max(0.5, _pinchStartZoom * dist / _pinchStartDist)) * 10) / 10;
                if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', newZ);
            }
        }, { passive: false });
    }

    // ── 최초 로드 시 화면에 꽉 맞는 zoom 계산 ────────────────
    async function calcFitZoom(page) {
        const scrollEl = document.getElementById('scroll-container');
        if (!scrollEl) return 1.0;
        const padding = 32; // 양쪽 16px 패딩
        const availW  = scrollEl.clientWidth  - padding;
        const availH  = scrollEl.clientHeight - padding;
        const vp1     = page.getViewport({ scale: 1.0 });
        const zoomByW = availW  / vp1.width;
        const zoomByH = availH  / vp1.height;
        // 전체 페이지가 화면 안에 딱 맞게 (가로/세로 중 작은 값 선택)
        const fit = Math.min(zoomByW, zoomByH);
        return Math.round(Math.max(0.5, Math.min(3.0, fit)) * 100) / 100;
    }

    // ── 공개 API ─────────────────────────────────────────────
    return {
        init(ref) { dotNetRef = ref; },

        async loadPdfFromStream(streamRef, _ignoredZoom) {
            await ensurePdfJs();
            const bytes = new Uint8Array(await streamRef.arrayBuffer());
            const _base = getPdfjsBase();
            pdfDoc = await window.pdfjsLib.getDocument({
                data: bytes,
                cMapUrl:        _base + '/pdfjs/web/cmaps/',
                cMapPacked:     true,
                standardFontDataUrl: _base + '/pdfjs/web/standard_fonts/'
            }).promise;
            totalPages   = pdfDoc.numPages;
            _pageHandlers = {};
            paths        = [];

            // 1페이지 기준으로 fit-zoom 계산
            const firstPage = await pdfDoc.getPage(1);
            const fitZoom   = await calcFitZoom(firstPage);
            currentZoom     = fitZoom;

            // 모든 페이지 렌더
            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, currentZoom);
            }
            setupScrollAndZoom();

            // Blazor에 zoom 값 동기화
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', currentZoom);
            return totalPages;
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            currentZoom   = zoom;
            _pageHandlers = {};
            // 병렬이 아닌 순차 렌더 (메모리 안정성)
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
            const cursor = tool === 'pen' ? 'crosshair'
                         : tool === 'eraser' ? 'cell'
                         : tool === 'ruler'  ? 'crosshair' : 'default';
            for (let i = 1; i <= totalPages; i++) {
                const a = getAnnoCanvas(i);
                if (a) a.style.cursor = cursor;
            }
        },

        undo() {
            paths.pop();
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        },

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

        endDraw() {
            if (isDrawing) {
                isDrawing = false;
                if (currentPath) { paths.push(currentPath); currentPath = null; }
            }
        },

        dispose() {
            // 진행 중인 렌더 취소
            Object.values(_renderTasks).forEach(t => { try { if(t) t.cancel(); } catch(_){} });
            _renderTasks  = {};
            pdfDoc        = null;
            paths         = [];
            _pageHandlers = {};
            isDrawing     = false;
            currentPath   = null;
        },

        preventScroll() {}
    };
})();