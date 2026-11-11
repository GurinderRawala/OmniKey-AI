using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>Records requests (method, URL, headers, body) and replies
    /// from a script. Per-instance state only, so tests can run in parallel.</summary>
    internal sealed class StubHandler : HttpMessageHandler
    {
        internal sealed record Recorded(HttpMethod Method, Uri Uri, string? Authorization, string? IfMatch, string? Accept, string? Body, string? ContentType);

        private readonly Queue<Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>> _script = new();
        public List<Recorded> Requests { get; } = new();

        public StubHandler Reply(HttpStatusCode status, string? body = null, string contentType = "application/json")
        {
            _script.Enqueue((_, _) => Task.FromResult(Response(status, body, contentType)));
            return this;
        }

        public StubHandler Throw(Exception ex)
        {
            _script.Enqueue((_, _) => Task.FromException<HttpResponseMessage>(ex));
            return this;
        }

        public StubHandler Hang()
        {
            _script.Enqueue(async (_, ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("unreachable");
            });
            return this;
        }

        private static HttpResponseMessage Response(HttpStatusCode status, string? body, string contentType)
        {
            var resp = new HttpResponseMessage(status);
            resp.Content = new StringContent(body ?? "", Encoding.UTF8, contentType);
            return resp;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string? body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Requests.Add(new Recorded(
                request.Method,
                request.RequestUri!,
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("If-Match", out var im) ? string.Join(",", im) : null,
                request.Headers.Accept.ToString(),
                body,
                request.Content?.Headers.ContentType?.MediaType));
            if (_script.Count == 0) throw new InvalidOperationException("No scripted response left.");
            return await _script.Dequeue()(request, ct);
        }
    }

    internal sealed class ServiceHarness
    {
        public StubHandler Handler { get; } = new();
        public string? Token { get; set; } = "jwt-1";
        public int ReauthCalls { get; private set; }
        public bool ReauthResult { get; set; } = true;
        public string? TokenAfterReauth { get; set; } = "jwt-2";
        public int FinalUnauthorizedCalls { get; private set; }

        public SkillsHttpService Create(TimeSpan? timeout = null) => new(
            new HttpMessageInvoker(Handler),
            baseUrl: () => "http://localhost:7071/",
            token: () => Token,
            reauthenticate: () =>
            {
                ReauthCalls++;
                if (ReauthResult) Token = TokenAfterReauth;
                return Task.FromResult(ReauthResult);
            },
            onFinalUnauthorized: () => { FinalUnauthorizedCalls++; Token = null; },
            timeout: timeout);
    }

    public class SkillsServiceTests
    {
        // Contract fixture (docs/skills-contract.md "Concrete API and event fixtures").
        private const string SkillJson =
            "{\"id\":\"cskill1\",\"name\":\"Review\",\"keyword\":\"code review\",\"instructions\":\"Check edge cases.\",\"enabled\":true,\"revision\":1,\"createdAt\":\"2026-11-11T00:00:00.000Z\",\"updatedAt\":\"2026-11-11T00:00:00.000Z\"}";
        private static readonly string ItemEnvelope = "{\"skill\":" + SkillJson + "}";

        [Fact]
        public async Task ListParsesSummariesWithAuthAndAcceptHeaders()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.OK,
                "{\"skills\":[{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"alpha\",\"enabled\":false,\"revision\":3,\"createdAt\":\"x\",\"updatedAt\":\"y\"},{\"id\":\"b\",\"name\":\"B\",\"keyword\":\"beta\",\"enabled\":true,\"revision\":1}]}");

            var list = await h.Create().ListAsync();

            Assert.Equal(2, list.Count);
            Assert.Equal(new SkillSummary("a", "A", "alpha", false, 3, "x", "y"), list[0]);
            Assert.Equal(new SkillSummary("b", "B", "beta", true, 1), list[1]);
            var req = Assert.Single(h.Handler.Requests);
            Assert.Equal(HttpMethod.Get, req.Method);
            Assert.Equal("http://localhost:7071/api/skills", req.Uri.ToString());
            Assert.Equal("Bearer jwt-1", req.Authorization);
            Assert.Contains("application/json", req.Accept);
            Assert.Null(req.IfMatch);
        }

        [Fact]
        public async Task CreatePostsExactFieldsAndParsesCreatedSkill()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.Created, ItemEnvelope);

            var skill = await h.Create().CreateAsync(new SkillDraft("Review", "code review", "Check edge cases.", true));

            Assert.Equal("cskill1", skill.Id);
            Assert.Equal("Check edge cases.", skill.Instructions);
            Assert.Equal(1, skill.Revision);
            var req = Assert.Single(h.Handler.Requests);
            Assert.Equal(HttpMethod.Post, req.Method);
            Assert.Equal("application/json", req.ContentType);
            Assert.Null(req.IfMatch);
            using var body = JsonDocument.Parse(req.Body!);
            Assert.Equal(new[] { "name", "keyword", "instructions", "enabled" },
                body.RootElement.EnumerateObject().Select(p => p.Name).ToArray());
            Assert.Equal("Review", body.RootElement.GetProperty("name").GetString());
            Assert.True(body.RootElement.GetProperty("enabled").GetBoolean());
        }

        [Fact]
        public async Task UpdateSendsQuotedIfMatchAndOnlyChangedFields()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.OK, ItemEnvelope.Replace("\"revision\":1", "\"revision\":2").Replace("\"enabled\":true", "\"enabled\":false"));

            var skill = await h.Create().UpdateAsync("id/with space", 1, new SkillPatch(Enabled: false));

            Assert.False(skill.Enabled);
            Assert.Equal(2, skill.Revision);
            var req = Assert.Single(h.Handler.Requests);
            Assert.Equal(HttpMethod.Patch, req.Method);
            Assert.Equal("\"1\"", req.IfMatch);
            Assert.Equal("/api/skills/id%2Fwith%20space", req.Uri.AbsolutePath);
            Assert.Equal("{\"enabled\":false}", req.Body);
        }

        [Fact]
        public async Task DeleteSendsIfMatchAndAccepts204()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.NoContent);

            await h.Create().DeleteAsync("cskill1", 7);

            var req = Assert.Single(h.Handler.Requests);
            Assert.Equal(HttpMethod.Delete, req.Method);
            Assert.Equal("\"7\"", req.IfMatch);
            Assert.Null(req.Body);
        }

        [Fact]
        public async Task UnauthorizedReauthenticatesOnceAndRetriesWithNewToken()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.Unauthorized, "{\"error\":\"Unauthorized\"}")
                     .Reply(HttpStatusCode.OK, "{\"skills\":[]}");

            var list = await h.Create().ListAsync();

            Assert.Empty(list);
            Assert.Equal(1, h.ReauthCalls);
            Assert.Equal(0, h.FinalUnauthorizedCalls);
            Assert.Equal(new[] { "Bearer jwt-1", "Bearer jwt-2" }, h.Handler.Requests.Select(r => r.Authorization).ToArray());
        }

        [Fact]
        public async Task SecondAuthFailureInvalidatesTokenWithoutLooping()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.Forbidden, "Forbidden", "text/plain")
                     .Reply(HttpStatusCode.Forbidden, "{\"error\":{\"code\":\"FORBIDDEN\",\"message\":\"no\"}}");

            var ex = await Assert.ThrowsAsync<SkillsApiException>(() => h.Create().GetAsync("x"));

            Assert.Equal(SkillsErrorKind.Unauthenticated, ex.Kind);
            Assert.Equal(1, h.ReauthCalls);
            Assert.Equal(1, h.FinalUnauthorizedCalls);
            Assert.Equal(2, h.Handler.Requests.Count);
        }

        [Fact]
        public async Task FailedReauthenticationDoesNotRetry()
        {
            var h = new ServiceHarness { ReauthResult = false };
            h.Handler.Reply(HttpStatusCode.Unauthorized, "{\"error\":\"expired\"}");

            var ex = await Assert.ThrowsAsync<SkillsApiException>(() => h.Create().ListAsync());

            Assert.Equal(SkillsErrorKind.Unauthenticated, ex.Kind);
            Assert.Single(h.Handler.Requests);
            Assert.Equal(0, h.FinalUnauthorizedCalls);
        }

        [Fact]
        public async Task MissingTokenSendsNoAuthorizationHeader()
        {
            var h = new ServiceHarness { Token = null };
            h.Handler.Reply(HttpStatusCode.OK, "{\"skills\":[]}");
            await h.Create().ListAsync();
            Assert.Null(Assert.Single(h.Handler.Requests).Authorization);
        }

        [Fact]
        public async Task OldBackendListAndCreate404AreUpgradeRequiredButItem404IsNotFound()
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.NotFound, "<!DOCTYPE html><pre>Cannot GET /api/skills</pre>", "text/html")
                     .Reply(HttpStatusCode.NotFound, "<html></html>", "text/html")
                     .Reply(HttpStatusCode.NotFound, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"Skill not found.\"}}");
            var svc = h.Create();

            var list = await Assert.ThrowsAsync<SkillsApiException>(() => svc.ListAsync());
            var create = await Assert.ThrowsAsync<SkillsApiException>(() => svc.CreateAsync(new SkillDraft("a", "b", "c")));
            var item = await Assert.ThrowsAsync<SkillsApiException>(() => svc.GetAsync("gone"));

            Assert.Equal(SkillsErrorKind.UpgradeRequired, list.Kind);
            Assert.Equal(SkillsApiException.UpgradeMessage, list.Message);
            Assert.Equal(SkillsErrorKind.UpgradeRequired, create.Kind);
            Assert.Equal(SkillsErrorKind.NotFound, item.Kind);
        }

        [Theory]
        [InlineData(409, "{\"error\":{\"code\":\"REVISION_CONFLICT\",\"message\":\"Skill changed. Reload before retrying.\"}}", nameof(SkillsErrorKind.RevisionConflict))]
        [InlineData(409, "{\"error\":{\"code\":\"KEYWORD_CONFLICT\",\"message\":\"x\"}}", nameof(SkillsErrorKind.KeywordConflict))]
        [InlineData(409, "{\"error\":{\"code\":\"SKILL_QUOTA_EXCEEDED\",\"message\":\"x\"}}", nameof(SkillsErrorKind.QuotaExceeded))]
        [InlineData(428, "{\"error\":{\"code\":\"REVISION_REQUIRED\",\"message\":\"A revision is required.\"}}", nameof(SkillsErrorKind.RevisionRequired))]
        [InlineData(413, "{\"error\":{\"code\":\"INPUT_LIMIT_EXCEEDED\",\"message\":\"x\"}}", nameof(SkillsErrorKind.LimitExceeded))]
        [InlineData(503, "{\"error\":{\"code\":\"STORE_UNAVAILABLE\",\"message\":\"x\"}}", nameof(SkillsErrorKind.StoreUnavailable))]
        [InlineData(500, "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"x\"}}", nameof(SkillsErrorKind.Server))]
        [InlineData(502, "Bad gateway", nameof(SkillsErrorKind.Server))]
        public void ErrorsMapByStatusAndCode(int status, string body, string expected)
        {
            var ex = SkillsHttpService.MapError(status, body, SkillsHttpService.Endpoint.Item);
            Assert.Equal(expected, ex.Kind.ToString());
            Assert.Equal(status, ex.Status);
        }

        [Fact]
        public void NonValidationErrorsNeverEchoServerWording()
        {
            const string secret = "SECRET-INSTRUCTION-TEXT";
            foreach (int status in new[] { 409, 413, 428, 503, 500 })
            {
                var ex = SkillsHttpService.MapError(status,
                    "{\"error\":{\"code\":\"REVISION_CONFLICT\",\"message\":\"" + secret + "\"}}",
                    SkillsHttpService.Endpoint.Item);
                Assert.DoesNotContain(secret, ex.Message);
            }
        }

        [Fact]
        public void ValidationErrorsExposeFieldMessages()
        {
            var ex = SkillsHttpService.MapError(400,
                "{\"error\":{\"code\":\"VALIDATION_ERROR\",\"message\":\"Invalid skill.\",\"fields\":{\"keyword\":\"Keyword is reserved.\",\"body\":\"Unknown field.\",\"x\":1}}}",
                SkillsHttpService.Endpoint.Create);
            Assert.Equal(SkillsErrorKind.Validation, ex.Kind);
            Assert.Equal("Invalid skill.", ex.Message);
            Assert.Equal("Keyword is reserved.", ex.Fields["keyword"]);
            Assert.Equal("Unknown field.", ex.Fields["body"]);
            Assert.False(ex.Fields.ContainsKey("x"));
        }

        [Fact]
        public void KeywordConflictAddsInlineKeywordMessage()
        {
            var ex = SkillsHttpService.MapError(409, "{\"error\":{\"code\":\"KEYWORD_CONFLICT\",\"message\":\"x\"}}", SkillsHttpService.Endpoint.Item);
            Assert.Contains("including disabled", ex.Fields["keyword"]);
        }

        [Theory]
        [InlineData("{\"skill\":{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"k\",\"instructions\":\"i\",\"enabled\":true}}")]
        [InlineData("{\"skill\":{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"k\",\"instructions\":\"i\",\"enabled\":\"yes\",\"revision\":1}}")]
        [InlineData("{\"skill\":{\"id\":\"\",\"name\":\"A\",\"keyword\":\"k\",\"instructions\":\"i\",\"enabled\":true,\"revision\":1}}")]
        [InlineData("{\"skill\":{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"k\",\"enabled\":true,\"revision\":1}}")]
        [InlineData("{\"skill\":{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"k\",\"instructions\":\"i\",\"enabled\":true,\"revision\":0}}")]
        [InlineData("{\"skills\":[]}")]
        [InlineData("not json")]
        public async Task MalformedSuccessBodiesAreInvalidResponse(string body)
        {
            var h = new ServiceHarness();
            h.Handler.Reply(HttpStatusCode.OK, body);
            var ex = await Assert.ThrowsAsync<SkillsApiException>(() => h.Create().GetAsync("a"));
            Assert.Equal(SkillsErrorKind.InvalidResponse, ex.Kind);
        }

        [Fact]
        public async Task TransportFailureIsNetworkWithoutRawExceptionText()
        {
            var h = new ServiceHarness();
            h.Handler.Throw(new HttpRequestException("connect ECONNREFUSED 127.0.0.1:7071 secret-proxy"));
            var ex = await Assert.ThrowsAsync<SkillsApiException>(() => h.Create().ListAsync());
            Assert.Equal(SkillsErrorKind.Network, ex.Kind);
            Assert.DoesNotContain("secret-proxy", ex.Message);
        }

        [Fact]
        public async Task TimeoutIsNetworkButCallerCancellationIsCancelled()
        {
            var h = new ServiceHarness();
            h.Handler.Hang().Hang();
            var svc = h.Create(TimeSpan.FromMilliseconds(50));

            var timeout = await Assert.ThrowsAsync<SkillsApiException>(() => svc.ListAsync());
            Assert.Equal(SkillsErrorKind.Network, timeout.Kind);

            using var cts = new CancellationTokenSource();
            var pending = svc.ListAsync(cts.Token);
            cts.Cancel();
            var cancelled = await Assert.ThrowsAsync<SkillsApiException>(() => pending);
            Assert.Equal(SkillsErrorKind.Cancelled, cancelled.Kind);
        }
    }
}
