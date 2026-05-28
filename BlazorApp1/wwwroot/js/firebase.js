// ── Firebase 초기화 ───────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
    indexedDBLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey:            "%%FIREBASE_API_KEY%%",
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

// ── 영구 세션 유지 (IndexedDB) ────────────────────────────────────
// setPersistence는 비동기지만 auth 객체에 즉시 반영됨
// waitForAuthReady보다 먼저 설정되도록 모듈 최상단에서 호출
const _persistenceReady = setPersistence(auth, indexedDBLocalPersistence)
    .catch(e => console.warn('setPersistence failed:', e));

// ── Auth ─────────────────────────────────────────────────────────
window.firebaseAuth = {
    async signInWithGoogle() {
        try {
            // persistence 설정 완료 후 로그인 시도
            await _persistenceReady;
            const result = await signInWithPopup(auth, provider);
            const u = result.user;
            return { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL };
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

    // Firebase 세션 복원 완료까지 대기 후 현재 유저 반환
    async waitForAuthReady() {
        // persistence 설정이 완료된 뒤 세션 복원을 기다려야 함
        await _persistenceReady;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                console.warn('waitForAuthReady timeout');
                resolve(null);
            }, 6000);
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