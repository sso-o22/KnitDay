// ── Firebase 초기화 ───────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
    indexedDBLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    getFirestore, doc, getDoc, getDocFromServer, setDoc, collection, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
    getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const firebaseConfig = {
    apiKey:            "%%FIREBASE_API_KEY%%",
    authDomain:        "knitlog-94c63.firebaseapp.com",
    projectId:         "knitlog-94c63",
    storageBucket:     "knitlog-94c63.firebasestorage.app",
    messagingSenderId: "448627074243",
    appId:             "1:448627074243:web:32924c7262d7efc6e5ae76"
};

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const db       = getFirestore(app);
const functions = getFunctions(app, 'asia-northeast3');
const provider = new GoogleAuthProvider();

// Blazor에서 Cloud Function 호출용 전역 함수
window.callFirebaseFunction = async (name, jsonData) => {
    const fn = httpsCallable(functions, name);
    const data = jsonData ? JSON.parse(jsonData) : {};
    const result = await fn(data);
    return JSON.stringify(result.data);
};

// ── 영구 세션 유지 (IndexedDB) ────────────────────────────────────
// setPersistence는 비동기지만 auth 객체에 즉시 반영됨
// waitForAuthReady보다 먼저 설정되도록 모듈 최상단에서 호출
const _persistenceReady = setPersistence(auth, indexedDBLocalPersistence)
    .catch(e => {
        // 실패해도 앱은 계속 동작하되, 세션 유지가 안 될 수 있음을 경고
        console.error('setPersistence failed — 세션이 유지되지 않을 수 있습니다:', e);
    });

// ── Auth ─────────────────────────────────────────────────────────
window.firebaseAuth = {
    async signInWithGoogle() {
        try {
            // persistence 설정 완료 후 로그인 시도
            await _persistenceReady;
            const result = await signInWithPopup(auth, provider);
            const u = result.user;

            // ── 허용된 계정 확인 ────────────────────────────────────────
            // 관리자 UID는 allowedUsers 체크 없이 바로 통과
            const adminUid = 'xAz2xO8kulWUgoHnaaxCkzZV2nG2';
            if (u.uid !== adminUid) {
                try {
                    const allowDoc = await getDoc(doc(db, 'allowedUsers', u.email));
                    if (!allowDoc.exists()) {
                        // 미등록 계정 — 즉시 로그아웃 후 거부 신호 반환
                        await signOut(auth);
                        return { __denied__: true, email: u.email };
                    }
                    // 기간 만료 체크 (expiresAt 없으면 평생이용권 → 통과)
                    const expiresAt = allowDoc.data()?.expiresAt;
                    if (expiresAt && expiresAt !== 'lifetime' && new Date(expiresAt) < new Date()) {
                        await signOut(auth);
                        return { __expired__: true, email: u.email, expiresAt, dataDeletedAt: allowDoc.data()?.dataDeletedAt || null };
                    }
                } catch (checkErr) {
                    // Firestore 접근 오류 시 안전하게 거부
                    console.error('allowedUsers check failed:', checkErr);
                    await signOut(auth);
                    return { __denied__: true, email: u.email };
                }
            }
            // ────────────────────────────────────────────────────────────

            // allowedUsers에 uid 업데이트 (탈퇴/완전삭제 시 활용)
            // expiresAt 없으면 "lifetime"으로 자동 생성 (관리자 포함)
            try {
                const allowRef = doc(db, 'allowedUsers', u.email);
                const existingDoc = await getDoc(allowRef);
                const updateData = { uid: u.uid, lastLoginAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() };
                if (!existingDoc.data()?.expiresAt) {
                    updateData.expiresAt = 'lifetime';
                }
                await setDoc(allowRef, updateData, { merge: true });
            } catch (_) { /* uid 업데이트 실패해도 로그인은 진행 */ }

            return { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL };
        } catch (e) {
            // iOS Safari 등 팝업 차단 시 redirect 방식으로 폴백
            if (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request') {
                try {
                    await signInWithRedirect(auth, provider);
                    return null; // redirect 후 페이지 reload됨
                } catch (re) {
                    console.error('signInWithRedirect:', re.code, re.message);
                    return null;
                }
            }
            console.error('signInWithGoogle:', e.code, e.message);
            return null;
        }
    },

    async signOut() {
        try { await signOut(auth); return true; }
        catch (e) { return false; }
    },

    getCurrentUser() {
        const u = auth.currentUser;
        if (!u) return null;
        return { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL };
    },

    onAuthStateChanged(dotNetRef) {
        onAuthStateChanged(auth, async user => {
            if (user) {
                // 이미 로그인된 상태에서도 만료 체크
                const adminUid = 'xAz2xO8kulWUgoHnaaxCkzZV2nG2';
                if (user.uid !== adminUid) {
                    try {
                        const allowDoc = await getDoc(doc(db, 'allowedUsers', user.email));
                        if (!allowDoc.exists()) {
                            await signOut(auth);
                            dotNetRef.invokeMethodAsync('OnAuthStateChanged', null);
                            return;
                        }
                        const expiresAt = allowDoc.data()?.expiresAt;
                        if (expiresAt && expiresAt !== 'lifetime' && new Date(expiresAt) < new Date()) {
                            const dataDeletedAt = allowDoc.data()?.dataDeletedAt || null;
                            await signOut(auth);
                            dotNetRef.invokeMethodAsync('OnAuthExpired', user.email, expiresAt, dataDeletedAt);
                            return;
                        }
                        // 앱을 재실행/세션 복원만 해도(재로그인 없이) 여기로 옴 —
                        // lastLoginAt은 명시적 로그인 때만 갱신되므로, 실사용 빈도를 보려면
                        // 별도 필드로 매번(=앱을 열 때마다) 기록해줌
                        setDoc(doc(db, 'allowedUsers', user.email),
                            { lastActiveAt: new Date().toISOString() }, { merge: true })
                            .catch(() => {}); // 실패해도 로그인 흐름은 막지 않음 (fire-and-forget)
                    } catch (e) {
                        // 네트워크 오류 등 — 일단 통과 (오프라인 대응)
                    }
                }
                const info = { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL };
                dotNetRef.invokeMethodAsync('OnAuthStateChanged', info);
            } else {
                dotNetRef.invokeMethodAsync('OnAuthStateChanged', null);
            }
        });
    },

    // Firebase 세션 복원 완료까지 대기 후 현재 유저 반환
    async waitForAuthReady() {
        // persistence 설정이 완료된 뒤 세션 복원을 기다려야 함
        await _persistenceReady;
        // redirect 로그인 결과 처리 (iOS Safari 팝업 차단 폴백)
        try {
            const redirectResult = await getRedirectResult(auth);
            if (redirectResult && redirectResult.user) {
                const u = redirectResult.user;
                return { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL };
            }
        } catch (e) {
            // redirect 결과 없음 또는 오류 — 무시하고 계속
            if (e.code !== 'auth/no-auth-event') {
                console.warn('getRedirectResult:', e.code, e.message);
            }
        }
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                console.warn('waitForAuthReady timeout (12s) — 네트워크가 느리거나 Firebase 초기화가 지연됐습니다.');
                resolve(null);
            }, 12000);
            const unsubscribe = onAuthStateChanged(auth, user => {
                clearTimeout(timer);
                unsubscribe();
                if (!user) { resolve(null); return; }
                resolve({ uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL });
            });
        });
    }
};

