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

        private static readonly JsonSerializerOptions _jsonOpts = new()
        {
            WriteIndented = true,
            PropertyNameCaseInsensitive = true
        };

        public StorageService(IJSRuntime js) { _js = js; }

        // AuthService는 순환 의존 방지를 위해 나중에 주입
        public void SetAuthService(AuthService auth) { _auth = auth; }

        private string? Uid => _auth?.CurrentUser?.Uid;
        private bool IsLoggedIn => !string.IsNullOrEmpty(Uid);

        // ── 로컬 스토리지 ────────────────────────────────────────────
        private async Task SaveLocalAsync<T>(string key, List<T> list)
        {
            var json = JsonSerializer.Serialize(list, _jsonOpts);
            await _js.InvokeVoidAsync("localStorage.setItem", key, json);
        }

        private async Task<List<T>> LoadLocalAsync<T>(string key)
        {
            var json = await _js.InvokeAsync<string?>("localStorage.getItem", key);
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
        public async Task SyncOnLoginAsync()
        {
            if (!IsLoggedIn) return;

            await MergeCollectionAsync<KnitProject>(KEY_PROJECTS, "projects");
            await MergeCollectionAsync<Yarn>(KEY_YARNS, "yarns");
            await MergeCollectionAsync<KnitTool>(KEY_TOOLS, "tools");
            await MergeCollectionAsync<Swatch>(KEY_SWATCHES, "swatches");
            await SyncTodosAsync();
        }

        private async Task SyncTodosAsync()
        {
            // 할 일 목록은 배열 통째로 동기화 (항목 수가 더 많은 쪽 우선, 없으면 로컬 우선)
            var localJson = await _js.InvokeAsync<string?>("localStorage.getItem", KEY_TODOS);

            // Firebase에서 읽기
            string? cloudJson = null;
            try
            {
                var cloudDoc = await _js.InvokeAsync<string?>(
                    "firebaseStore.getDocument", $"users/{Uid}/settings/todos");
                if (!string.IsNullOrEmpty(cloudDoc))
                {
                    var el = JsonSerializer.Deserialize<JsonElement>(cloudDoc, _jsonOpts);
                    if (el.TryGetProperty("data", out var data))
                        cloudJson = data.GetRawText();
                }
            }
            catch { }

            // 병합: 둘 다 있으면 항목 수 많은 쪽 채택, 한쪽만 있으면 그쪽 사용
            string mergedJson = localJson ?? "[]";
            if (!string.IsNullOrEmpty(cloudJson))
            {
                var localCount  = string.IsNullOrEmpty(localJson) ? 0
                    : (JsonSerializer.Deserialize<JsonElement>(localJson,  _jsonOpts).GetArrayLength());
                var cloudCount  = JsonSerializer.Deserialize<JsonElement>(cloudJson, _jsonOpts).GetArrayLength();
                if (cloudCount > localCount) mergedJson = cloudJson;
            }

            // 로컬 저장
            await _js.InvokeVoidAsync("localStorage.setItem", KEY_TODOS, mergedJson);

            // Firebase 저장
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
            var localJson = await _js.InvokeAsync<string?>("localStorage.getItem", localKey);
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
            await _js.InvokeVoidAsync("localStorage.setItem", localKey, mergedJson);

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
                var todosJson = await _js.InvokeAsync<string?>("localStorage.getItem", KEY_TODOS);
                if (!string.IsNullOrEmpty(todosJson))
                {
                    try
                    {
                        var payload = JsonSerializer.Serialize(
                            new { data = JsonSerializer.Deserialize<JsonElement>(todosJson, _jsonOpts) }, _jsonOpts);
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
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        public async Task ResumeProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status = ProjectStatus.진행중;
            await SaveAsync(KEY_PROJECTS, "projects", "Id", list);
        }

        public async Task StartProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status    = ProjectStatus.진행중;
            proj.StartDate ??= DateTime.Today;
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
        public async Task<string> ExportAllAsync()
        {
            var data = new
            {
                Projects   = await GetProjectsAsync(),
                Yarns      = await GetYarnsAsync(),
                Tools      = await GetToolsAsync(),
                Swatches   = await GetSwatchesAsync(),
                ExportedAt = DateTime.Now
            };
            return JsonSerializer.Serialize(data, _jsonOpts);
        }
    }
}
