// 드래그앤드롭 기본 동작 방지
document.addEventListener('dragover', e => e.preventDefault());

window.initCardDrag = (dotNetRef) => {
    let dragId = null;

    // 이미 등록된 리스너 제거 방지
    if (window._cardDragInitialized) return;
    window._cardDragInitialized = true;

    document.addEventListener('dragstart', e => {
        const card = e.target.closest('[data-cardid]');
        if (!card) return;
        dragId = card.dataset.cardid;
        card.style.opacity = '0.5';
    });

    document.addEventListener('dragend', e => {
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.opacity = '';
            c.style.outline = '';
        });
        dragId = null;
    });

    document.addEventListener('dragover', e => {
        const card = e.target.closest('[data-cardid]');
        if (!card) return;
        document.querySelectorAll('[data-cardid]').forEach(c => c.style.outline = '');
        if (card.dataset.cardid !== dragId)
            card.style.outline = '2px dashed #267848';
    });

    document.addEventListener('drop', e => {
        e.preventDefault();
        const card = e.target.closest('[data-cardid]');
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.outline = '';
            c.style.opacity = '';
        });
        if (!card || !dragId || card.dataset.cardid === dragId) {
            dragId = null;
            return;
        }
        const toId = card.dataset.cardid;
        const fromId = dragId;
        dragId = null;
        dotNetRef.invokeMethodAsync('DropCard', fromId, toId);
    });
};