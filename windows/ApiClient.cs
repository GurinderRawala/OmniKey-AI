using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

namespace OmniKey.Windows
{
    internal enum EnhanceCommand { Enhance, Grammar, Task }

    internal sealed class TaskTemplateDto
    {
        public string Id { get; set; } = "";
        public string Heading { get; set; } = "";
        public string Instructions { get; set; } = "";
        public bool IsDefault { get; set; }
    }

    internal sealed class ApiClient
    {
        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(60) };

        // Read config once; both BaseUrl and IsSelfHosted are derived from this single call
        // so they are always consistent with each other.
        private static readonly string? _selfHostedPort = ReadSelfHostedPort();

        /// <summary>
        /// Base URL resolution order (mirrors macOS APIClient.swift):
        /// 1. ~/.omnikey/config.json OMNIKEY_PORT  →  http://localhost:{port}
        /// 2. OMNIKEY_BACKEND_URL environment variable
        /// 3. Fallback: http://localhost:7172
        /// </summary>
        public static readonly string BaseUrl = _selfHostedPort is { Length: > 0 } port
            ? $"http://localhost:{port}"
            : Environment.GetEnvironmentVariable("OMNIKEY_BACKEND_URL") is { Length: > 0 } env
                ? env
                : "http://localhost:7172";

        public static readonly bool IsSelfHosted = _selfHostedPort != null;

        /// Reads OMNIKEY_PORT from ~/.omnikey/config.json.
        /// Returns the port string when found, null otherwise.
        /// Mirrors macOS APIClient.selfHostedPort().
        private static string? ReadSelfHostedPort()
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

        private HttpRequestMessage BuildRequest(HttpMethod method, string path)
        {
            var req = new HttpRequestMessage(method, new Uri(BaseUrl + path));
            var token = SubscriptionManager.Instance.JwtToken;
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return req;
        }

        // ─── Enhance / Grammar / Custom-task ─────────────────────────

        public async Task<string> SendAsync(string text, EnhanceCommand command)
        {
            string path = command switch
            {
                EnhanceCommand.Enhance => "/api/feature/enhance",
                EnhanceCommand.Grammar => "/api/feature/grammar",
                EnhanceCommand.Task    => "/api/feature/custom-task",
                _                      => "/api/feature/enhance"
            };

            return await ExecuteWithReauthAsync(async () =>
            {
                using var req = BuildRequest(HttpMethod.Post, path);
                req.Headers.TryAddWithoutValidation("x-omnikey-stream", "true");
                req.Content = JsonContent.Create(new { text });

                using var resp = await Http.SendAsync(req);
                await EnsureSuccessAsync(resp);

                string body = await resp.Content.ReadAsStringAsync();
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.TryGetProperty("result", out var r) &&
                        r.ValueKind == JsonValueKind.String)
                        return ExtractImprovedText(r.GetString() ?? text);
                }
                catch { }

                return body.Length > 0 ? ExtractImprovedText(body) : text;
            });
        }

        // ─── Task Templates ───────────────────────────────────────────

        public async Task<List<TaskTemplateDto>> FetchTaskTemplatesAsync()
        {
            using var req = BuildRequest(HttpMethod.Get, "/api/instructions/templates");
            using var resp = await Http.SendAsync(req);
            await EnsureSuccessAsync(resp);

            string body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);

            var source = doc.RootElement.TryGetProperty("templates", out var arr)
                ? arr : doc.RootElement;

            var list = new List<TaskTemplateDto>();
            if (source.ValueKind == JsonValueKind.Array)
                foreach (var el in source.EnumerateArray())
                    list.Add(ParseTemplate(el));
            return list;
        }

        public async Task<TaskTemplateDto> CreateTaskTemplateAsync(string heading, string instructions)
        {
            using var req = BuildRequest(HttpMethod.Post, "/api/instructions/templates");
            req.Content = JsonContent.Create(new { heading, instructions });
            using var resp = await Http.SendAsync(req);
            await EnsureSuccessAsync(resp);
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            return ParseTemplate(doc.RootElement);
        }

        public async Task<TaskTemplateDto> UpdateTaskTemplateAsync(string id, string heading, string instructions)
        {
            using var req = BuildRequest(HttpMethod.Put, $"/api/instructions/templates/{id}");
            req.Content = JsonContent.Create(new { heading, instructions });
            using var resp = await Http.SendAsync(req);
            await EnsureSuccessAsync(resp);
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            return ParseTemplate(doc.RootElement);
        }

        public async Task DeleteTaskTemplateAsync(string id)
        {
            using var req = BuildRequest(HttpMethod.Delete, $"/api/instructions/templates/{id}");
            using var resp = await Http.SendAsync(req);
            if (resp.StatusCode != HttpStatusCode.NoContent)
                await EnsureSuccessAsync(resp);
        }

        public async Task<TaskTemplateDto> SetDefaultTaskTemplateAsync(string id)
        {
            using var req = BuildRequest(HttpMethod.Post, $"/api/instructions/templates/{id}/set-default");
            using var resp = await Http.SendAsync(req);
            await EnsureSuccessAsync(resp);
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            return ParseTemplate(doc.RootElement);
        }

        // ─── Helpers ──────────────────────────────────────────────────

        private static TaskTemplateDto ParseTemplate(JsonElement el) => new()
        {
            Id           = el.TryGetProperty("id", out var id)           ? id.GetString()  ?? "" : "",
            Heading      = el.TryGetProperty("heading", out var h)        ? h.GetString()   ?? "" : "",
            Instructions = el.TryGetProperty("instructions", out var ins) ? ins.GetString() ?? "" : "",
            IsDefault    = el.TryGetProperty("isDefault", out var def) && def.GetBoolean()
        };

        private static string ExtractImprovedText(string response)
        {
            string trimmed = response.Trim();
            int start = trimmed.IndexOf("<improved_text>", StringComparison.Ordinal);
            if (start < 0) return trimmed;
            start += "<improved_text>".Length;
            int end = trimmed.IndexOf("</improved_text>", start, StringComparison.Ordinal);
            if (end < 0) return trimmed;
            return trimmed[start..end].Trim();
        }

        private static async Task EnsureSuccessAsync(HttpResponseMessage resp)
        {
            if (resp.IsSuccessStatusCode) return;
            string body = await resp.Content.ReadAsStringAsync();
            throw new ApiException((int)resp.StatusCode, ExtractError(body, (int)resp.StatusCode));
        }

        private static string ExtractError(string body, int code)
        {
            if (!string.IsNullOrWhiteSpace(body))
            {
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    foreach (var key in new[] { "message", "error", "detail" })
                        if (doc.RootElement.TryGetProperty(key, out var v) &&
                            v.ValueKind == JsonValueKind.String)
                            return v.GetString()!;
                }
                catch { }
                if (body.Length < 200) return body.Trim();
            }
            return $"Server returned {code}";
        }

        private async Task<string> ExecuteWithReauthAsync(Func<Task<string>> action)
        {
            try
            {
                return await action();
            }
            catch (ApiException ex) when (ex.StatusCode == 401 || ex.StatusCode == 403)
            {
                bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (ok) return await action();
                throw;
            }
        }
    }

    internal sealed class ApiException : Exception
    {
        public int StatusCode { get; }
        public ApiException(int code, string msg) : base(msg) => StatusCode = code;
    }
}
