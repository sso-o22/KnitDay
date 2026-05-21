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
    let _pageHandlers = {};
    let _renderTasks = {};

    // 핀치/휠 줌 상태
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;
    let _isPinching = false;
    let _renderDebounceTimer = null;
    let _pendingZoom = null;

    // ── base href 기준 절대경로 (GitHub Pages 대응) ──────────
    function getPdfjsBase() {
        const baseEl = document.querySelector('base');
        const href = baseEl ? baseEl.href : (window.location.origin + '/');
        return href.replace(/\/$/, '');
    }

    // ── PDF.js inline module script 로드 ────────────────────
    let _pdfjsReady = null;
    async function ensurePdfJs() {
        if (_pdfjsReady) return _pdfjsReady;
        _pdfjsReady = new Promise((resolve, reject) => {
            if (window.pdfjsLib) { resolve(); return; }
            const base = getPdfjsBase();
            const scriptSrc = base + '/pdfjs/build/pdf.mjs';
            const workerSrc = base + '/pdfjs/build/pdf.worker.mjs';
            const cbName = '_pdfjsLoaded_' + Date.now();
            window[cbName] = function(lib) {
                window.pdfjsLib = lib;
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
                delete window[cbName];
                resolve();
            };
            const s = document.createElement('script');
            s.type = 'module';
            s.textContent =
                'import * as pdfjsLib from "' + scriptSrc + '";' +
                'window["' + cbName + '"](pdfjsLib);';
            s.onerror = function(e) { delete window[cbName]; reject(e); };
            document.head.appendChild(s);
        });
        return _pdfjsReady;
    }

    // ── 캔버스 헬퍼 ─────────────────────────────────────────
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

    // ── pdf-wrapper에 CSS transform scale 적용 (즉각 반응) ──
    function applyScaleTransform(zoom) {
        const wrapper = document.getElementById('pdf-wrapper');
        if (!wrapper) return;
        const ratio = zoom / currentZoom;
        wrapper.style.transform = 'scale(' + ratio + ')';
        wrapper.style.transformOrigin = 'top center';
    }

    function clearScaleTransform() {
        const wrapper = document.getElementById('pdf-wrapper');
        if (!wrapper) return;
        wrapper.style.transform = '';
        wrapper.style.transformOrigin = '';
    }

    // ── 어노테이션 다시 그리기 ───────────────────────────────
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

    // ── 페이지 핸들러 등록 ───────────────────────────────────
    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) return;
        _pageHandlers[pageNum] = true;
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const dpr = window.devicePixelRatio || 1;

        function onDown(e) {
            if (_isPinching) return;
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
            if (_isPinching) return;
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
            if (_isPinching) return;
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

    // ── 단일 페이지 렌더 (고해상도 DPR) ─────────────────────
    async function renderOnePage(pageNum, zoom) {
        if (!pdfDoc) return;
        const pdfCanvas  = getPdfCanvas(pageNum);
        const annoCanvas = getAnnoCanvas(pageNum);
        if (!pdfCanvas || !annoCanvas) return;

        if (_renderTasks[pageNum]) {
            try { _renderTasks[pageNum].cancel(); } catch (_) {}
            _renderTasks[pageNum] = null;
        }

        const page = await pdfDoc.getPage(pageNum);
        const dpr  = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: zoom });

        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        const bufW = Math.floor(cssW * dpr);
        const bufH = Math.floor(cssH * dpr);

        pdfCanvas.width   = bufW;
        pdfCanvas.height  = bufH;
        annoCanvas.width  = bufW;
        annoCanvas.height = bufH;

        pdfCanvas.style.width  = annoCanvas.style.width  = cssW + 'px';
        pdfCanvas.style.height = annoCanvas.style.height = cssH + 'px';

        const cursor = _tool === 'pen' ? 'crosshair'
                     : _tool === 'eraser' ? 'cell'
                     : _tool === 'ruler'  ? 'crosshair' : 'default';
        annoCanvas.style.cursor = cursor;

        const pdfCtx = pdfCanvas.getContext('2d');
        pdfCtx.save();
        pdfCtx.scale(dpr, dpr);
        const task = page.render({ canvasContext: pdfCtx, viewport: page.getViewport({ scale: zoom }) });
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

    // ── 디바운스된 전체 재렌더 (줌 조작 끝난 후) ────────────
    function scheduleRerender(zoom) {
        _pendingZoom = zoom;
        if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(async () => {
            if (!pdfDoc || _pendingZoom === null) return;
            const targetZoom = _pendingZoom;
            _pendingZoom = null;
            currentZoom = targetZoom;
            clearScaleTransform();
            _pageHandlers = {};
            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, targetZoom);
            }
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', targetZoom);
        }, 300); // 300ms 후 재렌더
    }

    // ── 스크롤 & 줌 초기화 ──────────────────────────────────
    function setupScrollAndZoom() {
        const scrollEl = document.getElementById('scroll-container');
        if (!scrollEl || scrollEl._bound) return;
        scrollEl._bound = true;

        // 스크롤 → 현재 페이지 추적
        scrollEl.addEventListener('scroll', () => {
            if (_isPinching) return;
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

        // PC: Ctrl+휠 → CSS scale 즉각 반응 + 디바운스 재렌더
        scrollEl.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                const newZ  = Math.round(Math.min(3.0, Math.max(0.5, currentZoom + delta)) * 10) / 10;
                applyScaleTransform(newZ);
                scheduleRerender(newZ);
            }
        }, { passive: false });

        // 모바일: 핀치 줌 시작
        scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                _isPinching = true;
                isDrawing = false; // 혹시 그리던 것 중단
                _pinchStartDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                _pinchStartZoom = currentZoom;
                e.preventDefault();
            }
        }, { passive: false });

        // 모바일: 핀치 줌 중 → CSS scale만 (렌더 없음)
        scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler' && e.touches.length === 1) { e.preventDefault(); return; }
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const newZ = Math.min(3.0, Math.max(0.5, _pinchStartZoom * dist / _pinchStartDist));
                applyScaleTransform(newZ);
                _pendingZoom = Math.round(newZ * 10) / 10;
            }
        }, { passive: false });

        // 모바일: 핀치 줌 끝 → 디바운스 재렌더
        scrollEl.addEventListener('touchend', e => {
            if (_isPinching && e.touches.length < 2) {
                _isPinching = false;
                if (_pendingZoom !== null) {
                    scheduleRerender(_pendingZoom);
                }
            }
        }, { passive: true });
    }

    // ── fit-zoom 계산 ────────────────────────────────────────
    async function calcFitZoom(page) {
        const scrollEl = document.getElementById('scroll-container');
        if (!scrollEl) return 1.0;
        const padding = 32;
        const availW  = scrollEl.clientWidth  - padding;
        const availH  = scrollEl.clientHeight - padding;
        const vp1     = page.getViewport({ scale: 1.0 });
        const fit = Math.min(availW / vp1.width, availH / vp1.height);
        return Math.round(Math.max(0.5, Math.min(3.0, fit)) * 100) / 100;
    }

    // ── 공개 API ────────────────────────────────────────────
    return {
        init(ref) { dotNetRef = ref; },

        // 1단계: 바이트 로드 + 페이지 수 반환
        async loadPdfBytes(streamRef) {
            await ensurePdfJs();
            const base  = getPdfjsBase();
            const bytes = new Uint8Array(await streamRef.arrayBuffer());
            pdfDoc = await window.pdfjsLib.getDocument({
                data: bytes,
                cMapUrl:             base + '/pdfjs/web/cmaps/',
                cMapPacked:          true,
                standardFontDataUrl: base + '/pdfjs/web/standard_fonts/'
            }).promise;
            totalPages    = pdfDoc.numPages;
            _pageHandlers = {};
            paths         = [];
            return totalPages;
        },

        // 2단계: DOM 준비 후 실제 렌더
        async renderPdf() {
            if (!pdfDoc) return;
            const firstPage = await pdfDoc.getPage(1);
            const fitZoom   = await calcFitZoom(firstPage);
            currentZoom     = fitZoom;

            for (let i = 1; i <= totalPages; i++) {
                await renderOnePage(i, currentZoom);
            }
            setupScrollAndZoom();
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', currentZoom);
        },

        // Blazor +/- 버튼용 (디바운스 없이 바로 재렌더)
        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            if (_renderDebounceTimer) { clearTimeout(_renderDebounceTimer); _renderDebounceTimer = null; }
            clearScaleTransform();
            currentZoom   = zoom;
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
            if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
            Object.values(_renderTasks).forEach(t => { try { if (t) t.cancel(); } catch (_) {} });
            _renderTasks  = {};
            pdfDoc        = null;
            paths         = [];
            _pageHandlers = {};
            isDrawing     = false;
            currentPath   = null;
            _isPinching   = false;
        },

        preventScroll() {}
    };
})();