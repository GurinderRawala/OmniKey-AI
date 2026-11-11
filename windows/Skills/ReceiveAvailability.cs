using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace OmniKey.Windows.Skills
{
    /// <summary>
    /// Tracks when a run's receive loop cannot read frames because it is
    /// awaiting local work (a shell command and its terminal-output reply).
    /// Steering acknowledgements the server sends meanwhile sit unread in the
    /// socket, so an acknowledgement deadline must only count time during
    /// which frames could actually be received. Thread-safe.
    /// </summary>
    internal sealed class ReceiveAvailability
    {
        private readonly object _lock = new();
        private readonly Func<TimeSpan> _now;
        private int _blockedDepth;
        private TimeSpan _blockedSince;
        private TimeSpan _blockedTotal;

        public ReceiveAvailability(Func<TimeSpan>? now = null)
        {
            if (now is null)
            {
                var clock = Stopwatch.StartNew();
                now = () => clock.Elapsed;
            }
            _now = now;
        }

        public bool IsBlocked
        {
            get { lock (_lock) return _blockedDepth > 0; }
        }

        /// <summary>Marks reception blocked until the returned scope is
        /// disposed. Nested scopes are counted.</summary>
        public IDisposable Block()
        {
            lock (_lock)
            {
                if (_blockedDepth++ == 0)
                    _blockedSince = _now();
            }
            return new Scope(this);
        }

        private void Unblock()
        {
            lock (_lock)
            {
                if (_blockedDepth == 0) return;
                if (--_blockedDepth == 0)
                    _blockedTotal += _now() - _blockedSince;
            }
        }

        /// <summary>A point in time to measure receiving time from.</summary>
        public Mark Start()
        {
            lock (_lock) return new Mark(_now(), BlockedTotalLocked());
        }

        /// <summary>Time since <paramref name="mark"/> during which frames
        /// could be received (blocked intervals excluded).</summary>
        public TimeSpan ReceivingSince(Mark mark)
        {
            lock (_lock)
            {
                var elapsed = _now() - mark.At;
                var blocked = BlockedTotalLocked() - mark.BlockedTotal;
                var receiving = elapsed - blocked;
                return receiving < TimeSpan.Zero ? TimeSpan.Zero : receiving;
            }
        }

        private TimeSpan BlockedTotalLocked() =>
            _blockedDepth > 0 ? _blockedTotal + (_now() - _blockedSince) : _blockedTotal;

        internal readonly record struct Mark(TimeSpan At, TimeSpan BlockedTotal);

        private sealed class Scope : IDisposable
        {
            private ReceiveAvailability? _owner;
            public Scope(ReceiveAvailability owner) => _owner = owner;
            public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Unblock();
        }
    }

    internal static class SteeringAckDeadline
    {
        /// <summary>Upper bound on one wait slice, so a deadline paused by a
        /// long command is re-checked promptly once reception resumes.</summary>
        public static readonly TimeSpan MaxSlice = TimeSpan.FromSeconds(1);

        /// <summary>
        /// Completes once <paramref name="budget"/> of receiving time has
        /// elapsed since the call (time while reception is blocked does not
        /// count). Once the run ends nothing blocks reception any more, so the
        /// wait always finishes within <paramref name="budget"/> of that.
        /// </summary>
        public static async Task WaitAsync(
            ReceiveAvailability availability,
            TimeSpan budget,
            Func<TimeSpan, Task> delay)
        {
            var mark = availability.Start();
            while (true)
            {
                var remaining = budget - availability.ReceivingSince(mark);
                if (remaining <= TimeSpan.Zero) return;
                await delay(remaining < MaxSlice ? remaining : MaxSlice);
            }
        }
    }
}
