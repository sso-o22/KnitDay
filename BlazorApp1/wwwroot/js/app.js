// 드래그앤드롭 기본 동작 방지
document.addEventListener('dragover', e => e.preventDefault());

// 카드 드래그앤드롭
window.initCardDrag = (dotNetRef) => {
    let dragId = null;

    document.addEventListener('dragstart', e => {
        const card = e.target.closest('[data-cardid]');
        if (!card) return;
        dragId = card.dataset.cardid;
        setTimeout(() => card.style.opacity = '0.5', 0);
    });

    document.addEventListener('dragend', e => {
        const card = e.target.closest('[data-cardid]');
        if (card) card.style.opacity = '';
        document.querySelectorAll('[data-cardid]').forEach(c => c.style.outline = '');
        dragId = null;
    });

    document.addEventListener('dragover', e => {
        const card = e.target.closest('[data-cardid]');
        if (!card || card.dataset.cardid === dragId) return;
        document.querySelectorAll('[data-cardid]').forEach(c => c.style.outline = '');
        card.style.outline = '2px dashed #267848';
        card.style.outlineOffset = '2px';
    });

    document.addEventListener('drop', e => {
        const card = e.target.closest('[data-cardid]');
        document.querySelectorAll('[data-cardid]').forEach(c => {
            c.style.outline = '';
            c.style.opacity = '';
        });
        if (!card || !dragId || card.dataset.cardid === dragId) return;
        dotNetRef.invokeMethodAsync('DropCard', dragId, card.dataset.cardid);
        dragId = null;
    });
};
