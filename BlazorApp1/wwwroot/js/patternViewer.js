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
    let _renderedPages = new Set(); // 실제 렌더된 페이지 추적

    // 핀치/휠 줌 상태 및 튕김 방지 플래그
    let _fitZoom = 1.0;        // 초기 fit-zoom 값
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;
    let _isPinching = false;
    let _isZooming = false;     // 🌟 휠/제스처 줌 전체를 감시하여 IntersectionObserver 튕김 오작동을 막는 플래그
    let _renderDebounceTimer = null;
    let _pendingZoom = null;

    // 가상화: 현재 보이는 페이지 기준 렌더 범위
    const RENDER_AHEAD = 1; // 위아래 1페이지씩만 렌더

    // ── base href 기준 절대경로 ──────────────────────────────
    function getPdfjsBase() {
        const baseEl = document.querySelector('base');
        const href = baseEl ? baseEl.href : (window.location.origin + '/');
        return href.replace(/\/$/, '');
    }

    // ── PDF.js inline module script 로드 ────────────────────
    let _pdfjsReady = null;
    async function ensurePdfjsLoaded() {
        if (_pdfjsReady) return _pdfjsReady;
        _pdfjsReady = (async () => {
            if (window.pdfjsLib) return;
            const base = getPdfjsBase();
            window.pdfjsWebAppOptions = { workerSrc: base + '/pdfjs/build/pdf.worker.mjs' };
            
            const script = document.createElement('script');
            script.type = 'module';
            script.src = base + '/pdfjs/build/pdf.mjs';
            document.head.appendChild(script);

            await new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window.pdfjsLib) {
                        clearInterval(check);
                        resolve();
                    }
                }, 50);
            });
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + '/pdfjs/build/pdf.worker.mjs';
        })();
        return _pdfjsReady;
    }

    // ── 전역 상태 관리 ───────────────────────────────────────
    let viewerContainer = null;
    let _intersectionObserver = null;
    let _pageSizes = {};      // {pageNum: {width, height}} 원본 사이즈 캐시
    let _pageSizeCache = {};  // {pageNum: {width, height}} currentZoom 반영 사이즈 캐시

    // 🌟 대통합 줌 기능 (확대/축소 시 튕김 방지 및 레이아웃 강제 고정 핵심 엔진)
    function changeZoom(newZoom) {
        if (!pdfDoc || !viewerContainer) return;

        // 1. 줌 동작 시작을 알려 IntersectionObserver 스크롤 감지를 잠시 차단
        _isZooming = true; 

        // 2. 현재 유저가 스크롤해서 보고 있던 위치의 퍼센트(%) 비율 저장
        const scrollTop = viewerContainer.scrollTop;
        const scrollHeight = viewerContainer.scrollHeight;
        const scrollPercent = scrollTop / (scrollHeight || 1);

        // 배율 제약 조건 (최소 0.5배 ~ 최대 4.0배)
        currentZoom = Math.max(0.5, Math.min(newZoom, 4.0));
        _pageSizeCache = {}; // 줌 배율이 바뀌었으므로 렌더링용 사이즈 캐시 초기화

        // 3. 렌더링 타임아웃 대기 시간 동안 컨테이너 및 모든 그리기 레이어 크기를 즉시 선변경
        for (let i = 1; i <= totalPages; i++) {
            const container = document.getElementById('page-container-' + i);
            if (container) {
                const orig = _pageSizes[i];
                if (orig) {
                    const newWidth = orig.width * currentZoom;
                    const newHeight = orig.height * currentZoom;

                    container.style.width = newWidth + 'px';
                    container.style.height = newHeight + 'px';

                    // 펜 선이나 도형 가이드 레이어가 어긋나지 않도록 자식 요소들도 동시에 임시 확대
                    const children = container.querySelectorAll('canvas, svg, .drawing-layer');
                    children.forEach(child => {
                        child.style.width = newWidth + 'px';
                        child.style.height = newHeight + 'px';
                    });
                }
            }
        }

        // 4. 계산된 비율에 맞춰 스크롤 바 위치를 강제로 홀딩 (화면 튕김 차단)
        viewerContainer.scrollTop = scrollPercent * viewerContainer.scrollHeight;

        // 5. 손가락을 떼거나 휠 조작이 멈추고 150ms 뒤에 고해상도로 정밀 재렌더링 수행
        if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(() => {
            updateVirtualPages();

            // 깨끗한 고해상도 벡터 이미지가 박히면 임시 가상 인라인 CSS 스타일을 해제
            setTimeout(() => {
                for (let i = 1; i <= totalPages; i++) {
                    const container = document.getElementById('page-container-' + i);
                    if (container) {
                        const children = container.querySelectorAll('canvas, svg, .drawing-layer');
                        children.forEach(child => {
                            child.style.width = '';
                            child.style.height = '';
                        });
                    }
                }
                _isZooming = false; // 방어막 해제
            }, 100);
        }, 150);
    }

    // ── 가상화 레이아웃 사이즈 연산 ───────────────────────────
    function getPageSize(pageNum) {
        if (_pageSizeCache[pageNum]) return _pageSizeCache[pageNum];
        const orig = _pageSizes[pageNum];
        if (!orig) return { width: 300, height: 400 };
        const w = orig.width * currentZoom;
        const h = orig.height * currentZoom;
        _pageSizeCache[pageNum] = { width: w, height: h };
        return _pageSizeCache[pageNum];
    }

    function updateVirtualPages() {
        if (!pdfDoc) return;
        const start = Math.max(1, currentPageNum - RENDER_AHEAD);
        const end = Math.min(totalPages, currentPageNum + RENDER_AHEAD);

        // 1. 범위를 벗어난 안 보이는 페이지 캔버스 제거 (메모리 절약)
        for (let i = 1; i <= totalPages; i++) {
            if (i < start || i > end) {
                if (_renderedPages.has(i)) {
                    const container = document.getElementById('page-container-' + i);
                    if (container) {
                        const cv = container.querySelector('canvas');
                        if (cv) cv.remove();
                    }
                    _renderedPages.delete(i);
                    if (_renderTasks[i]) {
                        try { _renderTasks[i].cancel(); } catch (_) {}
                        _renderTasks[i] = null;
                    }
                }
            }
        }

        // 2. 현재 보이는 타겟 범위 내의 페이지 고해상도 리렌더링
        for (let i = start; i <= end; i++) {
            if (!_renderedPages.has(i)) {
                renderActualPage(i);
            }
        }
    }

    async function renderActualPage(pageNum) {
        if (!pdfDoc || _renderedPages.has(pageNum)) return;
        _renderedPages.add(pageNum);

        try {
            const container = document.getElementById('page-container-' + pageNum);
            if (!container) return;

            if (_renderTasks[pageNum]) {
                try { _renderTasks[pageNum].cancel(); } catch (_) {}
            }

            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: currentZoom });

            let canvas = container.querySelector('canvas');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.style.position = 'absolute';
                canvas.style.left = '0';
                canvas.style.top = '0';
                canvas.style.zIndex = '1';
                container.appendChild(canvas);
            }

            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const ctx = canvas.getContext('2d');
            const renderContext = { canvasContext: ctx, viewport: viewport };
            const task = page.render(renderContext);
            _renderTasks[pageNum] = task;

            await task.promise;
            _renderTasks[pageNum] = null;

            // PDF 배경이 그려진 후 유저가 그린 필기 데이터 매끄럽게 복원
            redrawPage(pageNum);
        } catch (err) {
            if (err.name !== 'RenderingCancelledException') {
                console.error("Page render error:", err);
            }
            _renderedPages.delete(pageNum);
        }
    }

    // ── 아노테이션/드로잉 드로우 복원 백엔드 ────────────────
    function redrawPage(pageNum) {
        const container = document.getElementById('page-container-' + pageNum);
        if (!container) return;
        let canvas = container.querySelector('.drawing-layer');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'drawing-layer';
            canvas.style.position = 'absolute';
            canvas.style.left = '0';
            canvas.style.top = '0';
            canvas.style.zIndex = '5';
            canvas.style.pointerEvents = 'none';
            container.appendChild(canvas);
        }

        const size = getPageSize(pageNum);
        canvas.width = size.width;
        canvas.height = size.height;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const orig = _pageSizes[pageNum];
        if (!orig) return;

        // 원본 좌표계 데이터를 현재 줌 레벨에 맞추어 드로잉 컨텍스트 배율 동기화
        ctx.save();
        ctx.scale(currentZoom, currentZoom);

        paths.forEach(p => {
            if (p.pageNum !== pageNum || p.points.length < 2) return;
            ctx.beginPath();
            ctx.strokeStyle = p.color;
            ctx.lineWidth = p.size / currentZoom; // 줌 배율에 반비례하여 펜 굵기가 일정하게 보이도록 보정
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (p.tool === 'ruler' || p.tool === 'rect') {
                const p1 = p.points[0];
                const p2 = p.points[1];
                if (p.tool === 'ruler') {
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                } else {
                    ctx.rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
                }
            } else {
                ctx.moveTo(p.points[0].x, p.points[0].y);
                for (let i = 1; i < p.points.length; i++) {
                    ctx.lineTo(p.points[i].x, p.points[i].y);
                }
            }
            ctx.stroke();
        });

        // 현재 실시간으로 그리고 있는 활성 패스 렌더링
        if (currentPath && currentPath.pageNum === pageNum && currentPath.points.length >= 2) {
            ctx.beginPath();
            ctx.strokeStyle = currentPath.color;
            ctx.lineWidth = currentPath.size / currentZoom;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (currentPath.tool === 'ruler' || currentPath.tool === 'rect') {
                const p1 = currentPath.points[0];
                const p2 = currentPath.points[1];
                if (currentPath.tool === 'ruler') {
                    ctx.moveTo(currentPath.points[0].x, currentPath.points[0].y);
                    ctx.lineTo(p2.x, p2.y);
                } else {
                    ctx.rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
                }
            } else {
                ctx.moveTo(currentPath.points[0].x, currentPath.points[0].y);
                for (let i = 1; i < currentPath.points.length; i++) {
                    ctx.lineTo(currentPath.points[i].x, currentPath.points[i].y);
                }
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // ── 이벤트 핸들러 마운트 및 연산 구역 ─────────────────────
    function handleWheel(e) {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 0.15 : -0.15; 
            changeZoom(currentZoom + delta);
        }
    }

    function handleTouchStart(e) {
        if (e.touches.length === 2) {
            _isPinching = true;
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            _pinchStartDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            _pinchStartZoom = currentZoom;
        }
    }

    function handleTouchMove(e) {
        if (_isPinching && e.touches.length === 2) {
            e.preventDefault();
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
            if (_pinchStartDist > 0) {
                changeZoom(_pinchStartZoom * (dist / _pinchStartDist));
            }
        }
    }

    function handleTouchEnd(e) {
        if (_isPinching && e.touches.length < 2) {
            _isPinching = false;
        }
    }

    return {
        // 🌟 원본 규격 완벽 복구 1: Blazor가 최초 렌더링 시 무조건 호출하는 'initialize' 함수명 유지
        initialize: async function (containerId, dotnet) {
            this.dispose();
            await ensurePdfjsLoaded();

            viewerContainer = document.getElementById(containerId);
            if (!viewerContainer) return;
            dotNetRef = dotnet;

            viewerContainer.addEventListener('wheel', handleWheel, { passive: false });
            viewerContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
            viewerContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
            viewerContainer.addEventListener('touchend', handleTouchEnd, { passive: true });

            _intersectionObserver = new IntersectionObserver((entries) => {
                if (_isPinching || _isZooming) return;

                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const pageNum = parseInt(entry.target.getAttribute('data-page-number'));
                        if (!isNaN(pageNum)) {
                            currentPageNum = pageNum;
                            if (dotNetRef) dotNetRef.invokeMethodAsync('OnPageChanged', currentPageNum);
                        }
                    }
                });
            }, {
                root: viewerContainer,
                threshold: 0.3 
            });
        },

        // 🌟 원본 규격 완벽 복구 2: Blazor가 PDF 로드 시 에러를 뿜었던 진짜 원인 함수 'renderPdf' 이름 완벽 복구 및 통합
        renderPdf: async function (byteArray) {
            if (!viewerContainer) return 0;
            
            const loadingTask = window.pdfjsLib.getDocument({ data: byteArray });
            pdfDoc = await loadingTask.promise;
            totalPages = pdfDoc.numPages;

            const firstPage = await pdfDoc.getPage(1);
            const view = firstPage.getViewport({ scale: 1.0 });
            _fitZoom = (viewerContainer.clientWidth - 24) / view.width;
            currentZoom = _fitZoom;

            for (let i = 1; i <= totalPages; i++) {
                const pg = await pdfDoc.getPage(i);
                const vp = pg.getViewport({ scale: 1.0 });
                _pageSizes[i] = { width: vp.width, height: vp.height };

                const container = document.getElementById('page-container-' + i);
                if (container) {
                    const sz = getPageSize(i);
                    container.style.width = sz.width + 'px';
                    container.style.height = sz.height + 'px';
                    _intersectionObserver.observe(container);
                }
            }

            updateVirtualPages();
            return totalPages;
        },

        setCurrentPage: function (pageNum) {
            if (pageNum < 1 || pageNum > totalPages) return;
            currentPageNum = pageNum;
            const container = document.getElementById('page-container-' + pageNum);
            if (container && viewerContainer) {
                _isZooming = true;
                container.scrollIntoView({ behavior: 'auto', block: 'start' });
                setTimeout(() => { _isZooming = false; }, 150);
            }
            updateVirtualPages();
        },

        setTool: function (color, size, isEraser, toolName) {
            _color = color;
            _size = size;
            _isEraser = isEraser;
            _tool = toolName;
        },

        startDraw: function (pageNum, x, y) {
            if (_tool === 'select' || isDrawing) return;
            isDrawing = true;

            const origX = x / currentZoom;
            const origY = y / currentZoom;

            if (_tool === 'eraser') {
                const eraseRadius = 12 / currentZoom;
                paths = paths.filter(p => {
                    if (p.pageNum !== pageNum) return true;
                    const hit = p.points.some(pt => Math.hypot(pt.x - origX, pt.y - origY) <= eraseRadius);
                    return !hit;
                });
                isDrawing = false;
                for (let i = 1; i <= totalPages; i++) redrawPage(i);
            } else {
                currentPath = {
                    pageNum: pageNum,
                    color: _color,
                    size: _size,
                    tool: _tool,
                    points: [{ x: origX, y: origY }]
                };
            }
        },

        drawTo: function (pageNum, x, y) {
            if (!isDrawing || !currentPath || currentPath.pageNum !== pageNum) return;
            const origX = x / currentZoom;
            const origY = y / currentZoom;

            if (_tool === 'ruler' || _tool === 'rect') {
                if (currentPath.points.length === 1) {
                    currentPath.points.push({ x: origX, y: origY });
                } else {
                    currentPath.points[1] = { x: origX, y: origY };
                }
            } else {
                currentPath.points.push({ x: origX, y: origY });
            }
            redrawPage(pageNum);
        },

        endDraw: function () {
            if (isDrawing) {
                isDrawing = false;
                if (currentPath) {
                    paths.push(currentPath);
                    const pg = currentPath.pageNum;
                    currentPath = null;
                    redrawPage(pg); 
                }
            }
        },

        setCursor: function (cursor) {
            for (let i = 1; i <= totalPages; i++) {
                const a = document.getElementById('page-container-' + i);
                if (a) a.style.cursor = cursor;
            }
        },

        undo: function () {
            paths.pop();
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        },

        getRect: function (pageNum) {
            const pg = pageNum || currentPageNum;
            const container = document.getElementById('page-container-' + pg);
            if (!container) return [0, 0, 0, 0];
            const r = container.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        },

        clearAnnotations: function () {
            paths = [];
            for (let i = 1; i <= totalPages; i++) redrawPage(i);
        },

        dispose: function () {
            if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
            if (_intersectionObserver) { _intersectionObserver.disconnect(); _intersectionObserver = null; }
            Object.values(_renderTasks).forEach(t => { try { if (t) t.cancel(); } catch (_) {} });
            _renderTasks   = {};
            _renderedPages = new Set();
            pdfDoc         = null;
            paths          = [];
            _pageHandlers  = {};
            isDrawing      = false;
            currentPath    = null;
            _isPinching    = false;
            _isZooming     = false;
            _pageSizeCache = {};
        },

        preventScroll: function () {}
    };
})();