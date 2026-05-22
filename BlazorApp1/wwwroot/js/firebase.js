// ── Firebase 초기화 ───────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
    getAuth, GoogleAuthProvider,
    signInWithPopup, signInWithRedirect, getRedirectResult,
    signOut, onAuthStateChanged,
    indexedDBLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey:            "AIzaSyDO6b38CHxrbN0QrKRyzOuk-k7yOitDyKU",
    authDomain:        "knitlog-94c63.firebaseapp.com",
    projectId:         "knitlog-94c63",
    storageBucket:     "knitlog-94c63.firebasestorage.app",
    messagingSenderId: "448627074243",
    appId:             "1:448627074243:web:32924c7262d7efc6e5ae76"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const provider = new GoogleAuthProvider();

// ── 영구 세션 유지 (IndexedDB — PWA 재시작해도 로그인 유지) ───────
setPersistence(auth, indexedDBLocalPersistence).catch(e =>
    console.warn('setPersistence failed:', e)
);

// PWA(홈화면 앱)에서는 popup이 새 탭을 열어 앱 컨텍스트를 끊어버리므로
// standalone 모드일 때는 redirect 방식 사용
const isPWA = window.matchMedia('(display-mode: standalone)').matches
           || window.navigator.standalone === true;

// ── Auth ─────────────────────────────────────────────────────────
window.firebaseAuth = {
    async signInWithGoogle() {
        try {
            if (isPWA) {
                // redirect 방식: 현재 페이지를 Google 로그인 페이지로 이동
                // 결과는 waitForAuthReady에서 getRedirectResult로 처리
                await signInWithRedirect(auth, provider);
                return null; // 페이지가 이동되므로 여기는 도달 안 함
            } else {
                const result = await signInWithPopup(auth, provider);
                const u = result.user;
                return { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL };
            }
        } catch (e) {
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
        onAuthStateChanged(auth, user => {
            const info = user
                ? { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL }
                : null;
            dotNetRef.invokeMethodAsync('OnAuthStateChanged', info);
        });
    },

    // Firebase 세션 복원 완료까지 대기 + redirect 결과 처리
    waitForAuthReady() {
        return new Promise(async resolve => {
            // redirect 로그인 결과가 있으면 먼저 처리
            try {
                const redirectResult = await getRedirectResult(auth);
                if (redirectResult?.user) {
                    const u = redirectResult.user;
                    resolve({ uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL });
                    return;
                }
            } catch (e) {
                console.warn('getRedirectResult:', e);
            }

            // 기존 세션 복원 대기
            const timer = setTimeout(() => {
                console.warn('waitForAuthReady timeout');
                resolve(null);
            }, 5000);
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
    async getCollection(path) {
        try {
            const parts = path.split('/');
            const snap = await getDocs(collection(db, ...parts));
            const items = [];
            snap.forEach(d => items.push(d.data()));
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

    async getDocument(path) {
        try {
            const snap = await getDoc(doc(db, ...path.split('/')));
            return snap.exists() ? JSON.stringify(snap.data()) : null;
        } catch (e) {
            console.error('getDocument:', path, e);
            return null;
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
                await setDoc(doc(db, ...parts, String(id)), item, { merge: true });
            }
            return true;
        } catch (e) {
            console.error('saveCollection:', basePath, e);
            return false;
        }
    }
};
