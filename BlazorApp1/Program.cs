// =====================================================================
// Program.cs  —  Blazor WASM 진입점
// =====================================================================
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using KnitLog;
using KnitLog.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

// 서비스 등록
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<StorageService>();

var host = builder.Build();

// StorageService에 AuthService 주입 (순환 의존 방지)
var storage = host.Services.GetRequiredService<StorageService>();
var auth    = host.Services.GetRequiredService<AuthService>();
storage.SetAuthService(auth);

await host.RunAsync();
