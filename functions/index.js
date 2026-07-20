const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const crypto = require("crypto");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

setGlobalOptions({ region: "asia-northeast3" }); // 서울 리전

initializeApp();

/**
 * Cloudinary 파일 삭제 Cloud Function
 */
exports.deleteCloudinaryAsset = onCall(
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
        }

        const { publicId, resourceType = "image" } = request.data;

        if (!publicId) {
            throw new HttpsError("invalid-argument", "publicId가 필요합니다.");
        }

        const uid = request.auth.uid;
        if (!publicId.startsWith(uid + "/")) {
            throw new HttpsError("permission-denied", "해당 파일에 대한 권한이 없습니다.");
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret) {
            throw new HttpsError("internal", "Cloudinary 환경변수가 설정되지 않았습니다.");
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const signStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature = crypto.createHash("sha256").update(signStr).digest("hex");

        const formData = new URLSearchParams({
            public_id: publicId,
            timestamp: timestamp.toString(),
            api_key: apiKey,
            signature,
            resource_type: resourceType,
        });

        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`,
            { method: "POST", body: formData }
        );

        const result = await response.json();

        if (result.result === "ok" || result.result === "not found") {
            return { success: true, result: result.result };
        } else {
            throw new HttpsError("internal", `Cloudinary 삭제 실패: ${result.result}`);
        }
    }
);

/**
 * 계정 완전 삭제 Cloud Function
 * - Cloudinary {uid}/ 폴더 전체 삭제
 * - Firestore users/{uid} 컬렉션 삭제
 * - allowedUsers/{email} 삭제
 * - Firebase Auth 계정 삭제
 * 본인 또는 관리자(ADMIN_UID)만 호출 가능
 */
exports.deleteAccount = onCall(
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
        }

        const callerUid   = request.auth.uid;
        const targetUid   = request.data?.targetUid ?? callerUid; // 관리자가 타인 삭제 시
        const adminUid    = process.env.ADMIN_UID ?? "xAz2xO8kulWUgoHnaaxCkzZV2nG2";

        // 본인이거나 관리자여야 함
        if (callerUid !== targetUid && callerUid !== adminUid) {
            throw new HttpsError("permission-denied", "권한이 없습니다.");
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        const db        = getFirestore();
        const authAdmin = getAuth();

        const errors = [];

        // ── 1. Cloudinary {uid}/ 폴더 전체 삭제 (사진 + PDF) ──────
        if (cloudName && apiKey && apiSecret) {
            const prefix = `${targetUid}/`;
            // image(사진)와 raw(PDF)는 리소스 타입이 달라 각각 삭제해야 함
            for (const resourceType of ["image", "raw"]) {
                try {
                    await deleteCloudinaryByPrefix(cloudName, apiKey, apiSecret, prefix, resourceType);
                } catch (e) {
                    errors.push(`Cloudinary(${resourceType}): ${e.message}`);
                }
            }
        }

        // ── 2. Firestore users/{uid} 하위 문서 전체 삭제 ──────────
        try {
            const userRef = db.collection("users").doc(targetUid);
            await deleteFirestoreRecursive(db, userRef);
        } catch (e) {
            errors.push(`Firestore users: ${e.message}`);
        }

        // ── 3. allowedUsers/{email} 삭제 ──────────────────────────
        try {
            const userRecord = await authAdmin.getUser(targetUid);
            const email = userRecord.email;
            if (email) {
                await db.collection("allowedUsers").doc(email).delete();
            }
        } catch (e) {
            errors.push(`allowedUsers: ${e.message}`);
        }

        // ── 4. Firebase Auth 계정 삭제 ────────────────────────────
        try {
            await authAdmin.deleteUser(targetUid);
        } catch (e) {
            errors.push(`Auth: ${e.message}`);
        }

        return { success: errors.length === 0, errors };
    }
);

/**
 * 클라우드 데이터만 삭제 (계정/로그인은 유지) Cloud Function
 * - Cloudinary {uid}/ 폴더 전체 삭제
 * - Firestore users/{uid} 컬렉션 삭제
 * - allowedUsers/{email} 문서, Firebase Auth 계정은 그대로 유지 (탈퇴가 아님)
 * - 이 기기에 남아있는 로컬 데이터는 건드리지 않음 — 프론트엔드에서 로그아웃까지만 처리
 *   (그대로 로그인 상태를 유지하면 로컬→클라우드 자동 동기화 때문에 방금 지운 데이터가
 *    다시 올라갈 수 있어서, 삭제 직후에는 반드시 로그아웃해야 함 — 프론트엔드 책임)
 * 본인 계정만 호출 가능 (관리자 대리 삭제 없음 — 필요하면 deleteAccount 사용)
 */
exports.deleteCloudDataOnly = onCall(
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
        }

        const uid = request.auth.uid;

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;
        const db        = getFirestore();

        const errors = [];

        // ── 1. Cloudinary {uid}/ 폴더 전체 삭제 (사진 + PDF) ──────
        if (cloudName && apiKey && apiSecret) {
            const prefix = `${uid}/`;
            for (const resourceType of ["image", "raw"]) {
                try {
                    await deleteCloudinaryByPrefix(cloudName, apiKey, apiSecret, prefix, resourceType);
                } catch (e) {
                    errors.push(`Cloudinary(${resourceType}): ${e.message}`);
                }
            }
        }

        // ── 2. Firestore users/{uid} 하위 문서 전체 삭제 ──────────
        try {
            const userRef = db.collection("users").doc(uid);
            await deleteFirestoreRecursive(db, userRef);
        } catch (e) {
            errors.push(`Firestore users: ${e.message}`);
        }

        // allowedUsers/{email}, Firebase Auth 계정은 의도적으로 건드리지 않음
        return { success: errors.length === 0, errors };
    }
);


// Firestore 문서 + 하위 컬렉션 재귀 삭제
async function deleteFirestoreRecursive(db, docRef) {
    const collections = await docRef.listCollections();
    for (const col of collections) {
        const docs = await col.listDocuments();
        for (const d of docs) {
            await deleteFirestoreRecursive(db, d);
        }
    }
    await docRef.delete();
}

// Cloudinary prefix(폴더) 단위 삭제 — resourceType: "image" | "raw"
async function deleteCloudinaryByPrefix(cloudName, apiKey, apiSecret, prefix, resourceType) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signStr = `invalidate=true&prefix=${prefix}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash("sha256").update(signStr).digest("hex");

    const formData = new URLSearchParams({
        prefix,
        timestamp: timestamp.toString(),
        api_key: apiKey,
        signature,
        invalidate: "true",
    });

    await fetch(
        `https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/upload`,
        { method: "DELETE", body: formData }
    );
}

