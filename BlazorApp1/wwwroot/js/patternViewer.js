window.patternViewer = (() => {
    // ── IndexedDB: PDF 파일 저장/불러오기 ───────────────────
    const IDB_NAME = 'KnitLogPatternDB';
    const IDB_VER  = 1;
    const IDB_STORE = 'patterns';

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VER);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE))
                    db.createObjectStore(IDB_STORE, { keyPath: 'projectId' });
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    async function savePdfToIDB(projectId, bytes, fileName) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({ projectId, bytes, fileName, savedAt: Date.now() });
            tx.oncomplete = resolve;
            tx.onerror    = e => reject(e.target.error);
        });
    }

    async function loadPdfFromIDB(projectId) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(projectId);
            req.onsuccess = e => resolve(e.target.result || null);
            req.onerror   = e => reject(e.target.error);
        });
    }

    async function deletePdfFromIDB(projectId) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(projectId);
            tx.oncomplete = resolve;
            tx.onerror    = e => reject(e.target.error);
        });
    }

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
    let _opacity = 1.0; // 펜 투명도
    let _lastPdfBytes = null; // 마지막 로드한 PDF bytes (IDB 저장용)

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

    // 모든 페이지 핸들러 AbortController 해제
    function abortAllPageHandlers() {
        Object.values(_pageHandlers).forEach(ac => { try { if (ac && ac.abort) ac.abort(); } catch (_) {} });
        _pageHandlers = {};
    }

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

    // ── 어노테이션 다시 그리기 ───────────────────────────────
    // 저장 좌표: zoom=1 기준 CSS px (정규화)
    // 캔버스 버퍼: cssW*dpr x cssH*dpr
    // 그릴 때 버퍼 좌표 = normCoord * currentZoom * dpr
    function redrawPage(pageNum) {
        const anno = getAnnoCanvas(pageNum);
        if (!anno || !_renderedPages.has(pageNum)) return;
        const ctx = anno.getContext('2d');
        ctx.clearRect(0, 0, anno.width, anno.height);
        const dpr = window.devicePixelRatio || 1;
        const scale = currentZoom * dpr;
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (!p.points.length) return;
            ctx.save();
            ctx.beginPath();
            ctx.lineWidth = p.size * scale;
            ctx.lineCap   = 'round';
            ctx.lineJoin  = 'round';
            if (p.isEraser) {
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(0,0,0,1)';
                ctx.globalCompositeOperation = 'destination-out';
            } else {
                ctx.globalAlpha = (p.opacity !== undefined) ? p.opacity : 1.0;
                ctx.strokeStyle = p.color;
                ctx.globalCompositeOperation = 'source-over';
            }
            ctx.moveTo(p.points[0].x * scale, p.points[0].y * scale);
            for (let i = 1; i < p.points.length; i++)
                ctx.lineTo(p.points[i].x * scale, p.points[i].y * scale);
            ctx.stroke();
            ctx.restore();
        });
    }

    // ── 페이지 핸들러 ────────────────────────────────────────
    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) _pageHandlers[pageNum].abort();
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;

        const ac = new AbortController();
        _pageHandlers[pageNum] = ac;
        const sig = { signal: ac.signal };

        // 터치/마우스 → canvas 기준 CSS px 좌표
        // anno CSS size = cssW x cssH, buffer size = cssW*dpr x cssH*dpr
        // clientX - rect.left = CSS px 위치 (스크롤 자동 반영)
        function getCssPos(e) {
            const rect = anno.getBoundingClientRect();
            const src  = e.touches ? e.touches[0] : e;
            return {
                x: src.clientX - rect.left,
                y: src.clientY - rect.top
            };
        }

        function onDown(e) {
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') {
                const pos = getCssPos(e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown', pos.x, pos.y, pageNum);
                if (e.touches) e.preventDefault();
                return;
            }
            if (_tool !== 'pen' && _tool !== 'eraser') return;
            if (e.touches) e.preventDefault();
            const pos = getCssPos(e);
            currentPageNum = pageNum;
            isDrawing = true;
            console.log("[PEN] pos="+pos.x.toFixed(0)+","+pos.y.toFixed(0)+" cssW="+anno.offsetWidth+" cssH="+anno.offsetHeight+" bufW="+anno.width+" bufH="+anno.height+" dpr="+window.devicePixelRatio+" zoom="+currentZoom.toFixed(2));
            const dpr = window.devicePixelRatio || 1;
            // 정규화 저장: CSS px / currentZoom
            currentPath = {
                page: pageNum, color: _color, opacity: _opacity, size: _size,
                isEraser: _isEraser,
                points: [{ x: pos.x / currentZoom, y: pos.y / currentZoom }]
            };
            const ctx = anno.getContext('2d');
            ctx.beginPath();
            ctx.moveTo(pos.x * dpr, pos.y * dpr);
            ctx.lineWidth = _size * currentZoom * dpr;
            ctx.lineCap   = 'round';
            ctx.lineJoin  = 'round';
            if (_isEraser) {
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(0,0,0,1)';
                ctx.globalCompositeOperation = 'destination-out';
            } else {
                ctx.globalAlpha = _opacity;
                ctx.strokeStyle = _color;
                ctx.globalCompositeOperation = 'source-over';
            }
        }

        function onMove(e) {
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const pos = getCssPos(e);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove', pos.x, pos.y);
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum || (_tool !== 'pen' && _tool !== 'eraser')) return;
            if (e.touches) e.preventDefault();
            const pos = getCssPos(e);
            const dpr = window.devicePixelRatio || 1;
            if (currentPath) currentPath.points.push({ x: pos.x / currentZoom, y: pos.y / currentZoom });
            const ctx = anno.getContext('2d');
            ctx.lineTo(pos.x * dpr, pos.y * dpr);
            ctx.stroke();
        }

        function onUp(e) {
            if (_isPinching) return;
            if (_tool === 'ruler') { if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchEnd'); return; }
            if (!isDrawing || currentPageNum !== pageNum) return;
            isDrawing = false;
            const ctx = anno.getContext('2d');
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1.0;
            if (currentPath) {
                paths.push(currentPath);
                currentPath = null;
                if (dotNetRef) dotNetRef.invokeMethodAsync('NotifyAnnotationChanged');
            }
        }

        anno.addEventListener('mousedown',  onDown, sig);
        anno.addEventListener('mousemove',  onMove, sig);
        anno.addEventListener('mouseup',    onUp,   sig);
        anno.addEventListener('touchstart', onDown, { passive: false, signal: ac.signal });
        anno.addEventListener('touchmove',  onMove, { passive: false, signal: ac.signal });
        anno.addEventListener('touchend',   onUp,   sig);
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
        if (_pageHandlers[pageNum]) { _pageHandlers[pageNum].abort(); _pageHandlers[pageNum] = null; }
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
        _isZooming = true;   // Observer·스크롤 감지 차단
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
            if (wrapper) { wrapper.style.transform = ''; wrapper.style.transformOrigin = ''; wrapper.style.opacity = '1'; }

            // 렌더 캐시 무효화 + canvas 버퍼 즉시 해제 (축소 시 메모리 급증 방지)
            for (let i = 1; i <= totalPages; i++) {
                if (_renderTasks[i]) { try { _renderTasks[i].cancel(); } catch(_){} _renderTasks[i] = null; }
                const pc = getPdfCanvas(i);
                const ac = getAnnoCanvas(i);
                if (pc && pc.width > 1) { pc.width = 1; pc.height = 1; }
                if (ac && ac.width > 1) { ac.width = 1; ac.height = 1; }
            }
            _renderedPages.clear();
            abortAllPageHandlers();

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

            // opacity 복원 + 줌 플래그 OFF
            const wrapperAfter = document.getElementById('pdf-wrapper');
            if (wrapperAfter) wrapperAfter.style.opacity = '1';
            // 렌더 직후 바로 해제 (50ms만 유지 → 그리기 빠르게 복귀)
            setTimeout(() => { _isZooming = false; }, 50);

            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', targetZoom);
        }, 180);
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
        return Math.round(Math.max(0.1, Math.min(2.0, fit)) * 100) / 100;
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
            const maxZ = Math.min(4.0, _fitZoom * 6);
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
        // rAF 스로틀링용 변수 (touchmove마다 렌더하지 않고 프레임당 1회만)
        let _pinchRafId = null;
        let _pinchLatestDist = 0;
        let _pinchLatestCx = 0;
        let _pinchLatestCy = 0;
        let _pinchWrapperRect = null; // touchstart 때 캐싱 → touchmove 중 getBoundingClientRect 호출 제거

        scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length !== 2) return;
            _isPinching    = true;
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

            // wrapper rect 캐싱 (핀치 중 getBoundingClientRect 호출 제거)
            const wrapper = document.getElementById('pdf-wrapper');
            _pinchWrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
            if (wrapper) wrapper.style.willChange = 'transform'; // GPU 레이어 미리 확보

            e.preventDefault();
        }, { passive: false });

        scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler' && e.touches.length === 1) { e.preventDefault(); return; }
            if (e.touches.length !== 2) return;
            e.preventDefault();

            // 최신 터치 값만 저장 (rAF에서 소비)
            _pinchLatestDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            _pinchLatestCx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            _pinchLatestCy = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            // rAF가 이미 예약된 경우 중복 예약 안 함 (프레임당 1회만 실행)
            if (_pinchRafId !== null) return;
            _pinchRafId = requestAnimationFrame(() => {
                _pinchRafId = null;
                if (!_isPinching) return;
                const maxZ = Math.min(4.0, _fitZoom * 6);
                const minZ = _fitZoom * 0.3;
                const newZ = Math.min(maxZ, Math.max(minZ,
                    _pinchStartZoom * _pinchLatestDist / _pinchStartDist));

                // 캐싱된 rect 사용 (reflow 없음)
                const wrapper = document.getElementById('pdf-wrapper');
                if (wrapper && _pinchWrapperRect) {
                    wrapper.style.transformOrigin =
                        (_pinchLatestCx - _pinchWrapperRect.left) + 'px ' +
                        (_pinchLatestCy - _pinchWrapperRect.top)  + 'px';
                    wrapper.style.transform = 'scale(' + (newZ / currentZoom) + ')';
                }
                _pendingZoom = Math.round(newZ * 10) / 10;
            });
        }, { passive: false });

        scrollEl.addEventListener('touchend', e => {
            if (!_isPinching || e.touches.length >= 2) return;

            // 미처리 rAF 취소
            if (_pinchRafId !== null) { cancelAnimationFrame(_pinchRafId); _pinchRafId = null; }
            _pinchWrapperRect = null;

            // willChange 해제 (GPU 레이어 반환)
            const wrapperClean = document.getElementById('pdf-wrapper');
            if (wrapperClean) wrapperClean.style.willChange = '';

            const finalZoom = _pendingZoom;
            setTimeout(() => {
                _isPinching = false;
                if (finalZoom !== null) {
                    changeZoom(finalZoom, scrollEl._pinchAnchorDocY, scrollEl._pinchAnchorViewY);
                } else {
                    _isZooming = false;
                    const w = document.getElementById('pdf-wrapper');
                    if (w) { w.style.transform = ''; w.style.transformOrigin = ''; }
                }
            }, 50);
        }, { passive: true });
    }

    // ── 공개 API ────────────────────────────────────────────
    return {
        init(ref) { dotNetRef = ref; },

        // DotNetStreamReference 방식 (기존, 일부 환경)
        async loadPdfBytes(streamRef) {
            const raw = await streamRef.arrayBuffer();
            const bytes = new Uint8Array(raw);
            return await this._loadPdfData(bytes);
        },

        // Base64 방식 - iOS Safari 호환 (arrayBuffer 내부 URL 404 우회)
        async loadPdfBase64(base64String) {
            const binaryStr = atob(base64String);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            return await this._loadPdfData(bytes);
        },

        // 공통 로드 로직
        async _loadPdfData(bytes) {
            await ensurePdfJs();
            const base = getPdfjsBase();
            // PDF.js가 bytes의 ArrayBuffer 소유권을 transfer함 → 복사본을 IDB용으로 먼저 저장
            _lastPdfBytes = bytes.slice(0); // slice()로 독립 복사본 생성
            pdfDoc = await window.pdfjsLib.getDocument({
                data: bytes,
                cMapUrl:             base + '/pdfjs/web/cmaps/',
                cMapPacked:          true,
                standardFontDataUrl: base + '/pdfjs/web/standard_fonts/'
            }).promise;
            totalPages     = pdfDoc.numPages;
            abortAllPageHandlers();
            _renderedPages = new Set();
            _pageSizes     = {};
            paths          = [];

            const p1  = await pdfDoc.getPage(1);
            const vp1 = p1.getViewport({ scale: 1.0 });
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
            if (wrapper) { wrapper.style.transform = ''; wrapper.style.transformOrigin = ''; wrapper.style.opacity = '1'; }
            const maxZ = Math.min(4.0, _fitZoom * 6);
            const minZ = _fitZoom * 0.3;
            zoom = Math.min(maxZ, Math.max(minZ, zoom));
            currentZoom    = zoom;
            _renderedPages = new Set();
            abortAllPageHandlers();
            syncContainerSizes(zoom);
            await virtualizeRender(zoom);
            setupIntersectionObserver();
        },

        setTool(color, size, isEraser, tool, opacity) {
            if (isDrawing) { isDrawing = false; if (currentPath) { paths.push(currentPath); currentPath = null; } }
            _color = color; _size = size; _isEraser = isEraser;
            _opacity = (opacity !== undefined) ? Math.max(0.1, Math.min(1.0, opacity / 100)) : 1.0;
            if (tool !== undefined) _tool = tool;
            const cursor = (tool === 'pen' || tool === 'ruler') ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';
            for (let i = 1; i <= totalPages; i++) { const a = getAnnoCanvas(i); if (a) a.style.cursor = cursor; }
        },

        undo() {
            paths.pop();
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
            if (dotNetRef) dotNetRef.invokeMethodAsync('NotifyAnnotationChanged');
        },

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
            if (_pinchRafId !== null) { cancelAnimationFrame(_pinchRafId); _pinchRafId = null; }
            if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver = null; }
            abortAllPageHandlers();
            Object.values(_renderTasks).forEach(t => { try { if (t) t.cancel(); } catch (_) {} });
            _renderTasks   = {};
            _renderedPages = new Set();
            _pageSizes     = {};
            pdfDoc         = null;
            paths          = [];
            abortAllPageHandlers();
            isDrawing      = false;
            currentPath    = null;
            _isPinching    = false;
            _isZooming     = false;
        },

        scrollToPage(pageNum) {
            const scrollEl = getScrollEl();
            const el = document.getElementById('page-container-' + pageNum);
            if (!scrollEl || !el) return;
            const scrollRect = scrollEl.getBoundingClientRect();
            const elRect     = el.getBoundingClientRect();
            // 페이지가 scroll-container 상단에 오도록
            scrollEl.scrollTop += elRect.top - scrollRect.top - 8;
            currentPageNum = pageNum;
        },

        preventScroll() {},

        // 필기 패널 토글 (JS로 직접 제어 → Blazor 재렌더 없이)
        setDrawPanelOpen(open) {
            const btn   = document.getElementById('draw-fab-btn');
            const panel = document.getElementById('draw-panel-div');
            if (btn)   btn.classList.toggle('draw-fab-on', open);
            if (panel) panel.classList.toggle('draw-panel-open', open);
            // 패널 애니메이션(0.25s) 동안 IntersectionObserver 차단
            // → layout 변화로 인한 캔버스 재렌더 방지
            _isZooming = true;
            setTimeout(() => { _isZooming = false; }, 350);
        },

        triggerFileInput() {
            const inp = document.getElementById('pdf-file-input');
            if (inp) inp.click();
        },

        // ── IndexedDB PDF 저장/불러오기 ──────────────────────
        async savePdfToProject(projectId, fileName) {
            if (!_lastPdfBytes) return false;
            try {
                await savePdfToIDB(projectId, _lastPdfBytes, fileName);
                return true;
            } catch (e) {
                console.error('savePdfToProject error:', e);
                return false;
            }
        },

        async loadPdfFromProject(projectId) {
            try {
                const record = await loadPdfFromIDB(projectId);
                if (!record) return null;
                return record.fileName || '';
            } catch (e) {
                console.error('loadPdfFromProject error:', e);
                return null;
            }
        },

        async renderSavedPdf(projectId) {
            try {
                const record = await loadPdfFromIDB(projectId);
                if (!record || !record.bytes) return 0;
                await ensurePdfJs();
                const base = getPdfjsBase();
                pdfDoc = await window.pdfjsLib.getDocument({
                    data: record.bytes,
                    cMapUrl:             base + '/pdfjs/web/cmaps/',
                    cMapPacked:          true,
                    standardFontDataUrl: base + '/pdfjs/web/standard_fonts/'
                }).promise;
                totalPages     = pdfDoc.numPages;
                abortAllPageHandlers();
                _renderedPages = new Set();
                _pageSizes     = {};
                _lastPdfBytes  = record.bytes;
                const p1  = await pdfDoc.getPage(1);
                const vp1 = p1.getViewport({ scale: 1.0 });
                for (let i = 1; i <= totalPages; i++)
                    _pageSizes[i] = { w: vp1.width, h: vp1.height };
                return totalPages;
            } catch (e) {
                console.error('renderSavedPdf error:', e);
                return 0;
            }
        },

        async deleteSavedPdf(projectId) {
            try { await deletePdfFromIDB(projectId); return true; }
            catch (e) { return false; }
        },

        getPaths() {
            return JSON.stringify(paths);
        },

        setPaths(json) {
            try { paths = JSON.parse(json) || []; } catch(_) { paths = []; }
            // 복원 후 모든 페이지 다시 그리기
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        }
    };
})();