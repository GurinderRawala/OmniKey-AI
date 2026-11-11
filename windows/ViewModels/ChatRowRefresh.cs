using System;
using OmniKey.Windows.Skills;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>What a realized transcript row was built from. Rows are
    /// immutable snapshots of a mutable <c>ChatMessage</c>, so the view model
    /// compares this against the message's current values to decide whether
    /// a row must be rebuilt. Platform-neutral (unit tested).</summary>
    internal readonly record struct ChatRowSnapshot(
        Guid Id,
        bool IsStreaming,
        int BlockCount,
        SteeringBubbleState SteeringState,
        string? SteeringFailureReason,
        bool SteeringUnconfirmed);

    internal static class ChatRowRefresh
    {
        /// <summary>A row streams only when it is the ledger's actual target
        /// (by id), never merely because it is the last row: steering bubbles
        /// can sit below the assistant bubble that is still receiving output.</summary>
        public static bool IsStreaming(bool isRunning, Guid? streamingTarget, Guid messageId, bool isAssistant) =>
            isRunning && isAssistant && streamingTarget is Guid target && target == messageId;

        /// <summary>Rebuild when anything shown changed (blocks appended,
        /// streaming flag flipped, steering status moved) or while the row is
        /// streaming. Unchanged rows keep their realized visuals.</summary>
        public static bool NeedsRebuild(ChatRowSnapshot current, ChatRowSnapshot next) =>
            next.IsStreaming || current != next;
    }
}
