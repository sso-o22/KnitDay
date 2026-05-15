# 🧶 니트로그 (KnitLog)

Blazor WebAssembly로 만든 나만의 뜨개 프로젝트 기록 앱!

---

## 📁 파일 구조

```
KnitLog/
├── KnitLog.csproj          ← 프로젝트 파일
├── Program.cs                  ← 앱 진입점 & DI 등록
├── App.razor                   ← 라우터
├── _Imports.razor              ← 전체 using 선언
│
├── Models/
│   └── Models.cs              ← 데이터 모델 (Yarn, KnitTool, KnitProject 등)
│
├── Services/
│   └── StorageService.cs      ← localStorage 기반 저장/불러오기
│
├── Layout/
│   └── MainLayout.razor       ← 사이드바 레이아웃
│
├── Pages/
│   ├── Home.razor             ← 홈 대시보드
│   ├── Schedule.razor         ← 뜨케줄 (진행중)
│   ├── Finished.razor         ← 완성작
│   ├── Wishlist.razor         ← 위시리스트
│   ├── Yarns.razor            ← 실 장고
│   └── Tools.razor            ← 도구 (바늘)
│
└── wwwroot/
    ├── index.html             ← 진입 HTML
    └── css/
        └── app.css            ← 전체 스타일
```

---

## 🚀 시작하는 방법

### 1. 기존 Blazor WASM 프로젝트에 파일 복사하기

Visual Studio에서 **Blazor WebAssembly App** 프로젝트를 생성한 후,
이 파일들을 해당 위치에 붙여넣기 하세요.

> 💡 Visual Studio: 파일 → 새로 만들기 → 프로젝트 → Blazor WebAssembly App

### 2. 기존 파일 교체

| 교체 대상 | 이 파일로 교체 |
|-----------|----------------|
| `Program.cs` | `Program.cs` |
| `App.razor` | `App.razor` |
| `_Imports.razor` | `_Imports.razor` |
| `wwwroot/index.html` | `wwwroot/index.html` |
| `wwwroot/css/app.css` | `wwwroot/css/app.css` |
| `Layout/MainLayout.razor` | `Layout/MainLayout.razor` |

### 3. 없는 폴더/파일은 새로 만들기

- `Models/` 폴더 → `Models.cs` 추가
- `Services/` 폴더 → `StorageService.cs` 추가  
- `Pages/` 폴더에 5개 Razor 파일 추가

### 4. 실행!

```
dotnet run
```

또는 Visual Studio에서 F5!

---

## 💾 데이터 저장 방식

브라우저의 **localStorage**를 사용해요.

- 별도 서버나 DB 없이 브라우저 자체에 저장
- 앱을 닫아도 데이터가 유지돼요
- 같은 브라우저, 같은 도메인에서만 접근 가능
- 사진은 Base64로 인코딩해서 저장 (큰 사진이 많으면 용량 주의!)

> ⚠️ 브라우저 캐시를 지우면 데이터도 지워져요.
> 중요한 데이터는 나중에 추가할 JSON 내보내기 기능으로 백업하세요!

---

## ✨ 기능 목록

| 메뉴 | 기능 |
|------|------|
| **🏠 홈** | 프로젝트 현황 요약, 진행중 프로젝트 미리보기 |
| **🪡 뜨케줄** | 진행중 프로젝트 추가/수정/삭제, 과정 사진 업로드, 완료 버튼 |
| **✅ 완성작** | 완성된 작품 갤러리, 소요 기간 계산 |
| **💫 위시리스트** | 뜨고 싶은 작품 메모, 뜨케줄로 이동 |
| **🎀 실 장고** | 실 정보 기록 (브랜드/색상/무게/가격/구매처), 색상 코드 |
| **🪢 도구** | 대바늘/코바늘 정보 (브랜드/mm/소재/길이) |

---

## � 업데이트 내역
### 2026년 5월 14일

#### 🌅 오전 (10:33 - 11:43)
- **컴포넌트 정리 및 최적화**
  - Models.cs 리팩토링 - 데이터 구조 정리 및 정규화
  - PatternViewer.razor 간소화
  - Swatches.razor 완전 제거 (불필요 기능 통합)
  
