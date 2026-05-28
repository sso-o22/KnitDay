window.patternViewer = (() => {
    // ── IndexedDB ────────────────────────────────────────────
    const IDB_NAME = 'KnitLogPatternDB', IDB_VER = 1, IDB_STORE = 'patterns';
    function openDB() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(IDB_NAME, IDB_VER);
            req.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains(IDB_STORE)) e.target.result.createObjectStore(IDB_STORE, { keyPath: 'projectId' }); };
            req.onsuccess = e => res(e.target.result);
            req.onerror   = e => rej(e.target.error);
        });
    }
    async function savePdfToIDB(projectId, bytes, fileName) {
        const db = await openDB();
        return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).put({projectId,bytes,fileName,savedAt:Date.now()}); tx.oncomplete=res; tx.onerror=e=>rej(e.target.error); });
    }
    async function loadPdfFromIDB(projectId) {
        const db = await openDB();
        return new Promise((res, rej) => { const req = db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get(projectId); req.onsuccess=e=>res(e.target.result||null); req.onerror=e=>rej(e.target.error); });
    }
    async function deletePdfFromIDB(projectId) {
        const db = await openDB();
        return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).delete(projectId); tx.oncomplete=res; tx.onerror=e=>rej(e.target.error); });
    }

    // ── 상태 ─────────────────────────────────────────────────
    let pdfDoc = null, dotNetRef = null;
    let currentZoom = 1.0, _fitZoom = 1.0;
    let currentPageNum = 1, totalPages = 0;
    let _pageSizes = {};      // pageNum → {w, h} at zoom=1 CSS px
    let paths = [];
    let isDrawing = false, currentPath = null;
    let _color = '#000000', _size = 4, _isEraser = false, _tool = 'select', _opacity = 1.0;
    let _pageHandlers = {}, _renderTasks = {}, _renderedPages = new Set();
    let _fitZoomVal = 1.0;
    let _isPinching = false, _isZooming = false, _isPanelAnimating = false;
    let _pendingZoom = null, _renderDebounceTimer = null;
    let _pinchStartDist = 0, _pinchStartZoom = 1.0;
    let _intersectionObserver = null;
    let _lastPdfBytes = null;
    const RENDER_AHEAD = 1;

    // ── 좌표계 ───────────────────────────────────────────────
    // 모든 필기 좌표는 zoom=1, DPR=1 기준 CSS px 정규화로 저장
    // normX = cssX / (pageOrigW * zoom)  →  0~1
    // 그릴 때: bufX = normX * pageOrigW * zoom * dpr
    // Blazor용: cssX = normX * pageOrigW * zoom

    function getPageOrigW(pageNum) { return (_pageSizes[pageNum] || _pageSizes[1] || {w:1}).w; }
    function getPageOrigH(pageNum) { return (_pageSizes[pageNum] || _pageSizes[1] || {h:1}).h; }

    // 터치/마우스 → 정규화 좌표 (0~1)
    // offsetLeft/offsetTop 기반으로 계산 → CSS transform 영향 없음
    function getOffsetPos(el) {
        let x = 0, y = 0;
        while (el && el !== document.getElementById('scroll-container')) {
            x += el.offsetLeft;
            y += el.offsetTop;
            el = el.offsetParent;
        }
        return { x, y };
    }

    function getNormPos(anno, e, pageNum) {
        const src = e.touches ? e.touches[0] : e;
        const scrollEl = document.getElementById('scroll-container');
        const scrollTop  = scrollEl ? scrollEl.scrollTop  : 0;
        const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0;

        // anno의 scroll-container 기준 절대 위치 (transform 무관)
        const off = getOffsetPos(anno);
        const cssX = src.clientX - (off.x - scrollLeft + (scrollEl ? scrollEl.getBoundingClientRect().left : 0));
        const cssY = src.clientY - (off.y - scrollTop  + (scrollEl ? scrollEl.getBoundingClientRect().top  : 0));

        const origW = getPageOrigW(pageNum);
        const origH = getPageOrigH(pageNum);
        const normX2 = cssX / (origW * currentZoom);
        const normY2 = cssY / (origH * currentZoom);
        return { normX: normX2, normY: normY2 };
    }

    // 정규화 → 캔버스 버퍼 px
    function normToBuf(normX, normY, anno, pageNum) {
        const origW = getPageOrigW(pageNum);
        const origH = getPageOrigH(pageNum);
        const dpr = anno._dpr || 1;
        return {
            bx: normX * origW * currentZoom * dpr,
            by: normY * origH * currentZoom * dpr
        };
    }

    // 정규화 → CSS px (Blazor ruler용)
    function normToCss(normX, normY, pageNum) {
        const origW = getPageOrigW(pageNum);
        const origH = getPageOrigH(pageNum);
        return {
            cx: normX * origW * currentZoom,
            cy: normY * origH * currentZoom
        };
    }

    // ── 어노테이션 다시 그리기 ───────────────────────────────
    function redrawPage(pageNum) {
        const anno = getAnnoCanvas(pageNum);
        if (!anno || !_renderedPages.has(pageNum)) return;
        const ctx = anno.getContext('2d');
        ctx.clearRect(0, 0, anno.width, anno.height);
        const dpr   = anno._dpr || 1;
        const origW = getPageOrigW(pageNum);
        const origH = getPageOrigH(pageNum);
        const scaleX = origW * currentZoom * dpr;
        const scaleY = origH * currentZoom * dpr;
        const pathsOnPage = paths.filter(p => p.page === pageNum);
        paths.filter(p => p.page === pageNum).forEach(p => {
            if (!p.points.length) return;
            const isHighlighter = p.tool === 'highlighter';
            ctx.save();
            ctx.beginPath();
            if (isHighlighter) {
                ctx.lineWidth = p.size * 4 * currentZoom * dpr;
                ctx.lineCap   = 'square';
                ctx.lineJoin  = 'square';
                ctx.globalAlpha = 0.35;
                ctx.strokeStyle = p.color;
                ctx.globalCompositeOperation = 'multiply';
            } else if (p.isEraser) {
                ctx.lineWidth  = p.size * currentZoom * dpr;
                ctx.lineCap    = 'round';
                ctx.lineJoin   = 'round';
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = 'rgba(0,0,0,1)';
                ctx.globalCompositeOperation = 'destination-out';
            } else {
                ctx.lineWidth  = p.size * currentZoom * dpr;
                ctx.lineCap    = 'round';
                ctx.lineJoin   = 'round';
                ctx.globalAlpha = p.opacity ?? 1.0;
                ctx.strokeStyle = p.color;
                ctx.globalCompositeOperation = 'source-over';
            }
            ctx.moveTo(p.points[0].x * scaleX, p.points[0].y * scaleY);
            for (let i = 1; i < p.points.length; i++)
                ctx.lineTo(p.points[i].x * scaleX, p.points[i].y * scaleY);
            ctx.stroke();
            ctx.restore();
        });
    }

    // ── 페이지 핸들러 ─────────────────────────────────────────
    function getAnnoCanvas(p) { return document.getElementById('anno-canvas-' + p); }
    function getPdfCanvas(p)  { return document.getElementById('pdf-canvas-'  + p); }

    function addPageHandlers(pageNum) {
        if (_pageHandlers[pageNum]) _pageHandlers[pageNum].abort();
        const anno = getAnnoCanvas(pageNum);
        if (!anno) return;
        const ac  = new AbortController();
        _pageHandlers[pageNum] = ac;
        const sig = { signal: ac.signal };

        let _snapTimer = null, _snapTriggered = false;

        function onDown(e) {
            if (_isPinching || _isZooming) return;
            const {normX, normY} = getNormPos(anno, e, pageNum);
            if (_tool === 'ruler') {
                const {cx, cy} = normToCss(normX, normY, pageNum);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnCanvasPointerDown', cx, cy, pageNum);
                if (e.touches) e.preventDefault();
                return;
            }
            if (_tool !== 'pen' && _tool !== 'eraser' && _tool !== 'highlighter') return;
            if (e.touches) e.preventDefault();
            currentPageNum = pageNum;
            isDrawing = true;
            _snapTriggered = false;
            if (_snapTimer) { clearTimeout(_snapTimer); _snapTimer = null; }
            currentPath = { page: pageNum, color: _color, opacity: _opacity, size: _size,
                isEraser: _isEraser, tool: _tool,
                points: [{ x: normX, y: normY }] };
            const {bx, by} = normToBuf(normX, normY, anno, pageNum);
            if (_tool === 'highlighter') {
                // 형광펜: context 상태 미리 설정 후 유지 (onMove에서 재사용)
                const dpr = anno._dpr || 1;
                const hCtx = anno.getContext('2d');
                hCtx.lineWidth   = _size * 4 * currentZoom * dpr;
                hCtx.lineCap     = 'square';
                hCtx.lineJoin    = 'miter';
                hCtx.globalAlpha = 0.35;
                hCtx.strokeStyle = _color;
                hCtx.globalCompositeOperation = 'multiply';
                hCtx.beginPath();
                hCtx.moveTo(bx, by);
                anno._hlCtx = hCtx;  // onMove에서 재사용
            } else {
                _stroke(anno, pageNum, bx, by, bx + 0.1, by + 0.1);
            }
            // 직선 스냅: 0.9초 후 직선 모드 전환
            _snapTimer = setTimeout(() => {
                if (isDrawing && currentPath && currentPath.points.length >= 1) {
                    _snapTriggered = true;
                    const startPt = currentPath.points[0];
                    currentPath.points = [startPt];
                    redrawPage(pageNum);
                    if (navigator.vibrate) navigator.vibrate(30);
                }
            }, 900);
        }

        function onMove(e) {
            if (_isPinching || _isZooming) return;
            if (_tool === 'ruler') {
                if (e.touches) e.preventDefault();
                const {normX, normY} = getNormPos(anno, e, pageNum);
                const {cx, cy} = normToCss(normX, normY, pageNum);
                if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchMove', cx, cy);
                return;
            }
            if (!isDrawing || currentPageNum !== pageNum ||
                (_tool !== 'pen' && _tool !== 'eraser' && _tool !== 'highlighter')) return;
            if (e.touches) e.preventDefault();
            const {normX, normY} = getNormPos(anno, e, pageNum);
            if (_snapTriggered) {
                // 직선 스냅 모드: 시작점→현재점만 실시간 미리보기
                const startPt = currentPath.points[0];
                currentPath.points = [startPt, { x: normX, y: normY }];
                anno._hlCtx = null;  // 스냅 모드로 전환 시 연속 context 리셋
                redrawPage(pageNum);
                _drawFullPath(anno, pageNum, currentPath);
                return;
            }
            const prev = currentPath.points[currentPath.points.length - 1];
            currentPath.points.push({ x: normX, y: normY });
            if (_tool === 'highlighter' && anno._hlCtx) {
                // 형광펜: context 유지하며 lineTo로 이어그리기 (끊김 없음)
                const {bx: tx, by: ty} = normToBuf(normX, normY, anno, pageNum);
                anno._hlCtx.lineTo(tx, ty);
                anno._hlCtx.stroke();
                // stroke 후 다시 moveTo는 하지 않음 - 연속 경로 유지
                anno._hlCtx.beginPath();
                anno._hlCtx.moveTo(tx, ty);
            } else {
                const {bx: fx, by: fy} = normToBuf(prev.x, prev.y, anno, pageNum);
                const {bx: tx, by: ty} = normToBuf(normX, normY, anno, pageNum);
                _stroke(anno, pageNum, fx, fy, tx, ty);
            }
        }

        function onUp(e) {
            if (_isPinching) return;
            if (_snapTimer) { clearTimeout(_snapTimer); _snapTimer = null; }
            if (_tool === 'ruler') { if (dotNetRef) dotNetRef.invokeMethodAsync('OnRulerTouchEnd'); return; }
            if (!isDrawing || currentPageNum !== pageNum) return;
            isDrawing = false;
            _snapTriggered = false;
            if (currentPath && currentPath.points.length > 0) {
                paths.push(currentPath);
                if (dotNetRef) dotNetRef.invokeMethodAsync('NotifyAnnotationChanged');
            }
            // 형광펜: 손 뗄 때 redraw로 정리 (경로 누적 깔끔하게)
            if (_tool === 'highlighter') {
                anno._hlCtx = null;
                redrawPage(pageNum);
            }
            currentPath = null;
        }

        anno.addEventListener('mousedown',  onDown, sig);
        anno.addEventListener('mousemove',  onMove, sig);
        anno.addEventListener('mouseup',    onUp,   sig);
        anno.addEventListener('touchstart', onDown, { passive: false, signal: ac.signal });
        anno.addEventListener('touchmove',  onMove, { passive: false, signal: ac.signal });
        anno.addEventListener('touchend',   onUp,   sig);
    }

    // 매번 context 상태 완전 설정 (iOS context 상태 초기화 버그 방지)
    // 전체 경로를 한 번에 그리기 (형광펜 실시간 미리보기용)
    function _drawFullPath(anno, pageNum, path) {
        if (!path || path.points.length < 2) return;
        const dpr = anno._dpr || 1;
        const origW = getPageOrigW(pageNum);
        const origH = getPageOrigH(pageNum);
        const scaleX = origW * currentZoom * dpr;
        const scaleY = origH * currentZoom * dpr;
        const ctx = anno.getContext('2d');
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth  = path.size * 4 * currentZoom * dpr;
        ctx.lineCap    = 'square';
        ctx.lineJoin   = 'miter';
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = path.color;
        ctx.globalCompositeOperation = 'multiply';
        ctx.moveTo(path.points[0].x * scaleX, path.points[0].y * scaleY);
        for (let i = 1; i < path.points.length; i++)
            ctx.lineTo(path.points[i].x * scaleX, path.points[i].y * scaleY);
        ctx.stroke();
        ctx.restore();
    }

    function _stroke(anno, pageNum, fromX, fromY, toX, toY) {
        const dpr = anno._dpr || 1;
        const ctx = anno.getContext('2d');
        ctx.save();
        ctx.beginPath();
        ctx.lineCap  = 'round';
        ctx.lineJoin = 'round';
        if (_isEraser) {
            ctx.lineWidth  = _size * currentZoom * dpr;
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.globalCompositeOperation = 'destination-out';
        } else if (_tool === 'highlighter') {
            // 형광펜: 두껍고 반투명, multiply로 겹쳐도 진해지지 않음
            ctx.lineWidth  = _size * 4 * currentZoom * dpr;
            ctx.lineCap   = 'square';
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = _color;
            ctx.globalCompositeOperation = 'multiply';
        } else {
            ctx.lineWidth  = _size * currentZoom * dpr;
            ctx.globalAlpha = _opacity;
            ctx.strokeStyle = _color;
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        ctx.restore();
    }

    // ── 단일 페이지 렌더 ─────────────────────────────────────
    async function renderOnePage(pageNum, zoom) {
        if (!pdfDoc) return;
        const pdfCanvas  = getPdfCanvas(pageNum);
        const annoCanvas = getAnnoCanvas(pageNum);
        if (!pdfCanvas || !annoCanvas) return;
        if (_renderTasks[pageNum]) { try { _renderTasks[pageNum].cancel(); } catch(_){} _renderTasks[pageNum] = null; }

        const page = await pdfDoc.getPage(pageNum);
        const dpr  = window.devicePixelRatio || 1;
        const vp   = page.getViewport({ scale: zoom });
        const cssW = Math.floor(vp.width);
        const cssH = Math.floor(vp.height);
        const bufW = Math.floor(cssW * dpr);
        const bufH = Math.floor(cssH * dpr);

        pdfCanvas.width  = bufW; pdfCanvas.height  = bufH;
        annoCanvas.width = bufW; annoCanvas.height = bufH;
        pdfCanvas.style.width   = annoCanvas.style.width  = cssW + 'px';
        pdfCanvas.style.height  = annoCanvas.style.height = cssH + 'px';
        // Blazor 재렌더 시 style 리셋 방지 - MutationObserver로 CSS 크기 고정
        annoCanvas._cssW = cssW;
        annoCanvas._cssH = cssH;
        if (!annoCanvas._sizeObserver) {
            annoCanvas._sizeObserver = new MutationObserver(() => {
                if (annoCanvas._cssW && annoCanvas.style.width !== annoCanvas._cssW + 'px') {
                    annoCanvas.style.width  = annoCanvas._cssW + 'px';
                    annoCanvas.style.height = annoCanvas._cssH + 'px';
                }
            });
            annoCanvas._sizeObserver.observe(annoCanvas, { attributes: true, attributeFilter: ['style'] });
        }
        annoCanvas._dpr  = dpr;
        annoCanvas._zoom = zoom;

        const cursor = _tool === 'pen' || _tool === 'ruler' ? 'crosshair' : _tool === 'eraser' ? 'cell' : 'default';
        annoCanvas.style.cursor = cursor;

        const ctx = pdfCanvas.getContext('2d');
        const task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: zoom * dpr }) });
        _renderTasks[pageNum] = task;
        try { await task.promise; }
        catch (err) { if (err?.name !== 'RenderingCancelledException') console.warn('render err', pageNum, err); return; }
        _renderTasks[pageNum] = null;
        _renderedPages.add(pageNum);
        redrawPage(pageNum);
        addPageHandlers(pageNum);
    }

    function unloadPage(pageNum) {
        if (!_renderedPages.has(pageNum)) return;
        const pc = getPdfCanvas(pageNum), ac = getAnnoCanvas(pageNum);
        if (pc) { pc.width = 1; pc.height = 1; }
        if (ac) { ac.width = 1; ac.height = 1; }
        _renderedPages.delete(pageNum);
        if (_pageHandlers[pageNum]) { _pageHandlers[pageNum].abort(); _pageHandlers[pageNum] = null; }
    }

    async function virtualizeRender(zoom) {
        if (!pdfDoc) return;
        const from = Math.max(1, currentPageNum - RENDER_AHEAD);
        const to   = Math.min(totalPages, currentPageNum + RENDER_AHEAD);
        for (let i = 1; i <= totalPages; i++) { if (i < from || i > to) unloadPage(i); }
        for (let i = from; i <= to; i++) { if (!_renderedPages.has(i)) await renderOnePage(i, zoom); }
    }

    function getScrollEl() { return document.getElementById('scroll-container'); }

    function abortAllPageHandlers() {
        Object.values(_pageHandlers).forEach(ac => { try { if (ac?.abort) ac.abort(); } catch(_){} });
        _pageHandlers = {};
    }

    function syncContainerSizes(zoom) {
        for (let i = 1; i <= totalPages; i++) {
            const orig = _pageSizes[i];
            if (!orig) continue;
            const el = document.getElementById('page-container-' + i);
            if (el) { el.style.width = Math.floor(orig.w * zoom) + 'px'; el.style.height = Math.floor(orig.h * zoom) + 'px'; }
            const pc = getPdfCanvas(i), ac = getAnnoCanvas(i);
            if (pc && !_renderedPages.has(i)) { pc.style.width = Math.floor(orig.w*zoom)+'px'; pc.style.height = Math.floor(orig.h*zoom)+'px'; }
            if (ac && !_renderedPages.has(i)) { ac.style.width = Math.floor(orig.w*zoom)+'px'; ac.style.height = Math.floor(orig.h*zoom)+'px'; }
        }
    }

    function setupIntersectionObserver() {
        if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver = null; }
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        _intersectionObserver = new IntersectionObserver(entries => {
            if (_isPinching || _isZooming || _isPanelAnimating) return;
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const p = parseInt(entry.target.id.replace('page-container-',''), 10);
                if (!isNaN(p) && !_renderedPages.has(p)) renderOnePage(p, currentZoom);
            });
        }, { root: scrollEl, rootMargin: '300px 0px 300px 0px', threshold: 0 });
        for (let i = 1; i <= totalPages; i++) { const el = document.getElementById('page-container-'+i); if (el) _intersectionObserver.observe(el); }
    }

    function onScroll() {
        if (_isPinching || _isZooming) return;
        const scrollEl = getScrollEl();
        if (!scrollEl) return;
        const mid = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight / 2;
        let found = 1;
        for (let i = 1; i <= totalPages; i++) { const el = document.getElementById('page-container-'+i); if (el && el.getBoundingClientRect().top <= mid) found = i; }
        if (found !== currentPageNum) { currentPageNum = found; if (dotNetRef) dotNetRef.invokeMethodAsync('UpdatePageFromJS', found); }
    }

    function changeZoom(newZoom, anchorDocY, anchorViewY) {
        if (!pdfDoc) return;
        _isZooming = true;
        _pendingZoom = newZoom;
        const scrollEl = getScrollEl();
        const scrollPercent = scrollEl ? scrollEl.scrollTop / (scrollEl.scrollHeight || 1) : 0;
        if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(async () => {
            if (!pdfDoc) return;
            const targetZoom = _pendingZoom;
            _pendingZoom = null;
            const prevZoom = currentZoom;
            currentZoom = targetZoom;
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) { wrapper.style.transform = ''; wrapper.style.transformOrigin = ''; wrapper.style.opacity = '1'; }
            for (let i = 1; i <= totalPages; i++) {
                if (_renderTasks[i]) { try { _renderTasks[i].cancel(); } catch(_){} _renderTasks[i] = null; }
                const pc = getPdfCanvas(i), ac = getAnnoCanvas(i);
                if (pc && pc.width > 1) { pc.width = 1; pc.height = 1; }
                if (ac && ac.width > 1) { ac.width = 1; ac.height = 1; }
            }
            _renderedPages.clear();
            abortAllPageHandlers();
            syncContainerSizes(targetZoom);
            if (scrollEl) {
                if (anchorDocY !== undefined && anchorViewY !== undefined)
                    scrollEl.scrollTop = Math.max(0, anchorDocY * (targetZoom / prevZoom) - anchorViewY);
                else
                    scrollEl.scrollTop = scrollPercent * scrollEl.scrollHeight;
            }
            await virtualizeRender(targetZoom);
            setupIntersectionObserver();
            setTimeout(() => { _isZooming = false; }, 50);
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', targetZoom);
        }, 180);
    }

    async function calcFitZoom(page) {
        const scrollEl = getScrollEl();
        if (!scrollEl) return 1.0;
        const vp1 = page.getViewport({ scale: 1.0 });
        const fit = Math.min((scrollEl.clientWidth - 32) / vp1.width, (scrollEl.clientHeight - 32) / vp1.height);
        return Math.round(Math.max(0.1, Math.min(2.0, fit)) * 100) / 100;
    }

    function setupScrollAndZoom() {
        const scrollEl = getScrollEl();
        if (!scrollEl || scrollEl._bound) return;
        scrollEl._bound = true;
        scrollEl.addEventListener('scroll', onScroll, { passive: true });
        setupIntersectionObserver();

        let _wheelAnchorDocY = 0, _wheelAnchorViewY = 0;
        scrollEl.addEventListener('wheel', e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const maxZ = Math.min(4.0, _fitZoom * 6), minZ = _fitZoom * 0.3;
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 20;
            if (e.deltaMode === 2) dy *= 300;
            const rawZ = (_pendingZoom ?? currentZoom) * Math.exp(-dy * 0.003);
            const newZ = Math.min(maxZ, Math.max(minZ, rawZ));
            if (!_isZooming && _pendingZoom === null) {
                const scRect = scrollEl.getBoundingClientRect();
                _wheelAnchorViewY = e.clientY - scRect.top;
                _wheelAnchorDocY  = scrollEl.scrollTop + _wheelAnchorViewY;
            }
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) {
                const wRect = wrapper.getBoundingClientRect();
                wrapper.style.transformOrigin = (e.clientX - wRect.left) + 'px ' + (e.clientY - wRect.top) + 'px';
                wrapper.style.transform = 'scale(' + newZ / currentZoom + ')';
            }
            changeZoom(newZ, _wheelAnchorDocY, _wheelAnchorViewY);
        }, { passive: false });

        let _pinchRafId = null, _pinchLatestDist = 0, _pinchLatestCx = 0, _pinchLatestCy = 0, _pinchWrapperRect = null;
        scrollEl.addEventListener('touchstart', e => {
            if (e.touches.length !== 2) return;
            _isPinching = true; isDrawing = false;
            _pinchStartDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
            _pinchStartZoom = currentZoom;
            const cx = (e.touches[0].clientX+e.touches[1].clientX)/2, cy = (e.touches[0].clientY+e.touches[1].clientY)/2;
            const scRect = scrollEl.getBoundingClientRect();
            scrollEl._pinchAnchorViewY = cy - scRect.top;
            scrollEl._pinchAnchorDocY  = scrollEl.scrollTop + scrollEl._pinchAnchorViewY;
            const wrapper = document.getElementById('pdf-wrapper');
            _pinchWrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
            if (wrapper) wrapper.style.willChange = 'transform';
            e.preventDefault();
        }, { passive: false });

        scrollEl.addEventListener('touchmove', e => {
            if (_tool === 'ruler' && e.touches.length === 1) { e.preventDefault(); return; }
            if (e.touches.length !== 2) return;
            e.preventDefault();
            _pinchLatestDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
            _pinchLatestCx = (e.touches[0].clientX+e.touches[1].clientX)/2;
            _pinchLatestCy = (e.touches[0].clientY+e.touches[1].clientY)/2;
            if (_pinchRafId !== null) return;
            _pinchRafId = requestAnimationFrame(() => {
                _pinchRafId = null;
                if (!_isPinching) return;
                const newZ = Math.min(Math.min(4.0,_fitZoom*6), Math.max(_fitZoom*0.3, _pinchStartZoom*_pinchLatestDist/_pinchStartDist));
                const wrapper = document.getElementById('pdf-wrapper');
                if (wrapper && _pinchWrapperRect) {
                    wrapper.style.transformOrigin = (_pinchLatestCx-_pinchWrapperRect.left)+'px '+(_pinchLatestCy-_pinchWrapperRect.top)+'px';
                    wrapper.style.transform = 'scale('+(newZ/currentZoom)+')';
                }
                _pendingZoom = Math.round(newZ*10)/10;
            });
        }, { passive: false });

        scrollEl.addEventListener('touchend', e => {
            if (!_isPinching || e.touches.length >= 2) return;
            if (_pinchRafId !== null) { cancelAnimationFrame(_pinchRafId); _pinchRafId = null; }
            _pinchWrapperRect = null;
            const wrapperClean = document.getElementById('pdf-wrapper');
            if (wrapperClean) wrapperClean.style.willChange = '';
            const finalZoom = _pendingZoom;
            setTimeout(() => {
                _isPinching = false;
                if (finalZoom !== null) changeZoom(finalZoom, scrollEl._pinchAnchorDocY, scrollEl._pinchAnchorViewY);
                else { _isZooming = false; const w = document.getElementById('pdf-wrapper'); if (w) { w.style.transform=''; w.style.transformOrigin=''; } }
            }, 50);
        }, { passive: true });
    }

    // ── PDF.js 로드 ──────────────────────────────────────────
    let _pdfjsReady = null;
    async function ensurePdfJs() {
        if (_pdfjsReady) return _pdfjsReady;
        _pdfjsReady = new Promise((res, rej) => {
            if (window.pdfjsLib) { res(); return; }
            const base = (document.querySelector('base')?.href || location.origin+'/').replace(/\/$/,'');
            const cb = '_pdfjs_'+Date.now();
            window[cb] = lib => { window.pdfjsLib = lib; lib.GlobalWorkerOptions.workerSrc = base+'/pdfjs/build/pdf.worker.mjs'; delete window[cb]; res(); };
            const s = document.createElement('script'); s.type='module';
            s.textContent = 'import * as L from "'+base+'/pdfjs/build/pdf.mjs";window["'+cb+'"](L);';
            s.onerror = e => { delete window[cb]; rej(e); };
            document.head.appendChild(s);
        });
        return _pdfjsReady;
    }

    function getPdfjsBase() { return (document.querySelector('base')?.href || location.origin+'/').replace(/\/$/,''); }

    async function _loadPdfData(bytes) {
        await ensurePdfJs();
        const base = getPdfjsBase();
        _lastPdfBytes = bytes.slice(0);
        pdfDoc = await window.pdfjsLib.getDocument({ data: bytes, cMapUrl: base+'/pdfjs/web/cmaps/', cMapPacked: true, standardFontDataUrl: base+'/pdfjs/web/standard_fonts/' }).promise;
        totalPages = pdfDoc.numPages;
        abortAllPageHandlers(); _renderedPages = new Set(); _pageSizes = {}; paths = [];
        const p1 = await pdfDoc.getPage(1), vp1 = p1.getViewport({ scale: 1.0 });
        for (let i = 1; i <= totalPages; i++) _pageSizes[i] = { w: vp1.width, h: vp1.height };
        return totalPages;
    }

    // ── 공개 API ─────────────────────────────────────────────
    return {
        init(ref) { dotNetRef = ref; },

        async loadPdfBytes(streamRef) { return await _loadPdfData(new Uint8Array(await streamRef.arrayBuffer())); },
        async loadPdfBase64(b64) {
            const bin = atob(b64), bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return await _loadPdfData(bytes);
        },

        async renderPdf() {
            if (!pdfDoc) return;
            const p1 = await pdfDoc.getPage(1);
            _fitZoom = await calcFitZoom(p1);
            _fitZoomVal = _fitZoom;
            currentZoom = _fitZoom; currentPageNum = 1;
            syncContainerSizes(currentZoom);
            await virtualizeRender(currentZoom);
            setupScrollAndZoom();
            if (dotNetRef) dotNetRef.invokeMethodAsync('ZoomToFromJS', currentZoom);
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            if (_renderDebounceTimer) { clearTimeout(_renderDebounceTimer); _renderDebounceTimer = null; }
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) { wrapper.style.transform=''; wrapper.style.transformOrigin=''; wrapper.style.opacity='1'; }
            const maxZ = Math.min(4.0, _fitZoom*6), minZ = _fitZoom*0.3;
            zoom = Math.min(maxZ, Math.max(minZ, zoom));
            currentZoom = zoom; _renderedPages = new Set(); abortAllPageHandlers();
            syncContainerSizes(zoom);
            await virtualizeRender(zoom);
            setupIntersectionObserver();
        },

        setTool(color, size, isEraser, tool, opacity) {
            if (isDrawing) { isDrawing = false; if (currentPath) { paths.push(currentPath); currentPath = null; } }
            _color = color; _size = size; _isEraser = isEraser;
            _opacity = opacity !== undefined ? Math.max(0.1, Math.min(1.0, opacity/100)) : 1.0;
            if (tool !== undefined) _tool = tool;
            const cursor = (tool==='pen'||tool==='ruler') ? 'crosshair' : tool==='eraser' ? 'cell' : 'default';
            for (let i = 1; i <= totalPages; i++) { const a = getAnnoCanvas(i); if (a) a.style.cursor = cursor; }
        },

        undo() { paths.pop(); for (let i=1;i<=totalPages;i++) redrawPage(i); if (dotNetRef) dotNetRef.invokeMethodAsync('NotifyAnnotationChanged'); },

        getRect(pageNum) {
            const el = document.getElementById('page-container-'+(pageNum||currentPageNum));
            if (!el) return [0,0,0,0];
            // offsetLeft/offsetTop 기반 (getBoundingClientRect는 iOS에서 물리px 반환 버그)
            const scrollEl = document.getElementById('scroll-container');
            const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
            const scrollTop  = scrollEl ? scrollEl.scrollTop  : 0;
            const scRect = scrollEl ? scrollEl.getBoundingClientRect() : {left:0,top:0};
            let ox = 0, oy = 0, cur = el;
            while (cur && cur !== scrollEl) { ox += cur.offsetLeft; oy += cur.offsetTop; cur = cur.offsetParent; }
            return [ox - scrollLeft + scRect.left, oy - scrollTop + scRect.top,
                    el.offsetWidth, el.offsetHeight];
        },

        clearAnnotations() { paths = []; for (let i=1;i<=totalPages;i++) redrawPage(i); },
        endDraw() { if (isDrawing) { isDrawing=false; if (currentPath) { paths.push(currentPath); currentPath=null; } } },

        dispose() {
            if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
            if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver=null; }
            abortAllPageHandlers();
            Object.values(_renderTasks).forEach(t => { try { if(t) t.cancel(); } catch(_){} });
            _renderTasks={}; _renderedPages=new Set(); _pageSizes={}; pdfDoc=null; paths=[];
            isDrawing=false; currentPath=null; _isPinching=false; _isZooming=false;
        },

        scrollToPage(pageNum) {
            const scrollEl = getScrollEl(), el = document.getElementById('page-container-'+pageNum);
            if (!scrollEl||!el) return;
            scrollEl.scrollTop += el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 8;
            currentPageNum = pageNum;
        },

        preventScroll() {},

        setDrawPanelOpen(open) {
            document.getElementById('draw-fab-btn')?.classList.toggle('draw-fab-on', open);
            document.getElementById('draw-panel-div')?.classList.toggle('draw-panel-open', open);
            _isPanelAnimating = true;
            setTimeout(() => { _isPanelAnimating = false; }, 350);
        },

        triggerFileInput() { document.getElementById('pdf-file-input')?.click(); },

        getPaths() { return JSON.stringify(paths); },

        setPaths(json) {
            try { paths = JSON.parse(json) || []; } catch(_) { paths = []; }
            for (let i=1; i<=totalPages; i++) { if (_renderedPages.has(i)) redrawPage(i); }
        },

        async savePdfToProject(projectId, fileName) {
            if (!_lastPdfBytes) return false;
            try { await savePdfToIDB(projectId, _lastPdfBytes, fileName); return true; }
            catch(e) { console.error(e); return false; }
        },

        async loadPdfFromProject(projectId) {
            try { const r = await loadPdfFromIDB(projectId); return r?.fileName || null; }
            catch(e) { return null; }
        },

        async renderSavedPdf(projectId) {
            try {
                const r = await loadPdfFromIDB(projectId);
                if (!r?.bytes) return 0;
                await ensurePdfJs();
                const base = getPdfjsBase();
                pdfDoc = await window.pdfjsLib.getDocument({ data: r.bytes, cMapUrl: base+'/pdfjs/web/cmaps/', cMapPacked: true, standardFontDataUrl: base+'/pdfjs/web/standard_fonts/' }).promise;
                totalPages = pdfDoc.numPages; abortAllPageHandlers(); _renderedPages=new Set(); _pageSizes={}; _lastPdfBytes=r.bytes;
                const p1 = await pdfDoc.getPage(1), vp1 = p1.getViewport({scale:1.0});
                for (let i=1;i<=totalPages;i++) _pageSizes[i]={w:vp1.width,h:vp1.height};
                return totalPages;
            } catch(e) { console.error(e); return 0; }
        },

        async deleteSavedPdf(projectId) { try { await deletePdfFromIDB(projectId); return true; } catch(e) { return false; } },

        async exportAllPdfs() {
            try {
                const db = await openDB();
                return new Promise((res, rej) => {
                    const req = db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).getAll();
                    req.onsuccess = e => {
                        const result = {};
                        for (const item of e.target.result) {
                            const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
                            let bin = ''; for (let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
                            result[item.projectId] = { fileName: item.fileName, data: btoa(bin) };
                        }
                        res(JSON.stringify(result));
                    };
                    req.onerror = e => rej(e.target.error);
                });
            } catch(e) { return '{}'; }
        },

        async importAllPdfs(jsonStr) {
            try {
                const map = JSON.parse(jsonStr);
                const db = await openDB();
                for (const [pid, val] of Object.entries(map)) {
                    const bin = atob(val.data), bytes = new Uint8Array(bin.length);
                    for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
                    await savePdfToIDB(pid, bytes, val.fileName);
                }
                return true;
            } catch(e) { console.error(e); return false; }
        },

        // ── 행 높이 자동 감지 ──────────────────────────────────────
        // canvas에 렌더링된 실제 픽셀 기준으로 행 높이 감지
        // rowHeight는 canvas CSS px 단위 (zoom=currentZoom 기준)
        detectRowHeight(pageNum) {
            try {
                const canvas = document.getElementById('pdf-canvas-' + pageNum);
                if (!canvas) return { rowHeight: 0, lineCount: 0, lineYs: [] };
                const ctx = canvas.getContext('2d');
                const dpr = window.devicePixelRatio || 1;
                // canvas buffer px (dpr 배율 적용됨)
                const bw = canvas.width, bh = canvas.height;
                // CSS px (화면에서 보이는 크기)
                const cssW = canvas.offsetWidth || bw / dpr;
                const cssH = canvas.offsetHeight || bh / dpr;

                // 도안 내용이 있는 중앙 영역만 스캔 (여백 제외)
                // 가로: 잉크가 있는 구간 자동 감지
                const fullData = ctx.getImageData(0, 0, bw, bh).data;

                // X방향으로 잉크 있는 범위 찾기 (상단 30% 영역 샘플링)
                const sampleH = Math.floor(bh * 0.3);
                let xMin = bw, xMax = 0;
                for (let y = 0; y < sampleH; y++) {
                    for (let x = 0; x < bw; x++) {
                        const i = (y * bw + x) * 4;
                        const b = (fullData[i] + fullData[i+1] + fullData[i+2]) / 3;
                        if (b < 240) { xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); }
                    }
                }
                // 여백이 많으면 잉크 있는 영역만, 없으면 전체 사용
                const scanX0 = xMin < bw ? Math.max(0, xMin) : 0;
                const scanX1 = xMax > 0 ? Math.min(bw, xMax + 1) : bw;
                const scanW  = Math.max(scanX1 - scanX0, Math.floor(bw * 0.3));
                const actualX0 = Math.max(0, Math.floor((scanX0 + scanX1) / 2) - Math.floor(scanW / 2));
                const actualX1 = Math.min(bw, actualX0 + scanW);

                // 밝기 프로파일 (잉크 범위만)
                const data = ctx.getImageData(actualX0, 0, actualX1 - actualX0, bh).data;
                const sw = actualX1 - actualX0;
                const profile = new Float32Array(bh);
                for (let y = 0; y < bh; y++) {
                    let sum = 0;
                    for (let x = 0; x < sw; x++) {
                        const i = (y * sw + x) * 4;
                        sum += (data[i] + data[i+1] + data[i+2]) / 3;
                    }
                    profile[y] = sum / sw;
                }

                // 어두운 줄 찾기
                const sorted = Float32Array.from(profile).sort();
                const p10 = sorted[Math.floor(bh * 0.10)];
                const p90 = sorted[Math.floor(bh * 0.90)];
                const threshold = p10 + (p90 - p10) * 0.35;

                const darkLines = []; // buffer px 단위
                for (let y = 1; y < bh - 1; y++) {
                    if (profile[y] < threshold &&
                        profile[y] <= profile[y-1] &&
                        profile[y] <= profile[y+1]) {
                        if (darkLines.length === 0 || y - darkLines[darkLines.length-1] > 2) {
                            darkLines.push(y);
                        }
                    }
                }

                console.log(`[행감지] p10=${p10.toFixed(0)}, p90=${p90.toFixed(0)}, threshold=${threshold.toFixed(0)}`);
                console.log(`[행감지] 어두운 줄 수: ${darkLines.length}, 처음 10개: ${darkLines.slice(0,10)}`);

                if (darkLines.length < 3) return { rowHeight: 0, lineCount: darkLines.length, lineYs: [] };

                // 간격 계산 및 중앙값
                const gaps = [];
                for (let i = 1; i < darkLines.length; i++)
                    gaps.push(darkLines[i] - darkLines[i-1]);
                gaps.sort((a, b) => a - b);
                const median = gaps[Math.floor(gaps.length / 2)];

                // 이상치 제거 후 평균 (중앙값 60~140% 범위)
                const filtered = gaps.filter(g => g > median * 0.6 && g < median * 1.4);
                const avgGap = filtered.length > 0
                    ? filtered.reduce((a, b) => a + b, 0) / filtered.length
                    : median;

                // CSS px 단위로 변환 (÷ dpr)
                const rowHeightCss = avgGap / dpr;

                console.log(`[행감지] avgGap=${avgGap.toFixed(1)}buf_px → CSS ${rowHeightCss.toFixed(1)}px`);

                // darkLines에서 실제 행 경계만 추출
                // avgGap보다 훨씬 가까운 줄들은 같은 행의 내부 격자선 → 병합
                // 실제 행 높이 = 행당 격자선 수 * avgGap
                // 방법: avgGap * 1.5 이상 벌어진 경우만 행 경계로 인정
                const minRowGap = avgGap * 2.2; // 이 간격 이상이면 다음 행
                const rowBoundaries = [darkLines[0]]; // 첫 번째 줄은 무조건 포함
                for (let i = 1; i < darkLines.length; i++) {
                    if (darkLines[i] - rowBoundaries[rowBoundaries.length - 1] >= minRowGap) {
                        rowBoundaries.push(darkLines[i]);
                    }
                }

                // 행 경계 간격으로 실제 행 높이 재계산
                let realRowHeightCss = rowHeightCss;
                if (rowBoundaries.length >= 3) {
                    const rowGaps = [];
                    for (let i = 1; i < rowBoundaries.length; i++)
                        rowGaps.push(rowBoundaries[i] - rowBoundaries[i-1]);
                    rowGaps.sort((a, b) => a - b);
                    const rowMedian = rowGaps[Math.floor(rowGaps.length / 2)];
                    const rowFiltered = rowGaps.filter(g => g > rowMedian * 0.6 && g < rowMedian * 1.4);
                    const rowAvg = rowFiltered.length > 0
                        ? rowFiltered.reduce((a, b) => a + b, 0) / rowFiltered.length
                        : rowMedian;
                    realRowHeightCss = rowAvg / dpr;
                    console.log(`[행감지] 행경계 ${rowBoundaries.length}개, 실제행높이=${realRowHeightCss.toFixed(1)}px`);
                }

                // rowBoundaries 간격 분포에서 최빈값(mode) 찾기
                // → 행 높이의 정수배인 경계들을 제거해서 실제 행만 남김
                const rowGapsAll = [];
                for (let i = 1; i < rowBoundaries.length; i++)
                    rowGapsAll.push(rowBoundaries[i] - rowBoundaries[i-1]);
                rowGapsAll.sort((a, b) => a - b);
                const rowMedianFinal = rowGapsAll[Math.floor(rowGapsAll.length / 2)];

                // 실제 행 경계: rowMedianFinal * 0.7 이상 간격인 것만 (작은 노이즈 제거)
                const trueRowBoundaries = [rowBoundaries[0]];
                let lastAccepted = rowBoundaries[0];
                for (let i = 1; i < rowBoundaries.length; i++) {
                    if (rowBoundaries[i] - lastAccepted >= rowMedianFinal * 0.7) {
                        trueRowBoundaries.push(rowBoundaries[i]);
                        lastAccepted = rowBoundaries[i];
                    }
                }

                // 진짜 행 높이 재계산
                const trueGaps = [];
                for (let i = 1; i < trueRowBoundaries.length; i++)
                    trueGaps.push(trueRowBoundaries[i] - trueRowBoundaries[i-1]);
                trueGaps.sort((a, b) => a - b);
                const trueMedian = trueGaps[Math.floor(trueGaps.length / 2)];
                const trueFiltered = trueGaps.filter(g => g > trueMedian * 0.6 && g < trueMedian * 1.4);
                const trueAvg = trueFiltered.length > 0
                    ? trueFiltered.reduce((a, b) => a + b, 0) / trueFiltered.length
                    : trueMedian;
                const finalRowHeightCss = trueAvg / dpr;

                const firstY = trueRowBoundaries[0] / dpr;
                const lastY  = trueRowBoundaries[trueRowBoundaries.length - 1] / dpr;
                const lineYs = [];
                for (let y = firstY; y <= lastY + finalRowHeightCss * 0.5; y += finalRowHeightCss) {
                    lineYs.push(y);
                }

                console.log(`[행감지] 최종 행경계 ${trueRowBoundaries.length}개, 높이=${finalRowHeightCss.toFixed(1)}px, lineYs=${lineYs.length}개`);

                return {
                    rowHeight: finalRowHeightCss,
                    lineCount: lineYs.length,
                    lineYs
                };
            } catch(e) {
                console.error('detectRowHeight error:', e);
                return { rowHeight: 0, lineCount: 0, lineYs: [] };
            }        },

        // 클릭 이벤트의 canvas 기준 CSS Y 좌표 반환 (스크롤 보정 포함)
        getCanvasCssY(pageNum, clientY) {
            const anno = document.getElementById('anno-canvas-' + pageNum);
            if (!anno) return clientY;
            const scrollEl = document.getElementById('scroll-container');
            const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
            const off = getOffsetPos(anno);
            const scrollContainerTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
            return clientY - (off.y - scrollTop + scrollContainerTop);
        },

        // 페이지 너비 반환 (zoom=1 기준 px)
        getPageWidth(pageNum) {
            return getPageOrigW(pageNum);
        },

        // 이미지 크기 반환
        getImageSize(imgId) {
            const img = document.getElementById(imgId);
            if (!img) return [0, 0];
            return [img.naturalWidth, img.naturalHeight];
        },

        // anno-canvas 크기 조정 (이미지 모드용)
        resizeAnnoCanvas(pageNum, w, h) {
            const anno = document.getElementById('anno-canvas-' + pageNum);
            if (!anno) return;
            const dpr = window.devicePixelRatio || 1;
            anno.width  = Math.round(w * dpr);
            anno.height = Math.round(h * dpr);
            anno.style.width  = w + 'px';
            anno.style.height = h + 'px';
        }
    };
})();