// =====================================================================
// Services/YarnDbService.cs  —  실 DB(yarn-db.json + 승인된 제보) 공용 로더
// 원작실 입력칸 자동완성 등 여러 화면에서 같이 쓰므로 한 번만 불러와 캐시해요.
// =====================================================================
using System.Net.Http.Json;
using Microsoft.JSInterop;

namespace KnitLog.Services
{
    public class YarnCatalogEntry
    {
        public string YarnType { get; set; } = "";
        public string Material { get; set; } = "";
        public int Ply { get; set; }
        public int WeightGram { get; set; }
        public int LengthMeter { get; set; }
        public decimal Price { get; set; }
    }

    public class YarnCatalogProduct
    {
        public string Brand { get; set; } = "";
        public string Name { get; set; } = "";
        public List<YarnCatalogEntry> Entries { get; set; } = new();
    }

    public class YarnDbService
    {
        private readonly HttpClient _http;
        private readonly IJSRuntime _js;
        private Task<List<YarnCatalogProduct>>? _loading;

        public YarnDbService(HttpClient http, IJSRuntime js)
        {
            _http = http;
            _js = js;
        }

        // 처음 부르면 로드하고, 이후엔 캐시를 돌려줘요. 로드가 비어서 끝나면(오프라인 등) 다음에 다시 시도해요.
        public async Task<List<YarnCatalogProduct>> GetAllAsync()
        {
            _loading ??= LoadAsync();
            var result = await _loading;
            if (result.Count == 0) _loading = null;
            return result;
        }

        private async Task<List<YarnCatalogProduct>> LoadAsync()
        {
            List<YarnCatalogProduct> db;
            try { db = await _http.GetFromJsonAsync<List<YarnCatalogProduct>>("data/yarn-db.json") ?? new(); }
            catch { db = new(); }

            // 관리자가 승인한 제보(Firestore yarnDbApproved)를 병합. 실패해도 조용히 무시.
            try
            {
                var json = await _js.InvokeAsync<string?>("firebaseStore.getCollection", "yarnDbApproved");
                if (!string.IsNullOrWhiteSpace(json))
                {
                    var approved = System.Text.Json.JsonSerializer.Deserialize<List<ApprovedDoc>>(json,
                        new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new();
                    foreach (var a in approved)
                    {
                        if (string.IsNullOrWhiteSpace(a.Brand) || string.IsNullOrWhiteSpace(a.Name)) continue;
                        var entry = new YarnCatalogEntry
                        {
                            YarnType = a.YarnType ?? "",
                            Material = a.Material ?? "",
                            Ply = a.Ply,
                            WeightGram = a.WeightGram,
                            LengthMeter = a.LengthMeter,
                            Price = a.Price
                        };
                        var existing = db.FirstOrDefault(p => p.Brand == a.Brand && p.Name == a.Name);
                        if (existing != null) existing.Entries.Add(entry);
                        else db.Add(new YarnCatalogProduct { Brand = a.Brand!, Name = a.Name!, Entries = new() { entry } });
                    }
                }
            }
            catch (Exception ex) { Console.Error.WriteLine($"승인된 제보 병합 실패: {ex.Message}"); }

            return db;
        }

        private class ApprovedDoc
        {
            public string? Brand { get; set; }
            public string? Name { get; set; }
            public string? YarnType { get; set; }
            public string? Material { get; set; }
            public int Ply { get; set; }
            public int WeightGram { get; set; }
            public int LengthMeter { get; set; }
            public decimal Price { get; set; }
        }
    }
}
