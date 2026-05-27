using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// Single-instance VM for the WPF OmniAgent session page. Replaces
    /// the legacy WinForms <c>AgentThinkingForm</c>.
    ///
    /// Implements <see cref="IAgentSession"/> so <see cref="AgentRunner"/>
    /// can stream agent steps directly into the observable
    /// <see cref="Timeline"/>. Each callback adds one collapsible
    /// <see cref="AgentTimelineRow"/> — the page shows a one-line
    /// summary by default and the full text on expand, mirroring the
    /// ChatPage thinking-timeline pattern instead of dumping every
    /// reasoning + terminal block in full.
    /// </summary>
    internal sealed partial class AgentSessionViewModel : ObservableObject, IAgentSession
    {
        public static readonly AgentSessionViewModel Shared = new();

        private readonly ApiClient _api = new();
        private CancellationTokenSource? _runCts;

        /// <summary>
        /// While true, changes to <see cref="SelectedSessionId"/> do NOT
        /// fire a session-preview reload. Set during internal updates
        /// (constructor seed, post-run dropdown refresh, run kickoff)
        /// so the user's actual run state isn't clobbered by a redundant
        /// history fetch. User-initiated picks from the dropdown leave
        /// this false and therefore reload the preview as expected.
        /// </summary>
        private bool _suppressPreviewLoad;

        /// <summary>
        /// Dropdown sentinel that represents "start a new session". The
        /// empty Id is what <see cref="AgentRunner.RunAgentSessionAsync"/>
        /// treats as "mint a fresh session id".
        /// </summary>
        public static readonly AgentSessionInfo NewSessionSentinel = new()
        {
            Id = "",
            Title = "Start new session",
        };

        public ObservableCollection<AgentSessionInfo> AvailableSessions { get; } = new();
        public ObservableCollection<AgentTimelineRow> Timeline { get; } = new();
        public ObservableCollection<HistoryTurnRow> History { get; } = new();

        [ObservableProperty] private string? selectedSessionId;
        [ObservableProperty] private string statusText = "Idle";
        [ObservableProperty] private bool isRunning;
        [ObservableProperty] private bool isLoadingSessions;
        [ObservableProperty] private string? pendingRequestText;
        [ObservableProperty] private string? lastErrorMessage;

        /// <summary>The user's @omniAgent request that kicked off this run.</summary>
        [ObservableProperty] private string? requestText;

        /// <summary>The agent's final answer, populated on success.</summary>
        [ObservableProperty] private string? finalAnswer;

        [ObservableProperty] private bool justCopiedFinal;

        public bool HasRequest => !string.IsNullOrEmpty(RequestText);
        public bool HasFinalAnswer => !string.IsNullOrEmpty(FinalAnswer);
        public bool HasHistory => History.Count > 0;
        public bool HasError => !string.IsNullOrWhiteSpace(LastErrorMessage);

        public bool HasNoActivity =>
            !HasRequest
            && !HasFinalAnswer
            && Timeline.Count == 0
            && History.Count == 0
            && string.IsNullOrEmpty(PendingRequestText);

        /// <summary>
        /// Header pill: "Thinking…" / "Thought for N steps" — same
        /// vocabulary as ChatPage so the two pages feel consistent.
        /// </summary>
        public string ThinkingHeader =>
            IsRunning
                ? "Thinking…"
                : Timeline.Count switch
                {
                    0 => "No steps",
                    1 => "Thought for 1 step",
                    int n => $"Thought for {n} steps",
                };

        public bool HasTimeline => Timeline.Count > 0;

        /// <summary>
        /// True when the dropdown selection matches the stored default.
        /// Drives the "Set as default" / "Default ✓" toggle visuals.
        /// </summary>
        public bool SelectedIsDefault
        {
            get
            {
                var stored = AgentSessionPreferences.ReadDefaultSessionId();
                if (string.IsNullOrEmpty(stored)) return false;
                if (SelectedSessionId == "")
                    return stored == AgentSessionPreferences.NewSessionSentinel;
                return stored == SelectedSessionId;
            }
        }

        private AgentSessionViewModel()
        {
            AvailableSessions.Add(NewSessionSentinel);
            // Seed the dropdown to the stored default without triggering a
            // preview fetch — the dropdown is empty at this point so the
            // fetch would be wasted; LoadSessionsAsync will replay once
            // the page opens.
            _suppressPreviewLoad = true;
            try { SelectedSessionId = ResolveStoredDefaultId(); }
            finally { _suppressPreviewLoad = false; }
        }

        // ─── Public surface used by HotkeyForm / page ─────────────────────

        public void StartRunWithDefault(string requestTextValue)
        {
            if (Application.Current?.Dispatcher is { } d && !d.CheckAccess())
            {
                d.Invoke(() => StartRunWithDefault(requestTextValue));
                return;
            }

            string? defaultId = ResolveStoredDefaultId();
            _suppressPreviewLoad = true;
            try { SelectedSessionId = defaultId ?? ""; }
            finally { _suppressPreviewLoad = false; }
            _ = StartRunCoreAsync(requestTextValue, defaultId);
        }

        public void PreparePendingRun(string requestTextValue)
        {
            if (Application.Current?.Dispatcher is { } d && !d.CheckAccess())
            {
                d.Invoke(() => PreparePendingRun(requestTextValue));
                return;
            }

            PendingRequestText = requestTextValue;
            LastErrorMessage = null;
            _ = LoadSessionsAsync();
            NotifyComputed();
        }

        public async Task LoadSessionsAsync()
        {
            if (IsLoadingSessions) return;
            IsLoadingSessions = true;
            try
            {
                var fetched = await AgentSessionService.FetchSessionsAsync();
                ReplaceSessions(fetched);
            }
            catch
            {
                // Best-effort refresh — leave the existing list intact.
            }
            finally
            {
                IsLoadingSessions = false;
            }
        }

        [RelayCommand(CanExecute = nameof(CanStart))]
        private void Start()
        {
            string? text = PendingRequestText;
            if (string.IsNullOrWhiteSpace(text)) return;
            string? sessionId = string.IsNullOrEmpty(SelectedSessionId) ? null : SelectedSessionId;
            _ = StartRunCoreAsync(text, sessionId);
        }

        private bool CanStart() => !IsRunning && !string.IsNullOrWhiteSpace(PendingRequestText);

        [RelayCommand]
        private void Cancel()
        {
            AgentRunner.CancelCurrentSession();
            _runCts?.Cancel();
            IsRunning = false;
            StatusText = "Cancelled";
            OnPropertyChanged(nameof(ThinkingHeader));
        }

        [RelayCommand]
        private void ToggleSelectedAsDefault()
        {
            if (SelectedIsDefault)
            {
                AgentSessionPreferences.ClearDefaultSessionId();
            }
            else
            {
                string toPersist = SelectedSessionId switch
                {
                    null or "" => AgentSessionPreferences.NewSessionSentinel,
                    _ => SelectedSessionId,
                };
                AgentSessionPreferences.WriteDefaultSessionId(toPersist);
            }
            OnPropertyChanged(nameof(SelectedIsDefault));
        }

        [RelayCommand]
        private void DismissError() => LastErrorMessage = null;

        [RelayCommand]
        private void ClearTranscript()
        {
            if (IsRunning) return;
            Timeline.Clear();
            History.Clear();
            RequestText = null;
            FinalAnswer = null;
            PendingRequestText = null;
            NotifyComputed();
        }

        [RelayCommand]
        private void CopyFinalAnswer()
        {
            if (string.IsNullOrEmpty(FinalAnswer)) return;
            try { System.Windows.Clipboard.SetText(FinalAnswer); } catch { }
            JustCopiedFinal = true;
            var timer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(2),
            };
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                JustCopiedFinal = false;
            };
            timer.Start();
        }

        // ─── Run plumbing ────────────────────────────────────────────────

        private async Task StartRunCoreAsync(string requestTextValue, string? sessionId)
        {
            if (IsRunning) return;

            Timeline.Clear();
            History.Clear();
            FinalAnswer = null;
            LastErrorMessage = null;
            PendingRequestText = null;
            RequestText = requestTextValue;
            StatusText = $"Connecting to agent (session: {(string.IsNullOrEmpty(sessionId) ? "new" : Short(sessionId))})…";
            IsRunning = true;
            NotifyComputed();

            // Resuming an existing session: pull its prior conversation
            // and render as a collapsible history card.
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                try
                {
                    var prior = await _api.FetchSessionMessagesAsync(sessionId);
                    HydrateHistory(prior);
                }
                catch
                {
                    // Non-fatal — proceed with the live run regardless.
                }
            }

            _runCts = new CancellationTokenSource();
            var ct = _runCts.Token;

            StatusText = "Streaming…";
            OnPropertyChanged(nameof(ThinkingHeader));

            string result;
            try
            {
                result = await AgentRunner.RunAgentSessionAsync(requestTextValue, this, ct, sessionId);
            }
            catch (OperationCanceledException)
            {
                StatusText = "Cancelled";
                IsRunning = false;
                NotifyComputed();
                OnPropertyChanged(nameof(ThinkingHeader));
                return;
            }
            catch (Exception ex)
            {
                LastErrorMessage = ex.Message;
                StatusText = "Error";
                IsRunning = false;
                NotifyComputed();
                OnPropertyChanged(nameof(ThinkingHeader));
                return;
            }

            FinalAnswer = result;
            StatusText = "Finished";
            IsRunning = false;
            _ = LoadSessionsAsync();
            NotifyComputed();
            OnPropertyChanged(nameof(ThinkingHeader));
        }

        // ─── IAgentSession implementation ────────────────────────────────

        public void SetInitialRequest(string text) => OnUi(() =>
        {
            RequestText = text;
            NotifyComputed();
        });

        public void AppendAgentMessage(string text) => OnUi(() =>
        {
            Timeline.Add(new AgentTimelineRow(TimelineKind.Reasoning, (text ?? "").Trim()));
            BumpThinking();
        });

        public void AppendWebCall(string text) => OnUi(() =>
        {
            Timeline.Add(new AgentTimelineRow(TimelineKind.Web, StripWebPrefix(text ?? "")));
            BumpThinking();
        });

        public void AppendMcpCall(string text) => OnUi(() =>
        {
            Timeline.Add(new AgentTimelineRow(TimelineKind.Mcp, (text ?? "").Trim()));
            BumpThinking();
        });

        public void AppendTerminalOutput(string text) => OnUi(() =>
        {
            Timeline.Add(new AgentTimelineRow(TimelineKind.Terminal, text ?? ""));
            BumpThinking();
        });

        public void SetRunning(bool running) => OnUi(() =>
        {
            IsRunning = running;
            if (!running && string.IsNullOrEmpty(StatusText))
                StatusText = "Finished";
            OnPropertyChanged(nameof(ThinkingHeader));
        });

        private void BumpThinking()
        {
            NotifyComputed();
            OnPropertyChanged(nameof(ThinkingHeader));
            OnPropertyChanged(nameof(HasTimeline));
        }

        // ─── Session list / history helpers ──────────────────────────────

        private void ReplaceSessions(IList<AgentSessionInfo> fetched)
        {
            string? prevSelection = SelectedSessionId;
            AvailableSessions.Clear();
            AvailableSessions.Add(NewSessionSentinel);
            foreach (var s in fetched)
                AvailableSessions.Add(s);

            // Rebinding the dropdown items is internal — do not trigger a
            // preview fetch, that would clobber an in-progress run or a
            // just-finished result.
            _suppressPreviewLoad = true;
            try
            {
                if (prevSelection != null && AvailableSessions.Any(s => s.Id == prevSelection))
                    SelectedSessionId = prevSelection;
                else
                    SelectedSessionId = ResolveStoredDefaultId() ?? "";
            }
            finally { _suppressPreviewLoad = false; }

            OnPropertyChanged(nameof(SelectedIsDefault));
        }

        private void HydrateHistory(IList<SessionHistoryEntryDto> prior)
        {
            History.Clear();
            foreach (var entry in prior)
            {
                if (string.IsNullOrWhiteSpace(entry?.Text)) continue;
                string scrubbed;
                if (string.Equals(entry.Role, "assistant", StringComparison.OrdinalIgnoreCase))
                {
                    scrubbed = (AgentRunner.ExtractFinalAnswer(entry.Text)
                                ?? AgentRunner.CleanDisplayText(entry.Text)).Trim();
                }
                else
                {
                    scrubbed = AgentRunner.CleanDisplayText(entry.Text).Trim();
                }
                if (string.IsNullOrWhiteSpace(scrubbed)) continue;
                History.Add(new HistoryTurnRow(entry.Role ?? "", scrubbed));
            }
            OnPropertyChanged(nameof(HasHistory));
        }

        private static string? ResolveStoredDefaultId()
        {
            string? stored = AgentSessionPreferences.ReadDefaultSessionId();
            if (string.IsNullOrEmpty(stored)) return null;
            if (stored == AgentSessionPreferences.NewSessionSentinel) return "";
            return stored;
        }

        partial void OnSelectedSessionIdChanged(string? value)
        {
            OnPropertyChanged(nameof(SelectedIsDefault));
            if (_suppressPreviewLoad) return;
            _ = LoadSessionPreviewAsync(value);
        }

        /// <summary>
        /// Populate <see cref="RequestText"/>, <see cref="Timeline"/>, and
        /// <see cref="FinalAnswer"/> from the most recent user→assistant
        /// turn of <paramref name="sessionId"/>. Earlier turns are shown
        /// in the collapsible <see cref="History"/> card so the user can
        /// still see the full conversation context. Cleared when the
        /// dropdown lands on the "new session" sentinel. Skipped during
        /// a live run so the in-flight stream isn't overwritten.
        /// </summary>
        public async Task LoadSessionPreviewAsync(string? sessionId)
        {
            if (IsRunning) return;

            // "Start new session" sentinel → reset the preview surface so
            // the page shows its empty-state.
            if (string.IsNullOrEmpty(sessionId))
            {
                Timeline.Clear();
                History.Clear();
                RequestText = null;
                FinalAnswer = null;
                LastErrorMessage = null;
                PendingRequestText = null;
                StatusText = "Idle";
                NotifyComputed();
                OnPropertyChanged(nameof(ThinkingHeader));
                return;
            }

            StatusText = $"Loading session {Short(sessionId)}…";
            List<SessionHistoryEntryDto> entries;
            try
            {
                entries = await _api.FetchSessionMessagesAsync(sessionId);
            }
            catch (Exception ex)
            {
                LastErrorMessage = $"Couldn't load session history: {ex.Message}";
                StatusText = "Idle";
                return;
            }

            ApplySessionPreview(entries);
            StatusText = "Idle";
        }

        /// <summary>
        /// Decompose the fetched session entries into the page's three
        /// regions: the last user message becomes the request card, the
        /// last assistant turn's blocks become the live-style timeline +
        /// final-answer card, and everything before that is folded into
        /// the Previous Conversation expander.
        /// </summary>
        private void ApplySessionPreview(List<SessionHistoryEntryDto> entries)
        {
            Timeline.Clear();
            History.Clear();
            RequestText = null;
            FinalAnswer = null;

            if (entries == null || entries.Count == 0)
            {
                NotifyComputed();
                OnPropertyChanged(nameof(ThinkingHeader));
                return;
            }

            int lastAssistantIdx = -1;
            for (int i = entries.Count - 1; i >= 0; i--)
            {
                if (string.Equals(entries[i].Role, "assistant", StringComparison.OrdinalIgnoreCase))
                {
                    lastAssistantIdx = i;
                    break;
                }
            }

            int lastUserIdx = -1;
            int upperBound = lastAssistantIdx >= 0 ? lastAssistantIdx : entries.Count;
            for (int i = upperBound - 1; i >= 0; i--)
            {
                if (string.Equals(entries[i].Role, "user", StringComparison.OrdinalIgnoreCase))
                {
                    lastUserIdx = i;
                    break;
                }
            }

            // Anything before the last user→assistant pair goes into the
            // collapsible "Previous Conversation" expander.
            int earlierCutoff = lastUserIdx >= 0 ? lastUserIdx : lastAssistantIdx;
            if (earlierCutoff > 0)
                HydrateHistory(entries.Take(earlierCutoff).ToList());

            // Last user message → the prominent request card at top.
            if (lastUserIdx >= 0)
            {
                var userText = AgentRunner.CleanDisplayText(entries[lastUserIdx].Text).Trim();
                if (!string.IsNullOrWhiteSpace(userText))
                    RequestText = userText;
            }

            // Last assistant turn → its non-final blocks become timeline
            // rows; its final block becomes the FinalAnswer card.
            if (lastAssistantIdx >= 0)
            {
                IngestAssistantTurn(entries[lastAssistantIdx]);
            }

            NotifyComputed();
            OnPropertyChanged(nameof(ThinkingHeader));
        }

        private void IngestAssistantTurn(SessionHistoryEntryDto entry)
        {
            // Server already structured per-step blocks for us — use them
            // when present.
            if (entry.Blocks is { Count: > 0 } blocks)
            {
                foreach (var b in blocks)
                {
                    string text = b.Text ?? "";
                    if (string.Equals(b.Kind, "finalAnswer", StringComparison.Ordinal))
                    {
                        text = (AgentRunner.ExtractFinalAnswer(text) ?? AgentRunner.CleanDisplayText(text)).Trim();
                        if (!string.IsNullOrWhiteSpace(text)) FinalAnswer = text;
                        continue;
                    }

                    text = AgentRunner.CleanDisplayText(text).Trim();
                    if (string.IsNullOrWhiteSpace(text)) continue;

                    var kind = b.Kind switch
                    {
                        "webCall"        => TimelineKind.Web,
                        "mcpCall"        => TimelineKind.Mcp,
                        "terminalOutput" => TimelineKind.Terminal,
                        "shellCommand"   => TimelineKind.Terminal,
                        _                => TimelineKind.Reasoning,
                    };
                    Timeline.Add(new AgentTimelineRow(kind, text));
                }
                return;
            }

            // No structured blocks — fall back to the assistant's raw
            // text as the final answer.
            var raw = entry.Text ?? "";
            var fallback = (AgentRunner.ExtractFinalAnswer(raw) ?? AgentRunner.CleanDisplayText(raw)).Trim();
            if (!string.IsNullOrWhiteSpace(fallback))
                FinalAnswer = fallback;
        }

        partial void OnIsRunningChanged(bool value) =>
            StartCommand.NotifyCanExecuteChanged();

        partial void OnPendingRequestTextChanged(string? value) =>
            StartCommand.NotifyCanExecuteChanged();

        partial void OnLastErrorMessageChanged(string? value) =>
            OnPropertyChanged(nameof(HasError));

        partial void OnRequestTextChanged(string? value) =>
            OnPropertyChanged(nameof(HasRequest));

        partial void OnFinalAnswerChanged(string? value) =>
            OnPropertyChanged(nameof(HasFinalAnswer));

        private void NotifyComputed()
        {
            OnPropertyChanged(nameof(HasNoActivity));
            OnPropertyChanged(nameof(HasRequest));
            OnPropertyChanged(nameof(HasFinalAnswer));
            OnPropertyChanged(nameof(HasHistory));
            OnPropertyChanged(nameof(HasError));
            OnPropertyChanged(nameof(HasTimeline));
        }

        private static void OnUi(Action a)
        {
            var d = Application.Current?.Dispatcher;
            if (d == null) { a(); return; }
            if (d.CheckAccess()) a();
            else d.BeginInvoke(a);
        }

        private static string StripWebPrefix(string text)
        {
            string t = text.Trim();
            foreach (string prefix in new[] { "[web_search]", "[web_call]", "[web]" })
            {
                if (t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return t[prefix.Length..].TrimStart();
                }
            }
            return t;
        }

        private static string Short(string id)
        {
            if (string.IsNullOrEmpty(id)) return "";
            return id.Length > 8 ? id[..8] : id;
        }
    }
}
