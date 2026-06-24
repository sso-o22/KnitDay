const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
            `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
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

        // ── 1. Cloudinary {uid}/ 폴더 전체 삭제 ──────────────────
        if (cloudName && apiKey && apiSecret) {
            try {
                const timestamp = Math.floor(Date.now() / 1000);
                const prefix = `${targetUid}/`;
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
                    `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload`,
                    { method: "DELETE", body: formData }
                );
            } catch (e) {
                errors.push(`Cloudinary: ${e.message}`);
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