// =====================================================================
// AuthService.cs  —  Firebase Auth 상태 관리
// =====================================================================
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.JSInterop;

namespace KnitLog.Services
{
    public class UserInfo
    {
        [JsonPropertyName("uid")]
        public string Uid { get; set; } = "";
        [JsonPropertyName("displayName")]
        public string DisplayName { get; set; } = "";
        [JsonPropertyName("email")]
        public string Email { get; set; } = "";
        [JsonPropertyName("photoURL")]
        public string? PhotoURL { get; set; }
    }

    public class AuthService
    {
        private readonly IJSRuntime _js;
        private DotNetObjectReference<AuthService>? _ref;

        public UserInfo? CurrentUser { get; private set; }
        public bool IsLoggedIn => CurrentUser != null;
        public bool IsInitialized { get; private set; }

        public event Action? OnAuthChanged;

        public AuthService(IJSRuntime js) { _js = js; }

        public async Task InitAsync()
        {
            if (IsInitialized) return;
            // firebase.js(module)가 로드될 때까지 대기 (최대 5초)
            for (int i = 0; i < 50; i++)
            {
                try
                {
                    var exists = await _js.InvokeAsync<bool>("eval", "typeof firebaseAuth !== 'undefined'");
                    if (exists) break;
                }
                catch { }
                await Task.Delay(100);
            }
            // Firebase 세션 복원 완료까지 대기 후 현재 로그인 상태 로드
            try
            {
                var current = await _js.InvokeAsync<JsonElement?>("firebaseAuth.waitForAuthReady");
                if (current.HasValue && current.Value.ValueKind != JsonValueKind.Null)
                {
                    CurrentUser = JsonSerializer.Deserialize<UserInfo>(
                        current.Value.GetRawText(),
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                }
            }
            catch { }
            IsInitialized = true;
            OnAuthChanged?.Invoke();
            // 이후 상태 변경 감지 (로그인/로그아웃)
            try
            {
                _ref = DotNetObjectReference.Create(this);
                await _js.InvokeVoidAsync("firebaseAuth.onAuthStateChanged", _ref);
            }
            catch { }
        }

        [JSInvokable]
        public void OnAuthStateChanged(JsonElement? userInfo)
        {
            if (userInfo == null || userInfo.Value.ValueKind == JsonValueKind.Null)
                CurrentUser = null;
            else
                CurrentUser = JsonSerializer.Deserialize<UserInfo>(
                    userInfo.Value.GetRawText(),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            OnAuthChanged?.Invoke();
        }

        public async Task<bool> SignInWithGoogleAsync()
        {
            try
            {
                var result = await _js.InvokeAsync<JsonElement?>("firebaseAuth.signInWithGoogle");
                if (result == null || result.Value.ValueKind == JsonValueKind.Null) return false;
                // 팝업 완료 즉시 상태 반영 (onAuthStateChanged 콜백 대기 없이)
                CurrentUser = JsonSerializer.Deserialize<UserInfo>(
                    result.Value.GetRawText(),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                OnAuthChanged?.Invoke();
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("SignInWithGoogle error: " + ex.Message);
                return false;
            }
        }

        public async Task SignOutAsync()
        {
            await _js.InvokeAsync<bool>("firebaseAuth.signOut");
        }

        public void Dispose() => _ref?.Dispose();
    }
}