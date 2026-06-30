// ── KnitDay IndexedDB (데이터 저장소) ────────────────────────────
// projects / yarns / tools / swatches / todos / photos 를 IDB에 저장
// localStorage 대체 — 용량 제한 없음
window.knitDB = (() => {
    const DB_NAME = 'KnitDayDB', DB_VER = 1;
    const STORES = ['data', 'photos'];   // data: JSON 컬렉션, photos: base64 이미지

    function openDB() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, DB_VER);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); });
            };
            req.onsuccess = e => res(e.target.result);
            req.onerror   = e => rej(e.target.error);
        });
    }

    async function get(store, key) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(store, 'readonly').objectStore(store).get(key);
            req.onsuccess = e => res(e.target.result ?? null);
            req.onerror   = e => rej(e.target.error);
        });
    }

    async function set(store, key, value) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(value, key);
            tx.oncomplete = res;
            tx.onerror    = e => rej(e.target.error);
        });
    }

    async function remove(store, key) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = res;
            tx.onerror    = e => rej(e.target.error);
        });
    }

    async function getAllKeys(store) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
            req.onsuccess = e => res(e.target.result);
            req.onerror   = e => rej(e.target.error);
        });
    }

    async function getAll(store) {
        const db = await openDB();
        return new Promise((res, rej) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = e => res(e.target.result);
            req.onerror   = e => rej(e.target.error);
        });
    }

    return {
        // ── 데이터 컬렉션 (JSON 문자열) ──
        async getData(key)          { return await get('data', key); },
        async setData(key, json)    { await set('data', key, json); },
        async removeData(key)       { await remove('data', key); },

        // ── 사진 (base64 문자열) ──
        async getPhoto(key)         { return await get('photos', key); },
        async setPhoto(key, b64)    { await set('photos', key, b64); },
        async removePhoto(key)      { await remove('photos', key); },
        async getAllPhotoKeys()      { return await getAllKeys('photos'); },

        // ── 내보내기용 전체 데이터 ──
        async exportAll() {
            const keys = ['knittracker_projects','knittracker_yarns','knittracker_tools','knittracker_swatches','knitlog_todos'];
            const result = {};
            for (const k of keys) {
                const v = await get('data', k);
                if (v) result[k] = JSON.parse(v);
            }
            result.exportedAt = new Date().toISOString();
            return result;
        },

        // ── 가져오기 (덮어쓰기) ──
        async importData(key, jsonStr) { await set('data', key, jsonStr); },

        // ── 용량 분류 계산 (사진 / 도안 / 기타) ──
        // 사진: knittracker_projects 안 Base64Data + knittracker_yarns/swatches 안 PhotoBase64
        // 도안: KnitLogPatternDB (별도 IDB)
        // 기타: 나머지 data store 전체
        async getUsageBreakdown() {
            try {
                // ── 기타 (data store 전체 JSON 크기) ──
                const allValues = await getAll('data');
                let otherBytes = 0;
                let photoBytes = 0;
                for (const val of allValues) {
                    if (typeof val !== 'string') continue;
                    const byteLen = new TextEncoder().encode(val).length;
                    // Base64 이미지 크기만 따로 추출 (data:image/... 패턴)
                    const imgMatches = val.match(/"data:image\/[^"]{10,}"/g) || [];
                    let imgBytes = 0;
                    for (const m of imgMatches) {
                        // base64 문자 수 → 실제 bytes ≈ len * 3/4
                        imgBytes += Math.floor(m.length * 0.75);
                    }
                    photoBytes += imgBytes;
                    otherBytes += byteLen - imgBytes;
                }

                // ── 도안 (KnitLogPatternDB) ──
                // 버전 번호 없이 열어서 신규 DB 생성/스키마 변경을 절대 트리거하지 않음
                // (버전 지정 시 patternViewer.js의 openDB()보다 먼저 실행되면
                //  onupgradeneeded 없이 빈 DB가 생성되어 'patterns' 스토어 누락 → NotFoundError 발생)
                let pdfBytes = 0;
                try {
                    const pdfDb = await new Promise((res, rej) => {
                        const req = indexedDB.open('KnitLogPatternDB');
                        req.onsuccess = e => res(e.target.result);
                        req.onerror   = e => rej(e.target.error);
                    });
                    if (!pdfDb.objectStoreNames.contains('patterns')) {
                        pdfDb.close();
                    } else {
                        const pdfRecs = await new Promise((res, rej) => {
                            const req = pdfDb.transaction('patterns','readonly').objectStore('patterns').getAll();
                            req.onsuccess = e => res(e.target.result);
                            req.onerror   = e => rej(e.target.error);
                        });
                        for (const rec of pdfRecs) {
                            if (rec.bytes) pdfBytes += rec.bytes.byteLength ?? rec.bytes.length ?? 0;
                        }
                        pdfDb.close();
                    }
                } catch(e) { /* PDF DB 없으면 0 */ }

                return JSON.stringify({ photoBytes, pdfBytes, otherBytes });
            } catch(e) {
                console.error('getUsageBreakdown:', e);
                return JSON.stringify({ photoBytes: 0, pdfBytes: 0, otherBytes: 0 });
            }
        },
    };
})();

