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
    // iOS Safari에서만 적용
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;

    document.querySelectorAll('input[type="date"]').forEach(inp => {
        if (!inp.value) {
            inp.classList.add('date-empty');
            // data-placeholder 속성으로 CSS ::before 처리
            inp.setAttribute('data-placeholder', '연도-월-일');
        } else {
            inp.classList.remove('date-empty');
            inp.removeAttribute('data-placeholder');
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
    // URL ?debug=1 또는 localStorage knitlog_debug=1 이면 활성화
    const debugEnabled = location.search.includes('debug=1') || localStorage.getItem('knitlog_debug') === '1';
    if (!debugEnabled) return;
    // PWA(홈화면 추가)는 pathname이 고정이라 Blazor 해시/히스토리 라우팅으로 감지
    // → 패널은 항상 생성하되, pattern-viewer 경로일 때만 표시

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

    // Blazor SPA 라우팅 감지 - polling 방식 (PWA에서 pushState 패치 타이밍 문제 우회)
    let _lastHref = '';
    function checkRoute() {
        const href = location.href;
        if (href === _lastHref) return;
        _lastHref = href;
        const show = href.includes('pattern-viewer');
        panel.style.display = show ? '' : 'none';
        if (show) console.log('[DBG] pattern-viewer detected: ' + href);
    }
    // 초기 체크 + 100ms 간격 polling
    checkRoute();
    setInterval(checkRoute, 100);
    // popstate도 함께
    window.addEventListener('popstate', checkRoute);
})();

// ── 앱 포그라운드 복귀 시 Blazor에 알림 (다기기 동기화용) ──────────
window.registerVisibilitySync = (dotNetRef) => {
    let _hidden = document.hidden;
    document.addEventListener('visibilitychange', () => {
        const nowHidden = document.hidden;
        // 숨김 → 보임 (앱/탭이 포그라운드로 돌아옴)
        if (_hidden && !nowHidden) {
            dotNetRef.invokeMethodAsync('OnAppResumed').catch(() => {});
        }
        _hidden = nowHidden;
    });
};

window.unregisterVisibilitySync = () => {
    // dotNetRef 해제는 Blazor 쪽에서 처리; 여기선 리스너 제거 불필요
    // (컴포넌트 dispose 시 dotNetRef가 해제되어 invoke가 silently fail됨)
};

// ── 온라인 복귀 시 Blazor에 알림 (오프라인 수정 push용) ────────────
window.registerOnlineSync = (dotNetRef) => {
    const handler = () => {
        dotNetRef.invokeMethodAsync('OnBackOnline').catch(() => {});
    };
    window.addEventListener('online', handler);
    // cleanup용으로 저장
    window._onlineSyncHandler = handler;
    window._onlineSyncRef = dotNetRef;
};

window.unregisterOnlineSync = () => {
    if (window._onlineSyncHandler) {
        window.removeEventListener('online', window._onlineSyncHandler);
        window._onlineSyncHandler = null;
        window._onlineSyncRef = null;
    }
};
// ── 토스트 알림 ──────────────────────────────────────────
window.showToast = function(message, type = 'success') {
    const existing = document.getElementById('kd-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'kd-toast';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 80px);
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        max-width: calc(100vw - 40px);
        background: ${type === 'success' ? '#666' : '#c03030'};
        color: #fff;
        padding: 8px 18px;
        border-radius: 20px;
        font-size: 0.82rem;
        font-weight: 500;
        z-index: 99999;
        opacity: 0;
        transition: opacity 0.2s ease, transform 0.2s ease;
        white-space: nowrap;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        pointer-events: none;
    `;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0px)';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(8px)';
        setTimeout(() => toast.remove(), 300);
    }, 1800);
};