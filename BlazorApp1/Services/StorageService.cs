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

        private void DeleteFirebaseDocBackground(string collectionName, string id)
        {
            if (!IsLoggedIn) return;
            _ = _js.InvokeAsync<bool>("firebaseStore.deleteDocument", $"users/{Uid}/{collectionName}/{id}").AsTask()
                   .ContinueWith(_ => { }, TaskContinuationOptions.None);
        }

        // ── 로그인 시 동기화 ─────────────────────────────────────────
        // 로그인 시 로컬 + Cloud 데이터를 Id 기준으로 merge
        // - 같은 Id: UpdatedAt이 더 최신인 것 우선
        // - 한쪽에만 있으면: 그냥 포함
        // ── Cloudinary 업로드 ────────────────────────────────
        public const long PerUserLimitBytes = 500L * 1024 * 1024; // 500MB

        public async Task<(string? url, string? error)> UploadPhotoAsync(string projectId, string photoId, string base64DataUrl)
        {
            try
            {
                var (used, _) = await GetCloudUsageAsync();
                if (used >= PerUserLimitBytes)
                    return (null, "quota");
                var publicId = $"{Uid ?? "anon"}/projects/{projectId}/{photoId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64DataUrl, publicId, "image");
                var url = await ParseCloudinaryResult(json, "photo");
                return (url, null);
            }
            catch { return (null, "error"); }
        }

        public async Task<(string? url, string? error)> UploadPdfAsync(string projectId, string base64Data)
        {
            try
            {
                var (photoUsed, pdfUsed) = await GetCloudUsageAsync();
                if (photoUsed + pdfUsed >= PerUserLimitBytes)
                    return (null, "quota");
                var publicId = $"{Uid ?? "anon"}/pdfs/{projectId}";
                var json = await _js.InvokeAsync<string?>("uploadToCloudinary", base64Data, publicId, "raw");
                var url = await ParseCloudinaryResult(json, "pdf");
                return (url, null);
            }
            catch { return (null, "error"); }
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

        private async Task<string?> ParseCloudinaryResult(string? json, string type)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                var url   = doc.RootElement.GetProperty("url").GetString();
                var bytes = doc.RootElement.TryGetProperty("bytes", out var b) ? b.GetInt64() : 0;
                if (!string.IsNullOrEmpty(url) && bytes > 0 && !string.IsNullOrEmpty(Uid))
                    await AddCloudUsageAsync(type, bytes);
                return url;
            }
            catch { return null; }
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
            try
            {
                var json = await _js.InvokeAsync<string?>("firebaseStore.getDocument", $"users/{Uid}/meta/usage");
                if (string.IsNullOrEmpty(json)) return (0, 0);
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                long p = doc.RootElement.TryGetProperty("photoBytes", out var pb) ? pb.GetInt64() : 0;
                long d = doc.RootElement.TryGetProperty("pdfBytes",   out var db) ? db.GetInt64() : 0;
                return (p, d);
            }
            catch { return (0, 0); }
        }

        // Cloudinary 무료: 클라이언트 삭제 불가 → 무시
        public Task DeletePhotoAsync(string projectId, string photoId) => Task.CompletedTask;

        public async Task SyncOnLoginAsync()
        {
            if (!IsLoggedIn) return;
            IsSyncing = true;
            OnSyncStarted?.Invoke();

            await MergeCollectionAsync<KnitProject>(KEY_PROJECTS, "projects");
            await MergeCollectionAsync<Yarn>(KEY_YARNS, "yarns");
            await MergeCollectionAsync<KnitTool>(KEY_TOOLS, "tools");
            await MergeCollectionAsync<Swatch>(KEY_SWATCHES, "swatches");
            await SyncTodosAsync();

            // 로그인 전 비로그인 상태로 쌓인 사진/도안(Base64, 로컬 전용)을 Cloudinary로 옮겨
            // IDB·Firestore 용량 부담을 줄임 — 계정당 1회만 실행 (매번 폴링 동기화마다 전체 스캔하지 않도록)
            try
            {
                var alreadyMigrated = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/meta/{KEY_MEDIA_MIGRATED}");
                if (string.IsNullOrEmpty(alreadyMigrated))
                {
                    await MigrateLocalMediaToCloudAsync();
                    await _js.InvokeAsync<bool>(
                        "firebaseStore.setDocument", $"users/{Uid}/meta/{KEY_MEDIA_MIGRATED}",
                        JsonSerializer.Serialize(new { done = true, at = DateTime.Now }, _jsonOpts));
                }
            }
            catch { }

            IsSyncing = false;
            OnSyncCompleted?.Invoke();
        }

        // ── 로컬(Base64) 사진/도안을 Cloudinary로 마이그레이션 ─────────────
        // 로그인 직후 1회 실행됨. 이미 StorageUrl/PatternCloudUrl이 있는 항목은 건너뜀(중복 업로드 방지).
        public async Task MigrateLocalMediaToCloudAsync()
        {
            var projects = await GetProjectsAsync();
            var changed = false;
            var quotaReached = false;

            foreach (var proj in projects)
            {
                if (quotaReached) break;

                // 사진: Base64Data가 남아있고 아직 클라우드에 안 올라간 것만 대상
                foreach (var photo in proj.Photos)
                {
                    if (string.IsNullOrEmpty(photo.Base64Data) || !string.IsNullOrEmpty(photo.StorageUrl))
                        continue;
                    try
                    {
                        var (url, err) = await UploadPhotoAsync(proj.Id.ToString(), photo.Id.ToString(), photo.Base64Data);
                        if (err == "quota") { quotaReached = true; break; } // 용량 초과 — 지금까지 옮긴 것은 저장하고 중단
                        if (!string.IsNullOrEmpty(url))
                        {
                            photo.StorageUrl = url;
                            photo.Base64Data = ""; // 업로드 성공 시에만 로컬 원본 비움 — 실패하면 그대로 보존
                            changed = true;
                        }
                    }
                    catch { /* 이 사진은 건너뛰고 다음으로 — 실패해도 로컬 데이터는 그대로 보존되어 안전 */ }
                }
                if (quotaReached) break;

                // 도안 PDF: 저장된 PDF가 있는데 아직 클라우드 URL이 없는 경우만 대상
                if (proj.HasSavedPattern && string.IsNullOrEmpty(proj.PatternCloudUrl))
                {
                    try
                    {
                        var base64Pdf = await _js.InvokeAsync<string?>("patternViewer.getSavedPdfBase64", proj.Id.ToString());
                        if (!string.IsNullOrEmpty(base64Pdf))
                        {
                            var (cloudUrl, cloudErr) = await UploadPdfAsync(proj.Id.ToString(), base64Pdf);
                            if (cloudErr == "quota") { quotaReached = true; }
                            else if (!string.IsNullOrEmpty(cloudUrl))
                            {
                                proj.PatternCloudUrl = cloudUrl;
                                changed = true;
                            }
                        }
                    }
                    catch { /* PDF 읽기/업로드 실패 — 로컬 PDF는 그대로 유지되므로 안전, 다음 프로젝트로 진행 */ }
                }
            }

            // quota 초과로 중단됐어도 그 전까지 성공한 마이그레이션 결과는 반드시 저장
            if (changed)
                await SaveAsync(KEY_PROJECTS, "projects", "Id", projects);
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

            // 로컬 먼저 추가
            foreach (var item in localList)
            {
                var id = GetId(item);
                if (id != null) merged[id] = item;
            }

            // Cloud에서 더 최신이면 덮어쓰기, 없으면 추가
            foreach (var item in cloudList)
            {
                var id = GetId(item);
                if (id == null) continue;
                if (!merged.ContainsKey(id))
                {
                    merged[id] = item;
                }
                else
                {
                    // UpdatedAt 비교 (없으면 Cloud 우선)
                    var localUpdated  = GetUpdatedAt(merged[id]);
                    var cloudUpdated  = GetUpdatedAt(item);
                    if (cloudUpdated > localUpdated) merged[id] = item;
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

        private static DateTime GetUpdatedAt(JsonElement el)
        {
            foreach (var key in new[] { "UpdatedAt", "updatedAt", "SavedAt", "savedAt", "CreatedAt", "createdAt" })
                if (el.TryGetProperty(key, out var val) && val.ValueKind == JsonValueKind.String)
                    if (DateTime.TryParse(val.GetString(), out var dt)) return dt;
            return DateTime.MinValue;
        }

        // ── 온라인 복귀 시 로컬 → Firebase push ─────────────────────
        // 오프라인 중 수정된 내용을 Firebase에 강제 업로드
        public async Task PushLocalToFirebaseAsync()
        {
            if (!IsLoggedIn) return;
            try
            {
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
            list.RemoveAll(p => p.Id == id);
            await SaveLocalAsync(KEY_PROJECTS, list);
            DeleteFirebaseDocBackground("projects", id.ToString());
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
            DeleteFirebaseDocBackground("yarns", id.ToString());
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
            DeleteFirebaseDocBackground("tools", id.ToString());
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
            DeleteFirebaseDocBackground("swatches", id.ToString());
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
}
