using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OmniKey.Windows
{
    /// <summary>
    /// Platform-neutral part of <see cref="AgentRunner"/>: the WebSocket wire
    /// shape and tag parsing. Kept free of WPF/WinForms/registry types so the
    /// cross-platform test project (windows.Tests) can compile it directly.
    /// </summary>
    internal static partial class AgentRunner
    {
        // ─── Tag parsing ─────────────────────────────────────────────

        internal static string? ExtractShellScript(string text)
        {
            int start = text.IndexOf("<shell_script>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<shell_script>".Length;
            int end = text.IndexOf("</shell_script>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        internal static string? ExtractFinalAnswer(string text)
        {
            int start = text.IndexOf("<final_answer>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<final_answer>".Length;
            int end = text.IndexOf("</final_answer>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        internal static string CleanDisplayText(string text)
        {
            return text
                .Replace("<shell_script>", "")
                .Replace("</shell_script>", "")
                .Replace("<final_answer>", "")
                .Replace("</final_answer>", "")
                .Trim();
        }

        // ─── JSON ─────────────────────────────────────────────────────

        internal static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
        };

        internal sealed class AgentMessage
        {
            public string? session_id { get; set; }
            public string? sender { get; set; }
            public string? content { get; set; }
            public bool is_terminal_output { get; set; }
            public bool is_error { get; set; }
            public bool? is_web_call { get; set; }
            public bool? is_image_rendering { get; set; }
            public bool? is_mcp_call { get; set; }
            public bool? is_steering { get; set; }
            public string platform { get; set; } = "windows";
            // Project group selected in the composer. Sent on the initial
            // outbound message; the backend stamps the new session with it
            // so the resumed session shows up under the right group header.
            // Wire format matches macOS ChatSessionRunner.AgentMessage —
            // see snake_case `group_name` on that side.
            public string? group_name { get; set; }

            /// <summary>Client-generated id for one steering send. The backend
            /// dedups retries of the same id within a run, so each user send
            /// gets a fresh id. Omitted from non-steering frames.</summary>
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? steering_id { get; set; }

            /// <summary>Inbound only: server acknowledgement of a steering
            /// send (<c>received</c> | <c>applied</c> | <c>rejected</c>).</summary>
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? steering_status { get; set; }

            /// <summary>Skills v1 opt-in: true only when every receiving
            /// runner handles <c>skill_status</c> notices before shell/final
            /// parsing. Omitted (never false) otherwise so old frames are
            /// byte-identical.</summary>
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public bool? supports_skill_status { get; set; }
        }
    }
}
