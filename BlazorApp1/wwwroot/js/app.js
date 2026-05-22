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
            // wrapper가 없으면 생성
            if (!inp.parentElement.classList.contains('date-input-wrap')) {
                const wrap = document.createElement('div');
                wrap.className = 'date-input-wrap';
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