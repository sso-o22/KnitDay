// =====================================================================
// StorageService.cs  —  JSON 기반 로컬 저장소 서비스
// =====================================================================
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using KnitLog.Models;
using Microsoft.JSInterop;

namespace KnitLog.Services
{
    public class StorageService
    {
        private readonly IJSRuntime _js;

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

        private async Task SaveAsync<T>(string key, List<T> list)
        {
            var json = JsonSerializer.Serialize(list, _jsonOpts);
            await _js.InvokeVoidAsync("localStorage.setItem", key, json);
        }

        private async Task<List<T>> LoadAsync<T>(string key)
        {
            var json = await _js.InvokeAsync<string?>("localStorage.getItem", key);
            if (string.IsNullOrWhiteSpace(json)) return new List<T>();
            try { return JsonSerializer.Deserialize<List<T>>(json, _jsonOpts) ?? new(); }
            catch { return new List<T>(); }
        }

        // ── 프로젝트 ──────────────────────────────────────────────────
        public Task<List<KnitProject>> GetProjectsAsync() => LoadAsync<KnitProject>(KEY_PROJECTS);

        public async Task SaveProjectAsync(KnitProject project)
        {
            var list = await GetProjectsAsync();
            var idx  = list.FindIndex(p => p.Id == project.Id);
            if (idx >= 0) list[idx] = project; else list.Add(project);
            await SaveAsync(KEY_PROJECTS, list);
        }

        public async Task DeleteProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            list.RemoveAll(p => p.Id == id);
            await SaveAsync(KEY_PROJECTS, list);
        }

        public async Task CompleteProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status  = ProjectStatus.완료;
            proj.EndDate ??= DateTime.Today;
            await SaveAsync(KEY_PROJECTS, list);
        }

        public async Task PauseProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status = ProjectStatus.일시중단;
            await SaveAsync(KEY_PROJECTS, list);
        }

        public async Task ResumeProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status = ProjectStatus.진행중;
            await SaveAsync(KEY_PROJECTS, list);
        }

        public async Task StartProjectAsync(Guid id)
        {
            var list = await GetProjectsAsync();
            var proj = list.Find(p => p.Id == id);
            if (proj is null) return;
            proj.Status    = ProjectStatus.진행중;
            proj.StartDate ??= DateTime.Today;
            await SaveAsync(KEY_PROJECTS, list);
        }

        // ── 실 장고 ──────────────────────────────────────────────────
        public Task<List<Yarn>> GetYarnsAsync() => LoadAsync<Yarn>(KEY_YARNS);

        public async Task SaveYarnAsync(Yarn yarn)
        {
            var list = await GetYarnsAsync();
            var idx  = list.FindIndex(y => y.Id == yarn.Id);
            if (idx >= 0) list[idx] = yarn; else list.Add(yarn);
            await SaveAsync(KEY_YARNS, list);
        }

        public async Task DeleteYarnAsync(Guid id)
        {
            var list = await GetYarnsAsync();
            list.RemoveAll(y => y.Id == id);
            await SaveAsync(KEY_YARNS, list);
        }

        // ── 도구 ─────────────────────────────────────────────────────
        public Task<List<KnitTool>> GetToolsAsync() => LoadAsync<KnitTool>(KEY_TOOLS);

        public async Task SaveToolAsync(KnitTool tool)
        {
            var list = await GetToolsAsync();
            var idx  = list.FindIndex(t => t.Id == tool.Id);
            if (idx >= 0) list[idx] = tool; else list.Add(tool);
            await SaveAsync(KEY_TOOLS, list);
        }

        public async Task DeleteToolAsync(Guid id)
        {
            var list = await GetToolsAsync();
            list.RemoveAll(t => t.Id == id);
            await SaveAsync(KEY_TOOLS, list);
        }

        // ── 스와치 ───────────────────────────────────────────────────
        public Task<List<Swatch>> GetSwatchesAsync() => LoadAsync<Swatch>(KEY_SWATCHES);

        public async Task SaveSwatchAsync(Swatch swatch)
        {
            var list = await GetSwatchesAsync();
            var idx  = list.FindIndex(s => s.Id == swatch.Id);
            if (idx >= 0) list[idx] = swatch; else list.Add(swatch);
            await SaveAsync(KEY_SWATCHES, list);
        }

        public async Task DeleteSwatchAsync(Guid id)
        {
            var list = await GetSwatchesAsync();
            list.RemoveAll(s => s.Id == id);
            await SaveAsync(KEY_SWATCHES, list);
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