// ── Firestore ────────────────────────────────────────────────────
window.firebaseStore = {
    async getCollectionIds(path) {
        try {
            const parts = path.split('/');
            const snap = await getDocs(collection(db, ...parts));
            return JSON.stringify(snap.docs.map(d => d.id));
        } catch (e) {
            console.error('getCollectionIds:', path, e);
            return null;
        }
    },

    async getCollection(path) {
        try {
            const parts = path.split('/');
            const snap = await getDocs(collection(db, ...parts));
            const items = [];
            snap.forEach(d => items.push({ id: d.id, ...d.data() }));
            return JSON.stringify(items);
        } catch (e) {
            console.error('getCollection:', path, e);
            return null;
        }
    },

    async setDocument(path, jsonData) {
        try {
            await setDoc(doc(db, ...path.split('/')), JSON.parse(jsonData), { merge: true });
            return true;
        } catch (e) {
            console.error('setDocument:', path, e);
            return false;
        }
    },

    // tombstone 전용: merge 없이 덮어써서 기존 필드 제거 (_deleted:true만 남김)
    async setTombstone(path, jsonData) {
        try {
            await setDoc(doc(db, ...path.split('/')), JSON.parse(jsonData));
            return true;
        } catch (e) {
            console.error('setTombstone:', path, e);
            return false;
        }
    },

    async getDocument(path) {
        try {
            // usage 문서는 항상 서버에서 직접 읽어서 캐시 불일치 방지
            const isUsage = path.includes('/meta/usage') || path.includes('/meta/knitday_media_migrated');
            const snap = isUsage
                ? await getDocFromServer(doc(db, ...path.split('/')))
                : await getDoc(doc(db, ...path.split('/')));
            return snap.exists() ? JSON.stringify(snap.data()) : null;
        } catch (e) {
            console.error('getDocument:', path, e);
            // 디버그용: 오류 내용을 특수 접두어로 반환
            return '__error__:' + (e.code || e.message || String(e));
        }
    },

    async deleteDocument(path) {
        try {
            await deleteDoc(doc(db, ...path.split('/')));
            return true;
        } catch (e) {
            return false;
        }
    },

    async saveCollection(basePath, jsonArray, idField) {
        try {
            const items = JSON.parse(jsonArray);
            const parts = basePath.split('/');
            for (const item of items) {
                const id = item[idField] ?? item[idField.toLowerCase()];
                if (!id) continue;
                // tombstone(_deleted:true)은 saveCollection으로 덮어쓰지 않음
                // (TombstoneFirebaseDocBackground가 이미 setDocument로 기록)
                if (item._deleted === true) continue;
                await setDoc(doc(db, ...parts, String(id)), item, { merge: true });
            }
            return true;
        } catch (e) {
            console.error('saveCollection:', basePath, e);
            return false;
        }
    }
};