- **JavaScript 모듈 정리** (`patternViewer.js`)
  - 불필요한 코드 제거 및 간소화 (150+ 줄 삭제)
  - 기능 최적화

#### 🌄 오후 (14:33 - 17:23)
- **데이터 서비스 개선** (`StorageService.cs`)
  - 저장소 로직 정리 및 최적화
  - 데이터 마이그레이션 로직 추가

- **페이지별 정리 작업**
  - Schedule.razor - 리스트 관리 로직 간소화
  - ProjectDetail.razor - 불필요 코드 정리
  - Tools.razor - UI 단순화
  - Yarns.razor - 목록 표시 로직 개선
  - Wishlist.razor - 마이너 수정

- **UI/CSS 최적화** (`app.css`)
  - 스타일 통일 및 레이아웃 조정

- **레이아웃 미세 조정** (`MainLayout.razor`)

---
### 2026년 5월 15일

#### 🌅 오전 (10:52 - 11:30)
- **색상 시스템 개선** (`MainLayout.razor`, `app.css`)
  - UI 색상 체계 정리 및 최적화
  
- **다크 모드 지원** (`Settings.razor`, `Stats.razor` 신규)
  - 다크 모드/라이트 모드 토글 추가
  - 통계 페이지(`Stats.razor`) 신규 추가
  - 설정 페이지 확장

- **배포 최적화** (`index.html`, `app.css`)
  - 프로덕션 배포 설정

#### 🌞 오전 중반 (11:30 - 13:00)
- **모델 확장** (`Models.cs`)
  - 프로젝트 데이터 필드 추가 및 확장
  
- **스케줄/뜨케줄 개선** (`Schedule.razor`)
  - UI/UX 개선
  - 기능 확장 및 인터렉션 개선
  
- **프로젝트 상세 페이지 대폭 업그레이드** (`ProjectDetail.razor`)
  - 프로젝트 상세 정보 관리 기능 강화 (200+ 줄 추가)
  - 이미지 업로드 및 프로젝트 정보 편집 기능
  
- **도구 관리 페이지 개선** (`Tools.razor`)
  - 바늘/도구 관리 기능 확장 (150+ 줄 추가)
  - 상세 정보 입력 및 검색 기능

- **위시리스트 기능 추가** (`Wishlist.razor`)
  - 위시리스트 관리 기능 개선
  
- **저장소 서비스 확장** (`StorageService.cs`)
  - 데이터 저장/로드 로직 추가 및 개선

#### 🌆 오후 (13:00 - 14:00)
- **UI/CSS 최적화** (`app.css`)
  - 반응형 디자인 개선
  - 스타일 통일 및 가독성 향상
  
- **홈 페이지 UI 개선** (`Home.razor`)
  - 대시보드 레이아웃 조정

---

## �🔧 확장 아이디어

나중에 추가하면 좋을 기능들:

- [ ] 뜨케줄에서 사용한 실/바늘 연결 (실장고 데이터 참조)
- [ ] JSON 파일로 내보내기/가져오기 (백업)
- [ ] 게이지 기록 (샘플 뜨기 결과)
- [ ] 코 수 계산기
- [ ] 프로젝트별 타임라인

---

## 🐛 Blazor를 처음 쓰는 윈폼 개발자를 위한 팁

| 윈폼 | Blazor |
|------|--------|
| `Button.Click += ...` | `@onclick="메서드명"` |
| `TextBox.Text` | `@bind="변수명"` |
| `label.Text = "..."` | `@변수명` (그냥 쓰면 자동 렌더링) |
| `this.Invoke(...)` | `StateHasChanged()` (UI 새로고침) |
| `Form.ShowDialog()` | 조건부 렌더링 (`@if (_showModal) { ... }`) |
| `List<T>` 바인딩 | `@foreach (var item in list) { ... }` |
| `async Task` | 그대로 사용 가능! `await` 도 동일 |