// ── localStorage → IDB 마이그레이션 (최초 1회) ────────────────────
// 기존 localStorage에 데이터가 있으면 IDB로 옮기고 localStorage는 삭제
(async () => {
    const MIGRATE_FLAG = 'knitday_idb_migrated_v1';
    if (localStorage.getItem(MIGRATE_FLAG)) return;  // 이미 마이그레이션 완료

    const DATA_KEYS = [
        'knittracker_projects',
        'knittracker_yarns',
        'knittracker_tools',
        'knittracker_swatches',
        'knitlog_todos',
    ];

    let migrated = 0;
    for (const key of DATA_KEYS) {
        const val = localStorage.getItem(key);
        if (val && val !== '[]' && val !== 'null') {
            try {
                await window.knitDB.setData(key, val);
                localStorage.removeItem(key);
                migrated++;
            } catch(e) {
                console.warn('KnitDay migration failed for', key, e);
            }
        }
    }

    localStorage.setItem(MIGRATE_FLAG, '1');
    if (migrated > 0) console.log(`KnitDay: localStorage → IDB 마이그레이션 완료 (${migrated}개)`);
})();

// ── 드래그앤드롭 ──────────────────────────────────────────
document.addEventListener('dragover', e => e.preventDefault());

window.initCardDrag = (dotNetRef) => {
    if (window._cardDragCleanup) window._cardDragCleanup();

    let dragId = null;

    // ── 마우스 드래그 (PC) ──────────────────────────────────────
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
        const fromId = dragId; dragId = null;
        dotNetRef.invokeMethodAsync('DropCard', fromId, card.dataset.cardid);
    };

    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragend',   onDragEnd);
    document.addEventListener('dragover',  onDragOver);
    document.addEventListener('drop',      onDrop);

    // ── 터치 드래그 (iOS/Android) ──────────────────────────────
    let touchDragId  = null;
    let touchGhost   = null;
    let touchOverId  = null;
    let touchOffsetX = 0;
    let touchOffsetY = 0;
    let longPressTimer = null;
    let touchStartEl = null;

    function createGhost(card) {
        const rect = card.getBoundingClientRect();
        const ghost = card.cloneNode(true);
        ghost.style.cssText = `
            position:fixed; left:${rect.left}px; top:${rect.top}px;
            width:${rect.width}px; pointer-events:none; z-index:9999;
            opacity:0.85; border-radius:12px;
            box-shadow:0 8px 32px rgba(0,0,0,0.22);
            transform:scale(1.03); transition:transform 0.1s;
        `;
        document.body.appendChild(ghost);
        return ghost;
    }

    function clearHighlight() {
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.outline = '';
            c.style.opacity = '';
        });
    }

    const onTouchStart = e => {
        const card = e.target.closest('[data-cardid]');
        if (!card) return;
        // 내부 인터랙티브 요소 (버튼, input, a) 터치면 드래그 안 함
        if (e.target.closest('button, input, select, textarea, a, label')) return;

        touchStartEl = card;
        const touch = e.touches[0];
        const rect = card.getBoundingClientRect();
        touchOffsetX = touch.clientX - rect.left;
        touchOffsetY = touch.clientY - rect.top;

        // 롱프레스(350ms) 후 드래그 시작
        longPressTimer = setTimeout(() => {
            touchDragId = card.dataset.cardid;
            card.style.opacity = '0.4';
            touchGhost = createGhost(card);
            if (navigator.vibrate) navigator.vibrate(30);
        }, 350);
    };

    const onTouchMove = e => {
        if (!longPressTimer) return;
        // 손가락이 많이 움직이면 롱프레스 취소 (스크롤로 판정)
        if (!touchDragId) {
            const touch = e.touches[0];
            const card = touchStartEl;
            if (!card) { clearTimeout(longPressTimer); longPressTimer = null; return; }
            const rect = card.getBoundingClientRect();
            const dx = touch.clientX - rect.left - touchOffsetX;
            const dy = touch.clientY - rect.top  - touchOffsetY;
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                clearTimeout(longPressTimer); longPressTimer = null;
            }
            return;
        }
        e.preventDefault();
        const touch = e.touches[0];

        // ghost 이동
        if (touchGhost) {
            touchGhost.style.left = (touch.clientX - touchOffsetX) + 'px';
            touchGhost.style.top  = (touch.clientY - touchOffsetY) + 'px';
        }

        // 현재 손가락 아래 카드 감지
        touchGhost && (touchGhost.style.display = 'none');
        const el = document.elementFromPoint(touch.clientX, touch.clientY);
        touchGhost && (touchGhost.style.display = '');
        const overCard = el && el.closest('[data-cardid]');
        const overId = overCard ? overCard.dataset.cardid : null;

        if (overId !== touchOverId) {
            clearHighlight();
            if (touchDragId) document.querySelector(`[data-cardid="${touchDragId}"]`).style.opacity = '0.4';
            if (overId && overId !== touchDragId) {
                overCard.style.outline = '2px dashed #267848';
            }
            touchOverId = overId;
        }
    };

    const onTouchEnd = e => {
        clearTimeout(longPressTimer); longPressTimer = null;
        if (touchGhost) { touchGhost.remove(); touchGhost = null; }
        clearHighlight();

        if (!touchDragId) { touchStartEl = null; return; }
        const fromId = touchDragId;
        const toId   = touchOverId;
        touchDragId = null; touchOverId = null; touchStartEl = null;

        if (toId && toId !== fromId) {
            dotNetRef.invokeMethodAsync('DropCard', fromId, toId);
        }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove',  onTouchMove,  { passive: false });
    document.addEventListener('touchend',   onTouchEnd,   { passive: true });

    window._cardDragCleanup = () => {
        document.removeEventListener('dragstart', onDragStart);
        document.removeEventListener('dragend',   onDragEnd);
        document.removeEventListener('dragover',  onDragOver);
        document.removeEventListener('drop',      onDrop);
        document.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('touchmove',  onTouchMove);
        document.removeEventListener('touchend',   onTouchEnd);
        if (touchGhost) { touchGhost.remove(); touchGhost = null; }
        clearTimeout(longPressTimer);
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
        // 보임 → 숨김 (백그라운드 진입): 진행 중 타이머 종료 요청
        if (!_hidden && nowHidden) {
            dotNetRef.invokeMethodAsync('OnAppHidden').catch(() => {});
        }
        _hidden = nowHidden;
    });
    // iOS PWA: pagehide = 앱 종료/스와이프 아웃
    window.addEventListener('pagehide', () => {
        dotNetRef.invokeMethodAsync('OnAppHidden').catch(() => {});
    });
};

