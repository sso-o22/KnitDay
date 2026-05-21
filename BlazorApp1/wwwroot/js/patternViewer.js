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

    // 핀치/휠 줌 상태 및 플래그
    let _fitZoom = 1.0;        
    let _pinchStartDist = 0;
    let _pinchStartZoom = 1.0;
    let _isPinching = false;
    let _isZooming = false;     // 🌟 휠/제스처 줌 전체를 감시하여 IntersectionObserver 오작동을 막는 플래그
    let _renderDebounceTimer = null;
    let _pendingZoom = null;

    const RENDER_AHEAD = 1; 

    function getPdfjsBase() {
        const baseEl = document.querySelector('base');
        const href = baseEl ? baseEl.href : (window.location.origin + '/');
        return href.replace(/\/$/, '');
    }

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

    let viewerContainer = null;
    let _intersectionObserver = null;
    let _pageSizes = {};      
    let _pageSizeCache = {};  

    // 🌟 대통합 줌 기능 (화면 튕김 차단 및 레이아웃 강제 유지)
    function changeZoom(newZoom) {
        if (!pdfDoc || !viewerContainer) return;

        _isZooming = true; 

        const scrollTop = viewerContainer.scrollTop;
        const scrollHeight = viewerContainer.scrollHeight;
        const scrollPercent = scrollTop / (scrollHeight || 1);

        currentZoom = Math.max(0.5, Math.min(newZoom, 4.0));
        _pageSizeCache = {}; 

        for (let i = 1; i <= totalPages; i++) {
            const container = document.getElementById('page-container-' + i);
            if (container) {
                const orig = _pageSizes[i];
                if (orig) {
                    const newWidth = orig.width * currentZoom;
                    const newHeight = orig.height * currentZoom;

                    container.style.width = newWidth + 'px';
                    container.style.height = newHeight + 'px';

                    const children = container.querySelectorAll('canvas, svg, .drawing-layer');
                    children.forEach(child => {
                        child.style.width = newWidth + 'px';
                        child.style.height = newHeight + 'px';
                    });
                }
            }
        }

        viewerContainer.scrollTop = scrollPercent * viewerContainer.scrollHeight;

        if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(() => {
            updateVirtualPages();

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
                _isZooming = false; 
            }, 100);
        }, 150);
    }

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

            redrawPage(pageNum);
        } catch (err) {
            if (err.name !== 'RenderingCancelledException') {
                console.error("Page render error:", err);
            }
            _renderedPages.delete(pageNum);
        }
    }

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

        ctx.save();
        ctx.scale(currentZoom, currentZoom);

        paths.forEach(p => {
            if (p.pageNum !== pageNum || p.points.length < 2) return;
            ctx.beginPath();
            ctx.strokeStyle = p.color;
            ctx.lineWidth = p.size / currentZoom; 
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
                    ctx.moveTo(p1.x, p1.y);
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
        initialize: async function (containerId, byteArray, dotnet) {
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

        // 🌟 버그 수정 완료: Blazor의 마우스 매핑 규격에 맞춰 완벽 복구
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

        // 🌟 버그 수정 완료: 드로잉 좌표 실시간 트래킹 원본 기능 복구
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

        // 🌟 버그 수정 완료: 그리기 종료 시 레이어에 패스를 고정하는 오리지널 로직 완벽 연동
        endDraw: function () {
            if (isDrawing) {
                isDrawing = false;
                if (currentPath) {
                    paths.push(currentPath);
                    const pg = currentPath.pageNum;
                    currentPath = null;
                    redrawPage(pg); // 마친 뒤 최종 확정선 새로고침
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