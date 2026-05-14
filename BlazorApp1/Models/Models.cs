// =====================================================================
// Models.cs  —  니트로그 앱 전체 데이터 모델
// =====================================================================
using System;
using System.Collections.Generic;

namespace KnitLog.Models
{
    public enum NeedleType { 대바늘, 코바늘 }
    public enum ProjectStatus { 진행중, 완료, 위시리스트 }
    public enum YarnWeight { 레이스, 핑거, 스포츠, DK, 워스티드, 벌키, 슈퍼벌키 }
    public enum KnitStitch { 메리야스, 가터, 고무단, 바둑판, 기타 }

    // ─────────────────────────────────────────────
    // 실 (Yarn)
    // ─────────────────────────────────────────────
    public class Yarn
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Name { get; set; } = "";
        public string Brand { get; set; } = "";
        public string Color { get; set; } = "";
        public string ColorCode { get; set; } = "#ffffff";
        public YarnWeight Weight { get; set; } = YarnWeight.워스티드;
        public string Material { get; set; } = "";
        public int WeightGram { get; set; }
        public int LengthMeter { get; set; }
        public string PurchasePlace { get; set; } = "";
        public decimal Price { get; set; }
        public int Quantity { get; set; } = 1;
        public string Memo { get; set; } = "";
        public DateTime CreatedAt { get; set; } = DateTime.Now;
    }

    // ─────────────────────────────────────────────
    // 스와치 (Swatch)
    // ─────────────────────────────────────────────
    public class Swatch
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Name { get; set; } = "";              // 스와치 이름 (선택)

        // 연결
        public Guid? YarnId { get; set; }                   // 사용 실
        public Guid? ProjectId { get; set; }                // 연결 프로젝트/위시리스트

        // 도구
        public double NeedleSizeMm { get; set; }            // 바늘 굵기
        public KnitStitch Stitch { get; set; } = KnitStitch.메리야스;

        // 세탁 전 게이지 (10cm 기준)
        public double PreWashStitches { get; set; }         // 코수
        public double PreWashRows { get; set; }             // 단수
        public double PreWashWidthCm { get; set; }          // 가로 cm
        public double PreWashHeightCm { get; set; }         // 세로 cm

        // 세탁 후 게이지
        public double PostWashStitches { get; set; }
        public double PostWashRows { get; set; }
        public double PostWashWidthCm { get; set; }
        public double PostWashHeightCm { get; set; }

        // 수축률 (자동 계산 프로퍼티)
        public double WidthShrinkagePercent =>
            PreWashWidthCm > 0
                ? Math.Round((PostWashWidthCm - PreWashWidthCm) / PreWashWidthCm * 100, 1)
                : 0;

        public double HeightShrinkagePercent =>
            PreWashHeightCm > 0
                ? Math.Round((PostWashHeightCm - PreWashHeightCm) / PreWashHeightCm * 100, 1)
                : 0;

        public string Memo { get; set; } = "";
        public DateTime CreatedAt { get; set; } = DateTime.Now;
    }

    // ─────────────────────────────────────────────
    // 도구 (Tool - 바늘)
    // ─────────────────────────────────────────────
    public class KnitTool
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public NeedleType NeedleType { get; set; } = NeedleType.대바늘;
        public string Brand { get; set; } = "";
        public double SizeMm { get; set; }
        public string Material { get; set; } = "";
        public int LengthCm { get; set; }
        public string Memo { get; set; } = "";
        public DateTime CreatedAt { get; set; } = DateTime.Now;
    }

    // ─────────────────────────────────────────────
    // 뜨개 과정 사진
    // ─────────────────────────────────────────────
    public class ProjectPhoto
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string FileName { get; set; } = "";
        public string Base64Data { get; set; } = "";
        public string Caption { get; set; } = "";
        public DateTime TakenAt { get; set; } = DateTime.Now;
    }

    // ─────────────────────────────────────────────
    // 뜨개 프로젝트
    // ─────────────────────────────────────────────
    public class KnitProject
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public ProjectStatus Status { get; set; } = ProjectStatus.위시리스트;
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public string PatternName { get; set; } = "";
        public string PatternSource { get; set; } = "";
        public string PatternMemo { get; set; } = "";
        public DateTime? StartDate { get; set; }
        public DateTime? EndDate { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.Now;
        public List<ProjectYarnUsage> YarnUsages { get; set; } = new();
        public List<Guid> ToolIds { get; set; } = new();
        public List<ProjectPhoto> Photos { get; set; } = new();
        public List<ProjectCounter> Counters { get; set; } = new();
        public List<ChecklistItem> Checklist { get; set; } = new();
        public List<KnitSession> Sessions { get; set; } = new();
        public string Memo { get; set; } = "";
        public string WishMemo { get; set; } = "";
    }

    public class ProjectYarnUsage
    {
        public Guid YarnId { get; set; }
        public int BallsUsed { get; set; }
        public string Memo { get; set; } = "";
    }

    public class ProjectCounter
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Label { get; set; } = "단수";
        public int Value { get; set; } = 0;
        public int Step { get; set; } = 1;
    }

    public class ChecklistItem
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Text { get; set; } = "";
        public bool Done { get; set; } = false;
    }

    public class KnitSession
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public DateTime StartTime { get; set; }
        public DateTime? EndTime { get; set; }
        public string Memo { get; set; } = "";

        public int GetDurationMinutes()
        {
            var end = EndTime ?? DateTime.Now;
            return (int)(end - StartTime).TotalMinutes;
        }

        public string GetFormattedDuration()
        {
            var minutes = GetDurationMinutes();
            var hours = minutes / 60;
            var mins = minutes % 60;
            if (hours > 0)
                return mins > 0 ? $"{hours}시간 {mins}분" : $"{hours}시간";
            return $"{mins}분";
        }

        public bool IsActive => !EndTime.HasValue;
    }
}
