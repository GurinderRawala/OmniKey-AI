using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// One row in the job-run history list. Wraps a <see cref="ScheduledJobDto"/>
    /// and exposes display-friendly properties (timestamp, status badge,
    /// prompt excerpt) for the master list.
    /// </summary>
    internal sealed partial class JobRunHistoryRow : ObservableObject
    {
        public ScheduledJobDto Job { get; }

        public string JobId => Job.Id;
        public string Label => string.IsNullOrWhiteSpace(Job.Label) ? "(untitled job)" : Job.Label;
        public string SessionId => Job.LastRunSessionId ?? string.Empty;
        public bool HasSession => !string.IsNullOrWhiteSpace(Job.LastRunSessionId);
        public bool HasRun => !string.IsNullOrWhiteSpace(Job.LastRunAt) || HasSession;

        public string TimestampDisplay
        {
            get
            {
                if (string.IsNullOrWhiteSpace(Job.LastRunAt)) return "Never run";
                if (DateTime.TryParse(
                        Job.LastRunAt,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                        out var utc))
                {
                    return utc.ToLocalTime().ToString("MMM d, yyyy  h:mm tt", CultureInfo.CurrentCulture);
                }
                return Job.LastRunAt!;
            }
        }

        public string PromptExcerpt
        {
            get
            {
                var p = (Job.Prompt ?? string.Empty).Replace("\r", " ").Replace("\n", " ").Trim();
                if (p.Length <= 140) return p;
                return p[..140] + "…";
            }
        }

        // ── Status badge ──
        public string StatusText => HasRun ? "Completed" : "No run yet";
        public string StatusSymbol => HasRun ? "CheckmarkCircle24" : "Circle24";

        public Brush StatusBrush => HasRun
            ? (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"]
            : (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"];

        public JobRunHistoryRow(ScheduledJobDto job) => Job = job;
    }

    /// <summary>
    /// One rendered section of a session transcript (final answer, prompt,
    /// reasoning step, or tool output). The view templates these into the
    /// detail pane.
    /// </summary>
    internal sealed class TranscriptSection
    {
        public string Header { get; init; } = string.Empty;
        public string Body { get; init; } = string.Empty;
        public Brush HeaderBrush { get; init; } =
            (Brush)System.Windows.Application.Current.Resources["Nord.PrimaryTextBrush"];
        public string HeaderSymbol { get; init; } = "DocumentText24";
        /// <summary>True for the Final Answer card so the view can show
        /// the inline copy-icon button at its top-right.</summary>
        public bool IsFinalAnswer { get; init; }
    }

    internal partial class JobRunHistoryViewModel : ObservableObject
    {
        private readonly ApiClient _api = new();

        public ObservableCollection<JobRunHistoryRow> Runs { get; } = new();
        public ObservableCollection<TranscriptSection> TranscriptSections { get; } = new();

        [ObservableProperty]
        private JobRunHistoryRow? selectedRun;

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isLoadingList;

        [ObservableProperty]
        private bool isLoadingDetail;

        [ObservableProperty]
        private string? finalAnswer;

        [ObservableProperty]
        private string detailHeading = "Select a run to view its transcript";

        [ObservableProperty]
        private string detailSubheading = string.Empty;

        public bool HasRuns => Runs.Count > 0;
        public bool HasSelection => SelectedRun is not null;
        public bool HasFinalAnswer => !string.IsNullOrWhiteSpace(FinalAnswer);
        public bool HasTranscript => TranscriptSections.Count > 0;
        public bool ShowEmptyDetail => SelectedRun is null && !IsLoadingDetail;
        public bool ShowEmptyList => !IsLoadingList && Runs.Count == 0;

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        public JobRunHistoryViewModel()
        {
            Runs.CollectionChanged += (_, _) =>
            {
                OnPropertyChanged(nameof(HasRuns));
                OnPropertyChanged(nameof(ShowEmptyList));
            };
            TranscriptSections.CollectionChanged += (_, _) =>
                OnPropertyChanged(nameof(HasTranscript));
        }

        partial void OnStatusKindChanged(StatusKind value) => OnPropertyChanged(nameof(StatusBrush));

        partial void OnIsLoadingListChanged(bool value) => OnPropertyChanged(nameof(ShowEmptyList));

        partial void OnIsLoadingDetailChanged(bool value) => OnPropertyChanged(nameof(ShowEmptyDetail));

        partial void OnFinalAnswerChanged(string? value)
        {
            OnPropertyChanged(nameof(HasFinalAnswer));
            CopyFinalAnswerCommand.NotifyCanExecuteChanged();
        }

        partial void OnSelectedRunChanged(JobRunHistoryRow? value)
        {
            OnPropertyChanged(nameof(HasSelection));
            OnPropertyChanged(nameof(ShowEmptyDetail));
            _ = LoadSelectedTranscriptAsync();
        }

        // ── Commands ──────────────────────────────────────────────────

        [RelayCommand]
        private async Task LoadAsync() => await RefreshAsync();

        [RelayCommand]
        private async Task RefreshAsync()
        {
            if (IsLoadingList) return;
            IsLoadingList = true;
            SetStatus("Loading job run history…", StatusKind.Neutral);
            try
            {
                if (string.IsNullOrWhiteSpace(SubscriptionManager.Instance.JwtToken))
                {
                    bool activated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                    if (!activated)
                    {
                        SetStatus("Not authenticated.", StatusKind.Negative);
                        return;
                    }
                }

                var jobs = await FetchWithReauthAsync(_api.FetchScheduledJobsAsync);

                // Sort newest run first; jobs that have never run go to the bottom.
                var ordered = jobs
                    .OrderByDescending(j => ParseRunTime(j.LastRunAt))
                    .ToList();

                var previousId = SelectedRun?.JobId;
                Runs.Clear();
                foreach (var j in ordered) Runs.Add(new JobRunHistoryRow(j));

                if (Runs.Count == 0)
                {
                    SelectedRun = null;
                    SetStatus("No scheduled jobs yet.", StatusKind.Neutral);
                }
                else
                {
                    SelectedRun = Runs.FirstOrDefault(r => r.JobId == previousId)
                                  ?? Runs.FirstOrDefault(r => r.HasSession)
                                  ?? Runs.First();
                    SetStatus($"Loaded {Runs.Count} run(s).", StatusKind.Positive);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to load runs: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoadingList = false;
            }
        }

        private bool CanCopyFinalAnswer() => HasFinalAnswer;

        [RelayCommand(CanExecute = nameof(CanCopyFinalAnswer))]
        private void CopyFinalAnswer()
        {
            if (string.IsNullOrEmpty(FinalAnswer)) return;
            try { System.Windows.Clipboard.SetText(FinalAnswer); }
            catch { /* ignore clipboard contention */ }
            SetStatus("Final answer copied to clipboard.", StatusKind.Positive);
        }

        // ── Detail loading ────────────────────────────────────────────

        private async Task LoadSelectedTranscriptAsync()
        {
            TranscriptSections.Clear();
            FinalAnswer = null;

            var row = SelectedRun;
            if (row is null)
            {
                DetailHeading = "Select a run to view its transcript";
                DetailSubheading = string.Empty;
                return;
            }

            DetailHeading = row.Label;
            DetailSubheading = row.HasRun
                ? $"Last run {row.TimestampDisplay}"
                : "This job has not run yet.";

            if (!row.HasSession)
            {
                return;
            }

            IsLoadingDetail = true;
            try
            {
                var messages = await FetchWithReauthAsync(
                    () => _api.FetchSessionMessagesAsync(row.SessionId));
                RenderMessages(messages);
            }
            catch (Exception ex)
            {
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "Error",
                    HeaderSymbol = "ErrorCircle24",
                    HeaderBrush = new SolidColorBrush(Color.FromRgb(252, 100, 100)),
                    Body = ex.Message,
                });
            }
            finally
            {
                IsLoadingDetail = false;
            }
        }

        /// <summary>
        /// Builds the transcript sections from the raw session messages.
        /// Mirrors <c>JobRunHistoryForm.RenderMessages</c> so the WPF view
        /// surfaces the same final-answer / prompt / reasoning / tool-output
        /// breakdown the original WinForms form used.
        /// </summary>
        private void RenderMessages(IList<SessionHistoryEntryDto> messages)
        {
            if (messages == null || messages.Count == 0)
            {
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "No transcript",
                    HeaderSymbol = "Info24",
                    Body = "No messages were recorded for this run.",
                });
                return;
            }

            var userMessages = messages
                .Where(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))
                .Select(m => m.Text)
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();

            var assistantMessages = messages
                .Where(m => string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase))
                .Select(m => m.Text)
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();

            int finalAnswerIndex = -1;
            string? finalAnswer = null;
            for (int i = assistantMessages.Count - 1; i >= 0; i--)
            {
                var extracted = ExtractFinalAnswer(assistantMessages[i]);
                if (!string.IsNullOrWhiteSpace(extracted))
                {
                    finalAnswer = extracted!.Trim();
                    finalAnswerIndex = i;
                    break;
                }
            }
            if (finalAnswer == null && assistantMessages.Count > 0)
            {
                // Fallback: extractor saw no tags. Still strip any stray
                // wrapper text (truncated responses sometimes have an
                // opening <final_answer> without a closing tag).
                finalAnswer = StripFinalAnswerTags(assistantMessages[^1]).Trim();
                finalAnswerIndex = assistantMessages.Count - 1;
            }

            FinalAnswer = string.IsNullOrWhiteSpace(finalAnswer) ? null : finalAnswer;

            var greenBrush = (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"];
            var blueBrush = (Brush)System.Windows.Application.Current.Resources["Nord.AccentBlueBrush"];
            var purpleBrush = (Brush)System.Windows.Application.Current.Resources["Nord.AccentPurpleBrush"];
            var amberBrush = (Brush)System.Windows.Application.Current.Resources["Nord.AccentAmberBrush"];

            if (FinalAnswer != null)
            {
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "Final Answer",
                    HeaderSymbol = "Sparkle24",
                    HeaderBrush = greenBrush,
                    Body = FinalAnswer,
                    IsFinalAnswer = true,
                });
            }

            if (userMessages.Count > 0)
            {
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "Job Prompt",
                    HeaderSymbol = "TextBulletList24",
                    HeaderBrush = blueBrush,
                    Body = StripFinalAnswerTags(userMessages[0]),
                });
            }

            var reasoning = new List<string>(assistantMessages.Count);
            for (int i = 0; i < assistantMessages.Count; i++)
            {
                if (i == finalAnswerIndex) continue;
                reasoning.Add(StripFinalAnswerTags(assistantMessages[i]));
            }

            if (reasoning.Count > 0)
            {
                var sb = new System.Text.StringBuilder();
                for (int i = 0; i < reasoning.Count; i++)
                {
                    if (i > 0) sb.AppendLine().AppendLine();
                    sb.Append(i + 1).Append(". ").Append(reasoning[i]);
                }
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "Agent Reasoning",
                    HeaderSymbol = "BrainCircuit24",
                    HeaderBrush = purpleBrush,
                    Body = sb.ToString(),
                });
            }

            if (userMessages.Count > 1)
            {
                var sb = new System.Text.StringBuilder();
                bool first = true;
                foreach (var output in userMessages.Skip(1))
                {
                    if (!first) sb.AppendLine().AppendLine();
                    sb.Append(StripFinalAnswerTags(output));
                    first = false;
                }
                TranscriptSections.Add(new TranscriptSection
                {
                    Header = "Tool Outputs",
                    HeaderSymbol = "Wrench24",
                    HeaderBrush = amberBrush,
                    Body = sb.ToString(),
                });
            }
        }

        // ── Helpers ───────────────────────────────────────────────────

        private static DateTime ParseRunTime(string? iso)
        {
            if (string.IsNullOrWhiteSpace(iso)) return DateTime.MinValue;
            return DateTime.TryParse(
                iso,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var dt)
                ? dt
                : DateTime.MinValue;
        }

        /// <summary>
        /// Runs an API call, transparently re-authenticating once on 401/403
        /// so a stale JWT doesn't surface as a generic error to the user.
        /// </summary>
        private static async Task<T> FetchWithReauthAsync<T>(Func<Task<T>> call)
        {
            try
            {
                return await call();
            }
            catch (ApiException ex) when (ex.StatusCode == 401 || ex.StatusCode == 403)
            {
                bool ok = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!ok) throw;
                return await call();
            }
        }

        private static string? ExtractFinalAnswer(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            int start = text.IndexOf("<final_answer>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<final_answer>".Length;
            int end = text.IndexOf("</final_answer>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        private static string StripFinalAnswerTags(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            return text
                .Replace("<final_answer>", string.Empty)
                .Replace("</final_answer>", string.Empty)
                .Trim();
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