// ── 계정 탈퇴 ────────────────────────────────────────────────────
window.deleteKnitDayAccount = async () => {
    try {
        const fn = httpsCallable(functions, 'deleteAccount');
        const result = await fn({});
        return JSON.stringify(result.data);
    } catch (e) {
        console.error('deleteAccount:', e);
        return JSON.stringify({ success: false, error: e.message });
    }
};

// ── 클라우드 데이터만 삭제 (계정/로그인은 유지, 로컬은 그대로) ─────────
window.deleteKnitDayCloudDataOnly = async () => {
    try {
        const fn = httpsCallable(functions, 'deleteCloudDataOnly');
        const result = await fn({});
        return JSON.stringify(result.data);
    } catch (e) {
        console.error('deleteCloudDataOnly:', e);
        return JSON.stringify({ success: false, error: e.message });
    }
};

// ── 비활성(오래 안 켰을 때) 데이터 유실 방지 푸시 알림 ──────────────
// 로그인 여부와 무관하게 기기 단위 익명 구독. 계정이 없어도 동작해야 하므로
// httpsCallable을 인증 없이 그대로 호출함 (해당 Cloud Function들은 로그인 불필요).
const VAPID_PUBLIC_KEY = 'BJFsijDu2HCZ1yIBuaW4FdUMVEASRR5wnS8vWZhha4pTdkrBOPtIjog-s-SZcrODCgz40QWCuVPP3OacfY2UAnQ';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function getOrCreateDeviceId() {
    let id = localStorage.getItem('knitday_push_device_id');
    if (!id) {
        id = 'dev_' + crypto.randomUUID().replace(/-/g, '');
        localStorage.setItem('knitday_push_device_id', id);
    }
    return id;
}

window.knitPush = {
    // 이 기기/브라우저가 알림을 받을 수 있는 환경인지
    // iOS(Safari)는 홈 화면 추가 앱에서만 가능 — 그 외(안드로이드 크롬 등)는
    // 브라우저 탭에서도 알림 권한만 있으면 바로 동작함
    isSupported() {
        const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        if (!hasApis) return false;
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+ 데스크톱 UA 대응
        if (!isIOS) return true; // 안드로이드/데스크톱은 탭에서도 바로 지원
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true; // iOS 구버전 호환
        return isStandalone;
    },

    // 현재 구독 상태 (권한 + 실제 구독 존재 여부)
    async getStatus() {
        if (!this.isSupported()) return 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            return sub ? 'subscribed' : 'not-subscribed';
        } catch (e) {
            return 'not-subscribed';
        }
    },

    // 알림 켜기 — 권한 요청부터 구독, 서버 등록까지
    async subscribe() {
        if (!this.isSupported()) return { success: false, error: '이 기기에서는 지원되지 않아요.' };
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return { success: false, error: '알림 권한이 거부됐어요.' };

        try {
            const reg = await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });
            }
            const deviceId = getOrCreateDeviceId();
            const fn = httpsCallable(functions, 'registerPushSubscription');
            await fn({ deviceId, subscription: sub.toJSON() });
            return { success: true };
        } catch (e) {
            console.error('knitPush.subscribe:', e);
            return { success: false, error: e.message };
        }
    },

    // 알림 끄기
    async unsubscribe() {
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            const deviceId = localStorage.getItem('knitday_push_device_id');
            if (!sub && !deviceId) return { success: true }; // 정리할 게 아예 없음 — 조용히 종료
            if (sub) await sub.unsubscribe();
            if (deviceId) {
                const fn = httpsCallable(functions, 'unregisterPushSubscription');
                await fn({ deviceId });
                localStorage.removeItem('knitday_push_device_id'); // 재호출 시 다시 안 타도록
            }
            return { success: true };
        } catch (e) {
            console.error('knitPush.unsubscribe:', e);
            return { success: false, error: e.message };
        }
    },

    // 앱을 열 때마다 호출 — 이미 구독 중이면 "최근에 열었다"는 걸 서버에 알려서
    // 불필요한 알림이 안 가게 함 (구독 안 돼있으면 조용히 아무것도 안 함)
    async heartbeat() {
        if (!this.isSupported()) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (!sub) return;
            const deviceId = getOrCreateDeviceId();
            const fn = httpsCallable(functions, 'pingDeviceActive');
            await fn({ deviceId });
        } catch (e) {
            // 조용히 무시 — 하트비트 실패가 앱 사용을 막으면 안 됨
        }
    }
};