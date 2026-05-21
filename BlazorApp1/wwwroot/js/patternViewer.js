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
    let _renderedPages = new Set();

    // 줌 상태 플래그
    let _fitZoom      = 1.0;
    let _isPinching   = false;
    let _isZooming    = false;   // 휠/핀치 줌 전체 감시 플래그
    let _renderDebounceTimer = null;
    let _pendingZoom  = null;

    // 핀치 추적
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;

    // 페이지 원본 크기 캐시 (zoom=1 기준)
    let _pageSizes = {};   // pageNum -> { w, h }  (viewport px at zoom=1)

    // IntersectionObserver
    let _intersectionObserver = null;

    const RENDER_AHEAD = 1;

    // ── base href ────────────────────────────────────────────
    function getPdfjsBase() {
        const baseEl = document.querySelector('base');
        return (baseEl ? baseEl.href : window.location.origin + '/').replace(/\/$/, '');
    }

    // ── PDF.js 로드 ──────────────────────────────────────────
    let _pdfjsReady = null;
    async function ensurePdfJs() {
        if (_pdfjsReady) return _pdfjsReady;
        _pdfjsReady = new Promise((resolve, reject) => {
            if (window.pdfjsLib) { resolve(); return; }
            const base = getPdfjsBase();
            const cbName = '_pdfjsLoaded_' + Date.now();
            window[cbName] = lib => {
                window.pdfjsLib = lib;
                lib.GlobalWorkerOptions.workerSrc = base + '/pdfjs/build/pdf.worker.mjs';
                delete window[cbName];
                resolve();
            };
            const s = document.createElement('script');
            s.type = 'module';
            s.textContent = 'import * as L from "' + base + '/pdfjs/build/pdf.mjs";window["' + cbName + '"](L);';
            s.onerror = e => { delete window[cbName]; reject(e); };
            document.head.appendChild(s);
        });
        return _pdfjsReady;
    }

    // ── 캔버스 헬퍼 ─────────────────────────────────────────
    function getAnnoCanvas(p) { return document.getElementById('anno-canvas-' + p); }
    function getPdfCanvas(p)  { return document.getElementById('pdf-canvas-'  + p); }

    function getCanvasPos(canvas, e) {
        const rect = canvas.getBoundingClientRect();
        const src  = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * (canvas.width  / rect.width),
            y: (src.clientY - rect.top)  * (canvas.height / rect.height)
        };
    }

    // ── 스크롤 컨테이너 ──────────────────────────────────────
    function getScrollEl() { return document.getElementById('scroll-container'); }

    // ── page-container 크기 즉시 동기화 ─────────────────────
    // 줌 변경 시 레이아웃 무너짐 방지 (렌더 전에 미리 크기 확보)
    function syncContainerSizes(zoom) {
        for (let i = 1; i <= totalPages; i++) {
            const orig = _pageSizes[i];
            if (!orig) continue;
            const container = document.getElementById('page-container-' + i);
            if (container) {
                container.style.width  = Math.floor(orig.w * zoom) + 'px';
                container.style.height = Math.floor(orig.h * zoom) + 'px';
            }
            // canvas도 CSS 크기만 맞춤 (픽셀 버퍼는 렌더 때 설정)
            const pdfCanvas  = getPdfCanvas(i);
            const annoCanvas = getAnnoCanvas(i);
            const cssW = Math.floor(orig.w * zoom);
            const cssH = Math.floor(orig.h * zoom);
            if (pdfCanvas && !_renderedPages.has(i)) {
                pdfCanvas.style.width  = cssW + 'px';
                pdfCanvas.style.height = cssH + 'px';
            }
            if (annoCanvas && !_renderedPages.has(i)) {
                annoCanvas.style.width  = cssW + 'px';
                annoCanvas.style.height = cssH + 'px';
            }
        }
    }

    // ── 어노테이션 다시 그리기 ───────────────────────────────
    function redrawPage(pageNum) {
        const anno = getAnnoCanvas(pageNum);
        if (!anno || !_renderedPages.has(pageNum)) return;
        const ctx = anno.getContext('2d');
        ctx.clearRect(0, 0, anno.width, anno.height);
        const dpr = window.devicePixelRatio || 1;
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (!p.points.length) return;
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth   = p.size * dpr * (currentZoom / p.originZoom);
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.strokeStyle = p.color;
            ctx.globalCompositeOperation = p.isEraser ? 'destination-out' : 'source-over';
            ctx.moveTo(p.points[0].x * currentZoom * dpr, p.points[0].y * currentZoom * dpr);
            for (let i = 1; i < p.points.length; i++)
                ctx.lineTo(p.points[i].x * currentZoom * dpr, p.points[i].y * currentZoom * dpr);
            ctx.stroke();
            ctx.restore();
        });
    }

    // ── 페이지 핸들러 ────────────────────────────────────────
    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) return;
        _pageHandlers[pageNum] = true;
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const dpr = window.devicePixelRatio || 1;

        function onDown(e) {
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') {
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown', pos.x / dpr, pos.y / dpr, pageNum);
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
                points: [{ x: pos.x / (currentZoom * dpr), y: pos.y / (currentZoom * dpr) }]
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
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const pos = getCanvasPos(anno, e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove', pos.x / dpr, pos.y / dpr);
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum || (_tool !== 'pen' && _tool !== 'eraser')) return;
            if (e.touches) e.preventDefault();
            const pos = getCanvasPos(anno, e);
            if (currentPath) currentPath.points.push({ x: pos.x / (currentZoom * dpr), y: pos.y / (currentZoom * dpr) });
            const ctx = anno.getContext('2d');
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        }

        function onUp(e) {
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') { if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchEnd'); return; }
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

    // ── 단일 페이지 렌더 ─────────────────────────────────────
    async function renderOnePage(pageNum, zoom) {
        if (!pdfDoc) return;
        const pdfCanvas  = getPdfCanvas(pageNum);
        const annoCanvas = getAnnoCanvas(pageNum);
        if (!pdfCanvas || !annoCanvas) return;

        if (_renderTasks[pageNum]) {
            try { _renderTasks[pageNum].cancel(); } catch (_) {}
            _renderTasks[pageNum] = null;
        }

        const page     = await pdfDoc.getPage(pageNum);
        const dpr      = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: zoom });
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        const bufW = Math.floor(cssW * dpr);
        const bufH = Math.floor(cssH * dpr);

        pdfCanvas.width  = bufW; pdfCanvas.height  = bufH;
        annoCanvas.width = bufW; annoCanvas.height = bufH;
        pdfCanvas.style.width   = annoCanvas.style.width  = cssW + 'px';
        pdfCanvas.style.height  = annoCanvas.style.height = cssH + 'px';

        const cursor = _tool === 'pen' || _tool === 'ruler' ? 'crosshair' : _tool === 'eraser' ? 'cell' : 'default';
        annoCanvas.style.cursor = cursor;

        const ctx = pdfCanvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        const task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: zoom }) });
        _renderTasks[pageNum] = task;
        try {
            await task.promise;
        } catch (err) {
            if (err?.name !== 'RenderingCancelledException') console.warn('render err p' + pageNum, err);
            ctx.restore();
            return;
        }
        ctx.restore();
        _renderTasks[pageNum] = null;
        _renderedPages.add(pageNum);
        redrawPage(pageNum);
        _pageHandlers[pageNum] = false;
        addPageHandlers(pageNum);
    }

    // ── 범위 밖 페이지 언로드 ───────────────────────────────
    function unloadPage(pageNum) {
        if (!_renderedPages.has(pageNum)) return;
        const pc = getPdfCanvas(pageNum);
        const ac = getAnnoCanvas(pageNum);
        if (pc) { pc.width = 1; pc.height = 1; }
        if (ac) { ac.width = 1; ac.height = 1; }
        _renderedPages.delete(pageNum);
        _pageHandlers[pageNum] = false;
    }

    // ── 현재 페이지 기준 가상화 렌더 ────────────────────────
    async function virtualizeRender(zoom) {
        if (!pdfDoc) return;
        const from = Math.max(1, currentPageNum - RENDER_AHEAD);
        const to   = Math.min(totalPages, currentPageNum + RENDER_AHEAD);
        for (let i = 1; i <= totalPages; i++) { if (i < from || i > to) unloadPage(i); }
        for (let i = from; i <= to; i++) { if (!_renderedPages.has(i)) await renderOnePage(i, zoom); }
    }

    // ── IntersectionObserver ─────────────────────────────────
    function setupIntersectionObserver() {
        if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver = null; }
        const scrollEl = getScrollEl();
        if (!scrollEl) return;

        _intersectionObserver = new IntersectionObserver(entries => {
            // 줌 동작 중에는 스크롤 감지 완전 차단 (currentPageNum 변경 방지)
            if (_isPinching || _isZooming) return;
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const pageNum = parseInt(entry.target.id.replace('page-container-', ''), 10);
                if (!isNaN(pageNum) && !_renderedPages.has(pageNum)) {
                    renderOnePage(pageNum, currentZoom);
                }
            });
        }, {
            root: scrollEl,
            rootMargin: '300px 0px 300px 0px',
            threshold: 0
        });

        for (let i = 1; i <= totalPages; i++) {
            const el = document.getElementById('page-container-' + i);
            if (el) _intersectionObserver.observe(el);
        }
    }

    // ── 스크롤 이벤트 ────────────────────────────────────────
    function onScroll() {
        if (_isPinching || _isZooming) return;
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        const mid = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight / 2;
        let found = 1;
        for (let i = 1; i <= totalPages; i++) {
            const el = document.getElementById('page-container-' + i);
            if (el && el.getBoundingClientRect().top <= mid) found = i;
        }
        if (found !== currentPageNum) {
            currentPageNum = found;
            if (dotNetRef) dotNetRef.invokeMethodAsync('UpdatePageFromJS', found);
        }
    }

    // ── 줌 변경 핵심 함수 ────────────────────────────────────
    // 스크롤 비율(%) 저장 → 컨테이너 크기 즉시 동기화 → 스크롤 복원 → 디바운스 렌더
    function changeZoom(newZoom, anchorDocY, anchorViewY) {
        if (!pdfDoc) return;

        // 줌 플래그 ON → Observer·스크롤 감지 차단
        _isZooming = true;
        _pendingZoom = newZoom;

        const scrollEl = getScrollEl();

        // 스크롤 비율 저장 (anchorDocY가 있으면 앵커 방식, 없으면 비율 방식)
        let scrollPercent = 0;
        if (scrollEl) {
            scrollPercent = scrollEl.scrollTop / (scrollEl.scrollHeight || 1);
        }

        if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(async () => {
            if (!pdfDoc) return;
            const targetZoom = _pendingZoom;
            _pendingZoom = null;
            const prevZoom = currentZoom;
            currentZoom = targetZoom;

            // CSS transform 제거
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) { wrapper.style.transform = ''; wrapper.style.transformOrigin = ''; }

            // 렌더 캐시 무효화
            _renderedPages.clear();
            _pageHandlers = {};

            // 컨테이너 크기 즉시 동기화 (레이아웃 무너짐 방지)
            syncContainerSizes(targetZoom);

            // 스크롤 위치 복원
            if (scrollEl) {
                if (anchorDocY !== undefined && anchorViewY !== undefined) {
                    // 앵커 방식: 기준점이 화면 같은 위치에 오도록
                    scrollEl.scrollTop = Math.max(0, anchorDocY * (targetZoom / prevZoom) - anchorViewY);
                } else {
                    // 비율 방식: 같은 비율 위치 유지
                    scrollEl.scrollTop = scrollPercent * scrollEl.scrollHeight;
                }
            }

            // 현재 보이는 페이지 렌더
            await virtualizeRender(targetZoom);
            setupIntersectionObserver();

            // 렌더 완료 후 줌 플래그 OFF
            setTimeout(() => { _isZooming = false; }, 100);

            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', targetZoom);
        }, 200);
    }

    // ── CSS transform (핀치/휠 중 시각 피드백) ──────────────
    function applyScaleTransform(newZoom, originClientX, originClientY) {
        const wrapper  = document.getElementById('pdf-wrapper');
        const scrollEl = getScrollEl();
        if (!wrapper || !scrollEl) return;
        const ratio  = newZoom / currentZoom;
        if (originClientX !== undefined) {
            const wRect = wrapper.getBoundingClientRect();
            wrapper.style.transformOrigin = (originClientX - wRect.left) + 'px ' + (originClientY - wRect.top) + 'px';
        } else {
            wrapper.style.transformOrigin = 'top center';
        }
        wrapper.style.transform = 'scale(' + ratio + ')';
    }

    // ── fit-zoom 계산 ────────────────────────────────────────
    async function calcFitZoom(page) {
        const scrollEl = getScrollEl();
        if (!scrollEl) return 1.0;
        const vp1 = page.getViewport({ scale: 1.0 });
        const fit = Math.min((scrollEl.clientWidth - 32) / vp1.width,
                             (scrollEl.clientHeight - 32) / vp1.height);
        return Math.round(Math.max(0.1, Math.min(3.0, fit)) * 100) / 100;
    }

    // ── 이벤트 초기화 ────────────────────────────────────────
    function setupScrollAndZoom() {
        const scrollEl = getScrollEl();
        if (!scrollEl || scrollEl._bound) return;
        scrollEl._bound = true;

        scrollEl.addEventListener('scroll', onScroll, { passive: true });
        setupIntersectionObserver();

        // PC: Ctrl+휠
        let _wheelAnchorDocY = 0, _wheelAnchorViewY = 0;
        scrollEl.addEventListener('wheel', e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const maxZ = Math.max(3.0, _fitZoom * 5);
            const minZ = _fitZoom * 0.3;

            // deltaY를 비례값으로 변환 → 부드러운 연속 확대 (픽셀/라인/페이지 단위 통일)
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 20;       // 라인 단위 → 픽셀
            if (e.deltaMode === 2) dy *= 300;      // 페이지 단위 → 픽셀
            const factor = Math.exp(-dy * 0.003);  // 지수 스케일: 자연스러운 배율 변화
            const rawZ   = (_pendingZoom !== null ? _pendingZoom : currentZoom) * factor;
            const newZ   = Math.min(maxZ, Math.max(minZ, rawZ));

            // 첫 휠: 앵커 기록
            if (!_isZooming && _pendingZoom === null) {
                const scRect = scrollEl.getBoundingClientRect();
                _wheelAnchorViewY = e.clientY - scRect.top;
                _wheelAnchorDocY  = scrollEl.scrollTop + _wheelAnchorViewY;
            }
            applyScaleTransform(newZ, e.clientX, e.clientY);
            changeZoom(newZ, _wheelAnchorDocY, _wheelAnchorViewY);
        }, { passive: false });

        // 모바일: 핀치
        scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length !== 2) return;
            _isPinching    = true;
            _isZooming     = true;
            isDrawing      = false;
            _pinchStartDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            _pinchStartZoom = currentZoom;
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const scRect = scrollEl.getBoundingClientRect();
            scrollEl._pinchAnchorViewY = cy - scRect.top;
            scrollEl._pinchAnchorDocY  = scrollEl.scrollTop + scrollEl._pinchAnchorViewY;

            // 핀치 시작 시 canvas 픽셀 버퍼 즉시 해제 (iOS 메모리 절약)
            // CSS 크기는 유지 → 레이아웃 안 깨짐, transform으로 시각 피드백
            for (let i = 1; i <= totalPages; i++) {
                const pc = getPdfCanvas(i);
                const ac = getAnnoCanvas(i);
                if (pc && pc.width > 1) { pc.width = 1; pc.height = 1; }
                if (ac && ac.width > 1) { ac.width = 1; ac.height = 1; }
            }
            _renderedPages.clear();

            e.preventDefault();
        }, { passive: false });

        scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler' && e.touches.length === 1) { e.preventDefault(); return; }
            if (e.touches.length !== 2) return;
            e.preventDefault();
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const maxZ = Math.max(3.0, _fitZoom * 5);
            const minZ = _fitZoom * 0.3;
            const newZ = Math.min(maxZ, Math.max(minZ, _pinchStartZoom * dist / _pinchStartDist));
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            applyScaleTransform(newZ, cx, cy);
            _pendingZoom = Math.round(newZ * 10) / 10;
        }, { passive: false });

        scrollEl.addEventListener('touchend', e => {
            if (!_isPinching || e.touches.length >= 2) return;
            const finalZoom = _pendingZoom;
            setTimeout(() => {
                _isPinching = false;
                if (finalZoom !== null) {
                    changeZoom(finalZoom, scrollEl._pinchAnchorDocY, scrollEl._pinchAnchorViewY);
                } else {
                    _isZooming = false;
                }
            }, 50);
        }, { passive: true });
    }

    // ── 공개 API ────────────────────────────────────────────
    return {
        init(ref) { dotNetRef = ref; },

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
            totalPages     = pdfDoc.numPages;
            _pageHandlers  = {};
            _renderedPages = new Set();
            _pageSizes     = {};
            paths          = [];

            // 페이지 원본 크기 캐시 (zoom=1 기준, 1페이지 값으로 전체 통일)
            const p1   = await pdfDoc.getPage(1);
            const vp1  = p1.getViewport({ scale: 1.0 });
            const size = { w: vp1.width, h: vp1.height };
            for (let i = 1; i <= totalPages; i++) _pageSizes[i] = size;

            return totalPages;
        },

        async renderPdf() {
            if (!pdfDoc) return;
            const firstPage = await pdfDoc.getPage(1);
            const fitZoom   = await calcFitZoom(firstPage);
            _fitZoom        = fitZoom;
            currentZoom     = fitZoom;
            currentPageNum  = 1;

            syncContainerSizes(currentZoom);
            await virtualizeRender(currentZoom);
            setupScrollAndZoom();
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', currentZoom);
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            if (_renderDebounceTimer) { clearTimeout(_renderDebounceTimer); _renderDebounceTimer = null; }
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) { wrapper.style.transform = ''; wrapper.style.transformOrigin = ''; }
            const maxZ = Math.max(3.0, _fitZoom * 5);
            const minZ = _fitZoom * 0.3;
            zoom = Math.min(maxZ, Math.max(minZ, zoom));
            currentZoom    = zoom;
            _renderedPages = new Set();
            _pageHandlers  = {};
            syncContainerSizes(zoom);
            await virtualizeRender(zoom);
            setupIntersectionObserver();
        },

        setTool(color, size, isEraser, tool) {
            if (isDrawing) { isDrawing = false; if (currentPath) { paths.push(currentPath); currentPath = null; } }
            _color = color; _size = size; _isEraser = isEraser;
            if (tool !== undefined) _tool = tool;
            const cursor = (tool === 'pen' || tool === 'ruler') ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';
            for (let i = 1; i <= totalPages; i++) { const a = getAnnoCanvas(i); if (a) a.style.cursor = cursor; }
        },

        undo() { paths.pop(); for (let i = 1; i <= totalPages; i++) redrawPage(i); },

        getRect(pageNum) {
            const el = document.getElementById('page-container-' + (pageNum || currentPageNum));
            if (!el) return [0, 0, 0, 0];
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        },

        clearAnnotations() { paths = []; for (let i = 1; i <= totalPages; i++) redrawPage(i); },

        endDraw() {
            if (isDrawing) { isDrawing = false; if (currentPath) { paths.push(currentPath); currentPath = null; } }
        },

        dispose() {
            if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
            if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver = null; }
            Object.values(_renderTasks).forEach(t => { try { if (t) t.cancel(); } catch (_) {} });
            _renderTasks   = {};
            _renderedPages = new Set();
            _pageSizes     = {};
            pdfDoc         = null;
            paths          = [];
            _pageHandlers  = {};
            isDrawing      = false;
            currentPath    = null;
            _isPinching    = false;
            _isZooming     = false;
        },

        preventScroll() {}
    };
})();