using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    internal sealed class AgentSessionInfo
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string Platform { get; set; } = "";
        public int Turns { get; set; }
        public int TotalTokensUsed { get; set; }
        public int RemainingContextTokens { get; set; }
        public int ContextBudget { get; set; }
        public string? LastActiveAt { get; set; }
    }

    internal sealed class AgentSessionSelection
    {
        public string? SessionId { get; init; }
        public string SessionTitle { get; init; } = "New Session";
    }

    internal static class AgentSessionPreferences
    {
        public const string NewSessionSentinel = "__new_session__";

        private const string RegSubKey = @"SOFTWARE\OmniKeyAI";
        private const string RegValueName = "AgentDefaultSessionId";

        public static string? ReadDefaultSessionId()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RegSubKey);
                string? value = key?.GetValue(RegValueName) as string;
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
            catch
            {
                return null;
            }
        }

        public static void WriteDefaultSessionId(string? value)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegSubKey);
                key.SetValue(RegValueName, value ?? "");
            }
            catch
            {
            }
        }

        public static void ClearDefaultSessionId() => WriteDefaultSessionId(null);
    }

    internal static class AgentSessionService
    {
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

        internal static async Task<List<AgentSessionInfo>> FetchSessionsAsync()
        {
            var token = SubscriptionManager.Instance.JwtToken;
            if (string.IsNullOrWhiteSpace(token))
            {
                bool activated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!activated)
                    return new List<AgentSessionInfo>();

                token = SubscriptionManager.Instance.JwtToken;
                if (string.IsNullOrWhiteSpace(token))
                    return new List<AgentSessionInfo>();
            }

            using var req = new HttpRequestMessage(HttpMethod.Get, ApiClient.BaseUrl + "/api/agent/sessions");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            try
            {
                using var resp = await Http.SendAsync(req);
                if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                    resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    bool reactivated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                    if (!reactivated)
                        return new List<AgentSessionInfo>();

                    string? refreshedToken = SubscriptionManager.Instance.JwtToken;
                    if (string.IsNullOrWhiteSpace(refreshedToken))
                        return new List<AgentSessionInfo>();

                    using var retryReq = new HttpRequestMessage(HttpMethod.Get, ApiClient.BaseUrl + "/api/agent/sessions");
                    retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", refreshedToken);
                    using var retryResp = await Http.SendAsync(retryReq);
                    if (!retryResp.IsSuccessStatusCode)
                        return new List<AgentSessionInfo>();

                    string retryJson = await retryResp.Content.ReadAsStringAsync();
                    var retryOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                    return JsonSerializer.Deserialize<List<AgentSessionInfo>>(retryJson, retryOptions) ?? new List<AgentSessionInfo>();
                }

                if (!resp.IsSuccessStatusCode)
                    return new List<AgentSessionInfo>();

                string json = await resp.Content.ReadAsStringAsync();
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                return JsonSerializer.Deserialize<List<AgentSessionInfo>>(json, options) ?? new List<AgentSessionInfo>();
            }
            catch
            {
                return new List<AgentSessionInfo>();
            }
        }
    }
}
