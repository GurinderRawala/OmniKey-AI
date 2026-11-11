using System.Collections.Generic;

namespace OmniKey.Windows.Skills
{
    /// <summary>The live steering fields of a user bubble.</summary>
    internal interface ISteeringBubble
    {
        SteeringBubbleState SteeringState { get; set; }
        bool SteeringUnconfirmed { get; set; }
        string? SteeringFailureReason { get; set; }
    }

    /// <summary>
    /// The bubble and banner changes ChatModel makes for each steering event
    /// (acknowledgement, deadline, failure). Kept pure so the tests drive the
    /// same transitions the app uses. Not thread-safe: use on the UI thread.
    /// </summary>
    internal static class SteeringBubbleTransition
    {
        /// <summary>A received/applied acknowledgement. Clears the unconfirmed
        /// flag; a failed bubble is never moved back. Returns true when the
        /// bubble changed.</summary>
        public static bool ApplyAck(ISteeringBubble? bubble, SteeringOutcomeKind kind)
        {
            if (bubble is null
                || bubble.SteeringFailureReason is not null
                || kind == SteeringOutcomeKind.Rejected
                || SteeringPresentation.StateAfter(kind) is not { } state)
                return false;
            bubble.SteeringState = state;
            bubble.SteeringUnconfirmed = false;
            return true;
        }

        /// <summary>The acknowledgement deadline passed: the bubble may still
        /// apply, so it is only flagged, never failed.</summary>
        public static bool MarkUnconfirmed(ISteeringBubble? bubble)
        {
            if (bubble is null
                || bubble.SteeringFailureReason is not null
                || bubble.SteeringState != SteeringBubbleState.Pending)
                return false;
            bubble.SteeringUnconfirmed = true;
            return true;
        }

        /// <summary>The send was not applied (rejected, not delivered, or the
        /// turn ended first).</summary>
        public static void MarkFailed(ISteeringBubble bubble, string reason)
        {
            bubble.SteeringFailureReason = reason;
            bubble.SteeringState = SteeringBubbleState.Failed;
            bubble.SteeringUnconfirmed = false;
        }

        /// <summary>The banner to show after an unconfirmed send was marked:
        /// only the session on screen shows it.</summary>
        public static string? BannerAfterUnconfirmed(string? banner, bool isActive) =>
            isActive ? SteeringPresentation.UnconfirmedBanner : banner;

        /// <summary>The banner after an acknowledgement resolved a send. The
        /// "not confirmed" warning is cleared only once no send in the
        /// session is still unconfirmed; any other message is kept.</summary>
        public static string? BannerAfterAck(
            string? banner, bool isActive, IReadOnlyList<PendingSteering> pending)
        {
            if (!isActive || banner != SteeringPresentation.UnconfirmedBanner)
                return banner;
            foreach (var entry in pending)
                if (entry.IsUnconfirmed)
                    return banner;
            return null;
        }
    }
}
