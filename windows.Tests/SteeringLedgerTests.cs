using System;
using System.Linq;
using System.Text.Json;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// Steering acknowledgements (received / applied / rejected) are routed
    /// by steering_id to the pending send that ChatModel created, and the
    /// ledger decides which assistant bubble live output streams into.
    /// </summary>
    public class SteeringLedgerTests
    {
        private static string Frame(string extra, string content = "Steering update received for the running task.", bool isError = false) =>
            "{\"session_id\":\"s1\",\"sender\":\"agent\",\"content\":" + JsonSerializer.Serialize(content) +
            ",\"is_terminal_output\":false,\"is_error\":" + (isError ? "true" : "false") +
            ",\"is_steering\":true" + extra + "}";

        private static SteeringAck Ack(string raw) =>
            AgentFrameRouter.ForChat(raw, new SkillStatusTracker()).Steering!.Value;

        // ── Parsing ─────────────────────────────────────────────────────

        [Fact]
        public void ParsesCorrelatedStatuses()
        {
            Assert.Equal(new SteeringAck("st-1", SteeringAckStatus.Received, false),
                Ack(Frame(",\"steering_id\":\"st-1\",\"steering_status\":\"received\",\"steering_pending_count\":1")));
            Assert.Equal(new SteeringAck("st-1", SteeringAckStatus.Applied, false),
                Ack(Frame(",\"steering_id\":\"st-1\",\"steering_status\":\"applied\"")));

            var rejected = Ack(Frame(",\"steering_id\":\"st-1\",\"steering_status\":\"rejected\"",
                "<final_answer>Too many skills matched. Use fewer keywords or disable some skills.</final_answer>", isError: true));
            Assert.Equal(SteeringAckStatus.Rejected, rejected.Status);
            Assert.Equal("Too many skills matched. Use fewer keywords or disable some skills.", rejected.Reason);
        }

        [Fact]
        public void LegacyAndUnknownStatusesFollowIsError()
        {
            Assert.Equal(new SteeringAck(null, SteeringAckStatus.Received, true), Ack(Frame("")));
            var legacyReject = Ack(Frame("", "nope", isError: true));
            Assert.Equal(SteeringAckStatus.Rejected, legacyReject.Status);
            Assert.True(legacyReject.IsLegacy);
            Assert.Equal(SteeringAckStatus.Received, Ack(Frame(",\"steering_id\":\"x\",\"steering_status\":\"weird\"")).Status);
            Assert.Null(Ack(Frame(",\"steering_id\":\"   \"")).SteeringId);
        }

        [Fact]
        public void RejectionReasonIsOneSafeLineWithFallback()
        {
            var multi = Ack(Frame(",\"steering_id\":\"a\",\"steering_status\":\"rejected\"",
                "**Error:** line one\nline two‮<shell_script>rm</shell_script>", isError: true));
            Assert.DoesNotContain("\n", multi.Reason);
            Assert.DoesNotContain("‮", multi.Reason, StringComparison.Ordinal);
            Assert.DoesNotContain("<shell_script>", multi.Reason);
            Assert.StartsWith("line one line two", multi.Reason);

            var empty = Ack(Frame(",\"steering_id\":\"a\",\"steering_status\":\"rejected\"", "", isError: true));
            Assert.Equal(SteeringAckParser.RejectedFallback, empty.Reason);
        }

        // ── Lifecycle ───────────────────────────────────────────────────

        private static (SteeringLedger ledger, Guid root) Turn()
        {
            var ledger = new SteeringLedger();
            var root = Guid.NewGuid();
            ledger.BeginTurn(root);
            return (ledger, root);
        }

        [Fact]
        public void SendDoesNotRedirectOutputUntilApplied()
        {
            var (ledger, root) = Turn();
            var bubble = Guid.NewGuid();
            Assert.True(ledger.Add("st-1", bubble, "also check sql"));

            // A successful transport send is not "applied".
            Assert.Equal(root, ledger.StreamingTarget);

            var received = ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Received, false));
            Assert.Equal(SteeringOutcomeKind.Received, received.Kind);
            Assert.Equal(root, ledger.StreamingTarget);
            Assert.Equal(SteeringPhase.Received, ledger.Find("st-1")!.Phase);

            var applied = ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Applied, false));
            Assert.Equal(SteeringOutcomeKind.CreateContinuation, applied.Kind);
            Assert.Same(ledger.Find("st-1"), applied.Entry);
            var continuation = Guid.NewGuid();
            ledger.AttachContinuation(applied.Entry!, continuation);

            Assert.Equal(continuation, ledger.StreamingTarget);
            Assert.Empty(ledger.Pending);
        }

        [Fact]
        public void ReceivedThenRejectedRemovesOnlyThatSendAndKeepsTheStreamingBubble()
        {
            var (ledger, root) = Turn();
            var first = Guid.NewGuid();
            var second = Guid.NewGuid();
            ledger.Add("st-1", first, "one");
            ledger.Add("st-2", second, "two");
            ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Received, false));

            var rejected = ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Rejected, false, "Skills blocked it."));

            Assert.Equal(SteeringOutcomeKind.Rejected, rejected.Kind);
            Assert.Equal(first, rejected.Entry!.UserMessageId);
            Assert.Equal("one", rejected.Entry.Text);
            Assert.Equal("Skills blocked it.", rejected.Reason);
            Assert.Equal(root, ledger.StreamingTarget); // output keeps its bubble
            Assert.Equal(new[] { "st-2" }, ledger.Pending.Select(p => p.SteeringId));

            // The later send still routes to its own bubble.
            var applied = ledger.Handle(new SteeringAck("st-2", SteeringAckStatus.Applied, false));
            Assert.Equal(second, applied.Entry!.UserMessageId);
        }

        [Fact]
        public void RejectionAfterAnEarlierApplyKeepsStreamingIntoThatContinuation()
        {
            var (ledger, _) = Turn();
            ledger.Add("st-1", Guid.NewGuid(), "one");
            var c1 = Guid.NewGuid();
            ledger.AttachContinuation(ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Applied, false)).Entry!, c1);

            ledger.Add("st-2", Guid.NewGuid(), "two");
            Assert.Equal(SteeringOutcomeKind.Rejected,
                ledger.Handle(new SteeringAck("st-2", SteeringAckStatus.Rejected, false, "x")).Kind);

            Assert.Equal(c1, ledger.StreamingTarget);
        }

        [Fact]
        public void UnknownStaleAndDuplicateAcksAreHarmless()
        {
            var (ledger, root) = Turn();
            Assert.Equal(SteeringOutcomeKind.None,
                ledger.Handle(new SteeringAck("nobody", SteeringAckStatus.Rejected, false, "x")).Kind);

            ledger.Add("st-1", Guid.NewGuid(), "one");
            var entry = ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Applied, false)).Entry!;
            ledger.AttachContinuation(entry, Guid.NewGuid());
            var target = ledger.StreamingTarget;

            // Late duplicates for an already-resolved id change nothing.
            Assert.Equal(SteeringOutcomeKind.None, ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Received, false)).Kind);
            Assert.Equal(SteeringOutcomeKind.None, ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Rejected, false)).Kind);
            Assert.Equal(target, ledger.StreamingTarget);

            // Legacy ack with nothing pending.
            Assert.Equal(SteeringOutcomeKind.None, ledger.Handle(new SteeringAck(null, SteeringAckStatus.Received, true)).Kind);

            // After the turn ends, acks from the old run do nothing.
            ledger.Add("st-2", Guid.NewGuid(), "two");
            ledger.EndTurn();
            Assert.Equal(SteeringOutcomeKind.None, ledger.Handle(new SteeringAck("st-2", SteeringAckStatus.Applied, false)).Kind);
            Assert.Null(ledger.StreamingTarget);
            Assert.False(ledger.IsTurn(root));
        }

        [Fact]
        public void DuplicateIdOrInactiveTurnIsNotRegistered()
        {
            var ledger = new SteeringLedger();
            Assert.False(ledger.Add("st-1", Guid.NewGuid(), "x")); // no turn
            ledger.BeginTurn(Guid.NewGuid());
            Assert.True(ledger.Add("st-1", Guid.NewGuid(), "x"));
            Assert.False(ledger.Add("st-1", Guid.NewGuid(), "y"));
            Assert.Single(ledger.Pending);
        }

        [Fact]
        public void LegacyAcksResolveTheOldestPendingSend()
        {
            var (ledger, _) = Turn();
            var first = Guid.NewGuid();
            ledger.Add("st-1", first, "one");
            ledger.Add("st-2", Guid.NewGuid(), "two");

            // Legacy servers never send `applied`: their receipt is final.
            var ack = ledger.Handle(new SteeringAck(null, SteeringAckStatus.Received, true));
            Assert.Equal(SteeringOutcomeKind.CreateContinuation, ack.Kind);
            Assert.Equal(first, ack.Entry!.UserMessageId);

            var reject = ledger.Handle(new SteeringAck(null, SteeringAckStatus.Rejected, true));
            Assert.Equal(SteeringOutcomeKind.Rejected, reject.Kind);
            Assert.Equal(SteeringAckParser.RejectedFallback, reject.Reason);
        }

        [Fact]
        public void InsertionAnchorFollowsLastPendingBubble()
        {
            var (ledger, root) = Turn();
            Assert.Equal(root, ledger.InsertionAnchor);
            var first = Guid.NewGuid();
            ledger.Add("st-1", first, "one");
            Assert.Equal(first, ledger.InsertionAnchor);

            var c1 = Guid.NewGuid();
            ledger.AttachContinuation(ledger.Handle(new SteeringAck("st-1", SteeringAckStatus.Applied, false)).Entry!, c1);
            Assert.Equal(c1, ledger.InsertionAnchor);
        }

        [Fact]
        public void TimeoutFailsOnlyUnacknowledgedSends()
        {
            var (ledger, _) = Turn();
            ledger.Add("queued", Guid.NewGuid(), "q");
            ledger.Add("silent", Guid.NewGuid(), "s");
            ledger.Handle(new SteeringAck("queued", SteeringAckStatus.Received, false));

            Assert.Null(ledger.FailIfUnacknowledged("queued")); // may wait for a running command
            Assert.Equal("s", ledger.FailIfUnacknowledged("silent")!.Text);
            Assert.Null(ledger.FailIfUnacknowledged("silent"));
            Assert.Equal(new[] { "queued" }, ledger.Pending.Select(p => p.SteeringId));
        }

        [Fact]
        public void SendFailureAndTurnEndReturnUnresolvedSendsForRestore()
        {
            var (ledger, root) = Turn();
            ledger.Add("st-1", Guid.NewGuid(), "one");
            ledger.Add("st-2", Guid.NewGuid(), "two");

            Assert.Equal("one", ledger.Fail("st-1")!.Text);
            Assert.Null(ledger.Fail("st-1"));

            Assert.True(ledger.IsTurn(root));
            var unresolved = ledger.EndTurn();
            Assert.Equal(new[] { "two" }, unresolved.Select(p => p.Text));
            Assert.Empty(ledger.Pending);
            Assert.False(ledger.IsActive);
        }

        [Fact]
        public void NewTurnResetsEverything()
        {
            var (ledger, _) = Turn();
            ledger.Add("st-1", Guid.NewGuid(), "one");
            var next = Guid.NewGuid();
            ledger.BeginTurn(next);
            Assert.Empty(ledger.Pending);
            Assert.Equal(next, ledger.StreamingTarget);
        }
    }
}
