using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    /// <summary>
    /// Session metadata returned by <c>GET /api/agent/sessions</c>.
    /// Mirrors macOS <c>AgentSessionInfo</c>; <see cref="GroupName"/> and
    /// <see cref="GroupDescription"/> were added in v1.1.0 to support
    /// grouping sessions by project name in the picker / sidebar.
    /// </summary>
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

        /// <summary>Project group this session belongs to (nullable — older
        /// sessions may not be classified yet).</summary>
        public string? GroupName { get; set; }

        /// <summary>Human-readable description of the project group. Used
        /// as the tooltip on group filter pills.</summary>
        public string? GroupDescription { get; set; }
    }

    /// <summary>
    /// Distinct project group returned by <c>GET /api/agent/groups</c>.
    /// Mirrors macOS <c>AgentGroupInfo</c>.
    /// </summary>
    internal sealed class AgentGroupInfo
    {
        public string GroupName { get; set; } = "";
        public string? GroupDescription { get; set; }
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

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
        };

        internal static async Task<List<AgentSessionInfo>> FetchSessionsAsync()
        {
            var token = await EnsureTokenAsync();
            if (token is null) return new List<AgentSessionInfo>();

            try
            {
                string? json = await GetJsonWithReauthAsync("/api/agent/sessions", token);
                if (json is null) return new List<AgentSessionInfo>();
                return JsonSerializer.Deserialize<List<AgentSessionInfo>>(json, JsonOptions)
                       ?? new List<AgentSessionInfo>();
            }
            catch
            {
                return new List<AgentSessionInfo>();
            }
        }

        /// <summary>
        /// Fetches distinct project groups for the current subscription.
        /// Mirrors macOS <c>fetchGroups()</c>. Returns an empty list on
        /// any failure — callers can keep their cached state.
        /// </summary>
        internal static async Task<List<AgentGroupInfo>> FetchGroupsAsync()
        {
            var token = await EnsureTokenAsync();
            if (token is null) return new List<AgentGroupInfo>();

            try
            {
                string? json = await GetJsonWithReauthAsync("/api/agent/groups", token);
                if (json is null) return new List<AgentGroupInfo>();

                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                    doc.RootElement.TryGetProperty("groups", out var groups) &&
                    groups.ValueKind == JsonValueKind.Array)
                {
                    return JsonSerializer.Deserialize<List<AgentGroupInfo>>(
                               groups.GetRawText(), JsonOptions)
                           ?? new List<AgentGroupInfo>();
                }

                // Some self-hosted backends just return an array.
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    return JsonSerializer.Deserialize<List<AgentGroupInfo>>(json, JsonOptions)
                           ?? new List<AgentGroupInfo>();
                }
            }
            catch
            {
            }

            return new List<AgentGroupInfo>();
        }

        // ─── helpers ───────────────────────────────────────────────────

        private static async Task<string?> EnsureTokenAsync()
        {
            var token = SubscriptionManager.Instance.JwtToken;
            if (!string.IsNullOrWhiteSpace(token)) return token;

            bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
            if (!ok) return null;

            token = SubscriptionManager.Instance.JwtToken;
            return string.IsNullOrWhiteSpace(token) ? null : token;
        }

        /// <summary>
        /// Sends an authenticated GET; on 401/403 reactivates the stored
        /// key once and retries. Returns the response body as a string
        /// on success, or null on any failure.
        /// </summary>
        private static async Task<string?> GetJsonWithReauthAsync(string path, string token)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, ApiClient.BaseUrl + path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var resp = await Http.SendAsync(req);
            if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
            {
                bool reactivated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!reactivated) return null;

                string? refreshedToken = SubscriptionManager.Instance.JwtToken;
                if (string.IsNullOrWhiteSpace(refreshedToken)) return null;

                using var retryReq = new HttpRequestMessage(HttpMethod.Get, ApiClient.BaseUrl + path);
                retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", refreshedToken);
                using var retryResp = await Http.SendAsync(retryReq);
                if (!retryResp.IsSuccessStatusCode) return null;
                return await retryResp.Content.ReadAsStringAsync();
            }

            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadAsStringAsync();
        }
    }
}