window.unregisterVisibilitySync = () => {
    // dotNetRef 해제는 Blazor 쪽에서 처리; 여기선 리스너 제거 불필요
    // (컴포넌트 dispose 시 dotNetRef가 해제되어 invoke가 silently fail됨)
};

// ── 온라인 복귀 시 Blazor에 알림 (오프라인 수정 push용) ────────────
window.registerOnlineSync = (dotNetRef) => {
    const onlineHandler = () => {
        // 오프라인 배너 숨기기
        const banner = document.getElementById('offline-banner');
        if (banner) banner.remove();
        showToast('온라인 연결됨 — 동기화 중...');
        dotNetRef.invokeMethodAsync('OnBackOnline').catch(() => {});
    };
    const offlineHandler = () => {
        if (document.getElementById('offline-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'offline-banner';
        banner.textContent = '오프라인 상태 — 로컬에 저장 중';
        banner.style.cssText = `
            position:fixed;top:0;left:0;right:0;
            background:#555;color:#fff;text-align:center;
            font-size:0.78rem;padding:5px 12px;
            z-index:99998;pointer-events:none;
        `;
        document.body.appendChild(banner);
    };
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    window._onlineSyncHandler = onlineHandler;
    window._offlineSyncHandler = offlineHandler;
    window._onlineSyncRef = dotNetRef;
    // 초기 오프라인 상태면 즉시 배너 표시
    if (!navigator.onLine) offlineHandler();
};

window.unregisterOnlineSync = () => {
    if (window._onlineSyncHandler) {
        window.removeEventListener('online', window._onlineSyncHandler);
        window._onlineSyncHandler = null;
    }
    if (window._offlineSyncHandler) {
        window.removeEventListener('offline', window._offlineSyncHandler);
        window._offlineSyncHandler = null;
    }
    window._onlineSyncRef = null;
};
// ── 토스트 알림 ──────────────────────────────────────────
window.showToast = function(message, type = 'success') {
    const toastId = (type === 'error' || type === 'info') ? 'kd-toast-alert' : 'kd-toast';
    const existing = document.getElementById(toastId);
    if (existing) existing.remove();

    const isAlert = type === 'error' || type === 'info';
    const toast = document.createElement('div');
    toast.id = toastId;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        ${isAlert
            ? 'top: calc(env(safe-area-inset-top, 0px) + 20px); bottom: auto;'
            : 'bottom: calc(env(safe-area-inset-bottom, 0px) + 80px);'}
        left: 50%;
        transform: translateX(-50%) translateY(${isAlert ? '-20px' : '20px'});
        max-width: calc(100vw - 40px);
        background: ${type === 'error' ? '#c03030' : type === 'info' ? '#2a6496' : '#666'};
        color: #fff;
        padding: 8px 18px;
        border-radius: 20px;
        font-size: 0.82rem;
        font-weight: 500;
        z-index: 99999;
        opacity: 0;
        transition: opacity 0.2s ease, transform 0.2s ease;
        white-space: pre-wrap;
        max-width: calc(100vw - 40px);
        text-align: center;
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
        toast.style.transform = `translateX(-50%) translateY(${isAlert ? '-8px' : '8px'})`;
        setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 4000 : type === 'info' ? 3000 : 1800);
};
// ── Debounce 유틸 (자동저장용) ───────────────────────────────────
window._debounceTimers = {};
window.debounce = (key, fn, delayMs) => {
    if (window._debounceTimers[key]) clearTimeout(window._debounceTimers[key]);
    window._debounceTimers[key] = setTimeout(() => {
        delete window._debounceTimers[key];
        fn();
    }, delayMs ?? 1500);
};

window.isOnline = () => navigator.onLine;
// ── 이미지 압축 (HEIF/HEIC 포함 → JPEG 변환, 리사이즈) ─────────
window.compressImage = function(base64DataUrl, maxWidthOrHeight = 800, quality = 0.75) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxWidthOrHeight || h > maxWidthOrHeight) {
                if (w > h) { h = Math.round(h * maxWidthOrHeight / w); w = maxWidthOrHeight; }
                else       { w = Math.round(w * maxWidthOrHeight / h); h = maxWidthOrHeight; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = base64DataUrl;
    });
};

