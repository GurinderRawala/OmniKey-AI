using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OmniKey.Windows.Skills
{
    internal enum SkillsErrorKind
    {
        /// <summary>The collection endpoint returned 404: the backend predates Skills.</summary>
        UpgradeRequired,
        NotFound,
        Validation,
        KeywordConflict,
        RevisionConflict,
        RevisionRequired,
        QuotaExceeded,
        LimitExceeded,
        Unauthenticated,
        StoreUnavailable,
        Server,
        Network,
        Cancelled,
        InvalidResponse,
    }

    /// <summary>
    /// Safe, user-presentable Skills failure. Messages are fixed client text
    /// keyed on HTTP status + structured <c>error.code</c> (never on server
    /// wording), except validation where the server's short message and
    /// per-field messages are shown. Never carries instruction text or tokens.
    /// </summary>
    internal sealed class SkillsApiException : Exception
    {
        public SkillsErrorKind Kind { get; }
        public int? Status { get; }
        public string? Code { get; }
        public IReadOnlyDictionary<string, string> Fields { get; }

        public SkillsApiException(
            SkillsErrorKind kind,
            string message,
            int? status = null,
            string? code = null,
            IReadOnlyDictionary<string, string>? fields = null)
            : base(message)
        {
            Kind = kind;
            Status = status;
            Code = code;
            Fields = fields ?? new Dictionary<string, string>();
        }

        public const string UpgradeMessage =
            "This OmniKey backend does not support Skills yet. Update the OmniKey CLI/daemon (or hosted backend) and try again.";
        public const string NetworkMessage =
            "Couldn't reach the OmniKey backend. Check that it is running, then retry.";
        public const string CancelledMessage = "Request cancelled.";

        public static SkillsApiException From(Exception error) => error switch
        {
            SkillsApiException api => api,
            OperationCanceledException => new SkillsApiException(SkillsErrorKind.Cancelled, CancelledMessage),
            _ => new SkillsApiException(SkillsErrorKind.Network, NetworkMessage),
        };
    }

    /// <summary>Operations the Skills page needs. Abstracted so view-model
    /// tests can drive responses deterministically without a network.</summary>
    internal interface ISkillsService
    {
        Task<IReadOnlyList<SkillSummary>> ListAsync(CancellationToken ct = default);
        Task<SkillDto> GetAsync(string id, CancellationToken ct = default);
        Task<SkillDto> CreateAsync(SkillDraft draft, CancellationToken ct = default);
        Task<SkillDto> UpdateAsync(string id, int revision, SkillPatch patch, CancellationToken ct = default);
        Task DeleteAsync(string id, int revision, CancellationToken ct = default);
    }

    /// <summary>
    /// Authenticated <c>/api/skills</c> client using the app's backend
    /// selection and identity. Auth mirrors <c>ApiClient.ExecuteWithReauthAsync</c>:
    /// a 401/403 triggers one stored-key re-activation and a single retry; a
    /// second auth failure invalidates the token. Never logs bodies or tokens.
    /// </summary>
    internal sealed class SkillsHttpService : ISkillsService
    {
        internal enum Endpoint { Collection, Create, Item }

        private readonly HttpMessageInvoker _http;
        private readonly Func<string> _baseUrl;
        private readonly Func<string?> _token;
        private readonly Func<Task<bool>> _reauthenticate;
        private readonly Action _onFinalUnauthorized;
        private readonly TimeSpan _timeout;

        public SkillsHttpService(
            HttpMessageInvoker http,
            Func<string> baseUrl,
            Func<string?> token,
            Func<Task<bool>> reauthenticate,
            Action onFinalUnauthorized,
            TimeSpan? timeout = null)
        {
            _http = http;
            _baseUrl = baseUrl;
            _token = token;
            _reauthenticate = reauthenticate;
            _onFinalUnauthorized = onFinalUnauthorized;
            _timeout = timeout ?? TimeSpan.FromSeconds(30);
        }

        // ─── Endpoints ─────────────────────────────────────────────────

        public async Task<IReadOnlyList<SkillSummary>> ListAsync(CancellationToken ct = default)
        {
            string body = await SendAsync(HttpMethod.Get, null, null, null, Endpoint.Collection, ct);
            return Parse(body, root =>
            {
                var list = new List<SkillSummary>();
                foreach (var el in RequireArray(root, "skills"))
                    list.Add(ParseSummary(el));
                return (IReadOnlyList<SkillSummary>)list;
            });
        }

        public async Task<SkillDto> GetAsync(string id, CancellationToken ct = default)
        {
            string body = await SendAsync(HttpMethod.Get, id, null, null, Endpoint.Item, ct);
            return Parse(body, root => ParseSkill(RequireObject(root, "skill")));
        }

        public async Task<SkillDto> CreateAsync(SkillDraft draft, CancellationToken ct = default)
        {
            var payload = new Dictionary<string, object>
            {
                ["name"] = draft.Name,
                ["keyword"] = draft.Keyword,
                ["instructions"] = draft.Instructions,
                ["enabled"] = draft.Enabled,
            };
            string body = await SendAsync(HttpMethod.Post, null, payload, null, Endpoint.Create, ct);
            return Parse(body, root => ParseSkill(RequireObject(root, "skill")));
        }

        public async Task<SkillDto> UpdateAsync(string id, int revision, SkillPatch patch, CancellationToken ct = default)
        {
            string body = await SendAsync(HttpMethod.Patch, id, patch.ToJsonObject(), revision, Endpoint.Item, ct);
            return Parse(body, root => ParseSkill(RequireObject(root, "skill")));
        }

        public async Task DeleteAsync(string id, int revision, CancellationToken ct = default)
        {
            await SendAsync(HttpMethod.Delete, id, null, revision, Endpoint.Item, ct);
        }

        // ─── Transport ─────────────────────────────────────────────────

        internal static string IfMatch(int revision) => "\"" + revision.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";

        internal Uri MakeUri(string? id)
        {
            string url = (_baseUrl() ?? "").TrimEnd('/') + "/api/skills";
            if (id is not null) url += "/" + Uri.EscapeDataString(id);
            return new Uri(url);
        }

        private HttpRequestMessage Build(HttpMethod method, string? id, Dictionary<string, object>? payload, int? revision)
        {
            var req = new HttpRequestMessage(method, MakeUri(id));
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            string? token = _token();
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (revision is int rev)
                req.Headers.TryAddWithoutValidation("If-Match", IfMatch(rev));
            if (payload is not null)
                req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            return req;
        }

        private async Task<string> SendAsync(
            HttpMethod method,
            string? id,
            Dictionary<string, object>? payload,
            int? revision,
            Endpoint endpoint,
            CancellationToken ct)
        {
            var (status, body) = await PerformAsync(method, id, payload, revision, ct);
            if (status == 401 || status == 403)
            {
                bool retry;
                try { retry = await _reauthenticate(); }
                catch { retry = false; }
                if (!retry) throw Unauthenticated(status);

                (status, body) = await PerformAsync(method, id, payload, revision, ct);
                if (status == 401 || status == 403)
                {
                    _onFinalUnauthorized();
                    throw Unauthenticated(status);
                }
            }

            if (status < 200 || status > 299)
                throw MapError(status, body, endpoint);
            return body;
        }

        private async Task<(int status, string body)> PerformAsync(
            HttpMethod method,
            string? id,
            Dictionary<string, object>? payload,
            int? revision,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(_timeout);
            using var req = Build(method, id, payload, revision);
            try
            {
                using var resp = await _http.SendAsync(req, timeout.Token);
                string body = await resp.Content.ReadAsStringAsync(timeout.Token);
                return ((int)resp.StatusCode, body);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw new SkillsApiException(SkillsErrorKind.Cancelled, SkillsApiException.CancelledMessage);
            }
            catch (Exception)
            {
                // Timeouts and transport failures. Never surface raw exception
                // text (it can include URLs or proxy details).
                throw new SkillsApiException(SkillsErrorKind.Network, SkillsApiException.NetworkMessage);
            }
        }

        private static SkillsApiException Unauthenticated(int status) => new(
            SkillsErrorKind.Unauthenticated,
            "Your OmniKey session is not authorized. Re-activate your subscription and retry.",
            status);

        /// <summary>Map an HTTP failure by status and structured
        /// <c>error.code</c>, never by message wording. Legacy string/HTML
        /// bodies are tolerated.</summary>
        internal static SkillsApiException MapError(int status, string? body, Endpoint endpoint)
        {
            string? code = null;
            string? serverMessage = null;
            var fields = new Dictionary<string, string>();
            if (!string.IsNullOrWhiteSpace(body))
            {
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                        doc.RootElement.TryGetProperty("error", out var err) &&
                        err.ValueKind == JsonValueKind.Object)
                    {
                        code = StringOrNull(err, "code");
                        serverMessage = StringOrNull(err, "message");
                        if (err.TryGetProperty("fields", out var f) && f.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var p in f.EnumerateObject())
                                if (p.Value.ValueKind == JsonValueKind.String)
                                    fields[p.Name] = p.Value.GetString() ?? "";
                        }
                    }
                }
                catch
                {
                    // Not JSON (e.g. an old backend's HTML 404). Status decides.
                }
            }

            switch (status)
            {
                case 404 when endpoint != Endpoint.Item:
                    return new(SkillsErrorKind.UpgradeRequired, SkillsApiException.UpgradeMessage, status, code);
                case 404:
                    return new(SkillsErrorKind.NotFound,
                        "This skill no longer exists. It may have been deleted elsewhere.", status, code);
                case 400:
                    return new(SkillsErrorKind.Validation,
                        string.IsNullOrWhiteSpace(serverMessage) ? "Some fields are invalid." : serverMessage!,
                        status, code, fields);
                case 409 when code == "KEYWORD_CONFLICT":
                    if (!fields.ContainsKey("keyword"))
                        fields["keyword"] = "Another skill already uses this keyword (including disabled skills).";
                    return new(SkillsErrorKind.KeywordConflict,
                        "Another skill already uses this keyword.", status, code, fields);
                case 409 when code == "SKILL_QUOTA_EXCEEDED":
                    return new(SkillsErrorKind.QuotaExceeded,
                        $"You already have the maximum of {SkillLimits.Saved} skills. Delete one before adding another.",
                        status, code);
                case 409:
                    return new(SkillsErrorKind.RevisionConflict,
                        "This skill changed elsewhere. Reload the latest version before saving again.", status, code);
                case 413:
                    return new(SkillsErrorKind.LimitExceeded,
                        "The request is too large. Shorten the instructions and try again.", status, code);
                case 428:
                    return new(SkillsErrorKind.RevisionRequired,
                        "The backend requires the current revision. Reload and try again.", status, code);
                case 503:
                    return new(SkillsErrorKind.StoreUnavailable,
                        "Skills are temporarily unavailable. Please retry.", status, code);
                default:
                    return new(SkillsErrorKind.Server,
                        $"The backend could not complete the Skills request (status {status}).", status, code);
            }
        }

        // ─── Parsing (strict; any shape error is InvalidResponse) ───────

        private static T Parse<T>(string body, Func<JsonElement, T> read)
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                return read(doc.RootElement);
            }
            catch (Exception)
            {
                throw new SkillsApiException(SkillsErrorKind.InvalidResponse,
                    "The backend returned an unexpected Skills response.");
            }
        }

        private static JsonElement.ArrayEnumerator RequireArray(JsonElement root, string name)
        {
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array)
                throw new FormatException(name);
            return arr.EnumerateArray();
        }

        private static JsonElement RequireObject(JsonElement root, string name)
        {
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty(name, out var obj) || obj.ValueKind != JsonValueKind.Object)
                throw new FormatException(name);
            return obj;
        }

        internal static SkillSummary ParseSummary(JsonElement el) => new(
            RequireId(el),
            RequireString(el, "name"),
            RequireString(el, "keyword"),
            RequireBool(el, "enabled"),
            RequireRevision(el),
            StringOrNull(el, "createdAt"),
            StringOrNull(el, "updatedAt"));

        internal static SkillDto ParseSkill(JsonElement el) => new(
            RequireId(el),
            RequireString(el, "name"),
            RequireString(el, "keyword"),
            RequireString(el, "instructions"),
            RequireBool(el, "enabled"),
            RequireRevision(el),
            StringOrNull(el, "createdAt"),
            StringOrNull(el, "updatedAt"));

        private static string RequireId(JsonElement el)
        {
            string id = RequireString(el, "id");
            if (id.Length == 0) throw new FormatException("id");
            return id;
        }

        private static string RequireString(JsonElement el, string name)
        {
            if (el.ValueKind != JsonValueKind.Object ||
                !el.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String)
                throw new FormatException(name);
            return v.GetString() ?? throw new FormatException(name);
        }

        private static bool RequireBool(JsonElement el, string name)
        {
            if (!el.TryGetProperty(name, out var v)) throw new FormatException(name);
            return v.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => throw new FormatException(name),
            };
        }

        private static int RequireRevision(JsonElement el)
        {
            if (!el.TryGetProperty("revision", out var v) ||
                v.ValueKind != JsonValueKind.Number ||
                !v.TryGetInt32(out int rev) || rev < 1)
                throw new FormatException("revision");
            return rev;
        }

        private static string? StringOrNull(JsonElement el, string name) =>
            el.ValueKind == JsonValueKind.Object &&
            el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString()
                : null;
    }
}
