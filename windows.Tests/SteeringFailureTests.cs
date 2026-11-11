using System;
using System.Collections.Generic;
using System.Linq;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// A steering update that is not applied must never lose the user's
    /// exact text and must never overwrite what they are typing.
    /// <see cref="SteeringFailureResolver"/> is the helper ChatModel calls for
    /// every failure path (rejected ack, send failure, ack timeout, turn end,
    /// Stop). <see cref="Chat"/> reproduces ChatModel's glue around the ledger
    /// and resolver (ChatModel itself needs WPF and isn't compiled here).
    /// </summary>
    public class SteeringFailureTests
    {
        private sealed class Msg
        {
            public Guid Id { get; } = Guid.NewGuid();
            public bool IsUser { get; init; }
            public bool IsSteering { get; init; }
            public string Text { get; init; } = "";
            public string? Failure { get; set; }
            public List<string> Blocks { get; } = new();
        }

        /// <summary>Same calls and order as ChatModel: SendCurrentInput,
        /// SendSteeringInput, handleSteeringAck, rejectSteering,
        /// endTurnSteering, CancelCurrentTurn, and the IsTurn guards on every
        /// run callback.</summary>
        private sealed class Chat
        {
            public readonly List<Msg> Messages = new();
            public readonly SteeringLedger Steering = new();
            public string Composer = "";
            public string? Error;
            public bool IsActive = true;

            public Guid Send(string text)
            {
                var root = new Msg();
                Messages.Add(new Msg { IsUser = true, Text = text });
                Messages.Add(root);
                Steering.BeginTurn(root.Id);
                return root.Id;
            }

            public string Steer(string text)
            {
                int anchor = Messages.FindIndex(m => m.Id == Steering.InsertionAnchor);
                while (anchor + 1 < Messages.Count && Messages[anchor + 1] is { IsSteering: true, Failure: not null })
                    anchor++;
                var bubble = new Msg { IsUser = true, IsSteering = true, Text = text };
                string id = Guid.NewGuid().ToString();
                Messages.Insert(anchor + 1, bubble);
                Assert.True(Steering.Add(id, bubble.Id, text));
                return id;
            }

            public void Ack(Guid turnRoot, SteeringAck ack)
            {
                if (!Steering.IsTurn(turnRoot)) return;
                var outcome = Steering.Handle(ack);
                if (outcome.Kind == SteeringOutcomeKind.CreateContinuation && outcome.Entry is { } applied)
                {
                    int i = Messages.FindIndex(m => m.Id == applied.UserMessageId);
                    var continuation = new Msg();
                    Messages.Insert(i + 1, continuation);
                    Steering.AttachContinuation(applied, continuation.Id);
                }
                else if (outcome.Kind == SteeringOutcomeKind.Rejected && outcome.Entry is { } rejected)
                {
                    Reject(new[] { rejected }, outcome.Reason);
                }
            }

            public void Block(Guid turnRoot, string block)
            {
                if (!Steering.IsTurn(turnRoot)) return;
                Messages.Single(m => m.Id == Steering.StreamingTarget).Blocks.Add(block);
            }

            public void Final(Guid turnRoot, string reason)
            {
                if (!Steering.IsTurn(turnRoot)) return;
                Block(turnRoot, "final");
                Reject(Steering.EndTurn(), reason);
            }

            public void Stop() => Reject(Steering.EndTurn(), "stopped");

            public void Reject(IReadOnlyList<PendingSteering> entries, string reason)
            {
                if (entries.Count == 0) return;
                var plan = SteeringFailureResolver.Resolve(
                    Messages, m => m.Id, (m, why) => m.Failure = why,
                    e => new Msg { IsUser = true, IsSteering = true, Text = e.Text },
                    entries, reason, IsActive, Composer);
                if (plan.ComposerText is { } restored) Composer = restored;
                if (plan.ShowReason) Error = reason;
            }

            public Msg Bubble(string text) => Messages.Single(m => m.IsSteering && m.Text == text);
        }

        private static SteeringAck Rejected(string id, string reason = "Skills blocked this update.") =>
            new(id, SteeringAckStatus.Rejected, false, reason);

        [Fact]
        public void VisibleEmptyComposerRestoresTextAndKeepsFailedBubble()
        {
            var chat = new Chat();
            var root = chat.Send("task");
            string a = chat.Steer("use the deploy skill");

            chat.Ack(root, new SteeringAck(a, SteeringAckStatus.Received, false));
            chat.Ack(root, Rejected(a));

            Assert.Equal("use the deploy skill", chat.Composer);
            Assert.Equal("Skills blocked this update.", chat.Error);
            var bubble = chat.Bubble("use the deploy skill");
            Assert.Equal("Skills blocked this update.", bubble.Failure);
        }

        [Fact]
        public void TypingIsNeverOverwrittenAndTheFailedTextStaysVisible()
        {
            var chat = new Chat();
            var root = chat.Send("task");
            string a = chat.Steer("message A");
            chat.Composer = "half-typed B";

            chat.Ack(root, Rejected(a));

            Assert.Equal("half-typed B", chat.Composer);
            Assert.Equal("message A", chat.Bubble("message A").Text);
            Assert.NotNull(chat.Bubble("message A").Failure);
            Assert.Equal("Skills blocked this update.", chat.Error);
        }

        [Fact]
        public void BackgroundSessionKeepsFailedBubbleWithoutTouchingComposerOrBanner()
        {
            var chat = new Chat { IsActive = false, Composer = "" };
            var root = chat.Send("task");
            string a = chat.Steer("background update");

            chat.Ack(root, Rejected(a));

            Assert.Equal("", chat.Composer);
            Assert.Null(chat.Error);
            Assert.Equal("Skills blocked this update.", chat.Bubble("background update").Failure);
        }

        [Theory]
        [InlineData(true)]  // the turn finished
        [InlineData(false)] // the user pressed Stop
        public void SeveralUnresolvedAtTurnEndAreAllKeptAndOnlyTheOldestIsRestored(bool finished)
        {
            var chat = new Chat();
            var root = chat.Send("task");
            chat.Steer("first");
            chat.Steer("second");
            chat.Steer("third");

            if (finished) chat.Final(root, "ended"); else chat.Stop();

            Assert.Equal("first", chat.Composer);
            foreach (var text in new[] { "first", "second", "third" })
                Assert.NotNull(chat.Bubble(text).Failure);
            Assert.Equal(new[] { "first", "second", "third" },
                chat.Messages.Where(m => m.IsSteering).Select(m => m.Text));
        }

        [Fact]
        public void SeveralUnresolvedWhileTypingRestoreNothing()
        {
            var chat = new Chat();
            var root = chat.Send("task");
            chat.Steer("first");
            chat.Steer("second");
            chat.Composer = "draft";

            chat.Final(root, "ended");

            Assert.Equal("draft", chat.Composer);
            Assert.All(chat.Messages.Where(m => m.IsSteering), m => Assert.Equal("ended", m.Failure));
        }

        [Fact]
        public void AMissingBubbleIsReAddedWithTheExactText()
        {
            var chat = new Chat { Composer = "typing" };
            var root = chat.Send("task");
            string a = chat.Steer("  exact\ttext ✓ ");
            chat.Messages.RemoveAll(m => m.IsSteering);

            chat.Ack(root, Rejected(a));

            var readded = chat.Bubble("  exact\ttext ✓ ");
            Assert.NotNull(readded.Failure);
            Assert.Equal("typing", chat.Composer);
        }

        [Fact]
        public void FailureKeepsAppliedContinuationAndStreamingTarget()
        {
            var chat = new Chat();
            var root = chat.Send("task");
            string a = chat.Steer("applied one");
            chat.Ack(root, new SteeringAck(a, SteeringAckStatus.Applied, false));
            chat.Block(root, "continuation block");
            Guid? target = chat.Steering.StreamingTarget;

            string b = chat.Steer("rejected one");
            chat.Ack(root, Rejected(b));
            chat.Block(root, "after rejection");

            Assert.Equal(target, chat.Steering.StreamingTarget);
            Assert.Equal(new[] { "continuation block", "after rejection" },
                chat.Messages.Single(m => m.Id == target).Blocks);
            Assert.Null(chat.Bubble("applied one").Failure);
            Assert.NotNull(chat.Bubble("rejected one").Failure);

            // A later send goes after the failed bubble and routes normally.
            string c = chat.Steer("later");
            var steering = chat.Messages.Where(m => m.IsSteering).Select(m => m.Text).ToArray();
            Assert.Equal(new[] { "applied one", "rejected one", "later" }, steering);
            chat.Ack(root, new SteeringAck(c, SteeringAckStatus.Applied, false));
            Assert.Null(chat.Bubble("later").Failure);
        }

        [Fact]
        public void EmptyFailureListChangesNothing()
        {
            var messages = new List<Msg>();
            var plan = SteeringFailureResolver.Resolve(
                messages, m => m.Id, (m, r) => m.Failure = r, e => new Msg(),
                Array.Empty<PendingSteering>(), "x", true, "");
            Assert.Equal(new SteeringFailurePlan(null, null, false), plan);
            Assert.Empty(messages);
        }

        [Fact]
        public void BlankReasonUsesFallback()
        {
            var chat = new Chat();
            var root = chat.Send("task");
            chat.Steer("x");
            chat.Reject(chat.Steering.EndTurn(), " ");
            Assert.Equal(SteeringAckParser.RejectedFallback, chat.Bubble("x").Failure);
        }

        // ── Old run callbacks after Stop + new send ─────────────────────

        [Fact]
        public void CallbacksFromAStoppedRunNeverTouchTheNewTurn()
        {
            var chat = new Chat();
            var oldRoot = chat.Send("first task");
            chat.Stop();

            var newRoot = chat.Send("second task");
            chat.Steer("new pending");

            // Late frames from the stopped run.
            chat.Block(oldRoot, "stale block");
            chat.Ack(oldRoot, new SteeringAck(null, SteeringAckStatus.Received, true)); // legacy, no id
            chat.Final(oldRoot, "old run ended");

            Assert.True(chat.Steering.IsTurn(newRoot));
            Assert.Single(chat.Steering.Pending);
            Assert.Null(chat.Bubble("new pending").Failure);
            Assert.DoesNotContain(chat.Messages, m => m.Blocks.Contains("stale block"));
            Assert.Equal(newRoot, chat.Steering.StreamingTarget);

            // The current run still works.
            chat.Block(newRoot, "fresh");
            Assert.Equal(new[] { "fresh" }, chat.Messages.Single(m => m.Id == newRoot).Blocks);
        }
    }
}
