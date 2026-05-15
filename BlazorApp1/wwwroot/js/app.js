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