// ── Cloudinary 업로드 ─────────────────────────────────────────────
const _CLOUD_NAME   = 'drgo1bi5z';
const _UPLOAD_PRESET = 'knitday_upload';

// base64DataUrl 또는 Blob → Cloudinary 업로드 → URL 반환
// resourceType: 'image' | 'raw' (PDF는 'raw')
window.uploadToCloudinary = async function(base64DataUrl, publicId, resourceType = 'image') {
    try {
        // Unsigned preset은 auto만 허용 — raw/image 구분은 Cloudinary가 자동 판단
        const uploadType = 'auto';
        const url = `https://api.cloudinary.com/v1_1/${_CLOUD_NAME}/${uploadType}/upload`;

        // base64 → Blob 변환
        let blob;
        if (base64DataUrl.startsWith('data:')) {
            const res = await fetch(base64DataUrl);
            blob = await res.blob();
        } else {
            // 순수 base64 (PDF bytes)
            const binary = atob(base64DataUrl);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            blob = new Blob([bytes], { type: 'application/pdf' });
        }

        const fd = new FormData();
        fd.append('file', blob, resourceType === 'raw' ? 'file.pdf' : 'file.jpg');
        fd.append('upload_preset', _UPLOAD_PRESET);
        fd.append('public_id', publicId);

        const resp = await fetch(url, { method: 'POST', body: fd });
        if (!resp.ok) { console.error('Cloudinary upload failed', resp.status); return null; }
        const data = await resp.json();
        if (!data.secure_url) return null;
        // bytes 및 resource_type 반환 (용량 추적용)
        return JSON.stringify({ url: data.secure_url, bytes: data.bytes ?? 0, resourceType });
    } catch(e) {
        console.error('uploadToCloudinary:', e);
        return null;
    }
};

