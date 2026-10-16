// =====================================================================
// StorageService.cs  —  로컬 저장소 + Firebase Firestore 동기화
// =====================================================================
using System.Text.Json;
using KnitLog.Models;
using Microsoft.JSInterop;

namespace KnitLog.Services
{
    public class StorageService
    {
        private readonly IJSRuntime _js;
        private AuthService? _auth;

        private const string KEY_PROJECTS = "knittracker_projects";
        private const string KEY_YARNS    = "knittracker_yarns";
        private const string KEY_TOOLS    = "knittracker_tools";
        private const string KEY_SWATCHES = "knittracker_swatches";
        private const string KEY_TODOS    = "knitlog_todos";
        private const string KEY_MEDIA_MIGRATED = "knitday_media_migrated"; // 사용자별 마이그레이션 완료 플래그 (1회만 실행되도록)

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            WriteIndented = true,
            PropertyNameCaseInsensitive = true
        };

        // 동기화 완료 이벤트 (Home 등 화면에서 재로딩 트리거)
        public event Action? OnSyncCompleted;
        public event Action? OnSyncStarted;
        // 프로젝트 목록이 로컬에 저장될 때마다 발생 (사이드바 통계처럼 화면 밖에서 프로젝트를 참고하는 곳이 다시 읽도록)
        public event Action? OnProjectsChanged;
        public bool IsSyncing { get; private set; }

        // 마이그레이션 진행 이벤트
        public event Action<MigrationProgress>? OnMigrationProgress;
        public MigrationProgress? CurrentMigration { get; private set; }

        public StorageService(IJSRuntime js) { _js = js; }

        // AuthService는 순환 의존 방지를 위해 나중에 주입
        public void SetAuthService(AuthService auth) { _auth = auth; }

        private string? Uid => _auth?.CurrentUser?.Uid;
        public  bool IsLoggedIn => !string.IsNullOrEmpty(Uid);

        // ── IndexedDB 저장소 ─────────────────────────────────────────
        private async Task SaveLocalAsync<T>(string key, List<T> list)
        {
            var json = JsonSerializer.Serialize(list, _jsonOpts);
            await _js.InvokeVoidAsync("knitDB.setData", key, json);
            if (key == KEY_PROJECTS)
            {
                try { OnProjectsChanged?.Invoke(); } catch { }
            }
        }

        private async Task<List<T>> LoadLocalAsync<T>(string key)
        {
            var json = await _js.InvokeAsync<string?>("knitDB.getData", key);
            if (string.IsNullOrWhiteSpace(json)) return new();
            try { return JsonSerializer.Deserialize<List<T>>(json, _jsonOpts) ?? new(); }
            catch { return new(); }
        }

        // ── Firebase 동기화 헬퍼 ────────────────────────────────────
        private async Task SaveFirebaseAsync<T>(string collectionName, List<T> list, string idField)
        {
            if (!IsLoggedIn) return;
            try
            {
                var json = JsonSerializer.Serialize(list, _jsonOpts);
                await _js.InvokeAsync<bool>("firebaseStore.saveCollection",
                    $"users/{Uid}/{collectionName}", json, idField);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Firebase save error ({collectionName}): {ex.Message}");
            }
        }

        private async Task<List<T>?> LoadFirebaseAsync<T>(string collectionName)
        {
            if (!IsLoggedIn) return null;
            try
            {
                var json = await _js.InvokeAsync<string?>("firebaseStore.getCollection",
                    $"users/{Uid}/{collectionName}");
                if (string.IsNullOrEmpty(json)) return null;
                return JsonSerializer.Deserialize<List<T>>(json, _jsonOpts);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Firebase load error ({collectionName}): {ex.Message}");
                return null;
            }
        }

        private void TombstoneFirebaseDocBackground(string collectionName, string id)
        {
            if (!IsLoggedIn) return;
            var tombstone = System.Text.Json.JsonSerializer.Serialize(new
            {
                _deleted = true,
                UpdatedAt = DateTime.UtcNow
            });
            _ = _js.InvokeAsync<bool>("firebaseStore.setTombstone",
                    $"users/{Uid}/{collectionName}/{id}", tombstone).AsTask()
                   .ContinueWith(_ => { }, TaskContinuationOptions.None);
        }

        // ── 로그인 시 동기화 ─────────────────────────────────────────
        // 로그인 시 로컬 + Cloud 데이터를 Id 기준으로 merge
        // - 같은 Id: UpdatedAt이 더 최신인 것 우선
        // - 한쪽에만 있으면: 그냥 포함
        // ── Cloudinary 업로드 ────────────────────────────────
        public long PerUserLimitBytes { get; private set; } = 300L * 1024 * 1024; // 기본 300MB — 로그인 시 Firestore quota 문서로 덮어씀
        public const long MaxPdfUploadBytes = 10L * 1024 * 1024;   // 10MB — Cloudinary free 제한
        // PatternCloudUrl에 세팅하는 특수값: 클라우드 업로드 불가(용량 초과 등) → 재시도 방지
        public const string PatternCloudUrlLocalOnly = "local-only";
        // 10MB 초과로 영구적으로 업로드 불가능한 경우 전용 값. local-only와 분리한 이유는 아래 참고.
        public const string PatternCloudUrlTooLarge = "too-large";

        // 도안 클라우드 업로드가 필요한지 판정. "local-only"는 '어떤 기기에도 없어 영구 포기'가 아니라
        // '이 마킹을 한 기기에는 없었다'는 뜻일 뿐이므로, 실제 파일을 가진 다른 기기가 재시도할 수 있도록
        // 빈 값과 동일하게 "재시도 대상"으로 취급한다. (안 그러면 한 기기가 local-only로 마킹한 순간
        // 실제로 파일을 갖고 있는 다른 기기에서도 영원히 업로드 시도가 안 됨)
        // 반면 "too-large"는 파일 크기 자체의 한계라 어느 기기에서 재시도해도 결과가 똑같으므로,
        // 재시도 대상에서 제외해야 앱 실행할 때마다 계속 마이그레이션을 재시도하는 문제가 없음.
        private static bool NeedsPatternUpload(KnitProject p) =>
            p.HasSavedPattern && (string.IsNullOrEmpty(p.PatternCloudUrl) || p.PatternCloudUrl == PatternCloudUrlLocalOnly);

        // 클라우드에 못 올라가고 기기에만(Base64) 남아 있는 스와치 사진인지
        private static bool NeedsSwatchPhotoUpload(Swatch s) =>
            !string.IsNullOrEmpty(s.PhotoBase64) && !s.PhotoBase64.StartsWith("http") && string.IsNullOrEmpty(s.PhotoStorageUrl);

        public async Task<(string? url, string? error, long bytes)> UploadPhotoAsync(string projectId, string photoId, string base64DataUrl)
        {
            try
            {
                // 용량 한도 확인은 사진마다 서버에서 다시 읽지 않고, 잠시 보관한 값을 씀 (여러 장 업로드 시 왕복 절감)
                var (used, _) = await GetCloudUsageCachedAsync();
                if (used >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid ?? "anon"}/projects/{projectId}/{photoId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64DataUrl, publicId, "image");
                // 사용량 기록은 업로드 결과를 기다리지 않고 뒤에서 처리 (사진이 슬롯에 뜨기까지의 대기 단축)
                var (url, bytes) = await ParseCloudinaryResult(json, "photo", awaitUsage: false);
                return (url, null, bytes);
            }
            catch { return (null, "error", 0); }
        }

        // ── 방금 올린 사진의 미리보기 ─────────────────────────────────
        // 업로드가 끝나도 슬롯의 이미지는 Cloudinary에서 다시 내려받아야 해서 한동안 빈칸으로 보임.
        // 방금 올린 사진은 기기에 이미 압축본이 있으므로 그걸 바로 보여줌.
        // 메모리에만 보관하고(저장하지 않음), 개수를 제한해서 메모리를 아낌. 앱을 다시 열면 평소처럼 URL로 표시됨.
        private readonly Dictionary<Guid, string> _photoPreviews = new();
        private readonly Queue<Guid> _photoPreviewOrder = new();
        private const int MaxPhotoPreviews = 12;

        public void RememberPhotoPreview(Guid photoId, string? dataUrl)
        {
            if (string.IsNullOrEmpty(dataUrl) || !dataUrl.StartsWith("data:")) return;
            if (!_photoPreviews.ContainsKey(photoId)) _photoPreviewOrder.Enqueue(photoId);
            _photoPreviews[photoId] = dataUrl;
            while (_photoPreviewOrder.Count > MaxPhotoPreviews)
                _photoPreviews.Remove(_photoPreviewOrder.Dequeue());
        }

