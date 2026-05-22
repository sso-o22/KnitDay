// ── 드래그앤드롭 ──────────────────────────────────────────
document.addEventListener('dragover', e => e.preventDefault());

window.initCardDrag = (dotNetRef) => {
    // 기존 리스너 제거
    if (window._cardDragCleanup) window._cardDragCleanup();

    let dragId = null;

    const onDragStart = e => {
        const card = e.target.closest('[data-cardid]');
        if (!card) return;
        dragId = card.dataset.cardid;
        card.style.opacity = '0.5';
    };

    const onDragEnd = e => {
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.opacity = '';
            c.style.outline = '';
        });
        dragId = null;
    };

    const onDragOver = e => {
        const card = e.target.closest('[data-cardid]');
        document.querySelectorAll('[data-cardid]').forEach(c => c.style.outline = '');
        if (card && card.dataset.cardid !== dragId)
            card.style.outline = '2px dashed #267848';
    };

    const onDrop = e => {
        e.preventDefault();
        const card = e.target.closest('[data-cardid]');
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.outline = '';
            c.style.opacity = '';
        });
        if (!card || !dragId || card.dataset.cardid === dragId) { dragId = null; return; }
        const fromId = dragId;
        dragId = null;
        dotNetRef.invokeMethodAsync('DropCard', fromId, card.dataset.cardid);
    };

    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragend', onDragEnd);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);

    // cleanup 함수 저장 — 페이지 이동 시 Blazor가 Dispose 호출하면 제거
    window._cardDragCleanup = () => {
        document.removeEventListener('dragstart', onDragStart);
        document.removeEventListener('dragend', onDragEnd);
        document.removeEventListener('dragover', onDragOver);
        document.removeEventListener('drop', onDrop);
        window._cardDragCleanup = null;
    };
};

window.cleanupCardDrag = () => {
    if (window._cardDragCleanup) window._cardDragCleanup();
};
// ── 날짜 input placeholder (iOS Safari 대응) ──────────────────
// 빈 date input에 "연도-월-일" 텍스트 표시
function updateDatePlaceholders() {
    document.querySelectorAll('input[type="date"]').forEach(inp => {
        if (!inp.value) {
            inp.classList.add('date-empty');
            if (!inp.parentElement.classList.contains('date-input-wrap')) {
                // 감싸기 전 높이 기록
                const h = inp.offsetHeight;
                const wrap = document.createElement('div');
                wrap.className = 'date-input-wrap';
                // 래퍼 높이를 input 높이로 명시 고정
                if (h > 0) wrap.style.height = h + 'px';
                inp.parentNode.insertBefore(wrap, inp);
                wrap.appendChild(inp);
                const ph = document.createElement('span');
                ph.className = 'date-placeholder';
                ph.textContent = '연도-월-일';
                wrap.appendChild(ph);
            }
            const ph = inp.parentElement.querySelector('.date-placeholder');
            if (ph) ph.style.display = '';
        } else {
            inp.classList.remove('date-empty');
            const ph = inp.parentElement.querySelector('.date-placeholder');
            if (ph) ph.style.display = 'none';
        }
    });
}

// Blazor 렌더 완료 후 실행
document.addEventListener('DOMContentLoaded', updateDatePlaceholders);

// Blazor가 DOM 업데이트할 때마다 실행 (MutationObserver)
const _dateObserver = new MutationObserver(() => updateDatePlaceholders());
_dateObserver.observe(document.body, { childList: true, subtree: true });

// date input 변경 시 즉시 업데이트
document.addEventListener('change', e => {
    if (e.target.type === 'date') updateDatePlaceholders();
}, true);

// ── 모바일 디버그 콘솔 ──────────────────────────────────────
// URL에 ?debug=1 붙이면 화면에 로그 패널 표시
(function() {
    if (!location.search.includes('debug=1')) return;
    // 도안 뷰어 페이지에서만 표시
    // (다른 페이지 URL에 ?debug=1 붙여도 패널 안 뜸 — pattern-viewer 경로만 허용)
    // 모든 페이지에서 보고 싶으면 아래 줄 주석 처리
    if (!location.pathname.includes('pattern-viewer')) return;

    const panel = document.createElement('div');
    panel.id = '_dbg';
    panel.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0',
        'height:220px', 'background:rgba(0,0,0,0.88)',
        'color:#0f0', 'font:11px/1.4 monospace',
        'overflow-y:auto', 'z-index:99999',
        'padding:4px 6px', 'box-sizing:border-box',
        'border-top:2px solid #0f0'
    ].join(';');

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;position:sticky;top:0;background:rgba(0,0,0,0.9);padding:2px 0;';
    toolbar.innerHTML = '<span style="color:#0f0;flex:1;font-weight:bold;">📱 Debug Console</span>'
        + '<button onclick="document.getElementById(\'_dbg_log\').innerHTML=\'\'" style="background:#333;color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:11px;">Clear</button>'
        + '<button onclick="document.getElementById(\'_dbg\').style.height=(document.getElementById(\'_dbg\').style.height===\'220px\'?\'45px\':\'220px\')" style="background:#333;color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:11px;">↕</button>'
        + '<button onclick="document.getElementById(\'_dbg\').remove()" style="background:#c00;color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:11px;">✕</button>';

    const log = document.createElement('div');
    log.id = '_dbg_log';

    panel.appendChild(toolbar);
    panel.appendChild(log);
    document.body.appendChild(panel);

    function addLog(type, args) {
        const line = document.createElement('div');
        const colors = { log: '#0f0', warn: '#ff0', error: '#f44', info: '#4af' };
        line.style.color = colors[type] || '#0f0';
        line.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
        line.style.padding = '1px 0';
        const text = Array.from(args).map(a => {
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
            return String(a);
        }).join(' ');
        line.textContent = '[' + type.toUpperCase() + '] ' + text;
        log.appendChild(line);
        panel.scrollTop = panel.scrollHeight;
        // 최대 200줄
        while (log.children.length > 200) log.removeChild(log.firstChild);
    }

    ['log', 'warn', 'error', 'info'].forEach(type => {
        const orig = console[type].bind(console);
        console[type] = function(...args) { orig(...args); addLog(type, args); };
    });

    window.addEventListener('error', e => addLog('error', [e.message, e.filename + ':' + e.lineno]));
    window.addEventListener('unhandledrejection', e => addLog('error', ['UnhandledPromise:', e.reason]));

    console.log('Debug panel ready. URL: ' + location.href);
})();