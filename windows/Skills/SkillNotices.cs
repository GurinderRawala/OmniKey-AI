using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace OmniKey.Windows.Skills
{
    internal enum SkillStatusKind { Applied, Warning, Blocked }

    internal sealed record SkillStatusError(string Code, string? Message);

    /// <summary><c>skill_status</c> metadata on a nonterminal agent notice.</summary>
    internal sealed record SkillStatus(
        string InputId,
        SkillStatusKind Status,
        IReadOnlyList<AppliedSkillRef> Skills,
        IReadOnlyList<SkillWarning> Warnings,
        SkillStatusError? Error = null);

    internal enum SkillNoticeClass
    {
        /// <summary>Ordinary agent frame; continue with existing parsing.</summary>
        NotSkillNotice,
        /// <summary>Carries <c>skill_status</c> but it is null or malformed.
        /// Still consumed so it never reaches shell/final-answer parsing.</summary>
        Malformed,
        Status,
    }

    internal readonly record struct SkillNoticeClassification(SkillNoticeClass Kind, SkillStatus? Status = null);

    /// <summary>
    /// Optional sink for live Skills notices. <see cref="AgentRunner"/> uses it
    /// when the session implements it and falls back to the ordinary
    /// agent-message callback otherwise. Text is literal plain text.
    /// </summary>
    internal interface ISkillNoticeSink
    {
        void AppendSkillNotice(string text);
    }

    /// <summary>
    /// Per-turn dedup of notices by input id + status. Created fresh for every
    /// run, so nothing survives a new turn, completion, stop or disconnect.
    /// </summary>
    internal sealed class SkillStatusTracker
    {
        private readonly object _lock = new();
        private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

        /// <summary>True the first time an (input id, status) pair is offered.</summary>
        public bool ShouldPresent(SkillStatus status)
        {
            string key = status.InputId + "\u0000" + status.Status;
            lock (_lock) return _seen.Add(key);
        }
    }

    internal static class SkillNoticeInterceptor
    {
        /// <summary>
        /// Classify one raw WebSocket text frame. Must run before any tool,
        /// steering, shell-script or final-answer handling. Key presence uses
        /// the same exact, case-sensitive property name the runners' snake_case
        /// deserializer would use. If the frame is not parseable JSON it is
        /// reported as not-a-notice; the runners' own decode then fails as well
        /// and the frame is dropped, so it can never execute or complete.
        /// </summary>
        public static SkillNoticeClassification Classify(string raw)
        {
            JsonDocument doc;
            try { doc = JsonDocument.Parse(raw); }
            catch { return new(SkillNoticeClass.NotSkillNotice); }

            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object ||
                    !root.TryGetProperty("skill_status", out var el))
                    return new(SkillNoticeClass.NotSkillNotice);

                try
                {
                    var status = ParseStatus(el);
                    return status is null
                        ? new(SkillNoticeClass.Malformed)
                        : new(SkillNoticeClass.Status, status);
                }
                catch
                {
                    // e.g. a lone surrogate that cannot be transcoded.
                    return new(SkillNoticeClass.Malformed);
                }
            }
        }

        /// <summary>
        /// Returns false when <paramref name="raw"/> is not a Skills notice (the
        /// caller continues normal parsing). True means the frame is consumed
        /// and must go no further; <paramref name="display"/> is literal text
        /// to show, or null when it is a duplicate, malformed or empty.
        /// </summary>
        public static bool TryIntercept(string raw, SkillStatusTracker tracker, out string? display)
        {
            display = null;
            var c = Classify(raw);
            switch (c.Kind)
            {
                case SkillNoticeClass.NotSkillNotice:
                    return false;
                case SkillNoticeClass.Malformed:
                    return true;
                default:
                    if (c.Status is { } status && tracker.ShouldPresent(status))
                        display = SkillStatusPresentation.Text(status);
                    return true;
            }
        }

        private static SkillStatus? ParseStatus(JsonElement el)
        {
            if (el.ValueKind != JsonValueKind.Object) return null;

            string? inputId = Str(el, "input_id");
            if (string.IsNullOrEmpty(inputId)) return null;

            SkillStatusKind kind;
            switch (Str(el, "status"))
            {
                case "applied": kind = SkillStatusKind.Applied; break;
                case "warning": kind = SkillStatusKind.Warning; break;
                case "blocked": kind = SkillStatusKind.Blocked; break;
                default: return null;
            }

            var skills = new List<AppliedSkillRef>();
            if (el.TryGetProperty("skills", out var arr) && arr.ValueKind != JsonValueKind.Null)
            {
                if (arr.ValueKind != JsonValueKind.Array) return null;
                foreach (var s in arr.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object) return null;
                    string? id = Str(s, "id"), name = Str(s, "name"), keyword = Str(s, "keyword");
                    if (id is null || name is null || keyword is null) return null;
                    if (!s.TryGetProperty("revision", out var r) || r.ValueKind != JsonValueKind.Number ||
                        !r.TryGetInt32(out int rev))
                        return null;
                    skills.Add(new AppliedSkillRef(id, name, keyword, rev));
                }
            }

            var warnings = new List<SkillWarning>();
            if (el.TryGetProperty("warnings", out var warr) && warr.ValueKind != JsonValueKind.Null)
            {
                if (warr.ValueKind != JsonValueKind.Array) return null;
                foreach (var w in warr.EnumerateArray())
                {
                    if (w.ValueKind != JsonValueKind.Object) return null;
                    string? code = Str(w, "code");
                    if (code is null) return null;
                    warnings.Add(new SkillWarning(code, Str(w, "skillId"), Str(w, "message")));
                }
            }

            SkillStatusError? error = null;
            if (el.TryGetProperty("error", out var e) && e.ValueKind != JsonValueKind.Null)
            {
                if (e.ValueKind != JsonValueKind.Object) return null;
                string? code = Str(e, "code");
                if (code is null) return null;
                error = new SkillStatusError(code, Str(e, "message"));
            }

            return new SkillStatus(inputId, kind, skills, warnings, error);
        }

        private static string? Str(JsonElement el, string name) =>
            el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    }

    /// <summary>
    /// Plain-text formatting for notices. Output is always one line built from
    /// fixed wording plus sanitized names; no server message, keyword or
    /// instruction text is interpolated. Views must render it literally
    /// (TextBlock, never Markdown/HTML), and it is never parsed for tags.
    /// </summary>
    internal static class SkillStatusPresentation
    {
        public const string AppliedPrefix = "Skills applied: ";

        public static string? Text(SkillStatus status)
        {
            switch (status.Status)
            {
                case SkillStatusKind.Applied:
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    var names = new List<string>();
                    foreach (var s in status.Skills)
                        if (seen.Add(s.Id)) names.Add(DisplayName(s.Name));
                    return names.Count == 0 ? null : AppliedPrefix + string.Join(", ", names);

                case SkillStatusKind.Warning:
                    int count = Math.Max(status.Warnings.Count, 1);
                    string noun = count == 1
                        ? "1 saved skill was invalid and was"
                        : $"{count} saved skills were invalid and were";
                    return $"Some skills were skipped: {noun} skipped. Review them in Skills.";

                default:
                    return "Skills could not be applied: " + BlockedReason(status.Error?.Code);
            }
        }

        /// <summary>Fixed reason text by error code (mirrors the backend table).</summary>
        public static string BlockedReason(string? code) => code switch
        {
            "STORE_UNAVAILABLE" => "Skills are temporarily unavailable. Please retry.",
            "ACTIVE_LIMIT_EXCEEDED" => "Too many skills matched. Use fewer keywords or disable some skills.",
            "CONTEXT_LIMIT_EXCEEDED" => "Matched skill instructions exceed the context budget. Shorten or disable skills.",
            _ => "Check settings and try again.",
        };

        /// <summary>Collapse controls, line/paragraph separators, format
        /// characters (bidi overrides, zero-width) and whitespace runs to one
        /// space, trim, and cap at the name limit on whole text elements.</summary>
        public static string DisplayName(string? raw) => SafeText.SingleLine(raw, SkillLimits.NameCodePoints, "Unnamed skill");
    }

    internal static class SafeText
    {
        /// <summary>One-line literal text: Cc/Cf/Zl/Zp/whitespace → single
        /// space; trimmed; capped to <paramref name="maxCodePoints"/> on whole
        /// grapheme clusters plus an ellipsis; empty → fallback.</summary>
        public static string SingleLine(string? raw, int maxCodePoints, string fallback)
        {
            var sb = new StringBuilder();
            bool lastWasSpace = false;
            foreach (var rune in (raw ?? "").EnumerateRunes())
            {
                var cat = Rune.GetUnicodeCategory(rune);
                bool breaking = cat is UnicodeCategory.Control or UnicodeCategory.Format
                    or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator
                    or UnicodeCategory.Surrogate or UnicodeCategory.PrivateUse
                    || Rune.IsWhiteSpace(rune);
                if (breaking)
                {
                    if (!lastWasSpace) sb.Append(' ');
                    lastWasSpace = true;
                }
                else
                {
                    sb.Append(rune.ToString());
                    lastWasSpace = false;
                }
            }

            string text = sb.ToString().Trim();
            if (SkillLimits.CodePoints(text) > maxCodePoints)
            {
                var kept = new StringBuilder();
                int used = 0;
                var e = StringInfo.GetTextElementEnumerator(text);
                while (e.MoveNext())
                {
                    string element = e.GetTextElement();
                    int size = SkillLimits.CodePoints(element);
                    if (used + size > maxCodePoints) break;
                    kept.Append(element);
                    used += size;
                }
                text = kept.ToString().TrimEnd() + "…";
            }
            return text.Length == 0 ? fallback : text;
        }
    }

    /// <summary>Error text for a terminal <c>is_error</c> final answer shown
    /// in the OmniAgent session error banner instead of as an answer.</summary>
    internal static class AgentFailureText
    {
        public const string Generic = "The agent could not complete this request.";
        public const int MaxLength = 300;

        public static string Sanitize(string? finalAnswer)
        {
            string text = (finalAnswer ?? "").Trim();
            if (text.StartsWith("**Error:**", StringComparison.Ordinal))
                text = text["**Error:**".Length..];
            return SafeText.SingleLine(text, MaxLength, Generic);
        }
    }
}
