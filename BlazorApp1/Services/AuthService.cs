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
            _ref = DotNetObjectReference.Create(this);
            await _js.InvokeVoidAsync("firebaseAuth.onAuthStateChanged", _ref);
            IsInitialized = true;
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