/**
 * 만료된 기간제 이용권(6개월/1년) 유저의 클라우드 데이터 자동 삭제
 * - 대상: allowedUsers 중 expiresAt이 "lifetime"이 아니고, 만료일 + 유예기간(60일)이 지난 유저
 * - 평생권("lifetime") 및 아직 유예기간 내인 유저는 절대 건드리지 않음
 * - Cloudinary({uid}/ 폴더: 사진+PDF) + Firestore(users/{uid}) 삭제
 * - allowedUsers/{email} 문서 자체는 삭제하지 않고 dataDeletedAt만 기록 (이력 보존, 재구매 시 참고용)
 * - Firebase Auth 계정도 삭제하지 않음 (재구매 시 그대로 재로그인 가능)
 * - 매일 1회 자동 실행 (KST 새벽 4시)
 */
const GRACE_PERIOD_DAYS = 60;

exports.purgeExpiredUserData = onSchedule(
    { schedule: "0 4 * * *", timeZone: "Asia/Seoul" },
    async () => {
        const db = getFirestore();
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        const snapshot = await db.collection("allowedUsers").get();
        const now = new Date();

        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            const expiresAt = data?.expiresAt;

            // 평생권, 만료일 미설정, 이미 삭제 처리된 유저는 건너뜀
            if (!expiresAt || expiresAt === "lifetime") continue;
            if (data?.dataDeletedAt) continue;

            const expiryDate = new Date(expiresAt);
            if (isNaN(expiryDate.getTime())) continue; // 형식 이상 → 안전하게 건너뜀

            const purgeDate = new Date(expiryDate);
            purgeDate.setDate(purgeDate.getDate() + GRACE_PERIOD_DAYS);

            // 아직 유예기간 이내면 건너뜀 (현재 이용 중이거나 최근 만료된 유저는 절대 미삭제)
            if (now < purgeDate) continue;

            const uid = data?.uid;
            if (!uid) {
                // 클라우드에 실제로 올린 게 없는 유저 — 표시만 하고 종료
                await docSnap.ref.set({ dataDeletedAt: now.toISOString() }, { merge: true });
                continue;
            }

            try {
                if (cloudName && apiKey && apiSecret) {
                    const prefix = `${uid}/`;
                    for (const resourceType of ["image", "raw"]) {
                        try {
                            await deleteCloudinaryByPrefix(cloudName, apiKey, apiSecret, prefix, resourceType);
                        } catch (e) {
                            console.error(`purgeExpiredUserData Cloudinary(${resourceType}) 실패 (${uid}):`, e.message);
                        }
                    }
                }
                const userRef = db.collection("users").doc(uid);
                await deleteFirestoreRecursive(db, userRef);

                await docSnap.ref.set({ dataDeletedAt: now.toISOString() }, { merge: true });
                console.log(`purgeExpiredUserData: ${docSnap.id} (${uid}) 클라우드 데이터 삭제 완료`);
            } catch (e) {
                console.error(`purgeExpiredUserData 실패 (${docSnap.id}):`, e.message);
            }
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
// 비활성 사용자 데이터 유실 방지 푸시 알림
// (비로그인 상태로 홈 화면에 추가해서 쓰는 사용자용 — 계정이 없어서
//  로그인 기반이 아니라, 기기별 익명 구독 ID로 추적함)
// ═══════════════════════════════════════════════════════════════════

const webpush = require("web-push");

// VAPID 키 — 반드시 환경변수(.env)로 관리, 코드에 하드코딩하지 않음
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (예: "mailto:you@example.com")
function configureWebPush() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || "mailto:support@knitday.kr";
    if (!publicKey || !privateKey) return false;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
}

/**
 * 익명 푸시 구독 등록/갱신 (로그인 불필요)
 * - 최초 구독 시에도, 이후 앱을 열 때마다(하트비트) 이 함수를 다시 호출해서
 *   lastActiveAt을 갱신함 → "N일간 미접속"을 정확히 추적하기 위함
 * - 앱을 열 때마다 reminderSent를 false로 리셋해서, 돌아온 뒤 다시 오래 안 켜면
 *   또 알림이 가도록 함
 */
exports.registerPushSubscription = onCall(async (request) => {
    const { deviceId, subscription } = request.data || {};
    if (!deviceId || typeof deviceId !== "string") {
        throw new HttpsError("invalid-argument", "deviceId가 필요합니다.");
    }
    if (!subscription || !subscription.endpoint) {
        throw new HttpsError("invalid-argument", "subscription이 필요합니다.");
    }

    const db = getFirestore();
    const now = new Date();
    await db.collection("pushSubscriptions").doc(deviceId).set({
        subscription,
        lastActiveAt: now.toISOString(),
        reminderSent: false,
        updatedAt: now.toISOString(),
    }, { merge: true });

    return { success: true };
});

/**
 * 하트비트만 (구독 정보 재전송 없이 lastActiveAt만 갱신하고 싶을 때 사용 가능)
 * — 프론트엔드는 편의상 registerPushSubscription 하나만 써도 무방
 */
exports.pingDeviceActive = onCall(async (request) => {
    const { deviceId } = request.data || {};
    if (!deviceId || typeof deviceId !== "string") {
        throw new HttpsError("invalid-argument", "deviceId가 필요합니다.");
    }
    const db = getFirestore();
    const ref = db.collection("pushSubscriptions").doc(deviceId);
    const snap = await ref.get();
    if (!snap.exists) return { success: false }; // 구독 안 된 기기 — 조용히 무시
    await ref.set({ lastActiveAt: new Date().toISOString(), reminderSent: false }, { merge: true });
    return { success: true };
});

/**
 * 구독 해제 (설정에서 알림 끄기)
 */
exports.unregisterPushSubscription = onCall(async (request) => {
    const { deviceId } = request.data || {};
    if (!deviceId || typeof deviceId !== "string") {
        throw new HttpsError("invalid-argument", "deviceId가 필요합니다.");
    }
    const db = getFirestore();
    await db.collection("pushSubscriptions").doc(deviceId).delete();
    return { success: true };
});

// 얼마나 안 켰을 때 알림을 보낼지 — iOS Safari의 약 7일 삭제 정책보다
// 여유 있게 미리 경고하기 위해 5일로 설정
const INACTIVITY_WARNING_DAYS = 5;

/**
 * 매일 새벽, 오래 안 켠 기기에 데이터 유실 경고 푸시 발송
 */
exports.sendInactivityReminders = onSchedule(
    { schedule: "0 9 * * *", timeZone: "Asia/Seoul" }, // 매일 오전 9시 (한밤중 알림 방지)
    async () => {
        if (!configureWebPush()) {
            console.error("sendInactivityReminders: VAPID 키가 설정되어 있지 않아 건너뜀");
            return;
        }

        const db = getFirestore();
        const now = new Date();
        const threshold = new Date(now);
        threshold.setDate(threshold.getDate() - INACTIVITY_WARNING_DAYS);

        const snap = await db.collection("pushSubscriptions")
            .where("reminderSent", "==", false)
            .get();

        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            const lastActiveAt = data?.lastActiveAt ? new Date(data.lastActiveAt) : null;
            if (!lastActiveAt || isNaN(lastActiveAt.getTime())) continue;
            if (lastActiveAt > threshold) continue; // 아직 기준일 안 지남

            try {
                await webpush.sendNotification(data.subscription, JSON.stringify({
                    title: "KnitDay",
                    body: "오랜만이에요! 저장해둔 뜨개 기록이 사라지기 전에 앱을 한 번 열어주세요.",
                    url: "/",
                    tag: "knitday-inactivity-reminder",
                }));
                await docSnap.ref.set({ reminderSent: true }, { merge: true });
                console.log(`sendInactivityReminders: ${docSnap.id} 발송 완료`);
            } catch (e) {
                // 구독이 만료/삭제된 경우(410/404) 정리
                if (e.statusCode === 410 || e.statusCode === 404) {
                    await docSnap.ref.delete();
                    console.log(`sendInactivityReminders: ${docSnap.id} 구독 만료로 삭제`);
                } else {
                    console.error(`sendInactivityReminders 실패 (${docSnap.id}):`, e.message);
                }
            }
        }
    }
);