        /// <summary>화면에 표시할 사진 주소: 방금 올린 사진이면 미리보기, 아니면 클라우드 URL, 없으면 기기에 저장된 Base64.</summary>
        public string PhotoSrc(ProjectPhoto photo)
        {
            if (!string.IsNullOrEmpty(photo.StorageUrl))
                return _photoPreviews.TryGetValue(photo.Id, out var preview) ? preview : photo.StorageUrl;
            return photo.Base64Data;
        }

        public async Task<(string? url, string? error, long bytes)> UploadPdfAsync(string projectId, byte[] bytes)
        {
            if (!IsLoggedIn || string.IsNullOrEmpty(Uid)) return (null, "not_logged_in", 0);
            if (bytes.Length > MaxPdfUploadBytes) return (null, "too_large", 0);
            try
            {
                var (photoUsed, pdfUsed) = await GetCloudUsageAsync();
                if (photoUsed + pdfUsed >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid}/pdfs/{projectId}";
                // byte[] → JS Uint8Array 직접 전달 (Blazor WASM 자동 변환)
                // DotNetStreamReference/base64 방식보다 안정적 — 안드로이드 포함 모든 브라우저 동작
                var json = await _js.InvokeAsync<string?>("uploadPdfBytes", bytes, publicId);
                var (url, fileBytes) = await ParseCloudinaryResult(json, "pdf");
                return (url, null, fileBytes);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"UploadPdfAsync error: {ex.Message}");
                return (null, "error", 0);
            }
        }

        // 마이그레이션용 base64 오버로드
        public async Task<(string? url, string? error, long bytes)> UploadPdfAsync(string projectId, string base64Data)
        {
            if (!IsLoggedIn || string.IsNullOrEmpty(Uid)) return (null, "not_logged_in", 0);
            try
            {
                var bytes = Convert.FromBase64String(base64Data);
                return await UploadPdfAsync(projectId, bytes);
            }
            catch { return (null, "error", 0); }
        }

        // 용량 차감 (앱에서 사진/PDF 삭제 시 호출)
        public async Task SubtractCloudUsageAsync(string type, long bytes)
        {
            if (string.IsNullOrEmpty(Uid) || bytes <= 0) return;
            _usageCache = null; // 용량이 줄었으니 다음 확인 때 서버에서 다시 읽음
            try
            {
                var path = $"users/{Uid}/meta/usage";
                var existJson = await _js.InvokeAsync<string?>("firebaseStore.getDocument", path);
                long photoBytes = 0, pdfBytes = 0;
                if (!string.IsNullOrEmpty(existJson))
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(existJson);
                    if (doc.RootElement.TryGetProperty("photoBytes", out var pb)) photoBytes = pb.GetInt64();
                    if (doc.RootElement.TryGetProperty("pdfBytes",   out var db)) pdfBytes   = db.GetInt64();
                }
                if (type == "photo") photoBytes = Math.Max(0, photoBytes - bytes);
                else                 pdfBytes   = Math.Max(0, pdfBytes   - bytes);
                var payload = System.Text.Json.JsonSerializer.Serialize(new { photoBytes, pdfBytes, updatedAt = DateTime.UtcNow });
                await _js.InvokeAsync<bool>("firebaseStore.setDocument", path, payload);
            }
            catch { }
        }

        // awaitUsage=false: 사용량 기록(서버 읽기+쓰기)을 기다리지 않고 뒤에서 처리 — 사진 업로드처럼 사용자가 결과를 기다리는 경우용
        private async Task<(string? url, long bytes)> ParseCloudinaryResult(string? json, string type, bool awaitUsage = true)
        {
            if (string.IsNullOrEmpty(json)) return (null, 0);
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                var url   = doc.RootElement.GetProperty("url").GetString();
                var bytes = doc.RootElement.TryGetProperty("bytes", out var b) ? b.GetInt64() : 0;
                if (!string.IsNullOrEmpty(url) && bytes > 0 && !string.IsNullOrEmpty(Uid))
                {
                    if (awaitUsage) await AddCloudUsageAsync(type, bytes);
                    else            _ = AddCloudUsageAsync(type, bytes); // 내부에서 예외를 모두 처리함
                }
                return (url, bytes);
            }
            catch { return (null, 0); }
        }

        // ── 용량 사용량 Firestore 누적 ────────────────────────
        // 읽고→더해서→쓰는 방식이라, 여러 건이 동시에 돌면 한쪽 증가분이 사라질 수 있어 한 번에 하나씩만 실행
        private readonly SemaphoreSlim _usageLock = new(1, 1);

        // 용량 한도 확인용 임시 보관값 (30초). 업로드/삭제 때 함께 갱신·무효화됨.
        private (long photo, long pdf)? _usageCache;
        private DateTime _usageCacheAt = DateTime.MinValue;
        private string? _usageCacheUid;

        private async Task<(long photoBytes, long pdfBytes)> GetCloudUsageCachedAsync(int maxAgeSeconds = 30)
        {
            if (_usageCache is { } c && _usageCacheUid == Uid && (DateTime.UtcNow - _usageCacheAt).TotalSeconds < maxAgeSeconds)
                return c;
            var u = await GetCloudUsageAsync();
            _usageCache = u;
            _usageCacheAt = DateTime.UtcNow;
            _usageCacheUid = Uid;
            return u;
        }

        private async Task AddCloudUsageAsync(string type, long bytes)
        {
            if (string.IsNullOrEmpty(Uid)) return;
            // 보관 중인 값에 먼저 반영 (다음 사진의 용량 확인에 바로 쓰이도록)
            if (_usageCache is { } c && _usageCacheUid == Uid)
                _usageCache = type == "photo" ? (c.photo + bytes, c.pdf) : (c.photo, c.pdf + bytes);
            await _usageLock.WaitAsync();
            try
            {
                var path = $"users/{Uid}/meta/usage";
                var existJson = await _js.InvokeAsync<string?>("firebaseStore.getDocument", path);
                long photoBytes = 0, pdfBytes = 0;
                if (!string.IsNullOrEmpty(existJson))
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(existJson);
                    if (doc.RootElement.TryGetProperty("photoBytes", out var pb)) photoBytes = pb.GetInt64();
                    if (doc.RootElement.TryGetProperty("pdfBytes",   out var db)) pdfBytes   = db.GetInt64();
                }
                if (type == "photo") photoBytes += bytes;
                else                 pdfBytes   += bytes;
                var payload = System.Text.Json.JsonSerializer.Serialize(new { photoBytes, pdfBytes, updatedAt = DateTime.UtcNow });
                await _js.InvokeAsync<bool>("firebaseStore.setDocument", path, payload);
            }
            catch { }
            finally { _usageLock.Release(); }
        }

        public async Task<(long photoBytes, long pdfBytes)> GetCloudUsageAsync()
        {
            if (string.IsNullOrEmpty(Uid)) return (0, 0);
            // 재시도 2회 (Firebase 일시 지연 대응)
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    var json = await _js.InvokeAsync<string?>("firebaseStore.getDocument", $"users/{Uid}/meta/usage");
                    if (string.IsNullOrEmpty(json))
                    {
                        if (attempt == 0) { await Task.Delay(800); continue; }
                        return (0, 0);
                    }
                    using var doc = System.Text.Json.JsonDocument.Parse(json);
                    long p = doc.RootElement.TryGetProperty("photoBytes", out var pb) ? pb.GetInt64() : 0;
                    long d = doc.RootElement.TryGetProperty("pdfBytes",   out var db) ? db.GetInt64() : 0;
                    return (p, d);
                }
                catch
                {
                    if (attempt == 0) { await Task.Delay(800); continue; }
                    return (0, 0);
                }
            }
            return (0, 0);
        }

        // Cloudinary 파일 삭제 — Firebase Cloud Function 경유 (API Secret 보안)
        public async Task DeletePhotoAsync(string projectId, string photoId, long fileSizeBytes = 0)
        {
            if (!IsLoggedIn) return;
            var publicId = $"{Uid}/projects/{projectId}/{photoId}";
            await DeleteCloudinaryAssetAsync(publicId, "image");
            if (fileSizeBytes > 0)
                await SubtractCloudUsageAsync("photo", fileSizeBytes);
        }

        public async Task<(string? url, string? error, long bytes)> UploadSwatchPhotoAsync(string swatchId, string base64DataUrl)
        {
            try
            {
                var (used, _) = await GetCloudUsageCachedAsync();
                if (used >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid ?? "anon"}/swatches/{swatchId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64DataUrl, publicId, "image");
                var (url, bytes) = await ParseCloudinaryResult(json, "photo", awaitUsage: false);
                return (url, null, bytes);
            }
            catch { return (null, "error", 0); }
        }

        public async Task DeleteSwatchPhotoAsync(string swatchId, long fileSizeBytes = 0)
        {
            if (!IsLoggedIn) return;
            var publicId = $"{Uid}/swatches/{swatchId}";
            await DeleteCloudinaryAssetAsync(publicId, "image");
            if (fileSizeBytes > 0)
                await SubtractCloudUsageAsync("photo", fileSizeBytes);
        }

        public async Task DeletePdfAsync(string projectId, long fileSizeBytes = 0)
        {
            if (!IsLoggedIn) return;
            var publicId = $"{Uid}/pdfs/{projectId}";
            // 확장자 없이 먼저 시도 (신규 업로드 방식)
            // 구 업로드(.pdf 붙은 파일)도 함께 시도 — Cloudinary는 없는 파일 삭제 시 "not found" 반환하므로 무해함
            await DeleteCloudinaryAssetAsync(publicId, "raw");
            await DeleteCloudinaryAssetAsync(publicId + ".pdf", "raw");
            if (fileSizeBytes > 0)
                await SubtractCloudUsageAsync("pdf", fileSizeBytes);
        }

        async Task DeleteCloudinaryAssetAsync(string publicId, string resourceType)
        {
            try
            {
                await _js.InvokeVoidAsync("callFirebaseFunction", "deleteCloudinaryAsset",
                    System.Text.Json.JsonSerializer.Serialize(new { publicId, resourceType }));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Cloudinary 삭제 실패 ({publicId}): {ex.Message}");
            }
        }

        private bool _isSyncingLogin = false;
        // 이번 실행(앱을 연 뒤)에 클라우드와 병합을 마친 사용자 Id. 병합 전에는 로컬이 낡았을 수 있어서
        // 로컬 전체를 그대로 클라우드에 올리면 다른 기기의 최신 내용을 덮어쓸 수 있음.
        private string? _mergedUid;
        public async Task SyncOnLoginAsync()
        {
            if (!IsLoggedIn) return;
            // 동시 호출 방지 (OnAuthChanged + OnAppResumed 동시 진입 시 중복 마이그레이션 방지)
            if (_isSyncingLogin) return;
            _isSyncingLogin = true;
            IsSyncing = true;
            OnSyncStarted?.Invoke();
            try
            {
            // ── 사용자별 용량 한도 읽기 (없으면 기본 300MB로 문서 생성)
            try
            {
                var quotaRaw = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/meta/quota");
                if (!string.IsNullOrEmpty(quotaRaw) && !quotaRaw.StartsWith("__error__:"))
                {
                    // 문서 있음 → limitBytes 읽어서 적용
                    using var qDoc = System.Text.Json.JsonDocument.Parse(quotaRaw);
                    if (qDoc.RootElement.TryGetProperty("limitBytes", out var lb) && lb.GetInt64() > 0)
                        PerUserLimitBytes = lb.GetInt64();
                }
                else if (quotaRaw == null) // 문서 없음 → 기본값으로 생성
                {
                    await _js.InvokeAsync<bool>(
                        "firebaseStore.setDocument", $"users/{Uid}/meta/quota",
                        JsonSerializer.Serialize(new { limitBytes = PerUserLimitBytes, createdAt = DateTime.UtcNow }, _jsonOpts));
                }
            }
            catch { }

            // 24시간 이상 된 활성 세션 자동 종료 (앱 강제 종료 등으로 미종료된 세션 정리)
            try
            {
                var allProjects = await GetProjectsAsync();
                bool staleFixed = false;
                foreach (var p in allProjects)
                {
                    var stale = p.Sessions.FirstOrDefault(s =>
                        s.IsActive && (DateTime.Now - s.StartTime).TotalHours > 24);
                    if (stale != null)
                    {
                        stale.EndTime = stale.StartTime.AddHours(24);
                        await SaveLocalAsync(KEY_PROJECTS, allProjects);
                        staleFixed = true;
                    }
                }
                if (staleFixed) await PushLocalToFirebaseAsync();
            }
            catch { }

            // 4개 컬렉션은 서로 독립(저장 키·클라우드 경로가 모두 다름)이라 동시에 처리 — 대기 시간이 합산되지 않음
            await Task.WhenAll(
                MergeCollectionAsync<KnitProject>(KEY_PROJECTS, "projects"),
                MergeCollectionAsync<Yarn>(KEY_YARNS, "yarns"),
                MergeCollectionAsync<KnitTool>(KEY_TOOLS, "tools"),
                MergeCollectionAsync<Swatch>(KEY_SWATCHES, "swatches"));
            _mergedUid = Uid; // 이번 실행에서 클라우드와 병합을 마쳤음 (PushLocalToFirebaseAsync가 참고)
            await SyncTodosAsync();
            await SyncHomeCountersAsync();

            // 병합이 끝난 시점에 화면을 먼저 갱신 — 아래 사진/도안 마이그레이션 확인(서버 왕복, 경우에 따라 업로드)이
            // 끝나길 기다리면 다른 기기에서 바뀐 내용이 한참 뒤에야 보임. 마지막(finally)에도 한 번 더 알림.
            try { OnSyncCompleted?.Invoke(); } catch { }

            // 로그인 전 비로그인 상태로 쌓인 사진/도안(Base64, 로컬 전용)을 Cloudinary로 옮겨
            // IDB·Firestore 용량 부담을 줄임 — 아래 조건 중 하나라도 해당하면 실행:
            //   1) 마이그레이션 완료 플래그가 없는 경우 (최초 1회)
            //   2) PatternCloudUrl이 비어있는 HasSavedPattern 항목이 있는 경우 (이전 실패/누락 복구)
            try
            {
                var flagRaw = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/meta/{KEY_MEDIA_MIGRATED}");
                // __error__:... 응답은 Firebase 오류 — null로 간주해 마이그레이션 실행
                var alreadyMigrated = (flagRaw != null && !flagRaw.StartsWith("__error__:")) ? flagRaw : null;

                // 플래그가 찍혀있어도 미완료 항목(PatternCloudUrl 누락)이 있으면 재실행
                bool hasPending = false;
                if (!string.IsNullOrEmpty(alreadyMigrated))
                {
                    var projectsForCheck = await GetProjectsAsync();
                    hasPending = projectsForCheck.Any(p =>
                        NeedsPatternUpload(p) ||
                        p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)))
                        || (await GetSwatchesAsync()).Any(NeedsSwatchPhotoUpload);
                }

                if (string.IsNullOrEmpty(alreadyMigrated) || hasPending)
                {
                    await MigrateLocalMediaToCloudAsync();
                    // 마이그레이션 완료 후 미완료 항목이 없을 때만 플래그 기록
                    var projectsAfter = await GetProjectsAsync();
                    bool allDone = !projectsAfter.Any(p =>
                        NeedsPatternUpload(p) ||
                        p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)))
                        && !(await GetSwatchesAsync()).Any(NeedsSwatchPhotoUpload);
                    if (allDone)
                    {
                        await _js.InvokeAsync<bool>(
                            "firebaseStore.setDocument", $"users/{Uid}/meta/{KEY_MEDIA_MIGRATED}",
                            JsonSerializer.Serialize(new { done = true, at = DateTime.Now }, _jsonOpts));
                    }
                }
            }
            catch { }
            }
            finally
            {
            IsSyncing = false;
            _isSyncingLogin = false;
            OnSyncCompleted?.Invoke();
            }
        }

        // ── 로컬(Base64) 사진/도안을 Cloudinary로 마이그레이션 ─────────────
        // 로그인 직후 1회 실행됨. 이미 StorageUrl/PatternCloudUrl이 있는 항목은 건너뜀(중복 업로드 방지).
        public async Task MigrateLocalMediaToCloudAsync()
        {
            // 이미 실행 중이면 중복 실행 방지
            if (CurrentMigration?.IsRunning == true) return;

            var projects = await GetProjectsAsync();

            // 총 작업 수 계산 (업로드 필요한 사진 + PDF)
            int total = 0;
            foreach (var p in projects)
            {
                total += p.Photos.Count(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl));
                if (NeedsPatternUpload(p)) total++;
            }
            total += (await GetSwatchesAsync()).Count(NeedsSwatchPhotoUpload);

            if (total == 0) return;

            var progress = new MigrationProgress { Total = total, Done = 0, Failed = 0, IsRunning = true };
            CurrentMigration = progress;
            OnMigrationProgress?.Invoke(progress);

            var changed = false;
            var quotaReached = false;
            const int MaxRetry = 3;

            foreach (var proj in projects)
            {
                if (quotaReached) break;

                // 멀티기기 race condition 방지: 프로젝트당 1회 Firestore 최신 상태 조회.
                // 다른 기기에서 방금 사진/도안을 삭제했다면, 이 기기의 로컬(IDB/Base64)에
                // 남아있는 데이터를 "유실분"으로 오인해 되살리지 않도록 사전 차단.
                bool freshHasSavedPattern = proj.HasSavedPattern;
                HashSet<Guid>? freshPhotoIds = null; // null이면 검증 불가(네트워크 오류 등) → 기존 로직대로 진행
                try
                {
                    var freshRaw = await _js.InvokeAsync<string?>(
                        "firebaseStore.getDocument", $"users/{Uid}/projects/{proj.Id}");
                    if (!string.IsNullOrEmpty(freshRaw) && !freshRaw.StartsWith("__error__:"))
                    {
                        using var freshDoc = System.Text.Json.JsonDocument.Parse(freshRaw);
                        if (freshDoc.RootElement.TryGetProperty("HasSavedPattern", out var hsp)
                            || freshDoc.RootElement.TryGetProperty("hasSavedPattern", out hsp))
                        {
                            freshHasSavedPattern = hsp.ValueKind == System.Text.Json.JsonValueKind.True;
                        }
                        if (freshDoc.RootElement.TryGetProperty("Photos", out var photosEl)
                            || freshDoc.RootElement.TryGetProperty("photos", out photosEl))
                        {
                            freshPhotoIds = new HashSet<Guid>();
                            foreach (var ph in photosEl.EnumerateArray())
                            {
                                if ((ph.TryGetProperty("Id", out var pid) || ph.TryGetProperty("id", out pid))
                                    && Guid.TryParse(pid.GetString(), out var gid))
                                    freshPhotoIds.Add(gid);
                            }
                        }
                    }
                }
                catch { /* 조회 실패 시 freshPhotoIds=null → 검증 스킵하고 기존 로직대로 진행 */ }

                // 서버 기준 도안이 이미 삭제됐다면 로컬도 동기화하고 PDF 마이그레이션 건너뜀
                if (proj.HasSavedPattern && !freshHasSavedPattern)
                {
                    proj.HasSavedPattern = false;
                    proj.PatternCloudUrl = "";
                    proj.PatternFileName = "";
                    changed = true;
                    try { await _js.InvokeAsync<bool>("patternViewer.deleteSavedPdf", proj.Id.ToString()); } catch { }
                }

                // 사진
                foreach (var photo in proj.Photos.ToList())
                {
                    // 서버 기준 이미 삭제된 사진이면 로컬 리스트에서도 제거하고 업로드 건너뜀
                    if (freshPhotoIds != null && !freshPhotoIds.Contains(photo.Id))
                    {
                        proj.Photos.Remove(photo);
                        changed = true;
                        continue;
                    }

                    if (string.IsNullOrEmpty(photo.Base64Data) || !string.IsNullOrEmpty(photo.StorageUrl))
                        continue;

                    string? url = null;
                    for (int attempt = 1; attempt <= MaxRetry; attempt++)
                    {
                        try
                        {
                            var (u, err, _) = await UploadPhotoAsync(proj.Id.ToString(), photo.Id.ToString(), photo.Base64Data);
                            if (err == "quota") { quotaReached = true; break; }
                            if (!string.IsNullOrEmpty(u)) { url = u; break; }
                        }
                        catch { }
                        if (attempt < MaxRetry)
                            await Task.Delay(1500 * attempt); // 재시도 간격: 1.5s, 3s
                    }

                    if (quotaReached) break;

                    if (!string.IsNullOrEmpty(url))
                    {
                        photo.StorageUrl = url;
                        photo.Base64Data = "";
                        changed = true;
                        progress.Done++;
                    }
                    else
                    {
                        progress.Failed++;
                    }
                    progress.CurrentLabel = $"{proj.PatternName} 사진";
                    OnMigrationProgress?.Invoke(progress);
                }

                if (quotaReached) break;

                // 도안 PDF (race condition 가드는 루프 진입부에서 이미 freshHasSavedPattern으로 처리됨)
                if (NeedsPatternUpload(proj))
                {
                    progress.CurrentLabel = $"{proj.PatternName} 도안";
                    OnMigrationProgress?.Invoke(progress);

                    string? cloudUrl = null;
                    bool pdfCountHandled = false;
                    bool usageSubtracted = false; // 재시도마다 중복 차감되지 않도록 1회만 실행 보장
                    for (int attempt = 1; attempt <= MaxRetry; attempt++)
                    {
                        try
                        {
                            var base64Pdf = await _js.InvokeAsync<string?>("patternViewer.getSavedPdfBase64", proj.Id.ToString());
                            if (!string.IsNullOrEmpty(base64Pdf))
                            {
                                // Cloudinary는 같은 publicId로 덮어쓰기 → 기존 usage를 딱 한 번만 차감 후 새 값 누적
                                if (!usageSubtracted && proj.PatternFileSizeBytes > 0)
                                {
                                    await SubtractCloudUsageAsync("pdf", proj.PatternFileSizeBytes);
                                    usageSubtracted = true;
                                }
                                var (u, err, pdfBytes) = await UploadPdfAsync(proj.Id.ToString(), base64Pdf);
                                if (err == "quota") { quotaReached = true; break; }
                                if (err == "too_large")
                                {
                                    // 파일 크기는 재시도해도 안 바뀌므로 즉시 종료 — local-only와 달리
                                    // 영구적으로 재시도하지 않도록 별도 값으로 마킹
                                    proj.PatternCloudUrl = PatternCloudUrlTooLarge;
                                    changed = true;
                                    progress.Failed++;
                                    progress.TooLargeCount++;
                                    pdfCountHandled = true;
                                    OnMigrationProgress?.Invoke(progress);
                                    break;
                                }
                                if (!string.IsNullOrEmpty(u)) { cloudUrl = u; proj.PatternFileSizeBytes = pdfBytes; break; }
                            }
                            else
                            {
                                // IDB에 PDF 없음 — 방금 저장 중인 레이스 컨디션일 수 있으므로
                                // 마지막 시도(MaxRetry)까지는 자연스럽게 재시도하고, 그때도 없으면 local-only
                                if (attempt == MaxRetry)
                                {
                                    proj.PatternCloudUrl = PatternCloudUrlLocalOnly;
                                    changed = true;
                                    progress.Failed++;
                                    pdfCountHandled = true;
                                    OnMigrationProgress?.Invoke(progress);
                                }
                            }
                        }
                        catch { }
                        if (attempt < MaxRetry)
                            await Task.Delay(1500 * attempt);
                    }

                    if (quotaReached) break;

                    if (!pdfCountHandled)
                    {
                        if (!string.IsNullOrEmpty(cloudUrl))
                        {
                            proj.PatternCloudUrl = cloudUrl;
                            changed = true;
                            progress.Done++;
                        }
                        else
                        {
                            // 3회 모두 실패 → local-only 표시해서 이후 재시도 차단
                            // (10MB 초과, 네트워크 오류 등 — 사용자가 도안 재업로드할 때 처리)
                            proj.PatternCloudUrl = PatternCloudUrlLocalOnly;
                            changed = true;
                            progress.Failed++;
                        }
                        OnMigrationProgress?.Invoke(progress);
                    }
                }
            }

            if (changed)
                await SaveAsync(KEY_PROJECTS, "projects", "Id", projects);

            // 스와치 사진 (기기에만 저장된 Base64 → Cloudinary)
            if (!quotaReached)
            {
                var swatchTargets = (await GetSwatchesAsync()).Where(NeedsSwatchPhotoUpload).ToList();
                foreach (var target in swatchTargets)
                {
                    string? sUrl = null;
                    long sBytes = 0;
                    for (int attempt = 1; attempt <= MaxRetry; attempt++)
                    {
                        try
                        {
                            var (u, err, bytes) = await UploadSwatchPhotoAsync(target.Id.ToString(), target.PhotoBase64);
                            if (err == "quota") { quotaReached = true; break; }
                            if (!string.IsNullOrEmpty(u)) { sUrl = u; sBytes = bytes; break; }
                        }
                        catch { }
                        if (attempt < MaxRetry)
                            await Task.Delay(1500 * attempt);
                    }

                    if (quotaReached) break;

                    if (!string.IsNullOrEmpty(sUrl))
                    {
                        // 업로드 중 사용자가 스와치를 수정/삭제했을 수 있으므로 최신 목록에서 해당 항목만 패치
                        var latest = await GetSwatchesAsync();
                        var cur = latest.FirstOrDefault(s => s.Id == target.Id);
                        if (cur != null && NeedsSwatchPhotoUpload(cur))
                        {
                            cur.PhotoStorageUrl = sUrl;
                            cur.PhotoFileSizeBytes = sBytes;
                            cur.PhotoBase64 = "";
                            await SaveAsync(KEY_SWATCHES, "swatches", "Id", latest);
                        }
                        progress.Done++;
                    }
                    else
                    {
                        progress.Failed++;
                    }
                    progress.CurrentLabel = $"{target.Name} 스와치 사진";
                    OnMigrationProgress?.Invoke(progress);
                }
            }

            progress.IsRunning = false;
            progress.QuotaReached = quotaReached;
            CurrentMigration = progress;
            OnMigrationProgress?.Invoke(progress);

            // 5초 후 진행 상태 초기화
            _ = Task.Delay(5000).ContinueWith(_ =>
            {
                CurrentMigration = null;
                OnMigrationProgress?.Invoke(new MigrationProgress());
            });
        }

        private async Task SyncTodosAsync()
        {
            var localJson = await _js.InvokeAsync<string?>("knitDB.getData", KEY_TODOS);

            string? cloudJson = null;
            DateTime cloudUpdatedAt = DateTime.MinValue;
            try
            {
                var cloudDoc = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/settings/todos");
                if (!string.IsNullOrEmpty(cloudDoc))
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(cloudDoc, _jsonOpts);
                    if (el.TryGetProperty("data", out var data))
                        cloudJson = data.GetRawText();
                    if (el.TryGetProperty("updatedAt", out var ts) && ts.ValueKind == JsonValueKind.String)
                        DateTime.TryParse(ts.GetString(), out cloudUpdatedAt);
                }
            }
            catch { }

            // 수정일 기반 winner-takes-all: 더 최신인 쪽 전체를 사용
            // (항목 추가 방식은 삭제된 항목이 다시 살아나는 문제 발생)
            string mergedJson;
            var localUpdatedAt = await GetTodosLocalUpdatedAt();
            if (string.IsNullOrEmpty(cloudJson))
            {
                mergedJson = localJson ?? "[]";
            }
            else if (string.IsNullOrEmpty(localJson) || localJson == "[]")
            {
                mergedJson = cloudJson;
            }
            else if (cloudUpdatedAt > localUpdatedAt)
            {
                // 클라우드가 더 최신 → 클라우드 데이터 사용
                mergedJson = cloudJson;
            }
            else
            {
                // 로컬이 더 최신이거나 동일 → 로컬 유지
                mergedJson = localJson;
            }

            await _js.InvokeVoidAsync("knitDB.setData", KEY_TODOS, mergedJson);

            try
            {
                var payload = JsonSerializer.Serialize(new { data = JsonSerializer.Deserialize<JsonElement>(mergedJson, _jsonOpts) }, _jsonOpts);
                await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                    $"users/{Uid}/settings/todos", payload);
            }
            catch { }
        }

        // ── 홈 화면 독립 카운터 동기화 (Todos와 동일한 패턴) ─────────────
        private const string KEY_HOME_COUNTERS    = "knitlog_home_counters";
        private const string KEY_HOME_COUNTERS_TS = "knitlog_home_counters_ts";

        private async Task SyncHomeCountersAsync()
        {
            var localJson = await _js.InvokeAsync<string?>("knitDB.getData", KEY_HOME_COUNTERS);

            string? cloudJson = null;
            DateTime cloudUpdatedAt = DateTime.MinValue;
            try
            {
                var cloudDoc = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/settings/homeCounters");
                if (!string.IsNullOrEmpty(cloudDoc))
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(cloudDoc, _jsonOpts);
                    if (el.TryGetProperty("data", out var data))
                        cloudJson = data.GetRawText();
                    if (el.TryGetProperty("updatedAt", out var ts) && ts.ValueKind == JsonValueKind.String)
                        DateTime.TryParse(ts.GetString(), out cloudUpdatedAt);
                }
            }
            catch { }

            // 수정일 기반 winner-takes-all: 더 최신인 쪽 전체를 사용
            string mergedCountersJson;
            var localUpdatedAt = await GetHomeCountersLocalUpdatedAt();
            if (string.IsNullOrEmpty(cloudJson))
            {
                mergedCountersJson = localJson ?? "[]";
            }
            else if (string.IsNullOrEmpty(localJson) || localJson == "[]")
            {
                mergedCountersJson = cloudJson;
            }
            else if (cloudUpdatedAt > localUpdatedAt)
            {
                mergedCountersJson = cloudJson;
            }
            else
            {
                mergedCountersJson = localJson;
            }

            await _js.InvokeVoidAsync("knitDB.setData", KEY_HOME_COUNTERS, mergedCountersJson);

            try
            {
                var payload = JsonSerializer.Serialize(new { data = JsonSerializer.Deserialize<JsonElement>(mergedCountersJson, _jsonOpts) }, _jsonOpts);
                await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                    $"users/{Uid}/settings/homeCounters", payload);
            }
            catch { }
        }

        private async Task MergeCollectionAsync<T>(string localKey, string collectionName)
        {
            var localJson = await _js.InvokeAsync<string?>("knitDB.getData", localKey);
            var localList = string.IsNullOrWhiteSpace(localJson) || localJson == "[]"
                ? new List<JsonElement>()
                : JsonSerializer.Deserialize<List<JsonElement>>(localJson, _jsonOpts) ?? new();

            var cloudJson = await LoadFirebaseAsync<JsonElement>(collectionName);
            var cloudList = cloudJson ?? new List<JsonElement>();

            // Id 기준으로 merge
            var merged = new Dictionary<string, JsonElement>();
            // 클라우드에 이미 있는 항목(삭제 표시 제외) — 클라우드와 같은 내용은 다시 올리지 않기 위한 기준
            var cloudById = new Dictionary<string, JsonElement>();
            // 클라우드에 올려야 하는 항목 Id (로컬에만 있거나, 로컬이 더 최신이거나, 세션 병합으로 내용이 달라진 것)
            var uploadIds = new HashSet<string>();

            // 로컬 먼저 추가 (_deleted tombstone 제외)
            foreach (var item in localList)
            {
                var id = GetId(item);
                if (id != null && !IsDeleted(item)) merged[id] = item;
            }

            // Cloud 기준으로 merge: tombstone이면 로컬에서도 제거, 최신이면 덮어쓰기
            foreach (var item in cloudList)
            {
                var id = GetId(item);
                if (id == null) continue;
                if (IsDeleted(item))
                {
                    // tombstone — 로컬에서도 제거
                    merged.Remove(id);
                    continue;
                }
                cloudById[id] = item;
                if (!merged.ContainsKey(id))
                {
                    merged[id] = item;
                }
                else
                {
                    var localUpdated = GetUpdatedAt(merged[id]);
                    var cloudUpdated = GetUpdatedAt(item);
                    // 프로젝트 컬렉션: Sessions 배열을 Id 기준으로 union merge
                    if (collectionName == "projects")
                    {
                        // cloud가 더 최신이거나 동일 시각이면 cloud 우선 (수정 동기화 보장)
                        var winner = cloudUpdated >= localUpdated ? item : merged[id];
                        var loser  = cloudUpdated >= localUpdated ? merged[id] : item;
                        merged[id] = MergeProjectSessions(winner, loser, _jsonOpts);
                        // 로컬이 더 최신이거나, 로컬에만 있던 세션이 합쳐져 클라우드와 달라졌으면 올림
                        if (cloudUpdated < localUpdated || SessionsDiffer(merged[id], item))
                            uploadIds.Add(id);
                    }
                    else
                    {
                        if (cloudUpdated >= localUpdated) merged[id] = item;
                        else uploadIds.Add(id); // 로컬이 더 최신 → 클라우드에 반영
                    }
                }
            }

            // 클라우드에 없는 항목(로컬에서만 만든 것, 오프라인 중 추가한 것)은 올림
            foreach (var id in merged.Keys)
                if (!cloudById.ContainsKey(id)) uploadIds.Add(id);

            var mergedList = merged.Values.ToList();
            var mergedJson = JsonSerializer.Serialize(mergedList, _jsonOpts);

            // 로컬 저장
            await _js.InvokeVoidAsync("knitDB.setData", localKey, mergedJson);

            // Cloud 업데이트: 클라우드와 이미 같은 항목은 건너뛰고 달라진 것만 올림
            // (예전에는 전체를 한 건씩 다시 써서 앱을 열 때마다 느리고 쓰기 요금도 나갔음)
            var path = $"users/{Uid}/{collectionName}";
            bool uploadOk = true;
            if (uploadIds.Count > 0)
            {
                var uploadList = merged.Where(kv => uploadIds.Contains(kv.Key)).Select(kv => kv.Value).ToList();
                uploadOk = await _js.InvokeAsync<bool>("firebaseStore.saveCollection",
                    path, JsonSerializer.Serialize(uploadList, _jsonOpts), "Id");
            }

            // 클라우드와 같다고 확인된 항목은 "이미 올라간 내용"으로 기억시켜,
            // 이후 첫 저장에서 변경 없는 항목까지 전부 다시 쓰는 일을 막음 (실패해도 동작엔 영향 없음)
            try
            {
                var syncedIds = merged.Keys.Where(id => uploadOk || !uploadIds.Contains(id)).ToList();
                if (syncedIds.Count > 0)
                {
                    var typed = JsonSerializer.Deserialize<List<T>>(mergedJson, _jsonOpts) ?? new();
                    await _js.InvokeAsync<bool>("firebaseStore.markSynced",
                        path, JsonSerializer.Serialize(typed, _jsonOpts), "Id", JsonSerializer.Serialize(syncedIds));
                }
            }
            catch { }
        }

        // 두 프로젝트의 세션 목록(Id → 종료 여부/시각)이 다른지 비교
        private static bool SessionsDiffer(JsonElement a, JsonElement b)
        {
            static Dictionary<string, string> Map(JsonElement el)
            {
                var m = new Dictionary<string, string>();
                if (el.TryGetProperty("Sessions", out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var s in arr.EnumerateArray())
                    {
                        if (!s.TryGetProperty("Id", out var sid)) continue;
                        var end = s.TryGetProperty("EndTime", out var et) && et.ValueKind != JsonValueKind.Null
                            ? et.ToString() : "";
                        m[sid.ToString()] = end;
                    }
                }
                return m;
            }
            var ma = Map(a);
            var mb = Map(b);
            if (ma.Count != mb.Count) return true;
            foreach (var kv in ma)
                if (!mb.TryGetValue(kv.Key, out var v) || v != kv.Value) return true;
            return false;
        }

        private static string? GetId(JsonElement el)
        {
            if (el.TryGetProperty("Id", out var id) || el.TryGetProperty("id", out id))
                return id.ValueKind == JsonValueKind.String ? id.GetString() : id.ToString();
            return null;
        }

        private static bool IsDeleted(JsonElement el)
        {
            if (el.TryGetProperty("_deleted", out var v))
                return v.ValueKind == JsonValueKind.True;
            return false;
        }

        private static DateTime GetUpdatedAt(JsonElement el)
        {
            foreach (var key in new[] { "UpdatedAt", "updatedAt", "SavedAt", "savedAt", "CreatedAt", "createdAt" })
                if (el.TryGetProperty(key, out var val) && val.ValueKind == JsonValueKind.String)
                    if (DateTime.TryParse(val.GetString(), out var dt)) return dt;
            return DateTime.MinValue;
        }

        // 프로젝트 merge 시 Sessions 배열을 Id 기준으로 합침
        // - 한쪽에만 있는 세션은 무조건 포함
        // - 양쪽에 같은 Id 세션이 있으면: IsActive(EndTime없음)인 쪽 우선 → 둘다 완료면 더 늦게 끝난 쪽
        private static JsonElement MergeProjectSessions(JsonElement winner, JsonElement loser, JsonSerializerOptions opts)
        {
            try
            {
                var dict = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(winner.GetRawText(), opts);
                if (dict == null) return winner;

                // 양쪽 세션을 Id 기준 딕셔너리로 수집
                var sessions = new Dictionary<string, JsonElement>();

                // winner 세션 먼저
                if (dict.TryGetValue("Sessions", out var winSessions) && winSessions.ValueKind == JsonValueKind.Array)
                    foreach (var s in winSessions.EnumerateArray())
                        if (s.TryGetProperty("Id", out var sid)) sessions[sid.ToString()] = s;

                // loser 세션: 없으면 추가, 있으면 IsActive 우선 비교
                if (loser.TryGetProperty("Sessions", out var loserSessions) && loserSessions.ValueKind == JsonValueKind.Array)
                {
                    foreach (var s in loserSessions.EnumerateArray())
                    {
                        if (!s.TryGetProperty("Id", out var sid)) continue;
                        var id = sid.ToString();
                        if (!sessions.ContainsKey(id))
                        {
                            // winner에 없는 세션 → 추가
                            sessions[id] = s;
                        }
                        else
                        {
                            // 양쪽에 있음 → "종료 기록(EndTime 있음)"이 항상 우선.
                            // 활성 상태를 무조건 우선시하면, 이미 멈춘 세션이 다른 기기의
                            // 오래된 로컬 데이터 때문에 되살아나는 문제가 생김.
                            var existing = sessions[id];
                            bool existingActive = !existing.TryGetProperty("EndTime", out var et1) || et1.ValueKind == JsonValueKind.Null;
                            bool incomingActive = !s.TryGetProperty("EndTime", out var et2) || et2.ValueKind == JsonValueKind.Null;

                            if (existingActive && !incomingActive)
                                sessions[id] = s; // winner는 아직 활성인데 loser에 명시적 종료 기록이 있음 → 종료 기록 우선
                            // 그 외(둘 다 종료 / 둘 다 활성 / winner가 이미 종료)는 winner 유지
                        }
                    }
                }

                dict["Sessions"] = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(sessions.Values.ToList(), opts), opts);
                return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(dict, opts), opts);
            }
            catch { return winner; }
        }

        // ── 온라인 복귀 시 로컬 → Firebase push ─────────────────────
        // 오프라인 중 수정된 내용을 Firebase에 강제 업로드
        public async Task PushLocalToFirebaseAsync()
        {
            if (!IsLoggedIn) return;
            try
            {
                // Cloudinary 미업로드 파일(PDF/사진) 먼저 처리
                var projectsToCheck = await GetProjectsAsync();
                bool hasPendingMedia = projectsToCheck.Any(p =>
                    NeedsPatternUpload(p) ||
                    p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)))
                    || (await GetSwatchesAsync()).Any(NeedsSwatchPhotoUpload);
                if (hasPendingMedia)
                    await MigrateLocalMediaToCloudAsync();

                if (_mergedUid == Uid)
                {
                    // 이번 실행에서 이미 클라우드와 병합했으므로, 그 뒤 로컬에서 바뀐 항목만 올라감
                    // (병합 직후 클라우드와 같다고 확인된 항목은 saveCollection이 건너뜀)
                    await SaveFirebaseAsync("projects", await GetProjectsAsync(), "Id");
                    await SaveFirebaseAsync("yarns",    await GetYarnsAsync(),    "Id");
                    await SaveFirebaseAsync("tools",    await GetToolsAsync(),    "Id");
                    await SaveFirebaseAsync("swatches", await GetSwatchesAsync(), "Id");
                }
                else
                {
                    // 아직 클라우드와 병합한 적이 없으면 로컬이 낡았을 수 있음 → 그대로 올리면 다른 기기의
                    // 최신 내용(예: 패드에서 멈춘 타이머)을 낡은 내용으로 덮어쓰므로, 비교·병합 후 올림
                    await Task.WhenAll(
                        MergeCollectionAsync<KnitProject>(KEY_PROJECTS, "projects"),
                        MergeCollectionAsync<Yarn>(KEY_YARNS, "yarns"),
                        MergeCollectionAsync<KnitTool>(KEY_TOOLS, "tools"),
                        MergeCollectionAsync<Swatch>(KEY_SWATCHES, "swatches"));
                    _mergedUid = Uid;
                }

                // todos push
                var todosJson = await _js.InvokeAsync<string?>("knitDB.getData", KEY_TODOS);
                if (!string.IsNullOrEmpty(todosJson))
                {
                    try
                    {
                        var tsStr = await _js.InvokeAsync<string?>("knitDB.getData", KEY_TODOS_TS);
                        if (string.IsNullOrEmpty(tsStr)) tsStr = DateTime.UtcNow.ToString("O");
                        var payload = JsonSerializer.Serialize(
                            new { data = JsonSerializer.Deserialize<JsonElement>(todosJson, _jsonOpts), updatedAt = tsStr }, _jsonOpts);
                        await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                            $"users/{Uid}/settings/todos", payload);
                    }
                    catch { }
                }

                // 홈 카운터 push
                var homeCountersJson = await _js.InvokeAsync<string?>("knitDB.getData", KEY_HOME_COUNTERS);
                if (!string.IsNullOrEmpty(homeCountersJson))
                {
                    try
                    {
                        var tsStr = await _js.InvokeAsync<string?>("knitDB.getData", KEY_HOME_COUNTERS_TS);
                        if (string.IsNullOrEmpty(tsStr)) tsStr = DateTime.UtcNow.ToString("O");
                        var payload = JsonSerializer.Serialize(
                            new { data = JsonSerializer.Deserialize<JsonElement>(homeCountersJson, _jsonOpts), updatedAt = tsStr }, _jsonOpts);
                        await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                            $"users/{Uid}/settings/homeCounters", payload);
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"PushLocalToFirebase error: {ex.Message}");
            }
        }

        // ── Todos 저장 (IDB + Firebase 즉시) ────────────────────────
        private const string KEY_TODOS_TS = "knitlog_todos_ts"; // 로컬 수정 타임스탬프

        public async Task SaveTodosAsync(string todosJson)
        {
            var nowStr = DateTime.UtcNow.ToString("O");
            await _js.InvokeVoidAsync("knitDB.setData", KEY_TODOS, todosJson);
            await _js.InvokeVoidAsync("knitDB.setData", KEY_TODOS_TS, nowStr);
            if (!IsLoggedIn) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    var payload = JsonSerializer.Serialize(
                        new { data = JsonSerializer.Deserialize<JsonElement>(todosJson, _jsonOpts), updatedAt = nowStr }, _jsonOpts);
                    await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                        $"users/{Uid}/settings/todos", payload);
                }
                catch { }
            });
        }

        private async Task<DateTime> GetTodosLocalUpdatedAt()
        {
            try
            {
                var ts = await _js.InvokeAsync<string?>("knitDB.getData", KEY_TODOS_TS);
                if (!string.IsNullOrEmpty(ts) && DateTime.TryParse(ts, out var dt)) return dt;
            }
            catch { }
            return DateTime.MinValue;
        }

        // ── 홈 카운터 저장 (IDB + Firebase 즉시) ────────────────────
        public async Task SaveHomeCountersAsync(string countersJson)
        {
            var nowStr = DateTime.UtcNow.ToString("O");
            await _js.InvokeVoidAsync("knitDB.setData", KEY_HOME_COUNTERS, countersJson);
            await _js.InvokeVoidAsync("knitDB.setData", KEY_HOME_COUNTERS_TS, nowStr);
            if (!IsLoggedIn) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    var payload = JsonSerializer.Serialize(
                        new { data = JsonSerializer.Deserialize<JsonElement>(countersJson, _jsonOpts), updatedAt = nowStr }, _jsonOpts);
                    await _js.InvokeAsync<bool>("firebaseStore.setDocument",
                        $"users/{Uid}/settings/homeCounters", payload);
                }
                catch { }
            });
        }

        private async Task<DateTime> GetHomeCountersLocalUpdatedAt()
        {
            try
            {
                var ts = await _js.InvokeAsync<string?>("knitDB.getData", KEY_HOME_COUNTERS_TS);
                if (!string.IsNullOrEmpty(ts) && DateTime.TryParse(ts, out var dt)) return dt;
            }
            catch { }
            return DateTime.MinValue;
        }

        // ── 통합 저장 (로컬 즉시 + Firebase 백그라운드) ──────────────
        // 로컬 저장은 즉시 완료 → UI 블로킹 없음
        // Firebase는 fire-and-forget: 오프라인이면 PushLocalToFirebaseAsync 로 나중에 올림
        private async Task SaveAsync<T>(string key, string collectionName, string idField, List<T> list)
        {
            // 1) 로컬 즉시 저장 (빠름)
            await SaveLocalAsync(key, list);
            // 2) Firebase 백그라운드 저장 (네트워크 문제 시 조용히 실패 → 오프라인 pending)
            _ = SaveFirebaseAsync(collectionName, list, idField);
        }

        // ── 프로젝트 ─────────────────────────────────────────────────
        public Task<List<KnitProject>> GetProjectsAsync() => LoadLocalAsync<KnitProject>(KEY_PROJECTS);

        public async Task SaveProjectAsync(KnitProject project)
        {
            project.UpdatedAt = DateTime.Now;  // 저장 시각 갱신 → 기기간 merge 시 최신 판단 기준
            var list = await GetProjectsAsync();
            var idx  = list.FindIndex(p => p.Id == project.Id);
            if (idx >= 0) list[idx] = project; else list.Add(project);
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        /// <summary>
        /// 저장하되 클라우드 업로드가 끝날 때까지(최대 timeoutMs) 기다림.
        /// 타이머 시작/종료처럼 다른 기기에 꼭 전달돼야 하는 변경용 — 일반 저장은 업로드를 기다리지 않아서
        /// 종료 직후 앱을 닫거나 화면을 끄면 업로드가 중간에 끊겨 다른 기기에서 타이머가 계속 도는 것처럼 보일 수 있음.
        /// 시간 안에 끝나지 않으면 기다리지 않고 넘어감(업로드는 계속 진행되고, 실패해도 다음 동기화 때 다시 올라감).
        /// </summary>
        public async Task SaveProjectAndWaitAsync(KnitProject project, int timeoutMs = 5000)
        {
            project.UpdatedAt = DateTime.Now;
            var list = await GetProjectsAsync();
            var idx  = list.FindIndex(p => p.Id == project.Id);
            if (idx >= 0) list[idx] = project; else list.Add(project);
            await SaveLocalAsync(KEY_PROJECTS, list);
            if (!IsLoggedIn) return;
            var upload = SaveFirebaseAsync("projects", list, "Id"); // 내부에서 예외를 처리함
            await Task.WhenAny(upload, Task.Delay(timeoutMs));
        }

        /// <summary>
        /// 프로젝트 하나만 클라우드에서 다시 읽어와 로컬보다 최신이면 병합해서 반영.
        /// 동기화는 로그인 시점에만 도는 구조라, 다른 기기에서 방금 멈춘 타이머 같은 변경사항을
        /// 재로그인 없이도 놓치지 않도록 프로젝트 상세를 열 때 호출하는 용도.
        /// 세션은 "종료 기록이 있는 쪽"을 우선해서 병합 — 활성 상태를 무조건 우선하면
        /// 이미 멈춘 세션이 로컬의 오래된 활성 상태 때문에 되살아나는 문제가 생김.
        /// </summary>
        public async Task<KnitProject?> RefreshProjectFromCloudAsync(Guid projectId)
        {
            if (!IsLoggedIn) return null;
            try
            {
                var json = await _js.InvokeAsync<string?>("firebaseStore.getDocument", $"users/{Uid}/projects/{projectId}");
                if (string.IsNullOrEmpty(json) || json.StartsWith("__error__")) return null;

                var cloud = System.Text.Json.JsonSerializer.Deserialize<KnitProject>(json);
                if (cloud == null) return null;

                var list  = await GetProjectsAsync();
                var local = list.FirstOrDefault(p => p.Id == projectId);
                if (local == null)
                {
                    list.Add(cloud);
                    await SaveLocalAsync(KEY_PROJECTS, list);
                    return cloud;
                }
                if (cloud.UpdatedAt <= local.UpdatedAt)
                {
                    // 로컬이 더 최신이어도, 클라우드에 "종료 기록"이 있는 세션이 로컬엔 아직 진행 중이면 종료 기록을 반영.
                    // (화면만 열었다 닫아도 저장 시각이 갱신되던 예전 동작 때문에, 낡은 로컬이 더 최신처럼 보일 수 있음)
                    bool endedApplied = false;
                    foreach (var cs in cloud.Sessions)
                    {
                        if (cs.EndTime == null) continue;
                        var ls = local.Sessions.FirstOrDefault(x => x.Id == cs.Id);
                        if (ls == null || ls.EndTime != null) continue;
                        ls.EndTime = cs.EndTime;
                        if (string.IsNullOrEmpty(ls.Memo) && !string.IsNullOrEmpty(cs.Memo)) ls.Memo = cs.Memo;
                        endedApplied = true;
                    }
                    if (endedApplied) await SaveLocalAsync(KEY_PROJECTS, list);
                    return local; // 그 외에는 로컬 그대로 유지
                }

                var mergedSessions = new Dictionary<Guid, KnitSession>();
                foreach (var s in local.Sessions) mergedSessions[s.Id] = s;
                foreach (var s in cloud.Sessions)
                {
                    if (!mergedSessions.TryGetValue(s.Id, out var existing)) { mergedSessions[s.Id] = s; continue; }
                    bool existingActive = existing.EndTime == null;
                    bool incomingActive = s.EndTime == null;
                    if (existingActive && !incomingActive) mergedSessions[s.Id] = s; // 로컬은 활성인데 클라우드가 종료 기록 있음 → 종료 기록 우선
                    // 그 외(로컬이 이미 종료 / 둘 다 활성 / 둘 다 종료)는 기존 값 유지
                }
                cloud.Sessions = mergedSessions.Values.OrderBy(s => s.StartTime).ToList();

                var idx = list.FindIndex(p => p.Id == projectId);
                if (idx >= 0) list[idx] = cloud; else list.Add(cloud);
                await SaveLocalAsync(KEY_PROJECTS, list);
                return cloud;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"RefreshProjectFromCloudAsync: {ex.Message}");
                return null;
            }
        }

        public async Task DeleteProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.FirstOrDefault(p => p.Id == id);

            // Cloudinary 사진 삭제
            if (proj != null && IsLoggedIn)
            {
                foreach (var photo in proj.Photos)
                {
                    if (!string.IsNullOrEmpty(photo.StorageUrl))
                        await DeletePhotoAsync(id.ToString(), photo.Id.ToString(), photo.FileSizeBytes);
                }
                // Cloudinary PDF 삭제
                if (!string.IsNullOrEmpty(proj.PatternCloudUrl) && proj.PatternCloudUrl != PatternCloudUrlLocalOnly && proj.PatternCloudUrl != PatternCloudUrlTooLarge)
                    await DeletePdfAsync(id.ToString(), proj.PatternFileSizeBytes);
            }

            // IDB PDF 삭제
            try { await _js.InvokeAsync<bool>("patternViewer.deleteSavedPdf", id.ToString()); } catch { }

            list.RemoveAll(p => p.Id == id);
            await SaveLocalAsync(KEY_PROJECTS, list);
            TombstoneFirebaseDocBackground("projects", id.ToString());
        }

        public async Task CompleteProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status  = ProjectStatus.완료;
            proj.EndDate ??= DateTime.Today;
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        public async Task PauseProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status = ProjectStatus.일시중단;
            proj.StatusLogs.Add(new StatusLog { At = DateTime.Now, Action = "중단" });
            proj.UpdatedAt = DateTime.Now;
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        public async Task ResumeProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status = ProjectStatus.진행중;
            proj.StatusLogs.Add(new StatusLog { At = DateTime.Now, Action = "재개" });
            proj.UpdatedAt = DateTime.Now;
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        public async Task StartProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status    = ProjectStatus.진행중;
            proj.StartDate ??= DateTime.Today;
            if (!string.IsNullOrEmpty(proj.WishMemo))
            {
                proj.PatternMemo = string.IsNullOrEmpty(proj.PatternMemo)
                    ? proj.WishMemo
                    : proj.PatternMemo + "\n" + proj.WishMemo;
                proj.WishMemo = "";
            }
            proj.StatusLogs.Add(new StatusLog { At = DateTime.Now, Action = "시작" });
            proj.UpdatedAt = DateTime.Now;
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        // ── 실 창고 ──────────────────────────────────────────────────
        public Task<List<Yarn>> GetYarnsAsync() => LoadLocalAsync<Yarn>(KEY_YARNS);

        public async Task SaveYarnAsync(Yarn yarn)
        {
            var list = await GetYarnsAsync();
            var idx  = list.FindIndex(y => y.Id == yarn.Id);
            if (idx >= 0) list[idx] = yarn; else list.Add(yarn);
            await SaveAsync(KEY_YARNS, "yarns", "Id", list);
        }

        public async Task DeleteYarnAsync(Guid id)
        {
            var list = await GetYarnsAsync();
            list.RemoveAll(y => y.Id == id);
            await SaveLocalAsync(KEY_YARNS, list);
            TombstoneFirebaseDocBackground("yarns", id.ToString());
        }

        // ── 도구 ─────────────────────────────────────────────────────
        public Task<List<KnitTool>> GetToolsAsync() => LoadLocalAsync<KnitTool>(KEY_TOOLS);

        public async Task SaveToolAsync(KnitTool tool)
        {
            var list = await GetToolsAsync();
            var idx  = list.FindIndex(t => t.Id == tool.Id);
            if (idx >= 0) list[idx] = tool; else list.Add(tool);
            await SaveAsync(KEY_TOOLS, "tools", "Id", list);
        }

        public async Task DeleteToolAsync(Guid id)
        {
            var list = await GetToolsAsync();
            list.RemoveAll(t => t.Id == id);
            await SaveLocalAsync(KEY_TOOLS, list);
            TombstoneFirebaseDocBackground("tools", id.ToString());
        }

        // ── 스와치 ───────────────────────────────────────────────────
        public Task<List<Swatch>> GetSwatchesAsync() => LoadLocalAsync<Swatch>(KEY_SWATCHES);

        public async Task SaveSwatchAsync(Swatch swatch)
        {
            var list = await GetSwatchesAsync();
            var idx  = list.FindIndex(s => s.Id == swatch.Id);
            if (idx >= 0) list[idx] = swatch; else list.Add(swatch);
            await SaveAsync(KEY_SWATCHES, "swatches", "Id", list);
        }

        public async Task DeleteSwatchAsync(Guid id)
        {
            var list = await GetSwatchesAsync();
            list.RemoveAll(s => s.Id == id);
            await SaveLocalAsync(KEY_SWATCHES, list);
            TombstoneFirebaseDocBackground("swatches", id.ToString());
        }

        // ── 내보내기 (사용 안 됨) ──────────────────────────────────────
        // ⚠️ 현재 실제 "데이터 내보내기" 버튼은 이 함수를 쓰지 않음 — 대신
        // Settings.razor의 ExecuteExport()가 JS의 window.knitDB.exportAll()을
        // 직접 호출해요 (knittracker_projects 등 IndexedDB 키를 그대로 읽어 내보냄).
        // 이 함수는 그 키 이름 규칙과도 안 맞아서(예: "Projects" vs "knittracker_projects")
        // 지금 호출하면 가져오기와 형식이 안 맞아 정상 동작하지 않아요. 삭제하거나,
        // 실제로 쓸 계획이 있으면 ExecuteExport 쪽 로직과 통일해서 다시 연결해야 해요.
        public async Task<string> ExportAllAsync()
        {
            var projects = await GetProjectsAsync();
            foreach (var p in projects)
                foreach (var photo in p.Photos)
                    photo.Base64Data = "";

            var yarns = await GetYarnsAsync();
            foreach (var y in yarns) y.PhotoBase64 = "";

            var swatches = await GetSwatchesAsync();
            foreach (var s in swatches) s.PhotoBase64 = "";

            var data = new
            {
                Projects   = projects,
                Yarns      = yarns,
                Tools      = await GetToolsAsync(),
                Swatches   = swatches,
                ExportedAt = DateTime.Now
            };
            return JsonSerializer.Serialize(data, _jsonOpts);
        }
    }

    public class MigrationProgress
    {
        public int Total { get; set; }
        public int Done { get; set; }
        public int Failed { get; set; }
        public int TooLargeCount { get; set; } // Failed 중 10MB 초과가 원인인 개수 (별도 안내용)
        public bool IsRunning { get; set; }
        public bool QuotaReached { get; set; }
        public string CurrentLabel { get; set; } = "";
        public int Percent => Total > 0 ? (int)((Done + Failed) * 100.0 / Total) : 0;
    }
}