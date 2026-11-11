using System;
using System.Text.Json;

namespace OmniKey.Windows.Skills
{
    internal enum AgentFrameKind
    {
        /// <summary>Skills notice: consumed. <see cref="AgentFrameAction.Display"/>
        /// is literal text to show (null = nothing to show). Never executes,
        /// never completes the turn.</summary>
        SkillNotice,
        /// <summary>Unparseable or null frame: skip it and keep listening.</summary>
        Ignored,
        WebCall,
        ImageRendering,
        McpCall,
        /// <summary>Run <see cref="AgentFrameAction.Text"/> as a shell script.</summary>
        ShellScript,
        /// <summary>Complete the turn with <see cref="AgentFrameAction.Text"/>.</summary>
        FinalAnswer,
        /// <summary>Hotkey only: terminal <c>is_error</c> final answer. Fail the
        /// run with the sanitized <see cref="AgentFrameAction.Text"/>; never
        /// present it as an answer.</summary>
        Failure,
        /// <summary>Hotkey only: no tags, so the text is the final answer.</summary>
        ImplicitFinalAnswer,
        /// <summary>Chat only: intermediate agent text; keep listening.</summary>
        AgentText,
        /// <summary>Chat only: steering acknowledgement in
        /// <see cref="AgentFrameAction.Steering"/>. Never executes or ends
        /// the turn.</summary>
        SteeringAck,
    }

    /// <param name="Display">Text to append to the live timeline first (null = nothing).</param>
    internal readonly record struct AgentFrameAction(
        AgentFrameKind Kind,
        AgentRunner.AgentMessage? Message = null,
        string Text = "",
        string? Display = null,
        SteeringAck? Steering = null);

    /// <summary>
    /// Pure per-frame dispatch for the two Windows agent consumers. Skills
    /// notices are intercepted FIRST — before decoding, web/MCP/image,
    /// steering, shell-script and final-answer handling — so notice metadata
    /// can never execute commands or end a turn. Apart from that interception
    /// and the hotkey <c>is_error</c> final handling, the order mirrors each
    /// runner's pre-Skills receive loop exactly.
    /// </summary>
    internal static class AgentFrameRouter
    {
        /// <summary>OmniAgent session (hotkey) runner, <see cref="AgentRunner"/>.</summary>
        public static AgentFrameAction ForHotkey(string raw, SkillStatusTracker tracker)
        {
            if (SkillNoticeInterceptor.TryIntercept(raw, tracker, out var notice))
                return new(AgentFrameKind.SkillNotice, Display: notice);

            var msg = Decode(raw);
            if (msg is null) return new(AgentFrameKind.Ignored);

            string content = msg.content ?? "";

            if (msg.is_web_call == true) return new(AgentFrameKind.WebCall, msg, content);
            if (msg.is_mcp_call == true) return new(AgentFrameKind.McpCall, msg, content);

            // A terminal error frame (e.g. "Skills could not be applied") must
            // fail the run rather than become the answer the user copies.
            string? final = AgentRunner.ExtractFinalAnswer(content);
            if (msg.is_error && final is not null)
                return new(AgentFrameKind.Failure, msg, AgentFailureText.Sanitize(final));

            string displayText = AgentRunner.CleanDisplayText(content);
            string? display = !string.IsNullOrWhiteSpace(displayText) &&
                              !displayText.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase)
                ? displayText
                : null;

            string? script = AgentRunner.ExtractShellScript(content);
            if (script is not null) return new(AgentFrameKind.ShellScript, msg, script, display);

            if (final is not null) return new(AgentFrameKind.FinalAnswer, msg, final, display);

            string answer = !string.IsNullOrWhiteSpace(displayText) ? displayText : content;
            return new(AgentFrameKind.ImplicitFinalAnswer, msg, answer, display);
        }

        /// <summary>Agent Chat runner, <see cref="ChatSessionRunner"/>.</summary>
        public static AgentFrameAction ForChat(string raw, SkillStatusTracker tracker)
        {
            if (SkillNoticeInterceptor.TryIntercept(raw, tracker, out var notice))
                return new(AgentFrameKind.SkillNotice, Display: notice);

            var msg = Decode(raw);
            if (msg is null) return new(AgentFrameKind.Ignored);

            string content = msg.content ?? "";

            // Steering acknowledgement: routed to its pending send by id. Its
            // content is never parsed for shell/final tags.
            if (msg.is_steering == true)
                return new(AgentFrameKind.SteeringAck, msg, Steering: SteeringAckParser.From(msg));
            if (msg.is_web_call == true) return new(AgentFrameKind.WebCall, msg, content);
            if (msg.is_image_rendering == true) return new(AgentFrameKind.ImageRendering, msg, content);
            if (msg.is_mcp_call == true) return new(AgentFrameKind.McpCall, msg, content);

            string? final = AgentRunner.ExtractFinalAnswer(content);
            if (final is not null) return new(AgentFrameKind.FinalAnswer, msg, final);

            string? script = AgentRunner.ExtractShellScript(content);
            if (script is not null) return new(AgentFrameKind.ShellScript, msg, script);

            string displayText = AgentRunner.CleanDisplayText(content);
            string? display = !string.IsNullOrWhiteSpace(displayText) &&
                              !displayText.StartsWith("[terminal ", StringComparison.OrdinalIgnoreCase)
                ? displayText
                : null;
            return new(AgentFrameKind.AgentText, msg, content, display);
        }

        private static AgentRunner.AgentMessage? Decode(string raw)
        {
            try
            {
                return JsonSerializer.Deserialize<AgentRunner.AgentMessage>(raw, AgentRunner.JsonOptions);
            }
            catch
            {
                // Not parseable – skip this frame and keep listening,
                // matching macOS behaviour (receiveNext() on decode failure).
                return null;
            }
        }
    }
}
