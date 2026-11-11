using System;
using System.Collections.Generic;

namespace OmniKey.Windows.Skills
{
    internal enum SteeringAckStatus
    {
        /// <summary>Queued by the server. Not yet applied to the task.</summary>
        Received,
        /// <summary>Applied to the running task at a safe point.</summary>
        Applied,
        /// <summary>Not accepted (Skills blocked it, the task finished, ...).</summary>
        Rejected,
    }

    /// <summary>
    /// One server acknowledgement of a steering send. <see cref="SteeringId"/>
    /// is null for legacy servers that predate correlated steering; those are
    /// matched best-effort to the oldest pending send. <see cref="Reason"/> is
    /// a sanitized single line, set only for rejections.
    /// </summary>
    internal readonly record struct SteeringAck(
        string? SteeringId,
        SteeringAckStatus Status,
        bool IsLegacy,
        string Reason = "");

    internal static class SteeringAckParser
    {
        public const string RejectedFallback =
            "The running task didn't accept this update. Send it again as a follow-up.";
        public const int MaxReasonLength = 300;

        /// <summary>
        /// Reads an <c>is_steering</c> agent frame. Mirrors macOS
        /// <c>ChatSessionRunner.steeringEvent(from:)</c>: an explicit
        /// <c>steering_status</c> wins; otherwise <c>is_error</c> means
        /// rejected and anything else means received. The content is only
        /// ever used as a plain-text reason, never parsed for tags/commands.
        /// </summary>
        public static SteeringAck? From(AgentRunner.AgentMessage? msg)
        {
            if (msg is null || msg.is_steering != true) return null;

            string? id = string.IsNullOrWhiteSpace(msg.steering_id) ? null : msg.steering_id.Trim();
            SteeringAckStatus status = msg.steering_status switch
            {
                "received" => SteeringAckStatus.Received,
                "applied" => SteeringAckStatus.Applied,
                "rejected" => SteeringAckStatus.Rejected,
                _ => msg.is_error ? SteeringAckStatus.Rejected : SteeringAckStatus.Received,
            };
            // A legacy server never sends steering_status/applied; an unknown
            // status from a correlated server keeps the id (no guessing).
            bool legacy = id is null;

            string reason = "";
            if (status == SteeringAckStatus.Rejected)
            {
                string raw = msg.content ?? "";
                raw = AgentRunner.ExtractFinalAnswer(raw) ?? AgentRunner.CleanDisplayText(raw);
                if (raw.StartsWith("**Error:**", StringComparison.Ordinal))
                    raw = raw["**Error:**".Length..];
                reason = SafeText.SingleLine(raw, MaxReasonLength, RejectedFallback);
            }

            return new SteeringAck(id, status, legacy, reason);
        }
    }

    internal enum SteeringPhase
    {
        /// <summary>Sent (or sending); the server has not acknowledged it.</summary>
        Pending,
        /// <summary>The server queued it; it is not applied yet.</summary>
        Received,
    }

    /// <summary>An unresolved steering send and its optimistic user bubble.</summary>
    internal sealed class PendingSteering
    {
        public PendingSteering(string steeringId, Guid userMessageId, string text)
        {
            SteeringId = steeringId;
            UserMessageId = userMessageId;
            Text = text;
        }

        public string SteeringId { get; }
        public Guid UserMessageId { get; }
        public string Text { get; }
        public SteeringPhase Phase { get; set; } = SteeringPhase.Pending;
    }

    /// <summary>What the chat model must do for one acknowledgement.</summary>
    internal enum SteeringOutcomeKind
    {
        /// <summary>Unknown, stale or duplicate id: change nothing.</summary>
        None,
        /// <summary>Queued: keep the bubble; streaming target unchanged.</summary>
        Received,
        /// <summary>Applied: insert an empty assistant continuation right after
        /// <see cref="SteeringOutcome.Entry"/>'s user bubble and call
        /// <see cref="SteeringLedger.AttachContinuation"/>.</summary>
        CreateContinuation,
        /// <summary>Not applied: hand the entry to
        /// <see cref="SteeringFailureResolver"/> (keep the bubble marked
        /// failed, maybe restore the text) and show
        /// <see cref="SteeringOutcome.Reason"/>.</summary>
        Rejected,
    }