// ── 체크리스트 touch 드래그 순서 변경 ────────────────────────────
window.initChecklistDrag = (dotNetRef, containerId) => {
    if (window._checklistDragCleanup) window._checklistDragCleanup();
    const container = document.getElementById(containerId);
    if (!container) return;

    let srcId = null, clone = null, ph = null;
    let startY = 0, startX = 0;
    let dragging = false;
    let pendingRow = null;   // touchstart 시 잡아둔 행

    const THRESHOLD = 8;    // 이 픽셀 이상 수직 이동 시 드래그 확정

    function cy(e) { return e.touches ? e.touches[0].clientY : e.clientY; }
    function cx(e) { return e.touches ? e.touches[0].clientX : e.clientX; }

    function startDrag(e, row) {
        if (dragging) return;
        dragging = true;
        const rect = row.getBoundingClientRect();
        startY  = cy(e);
        srcId   = row.dataset.checkid;

        ph = document.createElement('div');
        ph.style.cssText = `height:${rect.height}px;background:var(--theme-pale);border-radius:6px;flex-shrink:0;`;
        row.before(ph);
        row.remove();

        clone = document.createElement('div');
        clone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.2);border-radius:8px;background:var(--white);padding:8px 12px;font-size:0.85rem;color:var(--text-dark);pointer-events:none;box-sizing:border-box;opacity:0.95;display:flex;align-items:center;gap:8px;`;
        const label = row.querySelector('input.form-control')?.value || row.querySelector('span')?.textContent || '';
        clone.innerHTML = `<span style="color:var(--text-light);font-size:1rem;">⠿</span><span>${label}</span>`;
        document.body.appendChild(clone);
    }

    // ── Mouse ──
    function onMouseDown(e) {
        if (!e.target.closest('.drag-handle')) return;
        const row = e.target.closest('[data-checkid]');
        if (!row) return;
        e.preventDefault();
        startY = cy(e); startX = cx(e);
        startDrag(e, row);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup',   onMouseUp);
    }

    function onMouseMove(e) {
        if (!dragging) return;
        e.preventDefault();
        moveClone(e);
        movePlaceholder(cy(e));
    }

    function onMouseUp(e) {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        finish();
    }

    // ── Touch ──
    function onTouchStart(e) {
        if (!e.target.closest('.drag-handle')) return;
        const row = e.target.closest('[data-checkid]');
        if (!row) return;
        // passive:false이므로 preventDefault 가능 — 스크롤 차단
        e.preventDefault();
        startY = cy(e); startX = cx(e);
        pendingRow = row;
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend',  onTouchEnd,  { passive: false });
        document.addEventListener('touchcancel', onTouchCancel);
    }

    function onTouchMove(e) {
        if (!pendingRow) return;
        e.preventDefault();
        const dy = cy(e) - startY;
        const dx = cx(e) - startX;

        if (!dragging) {
            // threshold 초과 시 드래그 확정
            if (Math.abs(dy) > THRESHOLD) {
                startDrag(e, pendingRow);
                pendingRow = null;
            } else if (Math.abs(dx) > THRESHOLD * 2) {
                // 수평 이동이 크면 스크롤 의도 → 취소
                pendingRow = null;
                cleanup();
                return;
            }
        }

        if (dragging) {
            moveClone(e);
            movePlaceholder(cy(e));
        }
    }

    function onTouchEnd(e) {
        cleanup();
        finish();
    }

    function onTouchCancel() {
        cleanup();
        cancel();
    }

    function cleanup() {
        document.removeEventListener('touchmove',   onTouchMove);
        document.removeEventListener('touchend',    onTouchEnd);
        document.removeEventListener('touchcancel', onTouchCancel);
        pendingRow = null;
    }

    // ── 공통 ──
    function moveClone(e) {
        if (!clone) return;
        const dy = cy(e) - startY;
        clone.style.transform = `translateY(${dy}px)`;
    }

    function movePlaceholder(y) {
        if (!ph) return;
        const rows = [...container.querySelectorAll('[data-checkid]')];
        let placed = false;
        for (const r of rows) {
            const rect = r.getBoundingClientRect();
            if (y < rect.top + rect.height / 2) { r.before(ph); placed = true; break; }
        }
        if (!placed) container.appendChild(ph);
    }

    function finish() {
        if (!dragging) { cancel(); return; }
        dragging = false;
        if (clone) { clone.remove(); clone = null; }

        // ph 위치 기준으로 새 순서 계산
        let ids = [...container.querySelectorAll('[data-checkid]')].map(r => r.dataset.checkid);
        if (ph && ph.parentNode && srcId) {
            let next = ph.nextElementSibling;
            while (next && !next.dataset?.checkid) next = next.nextElementSibling;
            const insertIdx = next ? ids.indexOf(next.dataset.checkid) : -1;
            if (insertIdx >= 0) ids.splice(insertIdx, 0, srcId);
            else ids.push(srcId);
            ph.remove();
        } else {
            if (srcId && !ids.includes(srcId)) ids.push(srcId);
            if (ph) ph.remove();
        }
        ph = null;
        if (srcId) dotNetRef.invokeMethodAsync('ReorderChecklist', ids);
        srcId = null;
    }

    function cancel() {
        dragging = false;
        if (clone) { clone.remove(); clone = null; }
        if (ph) { ph.remove(); ph = null; }
        srcId = null; pendingRow = null;
    }

    container.addEventListener('mousedown',  onMouseDown);
    container.addEventListener('touchstart', onTouchStart, { passive: false });

    window._checklistDragCleanup = () => {
        container.removeEventListener('mousedown',  onMouseDown);
        container.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('mousemove',   onMouseMove);
        document.removeEventListener('mouseup',     onMouseUp);
        document.removeEventListener('touchmove',   onTouchMove);
        document.removeEventListener('touchend',    onTouchEnd);
        document.removeEventListener('touchcancel', onTouchCancel);
        cancel();
        window._checklistDragCleanup = null;
    };
};

window.cleanupChecklistDrag = () => {
    if (window._checklistDragCleanup) window._checklistDragCleanup();
};

// ── 모달 열기/닫기 스크롤 잠금 ──────────────────────────────
let _savedScrollY = 0;

window.lockBodyScroll = () => {
    _savedScrollY = window.scrollY || document.documentElement.scrollTop;
    document.body.style.overflow = 'hidden';
};

window.unlockBodyScroll = () => {
    document.body.style.overflow = '';
    window.scrollTo(0, _savedScrollY);
};

window.scrollModalToTop = () => {
    // 모바일: modal-backdrop이 스크롤 컨테이너
    const backdrop = document.querySelector('.modal-backdrop');
    if (backdrop) backdrop.scrollTop = 0;
    // PC: modal이 스크롤 컨테이너
    const modal = document.querySelector('.modal');
    if (modal) modal.scrollTop = 0;
};
// ── PDF 스트림 직접 Cloudinary 업로드 (큰 파일 대응) ─────────────
window.uploadPdfToCloudinary = async function(streamRef, publicId) {
    try {
        const arrayBuffer = await streamRef.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
        const url = `https://api.cloudinary.com/v1_1/${_CLOUD_NAME}/raw/upload`;
        const fd = new FormData();
        fd.append('file', blob, 'file');
        fd.append('upload_preset', _UPLOAD_PRESET);
        fd.append('public_id', publicId);
        const resp = await fetch(url, { method: 'POST', body: fd });
        if (!resp.ok) { console.error('Cloudinary PDF upload failed', resp.status); return null; }
        const data = await resp.json();
        if (!data.secure_url) return null;
        return JSON.stringify({ url: data.secure_url, bytes: data.bytes ?? 0, resourceType: 'raw' });
    } catch(e) {
        console.error('uploadPdfToCloudinary:', e);
        return null;
    }
};

