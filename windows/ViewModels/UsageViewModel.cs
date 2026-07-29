using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>One entry in the range selector. Mirrors the macOS
    /// <c>UsageRangeOption</c> enum (7d / 30d / month / 90d / all) so both
    /// clients ask the backend for identical windows.</summary>
    internal sealed class UsageRangeOption
    {
        public string Key { get; init; } = "30d";
        public string Label { get; init; } = "30d";
    }

    /// <summary>One entry in the provider filter. Keys must match the
    /// server-side provider identifiers (see <c>AIProviderDTO</c>) so filtering
    /// works even before any calls have been recorded for a provider. Keep in
    /// sync with <c>usageSupportedProviders</c> in macOS UsageView.swift.</summary>
    internal sealed class UsageProviderOption
    {
        public string Key { get; init; } = "all";
        public string Label { get; init; } = "All Providers";
    }

    /// <summary>A single "Tokens by model" meter row. Percentages and the
    /// display strings are pre-computed here rather than in converters so the
    /// XAML stays declarative and we avoid a converter per formatting rule.</summary>
    internal sealed class UsageMeterRow
    {
        public string Label { get; init; } = "";
        public string TokensDisplay { get; init; } = "";
        public string DetailDisplay { get; init; } = "";

        /// <summary>0-100, relative to the largest bucket in the list, so the
        /// widest meter always fills the row.</summary>
        public double Percent { get; init; }

        public Brush Accent { get; init; } = Brushes.Gray;
    }

    /// <summary>A single day column in the "Daily Token Split" chart. Heights
    /// are DIP values computed against <see cref="UsageViewModel.TrendChartHeight"/>
    /// so the XAML can stack two plain rectangles without a layout converter.</summary>
    internal sealed class UsageTrendBar
    {
        public string Label { get; init; } = "";
        public double PromptHeight { get; init; }
        public double CompletionHeight { get; init; }
        public string Tooltip { get; init; } = "";
    }

    /// <summary>A row in the "Recent Sessions" list.</summary>
    internal sealed class UsageSessionRow
    {
        public string Title { get; init; } = "";
        public string TokensDisplay { get; init; } = "";
        public string DetailDisplay { get; init; } = "";
    }

    /// <summary>
    /// Backs the Usage page: token counters for a selected range and provider,
    /// read from <c>GET /api/usage</c>. Mirrors macOS <c>UsageView</c> — cost
    /// figures were deliberately dropped server-side because provider pricing
    /// estimates can't be reconciled with invoices, so this reports only the
    /// token metrics we can state accurately.
    /// </summary>
    internal partial class UsageViewModel : ObservableObject
    {
        /// <summary>Total height of the daily trend chart in DIP. Bars are
        /// scaled against this so the tallest day fills the plot area.</summary>
        public const double TrendChartHeight = 110d;

        private readonly ApiClient _api = new();

        /// <summary>Cancels an in-flight refresh when the user changes the range
        /// or provider again before the previous request lands, so a slow earlier
        /// response can't overwrite the newer selection.</summary>
        private CancellationTokenSource? _inflight;

        public IReadOnlyList<UsageRangeOption> RangeOptions { get; } = new[]
        {
            new UsageRangeOption { Key = "7d",    Label = "7 days" },
            new UsageRangeOption { Key = "30d",   Label = "30 days" },
            new UsageRangeOption { Key = "month", Label = "This month" },
            new UsageRangeOption { Key = "90d",   Label = "90 days" },
            new UsageRangeOption { Key = "all",   Label = "All time" },
        };

        public IReadOnlyList<UsageProviderOption> ProviderOptions { get; } = new[]
        {
            new UsageProviderOption { Key = "all",       Label = "All Providers" },
            new UsageProviderOption { Key = "openai",    Label = "OpenAI" },
            new UsageProviderOption { Key = "anthropic", Label = "Anthropic (Claude)" },
            new UsageProviderOption { Key = "gemini",    Label = "Google Gemini" },
            new UsageProviderOption { Key = "nemotron",  Label = "NVIDIA Nemotron" },
        };

        public ObservableCollection<UsageMeterRow> ModelRows { get; } = new();
        public ObservableCollection<UsageTrendBar> TrendBars { get; } = new();
        public ObservableCollection<UsageSessionRow> SessionRows { get; } = new();

        // Selection ------------------------------------------------------------
        [ObservableProperty] private string selectedRangeKey = "30d";
        [ObservableProperty] private string selectedProviderKey = "all";

        // Load state -----------------------------------------------------------
        [ObservableProperty] private bool isBusy;

        /// <summary>True once a response has been rendered. Distinguishes "still
        /// loading for the first time" (skeleton/spinner) from "loaded but the
        /// range is empty" (empty state).</summary>
        [ObservableProperty] private bool hasMetrics;

        [ObservableProperty] private string? errorMessage;

        /// <summary>Mirrors the server's <c>usageRecordingEnabled</c>. When false
        /// we surface an InfoBar: historical rows still render, but no new ones
        /// are being written.</summary>
        [ObservableProperty] private bool recordingEnabled = true;

        // Rendered figures -----------------------------------------------------
        [ObservableProperty] private string rangeLabel = "Last 30 days";
        [ObservableProperty] private string providerLabel = "All Providers";
        [ObservableProperty] private string totalTokensDisplay = "0";
        [ObservableProperty] private string promptTokensDisplay = "0";
        [ObservableProperty] private string completionTokensDisplay = "0";
        [ObservableProperty] private string requestsSubtitle = "No calls recorded";
        [ObservableProperty] private string promptShareSubtitle = "";
        [ObservableProperty] private string completionShareSubtitle = "";
        [ObservableProperty] private string averageDailyDisplay = "0";
        [ObservableProperty] private string generatedAtDisplay = "";

        /// <summary>True when the range returned zero calls — drives the "no
        /// calls in this range" InfoBar (distinct from "nothing loaded yet").</summary>
        [ObservableProperty] private bool isRangeEmpty;

        public bool HasError => !string.IsNullOrWhiteSpace(ErrorMessage);
        public bool ShowRecordingWarning => HasMetrics && !RecordingEnabled;

        /// <summary>Spinner only replaces the dashboard on the very first load;
        /// later refreshes keep the previous numbers on screen and just show the
        /// inline busy ring so the page never flashes empty.</summary>
        public bool ShowFirstLoadSkeleton => IsBusy && !HasMetrics;

        /// <summary>Empty state: we finished loading and there is nothing to
        /// show at all (no metrics object came back, or an error occurred).</summary>
        public bool ShowEmptyState => !IsBusy && !HasMetrics;

        public bool ShowDashboard => HasMetrics;
        public bool HasModelRows => ModelRows.Count > 0;
        public bool HasTrendBars => TrendBars.Count > 0;
        public bool HasSessionRows => SessionRows.Count > 0;
        public bool CanRefresh => !IsBusy;

        /// <summary>Accent cycle for the per-model meters. Uses the shared Nord
        /// accent tokens so the Usage page speaks the same colour vocabulary as
        /// the OmniAgent session cards.</summary>
        private static readonly string[] MeterAccentKeys =
        {
            "Nord.AccentBlueBrush",
            "Nord.AccentPurpleBrush",
            "Nord.AccentGreenBrush",
            "Nord.AccentAmberBrush",
        };

        private static Brush Resource(string key) =>
            System.Windows.Application.Current?.Resources[key] as Brush ?? Brushes.Gray;

        private static Brush MeterAccent(int index) =>
            Resource(MeterAccentKeys[index % MeterAccentKeys.Length]);

        public Brush TotalAccentBrush      => Resource("Nord.AccentBrush");
        public Brush PromptAccentBrush     => Resource("Nord.AccentGreenBrush");
        public Brush CompletionAccentBrush => Resource("Nord.AccentPurpleBrush");
        public Brush AverageAccentBrush    => Resource("Nord.AccentAmberBrush");
        public Brush TrendPromptBrush      => Resource("Nord.AccentBlueBrush");
        public Brush TrendCompletionBrush  => Resource("Nord.AccentGreenBrush");

        // ---- Property-changed plumbing ---------------------------------------

        partial void OnIsBusyChanged(bool value)
        {
            OnPropertyChanged(nameof(CanRefresh));
            OnPropertyChanged(nameof(ShowFirstLoadSkeleton));
            OnPropertyChanged(nameof(ShowEmptyState));
            RefreshCommand.NotifyCanExecuteChanged();
        }

        partial void OnHasMetricsChanged(bool value)
        {
            OnPropertyChanged(nameof(ShowFirstLoadSkeleton));
            OnPropertyChanged(nameof(ShowEmptyState));
            OnPropertyChanged(nameof(ShowDashboard));
            OnPropertyChanged(nameof(ShowRecordingWarning));
        }

        partial void OnRecordingEnabledChanged(bool value) =>
            OnPropertyChanged(nameof(ShowRecordingWarning));

        partial void OnErrorMessageChanged(string? value) =>
            OnPropertyChanged(nameof(HasError));

        // Changing either filter immediately refetches, matching the macOS
        // pickers which reload on change rather than behind an Apply button.
        partial void OnSelectedRangeKeyChanged(string value) => _ = RefreshAsync();
        partial void OnSelectedProviderKeyChanged(string value) => _ = RefreshAsync();

        // ---- Commands --------------------------------------------------------

        [RelayCommand]
        private void DismissError() => ErrorMessage = null;

        [RelayCommand(CanExecute = nameof(CanRefresh))]
        public async Task RefreshAsync()
        {
            // Supersede any in-flight request so rapid filter changes settle on
            // the newest selection rather than whichever response lands last.
            _inflight?.Cancel();
            var cts = new CancellationTokenSource();
            _inflight = cts;

            IsBusy = true;
            ErrorMessage = null;
            try
            {
                var metrics = await _api.FetchUsageMetricsAsync(SelectedRangeKey, SelectedProviderKey);
                if (cts.IsCancellationRequested) return;
                Apply(metrics);
                HasMetrics = true;
            }
            catch (OperationCanceledException)
            {
                // Superseded by a newer request — leave the UI to that one.
            }
            catch (Exception ex)
            {
                if (cts.IsCancellationRequested) return;
                // Never throw at the user: the InfoBar carries the message and
                // any previously loaded numbers stay on screen.
                ErrorMessage = $"Couldn't load usage metrics: {ex.Message}";
            }
            finally
            {
                if (ReferenceEquals(_inflight, cts))
                {
                    IsBusy = false;
                    _inflight = null;
                }
                cts.Dispose();
            }
        }

        // ---- Projection ------------------------------------------------------

        private void Apply(UsageMetricsResponse m)
        {
            RecordingEnabled = m.RecordingEnabled;
            RangeLabel = string.IsNullOrWhiteSpace(m.Range.Label) ? "Selected range" : m.Range.Label;
            ProviderLabel = string.IsNullOrWhiteSpace(m.Provider.ProviderLabel)
                ? "All Providers"
                : m.Provider.ProviderLabel;

            int total = m.Totals.TotalTokens;
            TotalTokensDisplay = FormatTokens(total);
            PromptTokensDisplay = FormatTokens(m.Totals.PromptTokens);
            CompletionTokensDisplay = FormatTokens(m.Totals.CompletionTokens);
            AverageDailyDisplay = FormatTokens(m.Estimates.AverageDailyTokens);

            string rangeLower = RangeLabel.ToLowerInvariant();
            RequestsSubtitle = m.Totals.Requests == 1
                ? $"1 call in {rangeLower}"
                : $"{m.Totals.Requests} calls in {rangeLower}";
            PromptShareSubtitle = TokenShare(m.Totals.PromptTokens, total);
            CompletionShareSubtitle = TokenShare(m.Totals.CompletionTokens, total);
            GeneratedAtDisplay = FormatDateTime(m.GeneratedAt);
            IsRangeEmpty = m.Totals.Requests == 0;

            BuildModelRows(m.ByModel);
            BuildTrendBars(m.Daily);
            BuildSessionRows(m.RecentSessions);
        }

        /// <summary>Top 8 models by tokens, matching the macOS cap so neither
        /// client grows an unbounded list on a busy account.</summary>
        private void BuildModelRows(List<UsageBucketDto> byModel)
        {
            ModelRows.Clear();
            var buckets = byModel.Take(8).ToList();
            int max = buckets.Count > 0 ? buckets.Max(b => b.TotalTokens) : 0;

            for (int i = 0; i < buckets.Count; i++)
            {
                var b = buckets[i];
                ModelRows.Add(new UsageMeterRow
                {
                    Label = string.IsNullOrWhiteSpace(b.Label) ? b.Key : b.Label,
                    TokensDisplay = FormatTokens(b.TotalTokens),
                    DetailDisplay = $"{b.Requests} {(b.Requests == 1 ? "call" : "calls")}  ·  "
                                    + $"in {FormatTokens(b.PromptTokens)}  ·  out {FormatTokens(b.CompletionTokens)}",
                    // Guard against a divide-by-zero when every bucket is empty.
                    Percent = max > 0 ? b.TotalTokens * 100d / max : 0d,
                    Accent = MeterAccent(i),
                });
            }
            OnPropertyChanged(nameof(HasModelRows));
        }

        /// <summary>Last 32 days of the daily series (macOS uses the same
        /// suffix) rendered as stacked input/output columns. Days with no tokens
        /// are kept so gaps in activity stay visible.</summary>
        private void BuildTrendBars(List<UsageBucketDto> daily)
        {
            TrendBars.Clear();
            var buckets = daily.Count > 32 ? daily.Skip(daily.Count - 32).ToList() : daily;
            int max = buckets.Count > 0 ? buckets.Max(b => b.TotalTokens) : 0;

            // Nothing to plot: leave the collection empty so the section shows
            // its own inline empty text rather than a row of zero-height bars.
            if (max <= 0)
            {
                OnPropertyChanged(nameof(HasTrendBars));
                return;
            }

            foreach (var b in buckets)
            {
                double scale = TrendChartHeight / max;
                TrendBars.Add(new UsageTrendBar
                {
                    Label = ShortDate(b.Key),
                    PromptHeight = Math.Round(b.PromptTokens * scale, 2),
                    CompletionHeight = Math.Round(b.CompletionTokens * scale, 2),
                    Tooltip = $"{ShortDate(b.Key)} — {FormatTokens(b.TotalTokens)} tokens "
                              + $"(in {FormatTokens(b.PromptTokens)}, out {FormatTokens(b.CompletionTokens)})",
                });
            }
            OnPropertyChanged(nameof(HasTrendBars));
        }

        private void BuildSessionRows(List<UsageSessionDto> sessions)
        {
            SessionRows.Clear();
            foreach (var s in sessions.Take(5))
            {
                SessionRows.Add(new UsageSessionRow
                {
                    Title = string.IsNullOrWhiteSpace(s.Title) ? "Untitled Session" : s.Title,
                    TokensDisplay = FormatTokens(s.TotalTokens),
                    DetailDisplay = $"{s.Turns} {(s.Turns == 1 ? "turn" : "turns")}  ·  {ShortDate(s.LastActiveAt)}",
                });
            }
            OnPropertyChanged(nameof(HasSessionRows));
        }

        // ---- Formatting ------------------------------------------------------
        // Mirrors macOS UsageView.formatTokens: thousands as "12.3k", millions
        // as "1.24M", so the metric cards never overflow their fixed width.

        private static string FormatTokens(double tokens)
        {
            if (double.IsNaN(tokens) || double.IsInfinity(tokens) || tokens <= 0) return "0";
            if (tokens >= 1_000_000) return (tokens / 1_000_000d).ToString("0.##", CultureInfo.InvariantCulture) + "M";
            if (tokens >= 1_000)     return (tokens / 1_000d).ToString("0.#", CultureInfo.InvariantCulture) + "k";
            return Math.Round(tokens).ToString("0", CultureInfo.InvariantCulture);
        }

        private static string TokenShare(int part, int total) =>
            total <= 0 ? "No tokens recorded" : $"{part * 100d / total:0.#}% of total tokens";

        /// <summary>Parses an ISO-8601 timestamp (or a bare <c>yyyy-MM-dd</c>
        /// bucket key) into a short local date. Returns the raw value when it
        /// isn't parseable so an unexpected server format degrades to text
        /// rather than throwing.</summary>
        private static string ShortDate(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                       DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
                ? parsed.ToLocalTime().ToString("MMM d", CultureInfo.CurrentCulture)
                : value;
        }

        private static string FormatDateTime(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                       DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
                ? parsed.ToLocalTime().ToString("MMM d, HH:mm", CultureInfo.CurrentCulture)
                : value;
        }
    }
}