    internal readonly record struct SteeringOutcome(
        SteeringOutcomeKind Kind,
        PendingSteering? Entry = null,
        string Reason = "");

    /// <summary>
    /// Per-turn steering state for one chat session, keyed by message IDs
    /// rather than list indices so removing a rejected bubble never shifts
    /// where later output streams.
    ///
    /// Lifecycle (same as macOS ChatModel): a send adds a pending user bubble
    /// only. Output keeps streaming into the current assistant bubble until
    /// the server says <c>applied</c> (or a legacy server acknowledges);
    /// only then does a continuation bubble become the streaming target.
    /// <c>received</c> just marks the send queued. <c>rejected</c>, a send
    /// failure, an acknowledgement timeout, or the turn ending first removes
    /// the pending entry; nothing is ever treated as applied because the
    /// transport send succeeded. Not thread-safe: use on the UI thread.
    /// </summary>
    internal sealed class SteeringLedger
    {
        private readonly List<PendingSteering> _pending = new();
        private Guid? _root;
        private Guid? _latestContinuation;

        /// <summary>The assistant bubble that live output appends to, or null
        /// when no turn is streaming.</summary>
        public Guid? StreamingTarget => _latestContinuation ?? _root;

        public bool IsActive => _root.HasValue;

        /// <summary>True while the turn started for <paramref name="rootAssistantId"/>
        /// is the current one (a late callback from an older run is ignored).</summary>
        public bool IsTurn(Guid rootAssistantId) => _root == rootAssistantId;

        public IReadOnlyList<PendingSteering> Pending => _pending;

        /// <summary>Starts a turn that streams into <paramref name="assistantMessageId"/>.
        /// Any leftover state from a previous turn is discarded.</summary>
        public void BeginTurn(Guid assistantMessageId)
        {
            _pending.Clear();
            _root = assistantMessageId;
            _latestContinuation = null;
        }

        /// <summary>Ends the turn and returns every unresolved send so the
        /// caller can mark its bubble failed (see <see cref="SteeringFailureResolver"/>).</summary>
        public IReadOnlyList<PendingSteering> EndTurn()
        {
            var unresolved = _pending.ToArray();
            _pending.Clear();
            _root = null;
            _latestContinuation = null;
            return unresolved;
        }

        /// <summary>The message a new steering bubble goes right after: the
        /// last still-pending bubble, otherwise the streaming target.</summary>
        public Guid? InsertionAnchor =>
            _pending.Count > 0 ? _pending[^1].UserMessageId : StreamingTarget;

        /// <summary>Registers a send. Returns false (and records nothing) when
        /// no turn is active or the id was already used in this turn.</summary>
        public bool Add(string steeringId, Guid userMessageId, string text)
        {
            if (!IsActive || string.IsNullOrWhiteSpace(steeringId)) return false;
            if (Find(steeringId) is not null) return false;
            _pending.Add(new PendingSteering(steeringId, userMessageId, text));
            return true;
        }

        public PendingSteering? Find(string? steeringId)
        {
            if (steeringId is null) return null;
            foreach (var entry in _pending)
                if (string.Equals(entry.SteeringId, steeringId, StringComparison.Ordinal))
                    return entry;
            return null;
        }

        /// <summary>Routes a server acknowledgement to its pending send.</summary>
        public SteeringOutcome Handle(SteeringAck ack)
        {
            if (!IsActive) return new(SteeringOutcomeKind.None);

            PendingSteering? entry = ack.SteeringId is { } id
                ? Find(id)
                : (_pending.Count > 0 ? _pending[0] : null); // legacy: oldest first
            if (entry is null) return new(SteeringOutcomeKind.None);

            switch (ack.Status)
            {
                case SteeringAckStatus.Applied:
                    return new(SteeringOutcomeKind.CreateContinuation, entry);

                case SteeringAckStatus.Received when ack.IsLegacy:
                    // Legacy servers never send `applied`; their receipt is final.
                    return new(SteeringOutcomeKind.CreateContinuation, entry);

                case SteeringAckStatus.Received:
                    entry.Phase = SteeringPhase.Received;
                    return new(SteeringOutcomeKind.Received, entry);

                case SteeringAckStatus.Rejected:
                    _pending.Remove(entry);
                    return new(SteeringOutcomeKind.Rejected, entry,
                        string.IsNullOrEmpty(ack.Reason) ? SteeringAckParser.RejectedFallback : ack.Reason);

                default:
                    return new(SteeringOutcomeKind.None);
            }
        }

