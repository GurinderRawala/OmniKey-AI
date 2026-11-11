using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using OmniKey.Windows.Skills;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// The steering acknowledgement deadline only counts time during which the
    /// chat run can read frames. While ChatSessionRunner awaits a shell
    /// command (and its reply) the receive loop is blocked, so an ack the
    /// server already sent cannot arrive; that time must not expire the send.
    /// </summary>
    public class SteeringAckDeadlineTests
    {
        private sealed class FakeClock
        {
            public TimeSpan Now;
            public TimeSpan Get() => Now;
        }

        [Fact]
        public void BlockedIntervalsAreExcludedFromReceivingTime()
        {
            var clock = new FakeClock();
            var receive = new ReceiveAvailability(clock.Get);
            var mark = receive.Start();

            clock.Now += TimeSpan.FromSeconds(2);
            var scope = receive.Block();
            Assert.True(receive.IsBlocked);
            clock.Now += TimeSpan.FromSeconds(30); // long shell command
            Assert.Equal(TimeSpan.FromSeconds(2), receive.ReceivingSince(mark));

            var nested = receive.Block();
            nested.Dispose();
            Assert.True(receive.IsBlocked); // outer scope still blocks

            scope.Dispose();
            scope.Dispose(); // idempotent
            Assert.False(receive.IsBlocked);
            clock.Now += TimeSpan.FromSeconds(3);
            Assert.Equal(TimeSpan.FromSeconds(5), receive.ReceivingSince(mark));
        }

        [Fact]
        public void MarkTakenDuringABlockCountsOnlyTimeAfterItEnds()
        {
            var clock = new FakeClock();
            var receive = new ReceiveAvailability(clock.Get);
            receive.Block(); // never disposed in this test before the mark
            clock.Now += TimeSpan.FromSeconds(10);
            var mark = receive.Start();
            clock.Now += TimeSpan.FromSeconds(10);
            Assert.Equal(TimeSpan.Zero, receive.ReceivingSince(mark));
        }

        [Fact]
        public async Task DeadlineDoesNotExpireWhileACommandBlocksReception()
        {
            var clock = new FakeClock();
            var receive = new ReceiveAvailability(clock.Get);
            var budget = TimeSpan.FromSeconds(12);
            var slices = new List<TimeSpan>();
            IDisposable? shell = null;
            bool expiredWhileBlocked = false;

            // Each delay advances the fake clock. A shell command starts one
            // second in and runs for 60 s, then reception resumes.
            Task Delay(TimeSpan d)
            {
                slices.Add(d);
                Assert.True(d > TimeSpan.Zero && d <= SteeringAckDeadline.MaxSlice);
                clock.Now += d;
                if (clock.Now >= TimeSpan.FromSeconds(1) && shell is null && clock.Now < TimeSpan.FromSeconds(61))
                    shell = receive.Block();
                if (shell is not null && clock.Now >= TimeSpan.FromSeconds(61))
                {
                    shell.Dispose();
                    shell = new NoopScope(); // only once
                }
                return Task.CompletedTask;
            }

            var wait = SteeringAckDeadline.WaitAsync(receive, budget, Delay);
            await wait;
            expiredWhileBlocked = receive.IsBlocked;

            Assert.False(expiredWhileBlocked);
            // 1 s before the command + 60 s blocked + the remaining 11 s.
            Assert.Equal(TimeSpan.FromSeconds(72), clock.Now);
        }

        [Fact]
        public async Task DeadlineExpiresAfterTheBudgetWhenNothingBlocks()
        {
            var clock = new FakeClock();
            var receive = new ReceiveAvailability(clock.Get);
            await SteeringAckDeadline.WaitAsync(receive, TimeSpan.FromSeconds(12), d =>
            {
                clock.Now += d;
                return Task.CompletedTask;
            });
            Assert.Equal(TimeSpan.FromSeconds(12), clock.Now);
        }

        private sealed class NoopScope : IDisposable
        {
            public void Dispose() { }
        }
    }
}
