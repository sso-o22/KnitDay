// PDF.js 5.x는 비교적 최근에 추가된 JS 기능(Math.sumPrecise, Map.prototype.getOrInsertComputed 등)을 직접 사용한다.
// 이 기능이 없는 브라우저(구버전 Chrome/삼성 인터넷/WebView 등)에서는 폰트 처리 중 예외가 나서
// 한글 서브셋 폰트가 일반 글자 코드(! " # $ ...)로 깨져 보이므로, 없을 때만 보충한다.
// 메인 스레드와 워커 양쪽에서 각각 실행되어야 한다 (워커는 별도 전역).
(function () {
    // Math.sumPrecise — 정확한 합산(Shewchuk). 비유한 값이 섞이면 일반 합산으로 대체.
    if (typeof Math.sumPrecise !== 'function') {
        Object.defineProperty(Math, 'sumPrecise', {
            configurable: true, writable: true,
            value: function sumPrecise(items) {
                const partials = [];
                let plain = -0, finite = true;
                for (let x of items) {
                    if (typeof x !== 'number') throw new TypeError('Math.sumPrecise expects numbers');
                    plain += x;
                    if (!Number.isFinite(x)) { finite = false; continue; }
                    let i = 0;
                    for (let y of partials) {
                        if (Math.abs(x) < Math.abs(y)) { const t = x; x = y; y = t; }
                        const hi = x + y;
                        const lo = y - (hi - x);
                        if (lo !== 0) partials[i++] = lo;
                        x = hi;
                    }
                    partials.length = i;
                    partials.push(x);
                }
                if (!finite) return plain;
                if (partials.length === 0) return -0;
                let sum = 0;
                for (let i = partials.length - 1; i >= 0; i--) sum += partials[i];
                return sum;
            }
        });
    }

    // Map/WeakMap.prototype.getOrInsert / getOrInsertComputed
    for (const C of [Map, WeakMap]) {
        const p = C.prototype;
        if (typeof p.getOrInsert !== 'function') {
            Object.defineProperty(p, 'getOrInsert', {
                configurable: true, writable: true,
                value: function getOrInsert(key, value) {
                    if (!this.has(key)) this.set(key, value);
                    return this.get(key);
                }
            });
        }
        if (typeof p.getOrInsertComputed !== 'function') {
            Object.defineProperty(p, 'getOrInsertComputed', {
                configurable: true, writable: true,
                value: function getOrInsertComputed(key, callbackFn) {
                    if (!this.has(key)) this.set(key, callbackFn(key));
                    return this.get(key);
                }
            });
        }
    }
})();