        /// <summary>Completes a <see cref="SteeringOutcomeKind.CreateContinuation"/>:
        /// the send is resolved and later output streams into the new bubble.</summary>
        public void AttachContinuation(PendingSteering entry, Guid continuationMessageId)
        {
            if (!_pending.Remove(entry)) return;
            _latestContinuation = continuationMessageId;
        }

        /// <summary>Fails one unresolved send locally (transport failure or
        /// no acknowledgement). Returns null when it is already resolved.</summary>
        public PendingSteering? Fail(string steeringId)
        {
            var entry = Find(steeringId);
            if (entry is not null) _pending.Remove(entry);
            return entry;
        }

        /// <summary>Acknowledgement timeout: fails the send only if the server
        /// never even queued it (a received send may legitimately wait for
        /// the running command to finish).</summary>
        public PendingSteering? FailIfUnacknowledged(string steeringId) =>
            Find(steeringId) is { Phase: SteeringPhase.Pending } ? Fail(steeringId) : null;
    }

    /// <summary>What <see cref="SteeringFailureResolver.Resolve{TMessage}"/>
    /// asks the chat model to do with the shared composer.</summary>
    /// <param name="ComposerText">Text to put in the composer, or null to
    /// leave it untouched. Only ever set when the composer was empty.</param>
    /// <param name="RestoredSteeringId">The send whose text was restored.</param>
    /// <param name="ShowReason">True when the reason belongs in the visible
    /// error banner (the failing session is the one on screen).</param>
    internal readonly record struct SteeringFailurePlan(
        string? ComposerText,
        string? RestoredSteeringId,
        bool ShowReason);

    /// <summary>
    /// Applies failed steering sends (rejected, not delivered, unacknowledged
    /// or ended with the turn) to a transcript. Same lifecycle as macOS
    /// <c>failSteering</c>: the user bubble is never removed. It is kept and
    /// marked failed with the reason, so the exact text stays visible (and
    /// copyable) and never looks applied. The text is additionally restored
    /// into the composer for retry only when the session is on screen and the
    /// composer is empty; it never overwrites or appends to what the user is
    /// typing, and with several failures only the oldest is restored. A bubble
    /// that is no longer in the transcript is re-added as a failed bubble so
    /// its text is never lost. Not thread-safe: use on the UI thread.
    /// </summary>
    internal static class SteeringFailureResolver
    {
        public static SteeringFailurePlan Resolve<TMessage>(
            IList<TMessage> messages,
            Func<TMessage, Guid> idOf,
            Action<TMessage, string> markFailed,
            Func<PendingSteering, TMessage> recreate,
            IReadOnlyList<PendingSteering> failed,
            string reason,
            bool isActiveSession,
            string? composerText)
        {
            if (failed.Count == 0) return new(null, null, false);

            string safeReason = string.IsNullOrWhiteSpace(reason) ? SteeringAckParser.RejectedFallback : reason;
            foreach (var entry in failed)
            {
                TMessage? bubble = default;
                bool found = false;
                foreach (var message in messages)
                {
                    if (idOf(message) != entry.UserMessageId) continue;
                    bubble = message;
                    found = true;
                    break;
                }

                if (!found)
                {
                    bubble = recreate(entry);
                    messages.Add(bubble);
                }

                markFailed(bubble!, safeReason);
            }

            if (!isActiveSession) return new(null, null, false);

            if (string.IsNullOrEmpty(composerText) && failed[0].Text.Length > 0)
                return new(failed[0].Text, failed[0].SteeringId, true);

            return new(null, null, true);
        }
    }
}
