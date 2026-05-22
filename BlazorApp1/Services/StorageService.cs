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

        private async Task DeleteFirebaseDocAsync(string collectionName, string id)
        {
            if (!IsLoggedIn) return;
            try
            {
                await _js.InvokeAsync<bool>("firebaseStore.deleteDocument",
                    $"users/{Uid}/{collectionName}/{id}");
            }
            catch { }
        }

        // ── 로그인 시 동기화 ─────────────────────────────────────────
        // 로컬 있으면 Cloud로 업로드, Cloud 있으면 로컬로 다운로드
        public async Task SyncOnLoginAsync()
        {
            if (!IsLoggedIn) return;

            await SyncCollectionAsync<KnitProject>(KEY_PROJECTS, "projects", "Id");
            await SyncCollectionAsync<Yarn>(KEY_YARNS, "yarns", "Id");
            await SyncCollectionAsync<KnitTool>(KEY_TOOLS, "tools", "Id");
            await SyncCollectionAsync<Swatch>(KEY_SWATCHES, "swatches", "Id");
        }

        private async Task SyncCollectionAsync<T>(string localKey, string collectionName, string idField)
        {
            var localJson = await _js.InvokeAsync<string?>("localStorage.getItem", localKey);
            var hasLocal  = !string.IsNullOrWhiteSpace(localJson) && localJson != "[]";
            var cloudData = await LoadFirebaseAsync<T>(collectionName);
            var hasCloud  = cloudData != null && cloudData.Count > 0;

            if (hasLocal && !hasCloud)
            {
                // 로컬 → Cloud 업로드
                var list = JsonSerializer.Deserialize<List<T>>(localJson!, _jsonOpts) ?? new();
                await SaveFirebaseAsync(collectionName, list, idField);
            }
            else if (hasCloud)
            {
                // Cloud → 로컬 덮어쓰기
                await SaveLocalAsync(localKey, cloudData!);
            }
        }

        // ── 통합 저장 (로컬 + Firebase) ──────────────────────────────
        private async Task SaveAsync<T>(string key, string collectionName, string idField, List<T> list)
        {
            await SaveLocalAsync(key, list);
            await SaveFirebaseAsync(collectionName, list, idField);
        }

        // ── 프로젝트 ─────────────────────────────────────────────────
        public Task<List<KnitProject>> GetProjectsAsync() => LoadLocalAsync<KnitProject>(KEY_PROJECTS);

        public async Task SaveProjectAsync(KnitProject project)
        {
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
            await DeleteFirebaseDocAsync("projects", id.ToString());
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
            await DeleteFirebaseDocAsync("yarns", id.ToString());
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
            await DeleteFirebaseDocAsync("tools", id.ToString());
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
            await DeleteFirebaseDocAsync("swatches", id.ToString());
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
