const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const crypto = require("crypto");

setGlobalOptions({ region: "asia-northeast3" }); // 서울 리전

/**
 * Cloudinary 파일 삭제 Cloud Function
 * 환경변수는 배포 시 --set-env-vars 로 주입
 */
exports.deleteCloudinaryAsset = onCall(
    async (request) => {
        // 인증 확인
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
        }

        const { publicId, resourceType = "image" } = request.data;

        if (!publicId) {
            throw new HttpsError("invalid-argument", "publicId가 필요합니다.");
        }

        // publicId가 요청한 사용자의 UID로 시작하는지 확인
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

        // Cloudinary 서명 생성
        const timestamp = Math.floor(Date.now() / 1000);
        const signStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature = crypto.createHash("sha256").update(signStr).digest("hex");

        // Cloudinary Destroy API 호출
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
