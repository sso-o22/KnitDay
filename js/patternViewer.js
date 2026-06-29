window.patternViewer = (() => {
    // ── IndexedDB ────────────────────────────────────────────
    const IDB_NAME = 'KnitLogPatternDB', IDB_VER = 2, IDB_STORE = 'patterns';
    function openDB() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(IDB_NAME, IDB_VER);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE))
                    db.createObjectStore(IDB_STORE, { keyPath: 'projectId' });
            };
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
let basePaths = []; // 저장된 필기 (박제)
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

    function getMaxZoom() { return 8.0; } // 줌 상한 8배 (buffer 상한이 OOM 실제 방어)
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

    // 두 선 드래그: 선 엘리먼트에 mouse/touch 이벤트 부착
    function attachLineDrag(elId, pageNum, dotNetRef, callbackName) {
        const el = document.getElementById(elId);
        if (!el) return;

        function startDrag(e) {
            e.preventDefault();
            const startClientY = e.touches ? e.touches[0].clientY : e.clientY;
            const canvas = document.getElementById('anno-canvas-' + pageNum);
            const scrollEl = document.getElementById('scroll-container');

            function getCanvasY(clientY) {
                if (!canvas) return clientY;
                const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
                const off = getOffsetPos(canvas);
                const scrollContainerTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
                return clientY - (off.y - scrollTop + scrollContainerTop);
            }

            function onMove(ev) {
                const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
                const canvasY = getCanvasY(cy);
                el.style.top = canvasY + 'px';
                dotNetRef.invokeMethodAsync(callbackName, canvasY);
            }
            function onUp(ev) {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup',   onUp);
                window.removeEventListener('touchmove', onMove);
                window.removeEventListener('touchend',  onUp);
            }
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup',   onUp);
            window.addEventListener('touchmove', onMove, { passive: false });
            window.addEventListener('touchend',  onUp);
        }

        el.addEventListener('mousedown',  startDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });
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

    let _hasPen = false; // 펜슬 감지 시 true → 팜 리젝션 활성화

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
            // 펜슬 감지 → 팜 리젝션 활성화
            if (e.pointerType === 'pen') _hasPen = true;
            // 팜 리젝션: 펜슬이 감지된 기기에서만 touch 차단 (아이폰은 touch가 유일 입력이므로 제외)
            if (_hasPen && e.pointerType === 'touch') return;
            const {normX, normY} = getNormPos(anno, e, pageNum);
            if (_tool !== 'pen' && _tool !== 'eraser' && _tool !== 'highlighter') return;
            e.preventDefault();
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
                hCtx.lineCap     = 'round';
                hCtx.lineJoin    = 'round';
                hCtx.globalAlpha = 0.35;
                hCtx.strokeStyle = _color;
                hCtx.globalCompositeOperation = 'multiply';
                hCtx.beginPath();
                hCtx.moveTo(bx, by);
                // 콕 클릭 시 점 찍기 — lineTo로 짧은 선 그어서 바로 표시
                hCtx.lineTo(bx + 0.5, by + 0.5);
                hCtx.stroke();
                hCtx.beginPath();
                hCtx.moveTo(bx, by);
                anno._hlCtx = hCtx;  // onMove에서 재사용
            } else {
                _stroke(anno, pageNum, bx, by, bx + 0.1, by + 0.1);
            }
            // 직선 스냅: 펜 2초, 형광펜 0.9초 후 직선 모드 전환 (지우개 제외)
            if (_tool === 'pen' || _tool === 'highlighter') {
            _snapTimer = setTimeout(() => {
                if (isDrawing && currentPath && currentPath.points.length >= 1) {
                    _snapTriggered = true;
                    const startPt = currentPath.points[0];
                    currentPath.points = [startPt];
                    redrawPage(pageNum);
                    if (navigator.vibrate) navigator.vibrate(30);
                }
            }, _tool === 'highlighter' ? 900 : 2000);
            }
        }

        function onMove(e) {
            if (_isPinching || _isZooming) return;
            if (_hasPen && e.pointerType === 'touch') return;
            if (!isDrawing || currentPageNum !== pageNum ||
                (_tool !== 'pen' && _tool !== 'eraser' && _tool !== 'highlighter')) return;
            e.preventDefault();
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

        // pointer 이벤트로 통합 (팜 리젝션: pen/mouse만 필기 허용, touch는 차단)
        anno.addEventListener('pointerdown', onDown, { signal: ac.signal });
        anno.addEventListener('pointermove', onMove, { signal: ac.signal });
        anno.addEventListener('pointerup',   onUp,   sig);
        anno.addEventListener('pointercancel', onUp, sig);
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
        if (path.tool === 'highlighter') {
            ctx.lineWidth  = path.size * 4 * currentZoom * dpr;
            ctx.lineCap    = 'square';
            ctx.lineJoin   = 'miter';
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = path.color;
            ctx.globalCompositeOperation = 'multiply';
        } else if (path.isEraser) {
            ctx.lineWidth  = path.size * currentZoom * dpr;
            ctx.lineCap    = 'round';
            ctx.lineJoin   = 'round';
            ctx.globalAlpha = 1.0;
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.globalCompositeOperation = 'destination-out';
        } else {
            ctx.lineWidth  = path.size * currentZoom * dpr;
            ctx.lineCap    = 'round';
            ctx.lineJoin   = 'round';
            ctx.globalAlpha = path.opacity ?? 1.0;
            ctx.strokeStyle = path.color;
            ctx.globalCompositeOperation = 'source-over';
        }
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
        // iOS Retina DPR=3은 메모리를 9배 사용 → 최대 2로 캡 (화질 차이 거의 없음)
        const dpr  = Math.min(window.devicePixelRatio || 1, 2);
        const vp   = page.getViewport({ scale: zoom });
        const cssW = Math.floor(vp.width);
        const cssH = Math.floor(vp.height);

        // 모바일 OOM 방지: canvas buffer 픽셀 수 상한 (16MP, 기존 32MP에서 절반)
        const MAX_BUF_PX = 16 * 1024 * 1024;
        const rawBufW = Math.floor(cssW * dpr);
        const rawBufH = Math.floor(cssH * dpr);
        const rawPx   = rawBufW * rawBufH;
        const scale   = rawPx > MAX_BUF_PX ? Math.sqrt(MAX_BUF_PX / rawPx) : 1.0;
        const bufW    = Math.floor(rawBufW * scale);
        const bufH    = Math.floor(rawBufH * scale);
        const renderDpr = dpr * scale; // 실제 render에 쓸 배율

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
        annoCanvas._dpr  = renderDpr;
        annoCanvas._zoom = zoom;

        const cursor = _tool === 'pen' ? 'crosshair' : _tool === 'eraser' ? 'cell' : 'default';
        annoCanvas.style.cursor = cursor;

        const ctx = pdfCanvas.getContext('2d');
        const task = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: zoom * renderDpr }) });
        _renderTasks[pageNum] = task;
        try { await task.promise; }
        catch (err) { if (err?.name !== 'RenderingCancelledException') console.warn('render err', pageNum, err); return; }
        _renderTasks[pageNum] = null;
        // 렌더 완료 후 PDF.js 내부 페이지 리소스(폰트·이미지 캐시) 해제
        try { page.cleanup(); } catch(_) {}
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

    let _isScrollingTo = false; // scrollToPage 중 onScroll 콜백 차단용

    function onScroll() {
        if (_isPinching || _isZooming || _isScrollingTo) return;
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
            const maxZ = Math.min(getMaxZoom(), _fitZoom * 6), minZ = _fitZoom * 0.3;
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
            
            if (e.touches.length !== 2) return;
            e.preventDefault();
            _pinchLatestDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
            _pinchLatestCx = (e.touches[0].clientX+e.touches[1].clientX)/2;
            _pinchLatestCy = (e.touches[0].clientY+e.touches[1].clientY)/2;
            if (_pinchRafId !== null) return;
            _pinchRafId = requestAnimationFrame(() => {
                _pinchRafId = null;
                if (!_isPinching) return;
                const newZ = Math.min(Math.min(getMaxZoom(),_fitZoom*6), Math.max(_fitZoom*0.3, _pinchStartZoom*_pinchLatestDist/_pinchStartDist));
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
            // 렌더 완료 알림 (scrollToPage 타이밍 동기화용)
            if (dotNetRef) dotNetRef.invokeMethodAsync('OnRenderPdfComplete').catch(() => {});
        },

        async renderAllPages(zoom) {
            if (!pdfDoc) return;
            if (_renderDebounceTimer) { clearTimeout(_renderDebounceTimer); _renderDebounceTimer = null; }
            const wrapper = document.getElementById('pdf-wrapper');
            if (wrapper) { wrapper.style.transform=''; wrapper.style.transformOrigin=''; wrapper.style.opacity='1'; }
            const maxZ = Math.min(getMaxZoom(), _fitZoom*6), minZ = _fitZoom*0.3;
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
            const cursor = (tool==='pen') ? 'crosshair' : tool==='eraser' ? 'cell' : 'default';
            for (let i = 1; i <= totalPages; i++) { const a = getAnnoCanvas(i); if (a) a.style.cursor = cursor; }
        },

        undo() { if (paths.length > basePaths.length) { paths.pop(); for (let i=1;i<=totalPages;i++) redrawPage(i); if (dotNetRef) dotNetRef.invokeMethodAsync('NotifyAnnotationChanged'); } },

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
            _renderTasks={}; _renderedPages=new Set(); _pageSizes={}; pdfDoc=null; paths=[]; basePaths=[];
            isDrawing=false; currentPath=null; _isPinching=false; _isZooming=false;
        },

        scrollToPage(pageNum) {
            const scrollEl = getScrollEl();
            if (!scrollEl) return;
            const doScroll = () => {
                _isScrollingTo = true;
                if (_pageSizes[1]) {
                    let top = 0;
                    for (let i = 1; i < pageNum; i++) {
                        if (_pageSizes[i]) top += Math.floor(_pageSizes[i].h * currentZoom) + 8;
                    }
                    scrollEl.scrollTop = top;
                    currentPageNum = pageNum;
                    // rAF 후 scrollTop 확인 및 재설정 + 플래그 해제
                    requestAnimationFrame(() => {
                        if (Math.abs(scrollEl.scrollTop - top) > 10)
                            scrollEl.scrollTop = top;
                        currentPageNum = pageNum;
                        if (dotNetRef) dotNetRef.invokeMethodAsync('UpdatePageFromJS', pageNum).catch(() => {});
                        // 스크롤 안정화 후 플래그 해제
                        setTimeout(() => { _isScrollingTo = false; }, 300);
                    });
                } else {
                    const el = document.getElementById('page-container-' + pageNum);
                    if (el && el.offsetHeight > 0) {
                        scrollEl.scrollTop += el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 8;
                        currentPageNum = pageNum;
                        setTimeout(() => { _isScrollingTo = false; }, 300);
                    } else {
                        _isScrollingTo = false;
                    }
                }
            };
            requestAnimationFrame(doScroll);
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
            basePaths = [...paths]; // 로드된 필기 박제
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

        // IDB에서 PDF bytes를 Uint8Array로 반환 (uploadPdfFromIDB에서 사용)
        async loadPdfBytesFromIDB(projectId) {
            try {
                const r = await loadPdfFromIDB(projectId);
                if (!r?.bytes) return null;
                return r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
            } catch(e) { console.error('loadPdfBytesFromIDB:', e); return null; }
        },

        // 마이그레이션용: 저장된 PDF를 base64 문자열로 반환 (없으면 null)
        // btoa(String.fromCharCode(...)) 한 번에 하면 수MB PDF에서 스택/메모리 초과로 실패하므로
        // 청크 단위로 나눠서 처리
        async getSavedPdfBase64(projectId) {
            try {
                const r = await loadPdfFromIDB(projectId);
                if (!r?.bytes) return null;
                const bytes = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
                const CHUNK = 8192;
                let bin = '';
                for (let i = 0; i < bytes.length; i += CHUNK) {
                    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
                }
                return btoa(bin);
            } catch(e) { console.error('getSavedPdfBase64:', e); return null; }
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

        async exportPdfsByIds(ids) {
            try {
                const db = await openDB();
                const idSet = new Set(ids);
                return new Promise((res, rej) => {
                    const req = db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).getAll();
                    req.onsuccess = e => {
                        const result = {};
                        for (const item of e.target.result) {
                            if (!idSet.has(item.projectId)) continue;
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
        detectRowHeight(pageNum) {
            try {
                const canvas = document.getElementById('pdf-canvas-' + pageNum);
                if (!canvas) return { rowHeight: 0, lineCount: 0, lineYs: [] };
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                const dpr     = window.devicePixelRatio || 1;
                const bw      = canvas.width, bh = canvas.height;
                const bufToCss = 1 / dpr;

                const imgData = ctx.getImageData(0, 0, bw, bh).data;

                // ── 1. 잉크 있는 X 범위 찾기 ─────────────────────────────
                const sampleH = Math.floor(bh * 0.4);
                let xMin = bw, xMax = 0;
                for (let y = 0; y < sampleH; y++) {
                    for (let x = 0; x < bw; x++) {
                        const i = (y * bw + x) * 4;
                        if ((imgData[i]+imgData[i+1]+imgData[i+2])/3 < 200) {
                            xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
                        }
                    }
                }
                if (xMax <= xMin) return { rowHeight: 0, lineCount: 0, lineYs: [] };
                const inkW = xMax - xMin;

                // ── 2. 각 행(y)에서 "가로 연속 어두운 픽셀 비율" 계산 ───
                // 행 경계선은 페이지 폭 전체를 가로지르므로 비율이 높음
                // 격자 교차점, 문자, 기호는 국소적이라 비율이 낮음
                const horizScore = new Float32Array(bh);
                const threshold  = 180; // 어둡다고 볼 밝기 기준
                for (let y = 0; y < bh; y++) {
                    let darkCount = 0;
                    for (let x = xMin; x <= xMax; x++) {
                        const i = (y * bw + x) * 4;
                        if ((imgData[i]+imgData[i+1]+imgData[i+2])/3 < threshold) darkCount++;
                    }
                    horizScore[y] = darkCount / inkW;
                }

                // ── 3. 점수 분포 파악 (상위 5%가 행 경계선 후보) ──────────
                const scoresSorted = Float32Array.from(horizScore).sort().reverse();
                // 점수가 높은 쪽 상위 5%의 최솟값을 문턱으로
                const topN     = Math.max(3, Math.floor(bh * 0.05));
                const lineThresh = scoresSorted[topN] * 0.6;

                console.log(`[행감지] inkX=${xMin}~${xMax}(${inkW}px), lineThresh=${lineThresh.toFixed(3)}`);

                // ── 4. 행 경계선 후보 추출 (로컬 피크) ────────────────────
                const candidates = [];
                for (let y = 2; y < bh - 2; y++) {
                    if (horizScore[y] >= lineThresh &&
                        horizScore[y] >= horizScore[y-1] &&
                        horizScore[y] >= horizScore[y+1] &&
                        horizScore[y] >= horizScore[y-2] &&
                        horizScore[y] >= horizScore[y+2]) {
                        candidates.push(y);
                    }
                }
                console.log(`[행감지] 후보 수: ${candidates.length}, 처음 10개: ${candidates.slice(0,10)}`);
                if (candidates.length < 3) return { rowHeight: 0, lineCount: candidates.length, lineYs: [] };

                // ── 5. 후보 간격 히스토그램으로 행 높이 탐지 ─────────────
                const candGaps = [];
                for (let i = 1; i < candidates.length; i++)
                    candGaps.push(candidates[i] - candidates[i-1]);

                candGaps.sort((a, b) => a - b);
                const medGap = candGaps[Math.floor(candGaps.length / 2)];

                // 중앙값 60~140% 범위 평균 → 기본 행 높이 추정
                const filtGaps = candGaps.filter(g => g > medGap * 0.6 && g < medGap * 1.4);
                const avgGap   = filtGaps.length > 0
                    ? filtGaps.reduce((a,b)=>a+b,0) / filtGaps.length : medGap;

                console.log(`[행감지] avgGap=${avgGap.toFixed(1)}buf_px → CSS ${(avgGap*bufToCss).toFixed(1)}px`);

                // ── 6. 히스토그램 피크로 실제 행 높이 확정 ───────────────
                const maxCandGap = Math.max(...candGaps);
                const hist = new Float32Array(maxCandGap + 2);
                const sigma = Math.max(1.5, avgGap * 0.1);
                for (const g of candGaps) {
                    for (let b = Math.max(1, g - Math.ceil(sigma*3)); b <= Math.min(maxCandGap, g + Math.ceil(sigma*3)); b++)
                        hist[b] += Math.exp(-0.5 * ((b-g)/sigma)**2);
                }
                // avgGap * 0.7 이상에서 첫 피크 찾기
                const searchFrom = Math.floor(avgGap * 0.7);
                let peakVal = 0, rowUnitGap = searchFrom;
                for (let b = searchFrom; b <= maxCandGap; b++) {
                    if (hist[b] > peakVal) { peakVal = hist[b]; rowUnitGap = b; }
                }
                console.log(`[행감지] rowUnitGap=${rowUnitGap}buf_px → CSS ${(rowUnitGap*bufToCss).toFixed(1)}px`);

                // ── 7. 실제 행 경계만 추출 (rowUnitGap * 0.7 이상 간격) ──
                const rowBounds = [candidates[0]];
                let lastY = candidates[0];
                for (let i = 1; i < candidates.length; i++) {
                    if (candidates[i] - lastY >= rowUnitGap * 0.7) {
                        rowBounds.push(candidates[i]);
                        lastY = candidates[i];
                    }
                }

                // ── 8. 최종 행 높이 재계산 ────────────────────────────────
                const finalGaps = [];
                for (let i = 1; i < rowBounds.length; i++)
                    finalGaps.push(rowBounds[i] - rowBounds[i-1]);
                finalGaps.sort((a,b)=>a-b);
                const finalMed = finalGaps[Math.floor(finalGaps.length/2)];
                const finalFilt = finalGaps.filter(g => g > finalMed*0.6 && g < finalMed*1.4);
                const finalAvg  = finalFilt.length > 0
                    ? finalFilt.reduce((a,b)=>a+b,0)/finalFilt.length : finalMed;
                const finalRowHeightCss = finalAvg * bufToCss;

                // 실제 감지된 행 경계 좌표를 CSS px로 변환해 그대로 사용
                const lineYs = rowBounds.map(y => y * bufToCss);

                console.log(`[행감지] 최종 ${rowBounds.length}행, 높이=${finalRowHeightCss.toFixed(1)}px, lineYs=${lineYs.length}개`);
                return { rowHeight: finalRowHeightCss, lineCount: lineYs.length, lineYs };

            } catch(e) {
                console.error('detectRowHeight error:', e);
                return { rowHeight: 0, lineCount: 0, lineYs: [] };
            }
        },

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

        // 페이지 높이 반환 (현재 CSS px — zoom 반영됨)
        getPageHeight(pageNum) {
            const canvas = document.getElementById('pdf-canvas-' + pageNum);
            return canvas ? canvas.offsetHeight : 0;
        },

        // 수동 행 높이: 두 선을 각각 드래그해서 한 행 높이 지정
        // 현재 보이는 화면 중앙의 canvas(zoom 반영 CSS px) 기준 Y좌표 — 마커 추가 시 "보이는 화면 중앙"에 생성하기 위해 사용
        getViewCenterCanvasY(pageNum) {
            const scrollEl = document.getElementById('scroll-container');
            const canvas   = document.getElementById('anno-canvas-' + pageNum);
            if (!canvas) return 200;

            const scrollTop  = scrollEl ? scrollEl.scrollTop : 0;
            const scrollH    = scrollEl ? scrollEl.clientHeight : window.innerHeight;
            const canvasRect = canvas.getBoundingClientRect();
            const canvasTop  = canvasRect.top + scrollTop - (scrollEl ? scrollEl.getBoundingClientRect().top : 0);

            return scrollTop + scrollH / 2 - canvasTop;
        },

        // 두 선(높이 조절용)에 드래그 이벤트만 부착 — 위치는 Blazor가 이미 선택한 마커 기준으로 설정해둔 상태이므로 덮어쓰지 않음
        initRowLines(pageNum, dotNetRef) {
            const canvas = document.getElementById('anno-canvas-' + pageNum);
            if (!canvas) return;
            // 마운트 후 잠깐 기다린 다음 부착 (DOM에 선이 렌더링될 시간 필요)
            setTimeout(() => {
                attachLineDrag('rowdraw-line-a-' + pageNum, pageNum, dotNetRef, 'SetRowLineAY');
                attachLineDrag('rowdraw-line-b-' + pageNum, pageNum, dotNetRef, 'SetRowLineBY');
            }, 50);
        },

        // 단일행 마커 드래그: JS가 직접 top 업데이트, 종료시만 Blazor 호출
        attachMarkerDrag(markerId, pageNum, zoom, dotNetRef) {
            const el = document.getElementById(markerId);
            if (!el) return;
            // 이미 부착된 경우 중복 방지
            if (el._markerDragAttached) return;
            el._markerDragAttached = true;

            const canvas   = document.getElementById('anno-canvas-' + pageNum);

            // getBoundingClientRect는 transform이 적용된 상태에서도 실제 화면 위치를 정확히 반환
            // (offsetTop은 transform 영향을 안 받아서, 줌 애니메이션 중이면 큰 오차 발생)
            function getCanvasY(clientY) {
                if (!canvas) return clientY;
                const rect = canvas.getBoundingClientRect();
                return clientY - rect.top;
            }

            function clampY(y) {
                const maxY = canvas ? canvas.clientHeight - 4 : y;
                return Math.max(0, Math.min(y, maxY));
            }
            // 드래그 판정 임계값(px) — 이보다 적게 움직였으면 클릭(선택)으로 간주, 서버 호출(StartMarkerDrag) 자체를 보내지 않음
            const DRAG_THRESHOLD = 4;
            let _startClientY = 0, _hasMoved = false, _dragStarted = false;

            function onMouseMove(ev) {
                ev.preventDefault();
                if (!_hasMoved && Math.abs(ev.clientY - _startClientY) > DRAG_THRESHOLD) {
                    _hasMoved = true;
                    if (!_dragStarted) { _dragStarted = true; dotNetRef.invokeMethodAsync('StartMarkerDrag', markerId); }
                }
                if (!_hasMoved) return; // 임계값 이내에서는 위치 변경 없음 → 순수 클릭(선택)으로 처리
                const y = clampY(getCanvasY(ev.clientY));
                el.style.top = y + 'px';
            }
            function onMouseUp(ev) {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                if (_hasMoved) {
                    const y = clampY(getCanvasY(ev.clientY));
                    el.style.top = y + 'px';
                    // zoom=0 sentinel: Blazor에서 현재 _zoom을 직접 사용 (JS snapshot 사용 안 함)
                    dotNetRef.invokeMethodAsync('EndMarkerDrag', markerId, y, 0, true);
                }
                // 움직이지 않았으면 서버에 아무 것도 보내지 않음 — 곧바로 발생하는 click 이벤트(@onclick=SelectMarker)만 처리됨
            }
            function onTouchMove(ev) {
                if (!_hasMoved && Math.abs(ev.touches[0].clientY - _startClientY) > DRAG_THRESHOLD) {
                    _hasMoved = true;
                    if (!_dragStarted) { _dragStarted = true; dotNetRef.invokeMethodAsync('StartMarkerDrag', markerId); }
                }
                if (!_hasMoved) return;
                ev.preventDefault(); // 드래그 확정 후에만 스크롤 억제
                const y = clampY(getCanvasY(ev.touches[0].clientY));
                el.style.top = y + 'px';
            }
            function onTouchEnd(ev) {
                window.removeEventListener('touchmove', onTouchMove);
                window.removeEventListener('touchend', onTouchEnd);
                if (_hasMoved) {
                    const changedTouch = ev.changedTouches[0];
                    const y = clampY(getCanvasY(changedTouch.clientY));
                    // zoom=0 sentinel: Blazor에서 현재 _zoom을 직접 사용 (JS snapshot 사용 안 함)
                    dotNetRef.invokeMethodAsync('EndMarkerDrag', markerId, y, 0, true);
                }
                // 움직이지 않았으면 서버 호출 없이 종료 — 뒤따르는 click 이벤트가 선택을 처리
            }

            function onMouseDown(ev) {
                if (_isZooming || _isPinching) return; // 줌 전환 중엔 좌표 기준이 불안정하므로 드래그 시작 차단
                _startClientY = ev.clientY;
                _hasMoved = false;
                _dragStarted = false;
                // preventDefault는 호출하지 않음 — 클릭(선택) 이벤트가 정상 발생하도록 둠
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            }
            function onTouchStart(ev) {
                if (_isZooming || _isPinching) return;
                _startClientY = ev.touches[0].clientY;
                _hasMoved = false;
                _dragStarted = false;
                window.addEventListener('touchmove', onTouchMove, { passive: false });
                window.addEventListener('touchend', onTouchEnd);
            }

            // Apple Pencil은 touchstart 대신 pointerdown(type=pen)으로 들어옴
            // → pointerdown으로도 드래그/선택이 동작하도록 추가 등록
            let _pencilClickPending = false;
            function onPointerDown(ev) {
                if (ev.pointerType !== 'pen' && ev.pointerType !== 'touch') return;
                if (_isZooming || _isPinching) return;
                _startClientY = ev.clientY;
                _hasMoved = false;
                _dragStarted = false;
                _pencilClickPending = false;
                function onPointerMove(ev2) {
                    if (!_hasMoved && Math.abs(ev2.clientY - _startClientY) > DRAG_THRESHOLD) {
                        _hasMoved = true;
                        if (!_dragStarted) { _dragStarted = true; dotNetRef.invokeMethodAsync('StartMarkerDrag', markerId); }
                    }
                    if (!_hasMoved) return;
                    const y = clampY(getCanvasY(ev2.clientY));
                    el.style.top = y + 'px';
                }
                function onPointerUp(ev2) {
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    if (_hasMoved) {
                        const y = clampY(getCanvasY(ev2.clientY));
                        el.style.top = y + 'px';
                        dotNetRef.invokeMethodAsync('EndMarkerDrag', markerId, y, 0, true);
                    } else {
                        // Pencil pointerup 후 click이 안 오는 경우가 있어서 직접 dispatch
                        _pencilClickPending = true;
                        requestAnimationFrame(() => { _pencilClickPending = false; el.dispatchEvent(new MouseEvent('click', { bubbles: false })); });
                    }
                }
                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
            }

            el.addEventListener('mousedown', onMouseDown);
            el.addEventListener('touchstart', onTouchStart, { passive: false });
            el.addEventListener('pointerdown', onPointerDown);

            // 나중에 detachMarkerDrag로 떼어낼 수 있도록 참조 저장
            el._markerDragHandlers = { onMouseDown, onTouchStart, onPointerDown };
        },

        // 흔적 남기기 등으로 더 이상 이동 불가능해진 마커의 드래그 리스너를 제거
        // (DOM 엘리먼트가 Blazor diffing으로 재사용될 때 옛 드래그 리스너가 남아있는 것을 방지)
        detachMarkerDrag(markerId) {
            const el = document.getElementById(markerId);
            if (!el || !el._markerDragAttached) return;
            const h = el._markerDragHandlers;
            if (h) {
                el.removeEventListener('mousedown', h.onMouseDown);
                el.removeEventListener('touchstart', h.onTouchStart);
                el.removeEventListener('pointerdown', h.onPointerDown);
            }
            el._markerDragAttached = false;
            el._markerDragHandlers = null;
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