// PDF 업로드 — base64로 통일 (DotNetStreamReference.arrayBuffer()가 Android Chrome 등에서 불안정)
// base64 → Uint8Array 변환 시 atob 청크 처리로 대용량 PDF도 안전하게 처리
// PDF Uint8Array를 직접 받아 Cloudinary에 업로드
// byte[] → JS Uint8Array 자동 변환 (Blazor WASM 기본 동작) — 인터롭 안정적
window.uploadPdfBytes = async function(uint8Array, publicId) {
    try {
        const blob = new Blob([uint8Array], { type: 'application/pdf' });
        const url = `https://api.cloudinary.com/v1_1/${_CLOUD_NAME}/raw/upload`;
        const fd = new FormData();
        fd.append('file', blob, 'file');
        fd.append('upload_preset', _UPLOAD_PRESET);
        fd.append('public_id', publicId);
        const resp = await fetch(url, { method: 'POST', body: fd });
        if (!resp.ok) { console.error('uploadPdfBytes: Cloudinary 실패', resp.status); return null; }
        const data = await resp.json();
        if (!data.secure_url) return null;
        return JSON.stringify({ url: data.secure_url, bytes: data.bytes ?? 0, resourceType: 'raw' });
    } catch(e) {
        console.error('uploadPdfBytes:', e);
        return null;
    }
};

