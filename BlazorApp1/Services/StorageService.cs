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
        public long PerUserLimitBytes { get; private set; } = 500L * 1024 * 1024; // 기본 500MB — 로그인 시 Firestore quota 문서로 덮어씀
        public const long MaxPdfUploadBytes = 10L * 1024 * 1024;   // 10MB — Cloudinary free 제한
        // PatternCloudUrl에 세팅하는 특수값: 클라우드 업로드 불가(용량 초과 등) → 재시도 방지
        public const string PatternCloudUrlLocalOnly = "local-only";

        public async Task<(string? url, string? error, long bytes)> UploadPhotoAsync(string projectId, string photoId, string base64DataUrl)
        {
            try
            {
                var (used, _) = await GetCloudUsageAsync();
                if (used >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid ?? "anon"}/projects/{projectId}/{photoId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64DataUrl, publicId, "image");
                var (url, bytes) = await ParseCloudinaryResult(json, "photo");
                return (url, null, bytes);
            }
            catch { return (null, "error", 0); }
        }

        public async Task<(string? url, string? error, long bytes)> UploadPdfAsync(string projectId, byte[] bytes)
        {
            if (!IsLoggedIn || string.IsNullOrEmpty(Uid)) return (null, "not_logged_in", 0);
            try
            {
                var (photoUsed, pdfUsed) = await GetCloudUsageAsync();
                if (photoUsed + pdfUsed >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid}/pdfs/{projectId}";
                // IDB에서 직접 읽어 업로드 — Blazor↔JS 대용량 인터롭 없이 JS 내부에서 처리
                // (DotNetStreamReference/base64 전달이 안드로이드에서 불안정한 문제 회피)
                var json = await _js.InvokeAsync<string?>("uploadPdfFromIDB", projectId, publicId);
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

        private async Task<(string? url, long bytes)> ParseCloudinaryResult(string? json, string type)
        {
            if (string.IsNullOrEmpty(json)) return (null, 0);
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                var url   = doc.RootElement.GetProperty("url").GetString();
                var bytes = doc.RootElement.TryGetProperty("bytes", out var b) ? b.GetInt64() : 0;
                if (!string.IsNullOrEmpty(url) && bytes > 0 && !string.IsNullOrEmpty(Uid))
                    await AddCloudUsageAsync(type, bytes);
                return (url, bytes);
            }
            catch { return (null, 0); }
        }

        // ── 용량 사용량 Firestore 누적 ────────────────────────
        private async Task AddCloudUsageAsync(string type, long bytes)
        {
            if (string.IsNullOrEmpty(Uid)) return;
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
                var (used, _) = await GetCloudUsageAsync();
                if (used >= PerUserLimitBytes)
                    return (null, "quota", 0);
                var publicId = $"{Uid ?? "anon"}/swatches/{swatchId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64DataUrl, publicId, "image");
                var (url, bytes) = await ParseCloudinaryResult(json, "photo");
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
            // ── 사용자별 용량 한도 읽기 (없으면 기본 500MB로 문서 생성)
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

            await MergeCollectionAsync<KnitProject>(KEY_PROJECTS, "projects");
            await MergeCollectionAsync<Yarn>(KEY_YARNS, "yarns");
            await MergeCollectionAsync<KnitTool>(KEY_TOOLS, "tools");
            await MergeCollectionAsync<Swatch>(KEY_SWATCHES, "swatches");
            await SyncTodosAsync();

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
                        (p.HasSavedPattern && string.IsNullOrEmpty(p.PatternCloudUrl)) ||
                        p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)));
                }

                if (string.IsNullOrEmpty(alreadyMigrated) || hasPending)
                {
                    await MigrateLocalMediaToCloudAsync();
                    // 마이그레이션 완료 후 미완료 항목이 없을 때만 플래그 기록
                    var projectsAfter = await GetProjectsAsync();
                    bool allDone = !projectsAfter.Any(p =>
                        (p.HasSavedPattern && string.IsNullOrEmpty(p.PatternCloudUrl)) ||
                        p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)));
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
                if (p.HasSavedPattern && string.IsNullOrEmpty(p.PatternCloudUrl)) total++;
            }

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

                // 사진
                foreach (var photo in proj.Photos)
                {
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

                // 도안 PDF
                if (proj.HasSavedPattern && string.IsNullOrEmpty(proj.PatternCloudUrl))
                {
                    progress.CurrentLabel = $"{proj.PatternName} 도안";
                    OnMigrationProgress?.Invoke(progress);

                    string? cloudUrl = null;
                    bool pdfCountHandled = false;
                    for (int attempt = 1; attempt <= MaxRetry; attempt++)
                    {
                        try
                        {
                            var base64Pdf = await _js.InvokeAsync<string?>("patternViewer.getSavedPdfBase64", proj.Id.ToString());
                            if (!string.IsNullOrEmpty(base64Pdf))
                            {
                                // Cloudinary는 같은 publicId로 덮어쓰기 → 기존 usage 먼저 차감 후 새 값 누적
                                if (proj.PatternFileSizeBytes > 0)
                                    await SubtractCloudUsageAsync("pdf", proj.PatternFileSizeBytes);
                                var (u, err, pdfBytes) = await UploadPdfAsync(proj.Id.ToString(), base64Pdf);
                                if (err == "quota") { quotaReached = true; break; }
                                if (!string.IsNullOrEmpty(u)) { cloudUrl = u; proj.PatternFileSizeBytes = pdfBytes; break; }
                            }
                            else
                            {
                                // IDB에 PDF 없음
                                // 단, attempt==1이면 방금 업로드 중인 레이스 컨디션일 수 있으므로
                                // 1회는 건너뛰고 재시도 — 이후에도 없으면 local-only
                                if (attempt < MaxRetry)
                                    break; // 재시도 루프로
                                // 3회 모두 없음 → local-only 표시
                                proj.PatternCloudUrl = PatternCloudUrlLocalOnly;
                                changed = true;
                                progress.Failed++;
                                pdfCountHandled = true;
                                OnMigrationProgress?.Invoke(progress);
                                break;
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
                    }
                    else
                    {
                        if (cloudUpdated >= localUpdated) merged[id] = item;
                    }
                }
            }

            var mergedList = merged.Values.ToList();
            var mergedJson = JsonSerializer.Serialize(mergedList, _jsonOpts);

            // 로컬 저장
            await _js.InvokeVoidAsync("knitDB.setData", localKey, mergedJson);

            // Cloud 업데이트 (로컬에만 있던 것도 올리기)
            await _js.InvokeAsync<bool>("firebaseStore.saveCollection",
                $"users/{Uid}/{collectionName}", mergedJson, "Id");
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
                            // 양쪽에 있음 → IsActive(EndTime없음)인 쪽 우선
                            var existing = sessions[id];
                            bool existingActive = !existing.TryGetProperty("EndTime", out var et1) || et1.ValueKind == JsonValueKind.Null;
                            bool incomingActive = !s.TryGetProperty("EndTime", out var et2) || et2.ValueKind == JsonValueKind.Null;

                            if (incomingActive && !existingActive)
                                sessions[id] = s; // loser가 활성 → loser 우선
                            else if (!incomingActive && !existingActive)
                                sessions[id] = existing; // 둘다 활성 → winner 유지
                            // 둘다 완료면 winner 유지 (UpdatedAt 기준 이미 winner 선택됨)
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
                    (p.HasSavedPattern && string.IsNullOrEmpty(p.PatternCloudUrl)) ||
                    p.Photos.Any(ph => !string.IsNullOrEmpty(ph.Base64Data) && string.IsNullOrEmpty(ph.StorageUrl)));
                if (hasPendingMedia)
                    await MigrateLocalMediaToCloudAsync();

                await SaveFirebaseAsync("projects", await GetProjectsAsync(), "Id");
                await SaveFirebaseAsync("yarns",    await GetYarnsAsync(),    "Id");
                await SaveFirebaseAsync("tools",    await GetToolsAsync(),    "Id");
                await SaveFirebaseAsync("swatches", await GetSwatchesAsync(), "Id");

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
                if (!string.IsNullOrEmpty(proj.PatternCloudUrl) && proj.PatternCloudUrl != PatternCloudUrlLocalOnly)
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

        // ── 내보내기 ─────────────────────────────────────────────────
        // export 시 사진 base64 제외 (용량 절감 — 사진은 기기 로컬에만 저장됨)
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
        public bool IsRunning { get; set; }
        public bool QuotaReached { get; set; }
        public string CurrentLabel { get; set; } = "";
        public int Percent => Total > 0 ? (int)((Done + Failed) * 100.0 / Total) : 0;
    }
}
