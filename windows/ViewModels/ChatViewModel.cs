using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// Thin observable wrapper around the singleton <see cref="ChatModel"/>.
    /// Re-projects model events onto WPF binding-friendly properties and
    /// observable collections so the XAML page can stay declarative.
    /// </summary>
    internal partial class ChatViewModel : ObservableObject
    {
        private readonly ChatModel _model = ChatModel.Shared;
        private readonly SynchronizationContext _ui;
        private bool _suppressSelectionFeedback;
        private bool _suppressDefaultTemplateFeedback;

        public ObservableCollection<AgentSessionInfo> Sessions { get; } = new();
        public ObservableCollection<ChatMessageRow> Messages { get; } = new();

        /// <summary>Group filter pills shown above the sidebar session list.
        /// First item is always the "All" pill (no filter). Selecting a pill
        /// updates <see cref="ChatModel.SelectedGroupFilter"/> and the
        /// <see cref="Sessions"/> / <see cref="SessionRows"/> collections
        /// reproject through the model's <c>FilteredSessions</c>.</summary>
        public ObservableCollection<GroupFilterRow> GroupFilters { get; } = new();

        /// <summary>Flattened, section-aware session list. When the visible
        /// sessions span multiple groups (filter = "All") a
        /// <see cref="SessionGroupHeaderRow"/> is emitted before each group's
        /// sessions; when a single group is in view, no headers are added.
        /// The sidebar ListBox binds to this so the UI stays declarative.</summary>
        public ObservableCollection<object> SessionRows { get; } = new();

        // Seed with the sentinel so the ComboBox can resolve its SelectedValue
        // (which defaults to "" for "no template active") on the very first
        // render, before SyncTaskTemplates has had a chance to run. Without
        // this seed, the dropdown briefly shows a blank cell after page load
        // until the model's templates arrive.
        public ObservableCollection<TaskTemplateDto> AvailableTaskTemplates { get; } = new() { NoTemplateSentinel };

        [ObservableProperty] private string activeSessionTitle = "New Chat";
        [ObservableProperty] private bool isRunning;
        [ObservableProperty] private bool isLoadingHistory;
        [ObservableProperty] private string? lastErrorMessage;
        [ObservableProperty] private string sessionSearchQuery = string.Empty;
        [ObservableProperty] private int trimmedOlderMessageCount;
        [ObservableProperty] private AgentSessionInfo? selectedSession;
        [ObservableProperty] private bool isSidebarCollapsed;

        /// <summary>
        /// Sentinel row injected at the top of <see cref="AvailableTaskTemplates"/>.
        /// Picking it from the dropdown clears the default — replacing the
        /// old "X" button next to the ComboBox — and it doubles as the
        /// visible selection when no real template is active.
        /// </summary>
        private static readonly TaskTemplateDto NoTemplateSentinel = new()
        {
            Id = "",
            Heading = "No task instructions",
        };

        /// <summary>
        /// Id-based binding for the default-task ComboBox. We can't bind
        /// SelectedItem to <see cref="TaskTemplateDto"/> directly because
        /// the model rebuilds the DTOs after every update, which makes
        /// the previous SelectedItem reference orphaned — the ComboBox
        /// then loses its selection and triggers a spurious clear on
        /// the very first user pick. Tracking by Id sidesteps that.
        /// </summary>
        public string? SelectedDefaultTemplateId
        {
            // Return the sentinel Id ("") when no template is active so the
            // ComboBox shows the "No task instructions" row instead of a
            // blank box.
            get => _model.DefaultTaskTemplate?.Id ?? NoTemplateSentinel.Id;
            set
            {
                // Ignore writes coming from the ComboBox while we're projecting
                // model state into AvailableTaskTemplates — Clear+Add transiently
                // leaves the ComboBox with no matching item, and its
                // auto-fired SelectionChanged would push a spurious null back
                // through this setter and wipe the default.
                if (_suppressDefaultTemplateFeedback) return;
                // Sentinel maps back to null on the model side.
                var normalized = string.IsNullOrEmpty(value) ? null : value;
                if (_model.DefaultTaskTemplate?.Id == normalized) return;
                _model.SetDefaultTaskTemplate(normalized);
            }
        }

        public string InputText
        {
            get => _model.InputText;
            set
            {
                if (_model.InputText == value) return;
                _model.InputText = value;
                OnPropertyChanged();
                SendCommand.NotifyCanExecuteChanged();
            }
        }

        public bool CanSend => !IsRunning && !string.IsNullOrWhiteSpace(InputText);
        public bool HasError => !string.IsNullOrWhiteSpace(LastErrorMessage);
        public bool HasGroups => GroupFilters.Count > 1; // sentinel "All" + at least one real
        public bool HasNoMessages => Messages.Count == 0;
        public bool HasSearchQuery => !string.IsNullOrWhiteSpace(SessionSearchQuery);
        public bool SidebarHasSessions => Sessions.Count > 0;

        /// <summary>Tooltip text for the context-window ring. Format mirrors
        /// macOS: "32k of 200k context tokens left".</summary>
        public string? ContextSummary
        {
            get
            {
                var s = _model.ActiveSession;
                if (s == null || s.ContextBudget <= 0) return null;
                return $"{FormatTokens(s.RemainingContextTokens)} of {FormatTokens(s.ContextBudget)} context tokens left";
            }
        }

        public bool HasContextSummary => ContextSummary is not null;

        /// <summary>Group name of the active session, for the small
        /// uppercase eyebrow above the conversation title. Null when the
        /// active session is ungrouped or no session is selected — the
        /// XAML hides the eyebrow in that case.</summary>
        public string? ActiveSessionGroup
        {
            get
            {
                var s = _model.ActiveSession;
                return string.IsNullOrWhiteSpace(s?.GroupName) ? null : s!.GroupName;
            }
        }

        public bool HasActiveSessionGroup => !string.IsNullOrEmpty(ActiveSessionGroup);

        /// <summary>Fraction of the context window already consumed, 0..1.</summary>
        public double ContextUsedFraction
        {
            get
            {
                var s = _model.ActiveSession;
                if (s == null || s.ContextBudget <= 0) return 0;
                double used = Math.Max(0, s.ContextBudget - s.RemainingContextTokens);
                return Math.Min(1, used / s.ContextBudget);
            }
        }

        /// <summary>Tint of the ring — green when there's plenty of headroom,
        /// amber as it fills, red near the limit. Mirrors macOS behavior so
        /// the user gets nudged toward starting a new chat before the
        /// backend truncates older turns.</summary>
        public Brush ContextRingBrush
        {
            get
            {
                var key = ContextUsedFraction switch
                {
                    < 0.6 => "Nord.AccentGreenBrush",
                    < 0.85 => "Nord.AccentAmberBrush",
                    _ => null,
                };
                if (key is not null)
                    return (Brush)System.Windows.Application.Current.Resources[key];
                return new SolidColorBrush(Color.FromRgb(252, 100, 100));
            }
        }

        private static string FormatTokens(int n)
        {
            if (n >= 1000) return (n / 1000.0).ToString("0.#") + "k";
            return n.ToString();
        }

        public Brush ErrorBrush => new SolidColorBrush(Color.FromRgb(252, 100, 100));

        public ChatViewModel()
        {
            _ui = SynchronizationContext.Current ?? new SynchronizationContext();
            _model.BindToCurrentThread();
            _model.StateChanged += OnModelStateChanged;
            ProjectFromModel();
        }

        public void Dispose()
        {
            _model.StateChanged -= OnModelStateChanged;
        }

        [RelayCommand]
        private void Load()
        {
            _model.RefreshSessions();
            _model.FetchDefaultTaskTemplate();
        }

        [RelayCommand]
        private void NewChat() => _model.StartNewChat();

        [RelayCommand]
        private void ToggleSidebar() => IsSidebarCollapsed = !IsSidebarCollapsed;

        [RelayCommand]
        private void OpenSession(AgentSessionInfo? session)
        {
            if (session is null) return;
            _model.OpenSession(session);
        }

        [RelayCommand]
        private void DeleteSession(AgentSessionInfo? session)
        {
            if (session is null) return;
            _model.DeleteSession(session);
        }

        [RelayCommand(CanExecute = nameof(CanSend))]
        private void Send()
        {
            _model.SendCurrentInput();
            OnPropertyChanged(nameof(InputText));
        }

        [RelayCommand]
        private void Cancel() => _model.CancelCurrentTurn();

        [RelayCommand]
        private void DismissError() => _model.DismissError();


        [RelayCommand]
        private void SelectGroup(string? groupName)
        {
            // Empty string from the "All" pill maps to null on the model
            // (no filter). Real group names pass through unchanged.
            _model.SelectedGroupFilter = string.IsNullOrEmpty(groupName) ? null : groupName;
        }

        [RelayCommand]
        private void ClearSearch() => _model.ClearSessionSearch();

        partial void OnSessionSearchQueryChanged(string value)
        {
            if (_model.SessionSearchQuery == value) return;
            _model.SessionSearchQuery = value;
            OnPropertyChanged(nameof(HasSearchQuery));
        }

        partial void OnSelectedSessionChanged(AgentSessionInfo? value)
        {
            if (_suppressSelectionFeedback) return;
            if (value is null) return;
            if (_model.ActiveSessionId == value.Id) return;
            _model.OpenSession(value);
        }

        partial void OnIsRunningChanged(bool value) => SendCommand.NotifyCanExecuteChanged();

        private void OnModelStateChanged(object? sender, EventArgs e) =>
            _ui.Post(_ => ProjectFromModel(), null);

        private void ProjectFromModel()
        {
            // Sessions list — filtered for search AND active group.
            var visible = _model.FilteredSessions;
            ReplaceCollection(Sessions, visible);

            // Group filter pills — keep the "All" sentinel + one row per
            // available group. IsSelected drives the pill's active visual.
            SyncGroupFilters(_model.AvailableGroups, _model.SelectedGroupFilter);

            // Sectioned session rows: when more than one group is visible
            // (i.e. the user hasn't picked a specific group filter and the
            // backend reports multiple) inject uppercase eyebrow headers
            // so the sidebar reads like a tidy contact list.
            RebuildSessionRows(visible);

            // Active session sync (without re-entering OpenSession)
            var active = _model.ActiveSession;
            if (!ReferenceEquals(SelectedSession, active))
            {
                _suppressSelectionFeedback = true;
                try { SelectedSession = active; }
                finally { _suppressSelectionFeedback = false; }
            }

            // Messages — project with streaming flag on the last assistant turn.
            int lastIndex = _model.Messages.Count - 1;
            var rows = new List<ChatMessageRow>(_model.Messages.Count);
            for (int i = 0; i < _model.Messages.Count; i++)
            {
                bool streaming = _model.IsRunning && i == lastIndex
                    && _model.Messages[i].Role == ChatMessageRole.Assistant;
                rows.Add(ChatMessageRow.Create(_model.Messages[i], streaming));
            }
            ReplaceCollection(Messages, rows);

            // Templates list — keep existing item references when only the
            // Default flag changed. Replacing the items wholesale forces the
            // ComboBox to re-resolve its SelectedItem from SelectedValue,
            // which it doesn't always do reliably (the displayed selection
            // would only show on the second click). Diffing by Id avoids the
            // churn entirely.
            _suppressDefaultTemplateFeedback = true;
            try
            {
                SyncTaskTemplates(_model.AvailableTaskTemplates);
                OnPropertyChanged(nameof(SelectedDefaultTemplateId));
            }
            finally
            {
                _suppressDefaultTemplateFeedback = false;
            }

            // Scalar properties
            ActiveSessionTitle = _model.ActiveSessionTitle;
            IsRunning = _model.IsRunning;
            IsLoadingHistory = _model.IsLoadingSessionHistory;
            LastErrorMessage = _model.LastErrorMessage;
            TrimmedOlderMessageCount = _model.TrimmedOlderMessageCount;
            OnPropertyChanged(nameof(InputText));
            OnPropertyChanged(nameof(HasError));
            OnPropertyChanged(nameof(CanSend));
            OnPropertyChanged(nameof(HasNoMessages));
            OnPropertyChanged(nameof(SidebarHasSessions));
            OnPropertyChanged(nameof(HasSearchQuery));
            OnPropertyChanged(nameof(ContextSummary));
            OnPropertyChanged(nameof(HasContextSummary));
            OnPropertyChanged(nameof(ContextUsedFraction));
            OnPropertyChanged(nameof(ContextRingBrush));
            OnPropertyChanged(nameof(HasGroups));
            OnPropertyChanged(nameof(ActiveSessionGroup));
            OnPropertyChanged(nameof(HasActiveSessionGroup));
        }

        private static void ReplaceCollection<T>(ObservableCollection<T> target, IList<T> source)
        {
            target.Clear();
            foreach (var item in source) target.Add(item);
        }

        /// <summary>
        /// Diff <see cref="AvailableTaskTemplates"/> against the model's list
        /// by Id, so a "set default" round-trip — which only flips IsDefault
        /// on every item — doesn't tear down the ComboBox's ItemsSource. The
        /// ComboBox keeps its SelectedItem reference and the user's choice
        /// renders on the first click.
        /// </summary>
        private void SyncTaskTemplates(IList<TaskTemplateDto> source)
        {
            // The collection bound to the ComboBox is always [sentinel, ...source].
            // Diff against that shape so a "set default" round-trip that only
            // flips IsDefault on each item doesn't tear down the ItemsSource.
            if (AvailableTaskTemplates.Count == source.Count + 1
                && ReferenceEquals(AvailableTaskTemplates[0], NoTemplateSentinel))
            {
                bool sameOrder = true;
                for (int i = 0; i < source.Count; i++)
                {
                    if (AvailableTaskTemplates[i + 1].Id != source[i].Id) { sameOrder = false; break; }
                }
                if (sameOrder) return;
            }

            AvailableTaskTemplates.Clear();
            AvailableTaskTemplates.Add(NoTemplateSentinel);
            foreach (var item in source) AvailableTaskTemplates.Add(item);
        }

        private void SyncGroupFilters(IList<AgentGroupInfo> source, string? selected)
        {
            // Re-use existing items when possible so the ItemsControl doesn't
            // tear down/rebuild the visual rows on every model tick.
            // Layout: [All, group1, group2, ...].
            int desired = 1 + source.Count;

            // Sentinel "All" pill — always at index 0.
            if (GroupFilters.Count == 0)
            {
                GroupFilters.Add(new GroupFilterRow(null, "All", null));
            }
            else
            {
                GroupFilters[0].IsSelected = string.IsNullOrEmpty(selected);
            }

            for (int i = 0; i < source.Count; i++)
            {
                var g = source[i];
                int slot = i + 1;
                if (slot < GroupFilters.Count)
                {
                    var row = GroupFilters[slot];
                    if (row.GroupName != g.GroupName)
                    {
                        row.GroupName = g.GroupName;
                        row.DisplayName = g.GroupName;
                        row.Description = g.GroupDescription;
                    }
                    else
                    {
                        row.Description = g.GroupDescription;
                    }
                    row.IsSelected = string.Equals(selected, g.GroupName, StringComparison.Ordinal);
                }
                else
                {
                    GroupFilters.Add(new GroupFilterRow(
                        g.GroupName,
                        g.GroupName,
                        g.GroupDescription)
                    {
                        IsSelected = string.Equals(selected, g.GroupName, StringComparison.Ordinal),
                    });
                }
            }

            // Trim any extra rows from a previous larger list.
            while (GroupFilters.Count > desired)
                GroupFilters.RemoveAt(GroupFilters.Count - 1);
        }

        private void RebuildSessionRows(IList<AgentSessionInfo> visible)
        {
            SessionRows.Clear();

            // Decide whether to inject section headers. Headers appear when
            // we're showing the unfiltered "All" view AND the visible
            // sessions actually span multiple groups — matches macOS.
            bool filterActive = !string.IsNullOrEmpty(_model.SelectedGroupFilter);
            var distinct = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in visible)
                distinct.Add(s.GroupName ?? "");
            bool injectHeaders = !filterActive && distinct.Count > 1;

            string? currentHeader = null;
            foreach (var s in visible)
            {
                if (injectHeaders)
                {
                    string headerKey = s.GroupName ?? "";
                    if (currentHeader != headerKey)
                    {
                        currentHeader = headerKey;
                        SessionRows.Add(new SessionGroupHeaderRow
                        {
                            GroupName = string.IsNullOrEmpty(s.GroupName)
                                ? "Ungrouped"
                                : s.GroupName!,
                        });
                    }
                }
                SessionRows.Add(s);
            }
        }
    }

    /// <summary>One pill in the sidebar group filter strip. Mutating
    /// <see cref="IsSelected"/> swaps its fill / foreground brushes via the
    /// XAML data triggers — no template rebuilds.</summary>
    internal sealed partial class GroupFilterRow : ObservableObject
    {
        public string? GroupName { get; set; }
        [ObservableProperty] private string displayName = "";
        [ObservableProperty] private string? description;
        [ObservableProperty] private bool isSelected;

        public GroupFilterRow(string? groupName, string displayName, string? description)
        {
            GroupName = groupName;
            DisplayName = displayName;
            Description = description;
        }
    }

    /// <summary>Section header injected between groups in the sessions
    /// ListBox when the unfiltered "All" view spans multiple groups.</summary>
    internal sealed class SessionGroupHeaderRow
    {
        public string GroupName { get; set; } = "";
    }

    /// <summary>
    /// Single row in the chat transcript. Wraps a <see cref="ChatMessage"/> and
    /// pre-splits its blocks into "thinking" (non-final) and the single FinalAnswer
    /// so the XAML can render the collapsible timeline + answer panel separately.
    /// </summary>
    internal sealed partial class ChatMessageRow : ObservableObject
    {
        public ChatMessage Source { get; }
        public ChatMessageRole Role => Source.Role;
        public string Text => Source.Text;
        public bool IsStreaming { get; }

        public bool IsUser => Role == ChatMessageRole.User;
        public bool IsAssistant => Role == ChatMessageRole.Assistant;
        public bool IsSystem => Role == ChatMessageRole.System;

        public bool HasPlainText => !string.IsNullOrWhiteSpace(Text);

        public IReadOnlyList<ChatBlockRow> ThinkingBlocks { get; }
        public ChatBlockRow? FinalAnswer { get; }

        public bool HasThinking => ThinkingBlocks.Count > 0;
        public bool HasFinalAnswer => FinalAnswer is not null;
        public bool IsAwaitingFirstBlock => IsAssistant && IsStreaming && !HasThinking && !HasFinalAnswer && !HasPlainText;

        public string ThinkingHeaderText =>
            IsStreaming
                ? "Thinking…"
                : ThinkingBlocks.Count switch
                {
                    0 => "Thought",
                    1 => "Thought for 1 step",
                    int n => $"Thought for {n} steps",
                };

        [ObservableProperty] private bool isThinkingExpanded;

        [ObservableProperty] private bool justCopied;

        [RelayCommand]
        private void ToggleThinkingExpanded() => IsThinkingExpanded = !IsThinkingExpanded;

        /// <summary>
        /// Copies the user-visible text of this row to the clipboard:
        /// the message body for user turns, the final-answer text for
        /// assistant turns. Briefly flips <see cref="JustCopied"/> so the
        /// XAML can swap the icon to a checkmark for two seconds.
        /// </summary>
        [RelayCommand]
        private void CopyVisibleText()
        {
            string? text = IsUser
                ? Text
                : (FinalAnswer?.Text ?? Text);
            if (string.IsNullOrEmpty(text)) return;

            try { System.Windows.Clipboard.SetText(text); }
            catch { /* clipboard can throw transiently — swallow */ }

            JustCopied = true;
            var timer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = System.TimeSpan.FromSeconds(2),
            };
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                JustCopied = false;
            };
            timer.Start();
        }

        private ChatMessageRow(ChatMessage source, bool isStreaming)
        {
            Source = source;
            IsStreaming = isStreaming;
            var thinking = new List<ChatBlockRow>();
            ChatBlockRow? final = null;
            for (int i = 0; i < source.Blocks.Count; i++)
            {
                var b = source.Blocks[i];
                var isLast = i == source.Blocks.Count - 1;
                var streamingThis = isStreaming && isLast && b.Kind != ChatBlockKind.FinalAnswer;
                var row = new ChatBlockRow(b, streamingThis);
                if (b.Kind == ChatBlockKind.FinalAnswer && final is null)
                    final = row;
                else
                    thinking.Add(row);
            }
            ThinkingBlocks = thinking;
            FinalAnswer = final;
        }

        public static ChatMessageRow Create(ChatMessage m, bool isStreaming = false) => new(m, isStreaming);
    }

    /// <summary>
    /// One streamed block. Holds per-kind icon + accent metadata so the XAML
    /// timeline row can stay declarative.
    /// </summary>
    internal sealed partial class ChatBlockRow : ObservableObject
    {
        public ChatBlock Source { get; }
        public ChatBlockKind Kind => Source.Kind;
        public string Text => Source.Text;
        public bool IsActive { get; }

        [ObservableProperty] private bool isExpanded;

        public string Label => Kind switch
        {
            ChatBlockKind.AgentReasoning => "Reasoning",
            ChatBlockKind.ShellCommand => "Command",
            ChatBlockKind.TerminalOutput => "Output",
            ChatBlockKind.WebCall => "Web Search",
            ChatBlockKind.McpCall => "MCP Call",
            ChatBlockKind.ImageRendering => "Image",
            ChatBlockKind.FinalAnswer => "Answer",
            _ => Kind.ToString(),
        };

        /// <summary>Fluent system icon name for the block kind.</summary>
        public string IconGlyph => Kind switch
        {
            ChatBlockKind.AgentReasoning => "BrainCircuit24",
            ChatBlockKind.ShellCommand => "WindowConsole20",
            ChatBlockKind.TerminalOutput => "WindowDevTools20",
            ChatBlockKind.WebCall => "Globe24",
            ChatBlockKind.McpCall => "Server24",
            ChatBlockKind.ImageRendering => "Image24",
            ChatBlockKind.FinalAnswer => "CheckmarkCircle24",
            _ => "Circle24",
        };

        /// <summary>Compact preview (first non-empty line, capped at 120 chars).</summary>
        public string Summary
        {
            get
            {
                var raw = Text?.Trim() ?? string.Empty;
                if (raw.Length == 0) return string.Empty;
                var firstLine = raw.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                                   .FirstOrDefault(line => !string.IsNullOrWhiteSpace(line)) ?? string.Empty;
                var s = firstLine.Trim();
                if (s.Length == 0) s = raw;
                return s.Length > 120 ? s[..120] + "…" : s;
            }
        }

        public Brush AccentBrush => Kind switch
        {
            ChatBlockKind.AgentReasoning => GetBrush("Nord.AccentPurpleBrush"),
            ChatBlockKind.ShellCommand => GetBrush("Nord.AccentBrush"),
            ChatBlockKind.TerminalOutput => GetBrush("Nord.SecondaryTextBrush"),
            ChatBlockKind.WebCall => GetBrush("Nord.AccentBlueBrush"),
            ChatBlockKind.McpCall => GetBrush("Nord.AccentAmberBrush"),
            ChatBlockKind.ImageRendering => GetBrush("Nord.AccentGreenBrush"),
            ChatBlockKind.FinalAnswer => GetBrush("Nord.AccentGreenBrush"),
            _ => GetBrush("Nord.SecondaryTextBrush"),
        };

        public bool IsCode => Kind is ChatBlockKind.ShellCommand or ChatBlockKind.TerminalOutput;
        public bool IsReasoning => Kind == ChatBlockKind.AgentReasoning;
        public bool IsFinalAnswer => Kind == ChatBlockKind.FinalAnswer;
        public bool IsExternalCall => Kind is ChatBlockKind.WebCall or ChatBlockKind.McpCall;
        public bool IsImage => Kind == ChatBlockKind.ImageRendering;

        public ChatBlockRow(ChatBlock source, bool isActive = false)
        {
            Source = source;
            IsActive = isActive;
        }

        [RelayCommand]
        private void Toggle() => IsExpanded = !IsExpanded;

        private static Brush GetBrush(string key) =>
            (Brush)System.Windows.Application.Current.Resources[key];
    }
}
