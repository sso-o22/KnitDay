// ── Firebase 초기화 ───────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
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

// ── Auth ─────────────────────────────────────────────────────────
window.firebaseAuth = {
    async signInWithGoogle() {
        try {
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
        // 첫 발화 시 현재 상태 즉시 전달 (앱 재시작 시 로그인 유지)
        onAuthStateChanged(auth, user => {
            const info = user ? { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL } : null;
            dotNetRef.invokeMethodAsync('OnAuthStateChanged', info);
        });
    },

    // Firebase가 세션 복원 완료할 때까지 대기 후 현재 유저 반환
    waitForAuthReady() {
        return new Promise(resolve => {
            const unsubscribe = onAuthStateChanged(auth, user => {
                unsubscribe();
                if (!user) { resolve(null); return; }
                resolve({ uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL });
            });
        });
    }
};

// ── Firestore ────────────────────────────────────────────────────
window.firebaseStore = {
    // 컬렉션 전체 읽기
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

    // 문서 저장
    async setDocument(path, jsonData) {
        try {
            await setDoc(doc(db, ...path.split('/')), JSON.parse(jsonData), { merge: true });
            return true;
        } catch (e) {
            console.error('setDocument:', path, e);
            return false;
        }
    },

    // 문서 읽기
    async getDocument(path) {
        try {
            const snap = await getDoc(doc(db, ...path.split('/')));
            return snap.exists() ? JSON.stringify(snap.data()) : null;
        } catch (e) {
            console.error('getDocument:', path, e);
            return null;
        }
    },

    // 문서 삭제
    async deleteDocument(path) {
        try {
            await deleteDoc(doc(db, ...path.split('/')));
            return true;
        } catch (e) {
            return false;
        }
    },

    // 배열 → 컬렉션 upsert
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