// IDB에서 직접 읽어 업로드 (마이그레이션용)
window.uploadPdfFromIDB = async function(projectId, publicId) {
    try {
        const r = await window.patternViewer.loadPdfBytesFromIDB(projectId);
        if (!r) { console.error('uploadPdfFromIDB: IDB에 PDF 없음', projectId); return null; }
        return await window.uploadPdfBytes(r, publicId);
    } catch(e) {
        console.error('uploadPdfFromIDB:', e);
        return null;
    }
};

// ── PWA 설치 프롬프트 (Android Chrome) ──────────────────────────
let _installPromptEvent = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPromptEvent = e;
});

window.pwaInstall = {
    // 설치 프롬프트 사용 가능 여부
    canPrompt: () => !!_installPromptEvent,

    // 설치 프롬프트 실행
    prompt: async () => {
        if (!_installPromptEvent) return false;
        _installPromptEvent.prompt();
        const { outcome } = await _installPromptEvent.userChoice;
        _installPromptEvent = null;
        return outcome === 'accepted';
    },

    // standalone 모드 여부
    isStandalone: () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches,

    // iOS Safari 여부
    isIosSafari: () => {
        const ua = navigator.userAgent;
        return /iP(hone|od|ad)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|mercury/.test(ua);
    },

    // Android 여부
    isAndroid: () => /Android/.test(navigator.userAgent)
};

// ── PWA 설치 팝업 강제 표시 ──────────────────────────────────────
window._installGuideRef = null;

window.registerInstallGuideListener = (dotNetRef) => {
    window._installGuideRef = dotNetRef;
};

window.dispatchForceInstallGuide = async () => {
    if (window._installGuideRef) {
        try {
            await window._installGuideRef.invokeMethodAsync('HandleForceShowInstall');
        } catch(e) {
            console.warn('HandleForceShowInstall failed:', e);
        }
    }
};