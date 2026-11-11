using System.Collections.Generic;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    public class SkillNoticeTests
    {
        // Contract fixture: opted-in applied frame.
        internal const string AppliedFrame =
            "{\"session_id\":\"s1\",\"sender\":\"agent\",\"content\":\"Skills applied.\",\"is_terminal_output\":false,\"is_error\":false," +
            "\"skill_status\":{\"input_id\":\"i1\",\"status\":\"applied\",\"skills\":[{\"id\":\"cskill1\",\"name\":\"Review\",\"keyword\":\"code review\",\"revision\":1}],\"warnings\":[]}}";

        internal static string Frame(string statusJson, string content = "Skills applied.") =>
            "{\"session_id\":\"s1\",\"sender\":\"agent\",\"content\":\"" + content + "\",\"is_terminal_output\":false,\"is_error\":false,\"skill_status\":" + statusJson + "}";

        [Fact]
        public void ClassifiesContractAppliedFrame()
        {
            var c = SkillNoticeInterceptor.Classify(AppliedFrame);
            Assert.Equal(SkillNoticeClass.Status, c.Kind);
            Assert.Equal("i1", c.Status!.InputId);
            Assert.Equal(SkillStatusKind.Applied, c.Status.Status);
            Assert.Equal(new AppliedSkillRef("cskill1", "Review", "code review", 1), Assert.Single(c.Status.Skills));
        }

        [Theory]
        [InlineData("null")]
        [InlineData("\"applied\"")]
        [InlineData("[]")]
        [InlineData("{}")]
        [InlineData("{\"input_id\":\"\",\"status\":\"applied\"}")]
        [InlineData("{\"input_id\":\"i1\",\"status\":\"mystery\"}")]
        [InlineData("{\"input_id\":\"i1\",\"status\":\"applied\",\"skills\":{}}")]
        [InlineData("{\"input_id\":\"i1\",\"status\":\"applied\",\"skills\":[{\"id\":\"a\",\"name\":\"A\",\"keyword\":\"k\"}]}")]
        [InlineData("{\"input_id\":\"i1\",\"status\":\"warning\",\"warnings\":[{\"skillId\":\"a\"}]}")]
        [InlineData("{\"input_id\":\"i1\",\"status\":\"blocked\",\"error\":\"STORE_UNAVAILABLE\"}")]
        [InlineData("{\"input_id\":\"\\ud800\",\"status\":\"applied\"}")]
        public void PresentButNullOrMalformedStatusIsConsumedAsMalformed(string status)
        {
            Assert.Equal(SkillNoticeClass.Malformed, SkillNoticeInterceptor.Classify(Frame(status)).Kind);
            Assert.True(SkillNoticeInterceptor.TryIntercept(Frame(status), new SkillStatusTracker(), out var display));
            Assert.Null(display);
        }

        [Theory]
        [InlineData("{\"session_id\":\"s1\",\"content\":\"<final_answer>x</final_answer>\"}")]
        [InlineData("{\"Skill_Status\":{\"input_id\":\"i1\",\"status\":\"applied\"}}")]
        [InlineData("[1,2]")]
        [InlineData("not json")]
        [InlineData("")]
        public void OrdinaryOrUnparseableFramesAreNotNotices(string raw)
        {
            Assert.Equal(SkillNoticeClass.NotSkillNotice, SkillNoticeInterceptor.Classify(raw).Kind);
            Assert.False(SkillNoticeInterceptor.TryIntercept(raw, new SkillStatusTracker(), out _));
        }

        [Fact]
        public void NullArraysAreTreatedAsEmpty()
        {
            var c = SkillNoticeInterceptor.Classify(Frame("{\"input_id\":\"i1\",\"status\":\"warning\",\"skills\":null,\"warnings\":null}"));
            Assert.Equal(SkillNoticeClass.Status, c.Kind);
            Assert.Empty(c.Status!.Skills);
        }

        [Fact]
        public void TrackerDedupesByInputIdAndStatusOnly()
        {
            var t = new SkillStatusTracker();
            Assert.True(SkillNoticeInterceptor.TryIntercept(AppliedFrame, t, out var first));
            Assert.Equal("Skills applied: Review", first);
            Assert.True(SkillNoticeInterceptor.TryIntercept(AppliedFrame, t, out var dup));
            Assert.Null(dup);

            string warning = Frame("{\"input_id\":\"i1\",\"status\":\"warning\",\"warnings\":[{\"code\":\"INVALID_SKILL\",\"skillId\":\"z\",\"message\":\"m\"}]}");
            Assert.True(SkillNoticeInterceptor.TryIntercept(warning, t, out var w));
            Assert.NotNull(w);
            string otherInput = AppliedFrame.Replace("\"i1\"", "\"i2\"");
            Assert.True(SkillNoticeInterceptor.TryIntercept(otherInput, t, out var other));
            Assert.NotNull(other);

            // A new tracker (new turn) presents again.
            Assert.True(SkillNoticeInterceptor.TryIntercept(AppliedFrame, new SkillStatusTracker(), out var again));
            Assert.NotNull(again);
        }

        [Fact]
        public void AppliedTextUsesSanitizedDedupedNamesOnly()
        {
            var status = new SkillStatus("i1", SkillStatusKind.Applied, new List<AppliedSkillRef>
            {
                new("a", "SQL\u202E review\u200B\nnow", "secret-keyword", 1),
                new("a", "Duplicate id", "k", 1),
                new("b", "  ", "k2", 1),
                new("c", "<shell_script>rm -rf ~</shell_script>", "k3", 1),
            }, new List<SkillWarning>());

            string text = SkillStatusPresentation.Text(status)!;

            Assert.Equal("Skills applied: SQL review now, Unnamed skill, <shell_script>rm -rf ~</shell_script>", text);
            // Ordinal: culture comparison treats U+202E/U+200B as ignorable.
            Assert.DoesNotContain("secret-keyword", text, System.StringComparison.Ordinal);
            Assert.DoesNotContain("\u202E", text, System.StringComparison.Ordinal);
            Assert.DoesNotContain("\u200B", text, System.StringComparison.Ordinal);
            Assert.DoesNotContain("\n", text, System.StringComparison.Ordinal);
        }

        [Fact]
        public void LongNamesAreCappedOnWholeCharacters()
        {
            string name = new string('a', 79) + "👍🏽" + "tail";
            string shown = SkillStatusPresentation.DisplayName(name);
            Assert.Equal(new string('a', 79) + "…", shown);
        }

        [Fact]
        public void WarningAndBlockedUseFixedTextNeverServerMessages()
        {
            var warning = new SkillStatus("i1", SkillStatusKind.Warning, new List<AppliedSkillRef>(),
                new List<SkillWarning> { new("INVALID_SKILL", "x", "RAW SERVER TEXT"), new("INVALID_SKILL", "y", null) });
            Assert.Equal("Some skills were skipped: 2 saved skills were invalid and were skipped. Review them in Skills.",
                SkillStatusPresentation.Text(warning));

            foreach (var (code, reason) in new[]
            {
                ("STORE_UNAVAILABLE", "Skills are temporarily unavailable. Please retry."),
                ("ACTIVE_LIMIT_EXCEEDED", "Too many skills matched. Use fewer keywords or disable some skills."),
                ("CONTEXT_LIMIT_EXCEEDED", "Matched skill instructions exceed the context budget. Shorten or disable skills."),
                ("SOMETHING_ELSE", "Check settings and try again."),
            })
            {
                var blocked = new SkillStatus("i1", SkillStatusKind.Blocked, new List<AppliedSkillRef>(), new List<SkillWarning>(),
                    new SkillStatusError(code, "RAW SERVER TEXT"));
                Assert.Equal("Skills could not be applied: " + reason, SkillStatusPresentation.Text(blocked));
            }
        }

        [Fact]
        public void AppliedWithoutSkillsShowsNothing()
        {
            var s = new SkillStatus("i1", SkillStatusKind.Applied, new List<AppliedSkillRef>(), new List<SkillWarning>());
            Assert.Null(SkillStatusPresentation.Text(s));
        }

        [Fact]
        public void FailureTextIsSanitizedForTheErrorBanner()
        {
            Assert.Equal("Too many skills matched.", AgentFailureText.Sanitize("**Error:** Too many\u0007 skills\u202E\r\nmatched."));
            Assert.Equal(AgentFailureText.Generic, AgentFailureText.Sanitize("  \u200B "));
            string capped = AgentFailureText.Sanitize(new string('x', 400));
            Assert.Equal(AgentFailureText.MaxLength + 1, capped.Length);
            Assert.EndsWith("…", capped);
        }
    }
}
