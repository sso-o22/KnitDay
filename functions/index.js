const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const crypto = require("crypto");

setGlobalOptions({ region: "asia-northeast3" }); // 서울 리전

// Cloudinary 환경변수 (배포 시 firebase functions:secrets:set 으로 설정)
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

/**
 * Cloudinary 파일 삭제 Cloud Function
 * 클라이언트에서 publicId 를 전달하면 서버에서 API Secret으로 서명 후 삭제
 */
exports.deleteCloudinaryAsset = onCall(
    {
        secrets: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
    },
    async (request) => {
        // 인증 확인
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
        }

        const { publicId, resourceType = "image" } = request.data;

        if (!publicId) {
            throw new HttpsError("invalid-argument", "publicId가 필요합니다.");
        }

        // publicId가 요청한 사용자의 UID로 시작하는지 확인 (다른 사용자 파일 삭제 방지)
        const uid = request.auth.uid;
        if (!publicId.startsWith(uid + "/")) {
            throw new HttpsError("permission-denied", "해당 파일에 대한 권한이 없습니다.");
        }

        // Cloudinary 서명 생성
        const timestamp = Math.floor(Date.now() / 1000);
        const signStr = `public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`;
        const signature = crypto.createHash("sha256").update(signStr).digest("hex");

        // Cloudinary Destroy API 호출
        const formData = new URLSearchParams({
            public_id: publicId,
            timestamp: timestamp.toString(),
            api_key: process.env.CLOUDINARY_API_KEY,
            signature,
            resource_type: resourceType,
        });

        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
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
