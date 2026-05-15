// =====================================================================
// Models.cs  —  니트로그 앱 전체 데이터 모델
// =====================================================================
using System;
using System.Collections.Generic;

namespace KnitLog.Models
{
    public enum NeedleType { 대바늘, 코바늘, 케이블 }
    public enum ProjectStatus { 진행중, 일시중단, 완료, 위시리스트 }
    public enum YarnWeight { 레이스, 핑거, 스포츠, DK, 워스티드, 벌키, 슈퍼벌키 }
    public enum YarnType { 콘사, 볼실, 타래실, 손염색실, 기타 }

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
        public YarnType YarnType { get; set; } = YarnType.볼실;
        public string LotNumber { get; set; } = "";
        public string Material { get; set; } = "";
        public int WeightGram { get; set; }
        public int LengthMeter { get; set; }
        public string PurchasePlace { get; set; } = "";
        public decimal Price { get; set; }
        public DateTime? PurchaseDate { get; set; }
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
        public string Name { get; set; } = "";

        // 연결
        public Guid? YarnId { get; set; }
        public string YarnNameDirect { get; set; } = "";    // 직접 입력 실 이름
        public Guid? ProjectId { get; set; }

        // 도구
        public double NeedleSizeMm { get; set; }
        public string Stitch { get; set; } = "메리야스";     // 자유 입력

        // 세탁 전 게이지
        public double PreWashStitches { get; set; }
        public double PreWashRows { get; set; }
        public double PreWashWidthCm { get; set; }
        public double PreWashHeightCm { get; set; }

        // 세탁 후 게이지
        public double PostWashStitches { get; set; }
        public double PostWashRows { get; set; }
        public double PostWashWidthCm { get; set; }
        public double PostWashHeightCm { get; set; }

        // 수축률 자동 계산
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
        public string ModelName { get; set; } = "";      // 바늘 이름/모델 (예: 랜턴문, 진저)
        public bool IsSet { get; set; } = false;         // 세트 여부
        public double SizeMm { get; set; }               // 단일 굵기
        public List<double> SetSizes { get; set; } = new(); // 세트일 때 굵기 목록
        public string Material { get; set; } = "";
        public int LengthCm { get; set; }
        public string Memo { get; set; } = "";
        public DateTime CreatedAt { get; set; } = DateTime.Now;

        // 표시용 굵기 문자열
        public string SizeDisplay => IsSet && SetSizes.Count > 0
            ? string.Join(", ", SetSizes.Select(s => $"{s}mm"))
            : $"{SizeMm}mm";
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
        public string NeedleNote { get; set; } = "";        // 바늘 직접 입력 (예: 4mm 대바늘 80cm)
        public List<ProjectPhoto> Photos { get; set; } = new();
        public List<ProjectCounter> Counters { get; set; } = new();
        public List<ChecklistItem> Checklist { get; set; } = new();
        public List<KnitSession> Sessions { get; set; } = new();
        public string Memo { get; set; } = "";
        public string WishMemo { get; set; } = "";
        public List<string> VideoLinks { get; set; } = new();  // 참고 영상 링크
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
