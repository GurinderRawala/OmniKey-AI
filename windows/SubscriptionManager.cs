using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    internal sealed class SubscriptionManager
    {
        public static readonly SubscriptionManager Instance = new();

        private const string RegSubKey = @"SOFTWARE\OmniKeyAI";
        private const string RegValueName = "SubscriptionKey";

        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

        public string? UserKey { get; private set; }
        public string? JwtToken { get; private set; }
        public bool HasStoredKey => !string.IsNullOrWhiteSpace(UserKey);

        private SubscriptionManager()
        {
            UserKey = ReadFromRegistry();
        }

        /// Returns the OMNIKEY_PORT from ~/.omnikey/config.json, or null if not found.
        public static string? SelfHostedPort()
        {
            try
            {
                string path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".omnikey", "config.json");

                if (!File.Exists(path)) return null;

                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                var root = doc.RootElement;

                if (root.TryGetProperty("OMNIKEY_PORT", out var portEl))
                {
                    if (portEl.ValueKind == JsonValueKind.String) return portEl.GetString();
                    if (portEl.ValueKind == JsonValueKind.Number) return portEl.GetInt32().ToString();
                }
            }
            catch { }

            return null;
        }

        public async Task<bool> ActivateStoredKeyAsync()
        {
            if (string.IsNullOrWhiteSpace(UserKey)) return false;
            var (ok, token, _) = await ActivateCoreAsync(UserKey);
            JwtToken = ok ? token : null;
            return ok;
        }

        public async Task<(bool success, string? error)> UpdateUserKeyAsync(string newKey)
        {
            string trimmed = newKey.Trim();
            if (string.IsNullOrWhiteSpace(trimmed)) return (false, "Key cannot be empty.");

            var (ok, token, error) = await ActivateCoreAsync(trimmed);
            if (ok)
            {
                UserKey = trimmed;
                JwtToken = token;
                WriteToRegistry(trimmed);
            }
            return (ok, error);
        }

        public async Task<bool> ReactivateStoredKeyIfNeededAsync()
        {
            if (string.IsNullOrWhiteSpace(UserKey)) return false;
            var (ok, token, _) = await ActivateCoreAsync(UserKey);
            JwtToken = ok ? token : null;
            return ok;
        }

        public void InvalidateToken() => JwtToken = null;

        public void ClearSubscription()
        {
            UserKey = null;
            JwtToken = null;
            DeleteFromRegistry();
        }

        private async Task<(bool ok, string? token, string? error)> ActivateCoreAsync(string key)
        {
            try
            {
                string url = ApiClient.BaseUrl + "/api/subscription/activate";
                using var response = await Http.PostAsJsonAsync(url, new { key });
                string json = await response.Content.ReadAsStringAsync();

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (response.IsSuccessStatusCode &&
                    root.TryGetProperty("token", out var tokEl) &&
                    tokEl.GetString() is string tok)
                {
                    return (true, tok, null);
                }

                string? errMsg = null;
                if (root.TryGetProperty("error", out var errEl)) errMsg = errEl.GetString();
                else if (root.TryGetProperty("message", out var msgEl)) errMsg = msgEl.GetString();

                return (false, null, errMsg ?? $"Server returned {(int)response.StatusCode}");
            }
            catch (Exception ex)
            {
                return (false, null, ex.Message);
            }
        }

        private static string? ReadFromRegistry()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RegSubKey);
                return key?.GetValue(RegValueName) as string;
            }
            catch { return null; }
        }

        private static void WriteToRegistry(string value)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegSubKey);
                key.SetValue(RegValueName, value);
            }
            catch { }
        }

        private static void DeleteFromRegistry()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(RegSubKey, false); }
            catch { }
        }
    }
}
