using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    internal enum ScheduleKind
    {
        Recurring,
        OneShot,
    }

    /// <summary>
    /// Row item for the master list. Wraps a <see cref="ScheduledJobDto"/> and
    /// exposes the few display-friendly fields the row template binds against.
    /// </summary>
    internal sealed partial class ScheduledJobItem : ObservableObject
    {
        public ScheduledJobDto Dto { get; private set; }

        public ScheduledJobItem(ScheduledJobDto dto)
        {
            Dto = dto;
            isActive = dto.IsActive;
        }

        public string Id => Dto.Id;
        public string Label => string.IsNullOrWhiteSpace(Dto.Label) ? "(untitled)" : Dto.Label;

        public string ScheduleSummary => ScheduledJobsViewModel.FormatScheduleSummary(Dto);

        public string NextRunSummary
        {
            get
            {
                if (!string.IsNullOrWhiteSpace(Dto.NextRunAt))
                    return "Next: " + ScheduledJobsViewModel.FormatDateTime(Dto.NextRunAt!);
                if (!string.IsNullOrWhiteSpace(Dto.LastRunAt))
                    return "Last: " + ScheduledJobsViewModel.FormatDateTime(Dto.LastRunAt!);
                return "Never run";
            }
        }

        public string PromptExcerpt
        {
            get
            {
                var p = (Dto.Prompt ?? string.Empty).Replace('\n', ' ').Replace('\r', ' ').Trim();
                if (p.Length <= 80) return p;
                return p.Substring(0, 80) + "…";
            }
        }

        [ObservableProperty]
        private bool isActive;

        public void Replace(ScheduledJobDto dto)
        {
            Dto = dto;
            IsActive = dto.IsActive;
            OnPropertyChanged(nameof(Label));
            OnPropertyChanged(nameof(ScheduleSummary));
            OnPropertyChanged(nameof(NextRunSummary));
            OnPropertyChanged(nameof(PromptExcerpt));
        }
    }

    internal partial class ScheduledJobsViewModel : ObservableObject
    {
        private readonly ApiClient _api = new();
        private bool _suppressActiveToggleSync;

        public ObservableCollection<ScheduledJobItem> Jobs { get; } = new();

        public IReadOnlyList<(string Label, string Value)> CronPresets { get; } = new (string, string)[]
        {
            ("Weekdays at 9 AM",   "0 9 * * 1-5"),
            ("Daily at midnight",  "0 0 * * *"),
            ("Every hour",         "0 * * * *"),
            ("Monday at 8 AM",     "0 8 * * 1"),
        };

        // ── Selection / editor state ──────────────────────────────────

        [ObservableProperty]
        private ScheduledJobItem? selectedJob;

        [ObservableProperty]
        private bool isEditing;

        [ObservableProperty]
        private bool isCreatingNew;

        [ObservableProperty]
        private string editorLabel = string.Empty;

        [ObservableProperty]
        private string editorPrompt = string.Empty;

        [ObservableProperty]
        private ScheduleKind editorScheduleKind = ScheduleKind.Recurring;

        [ObservableProperty]
        private string editorCron = "0 9 * * 1-5";

        [ObservableProperty]
        private DateTime? editorRunAtDate = DateTime.Now.AddHours(1).Date;

        [ObservableProperty]
        private string editorRunAtTime = DateTime.Now.AddHours(1).ToString("HH:mm");

        [ObservableProperty]
        private bool editorIsActive = true;

        [ObservableProperty]
        private string editorLastRunSummary = string.Empty;

        [ObservableProperty]
        private string editorNextRunSummary = string.Empty;

        // ── Status / loading ──────────────────────────────────────────

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isLoading;

        public bool HasSelection => SelectedJob is not null || IsCreatingNew;
        public bool ShowEmptyState => !HasSelection;

        // Two-way-bindable bools the radio buttons can flip. Setting either
        // assigns the canonical EditorScheduleKind enum value (the kind enum
        // is the single source of truth — the bools just project it for XAML).
        public bool IsRecurring
        {
            get => EditorScheduleKind == ScheduleKind.Recurring;
            set { if (value) EditorScheduleKind = ScheduleKind.Recurring; }
        }
        public bool IsOneShot
        {
            get => EditorScheduleKind == ScheduleKind.OneShot;
            set { if (value) EditorScheduleKind = ScheduleKind.OneShot; }
        }

        public bool HasExistingJob => SelectedJob is not null && !IsCreatingNew;

        public bool CanSave =>
            !IsLoading
            && IsEditing
            && !string.IsNullOrWhiteSpace(EditorLabel)
            && !string.IsNullOrWhiteSpace(EditorPrompt);

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        // ── Property change wiring ────────────────────────────────────

        partial void OnSelectedJobChanged(ScheduledJobItem? value)
        {
            if (value is null)
            {
                if (!IsCreatingNew)
                {
                    IsEditing = false;
                    ResetEditorFields();
                }
            }
            else
            {
                IsCreatingNew = false;
                LoadEditorFromJob(value.Dto);
                IsEditing = true;
            }

            OnPropertyChanged(nameof(HasSelection));
            OnPropertyChanged(nameof(ShowEmptyState));
            OnPropertyChanged(nameof(HasExistingJob));
            SaveCommand.NotifyCanExecuteChanged();
            DeleteCommand.NotifyCanExecuteChanged();
            RunNowCommand.NotifyCanExecuteChanged();
        }

        partial void OnIsCreatingNewChanged(bool value)
        {
            OnPropertyChanged(nameof(HasSelection));
            OnPropertyChanged(nameof(ShowEmptyState));
            OnPropertyChanged(nameof(HasExistingJob));
            DeleteCommand.NotifyCanExecuteChanged();
            RunNowCommand.NotifyCanExecuteChanged();
        }

        partial void OnIsEditingChanged(bool value) => SaveCommand.NotifyCanExecuteChanged();

        partial void OnIsLoadingChanged(bool value)
        {
            SaveCommand.NotifyCanExecuteChanged();
            DeleteCommand.NotifyCanExecuteChanged();
            RunNowCommand.NotifyCanExecuteChanged();
            RefreshCommand.NotifyCanExecuteChanged();
        }

        partial void OnEditorLabelChanged(string value) => SaveCommand.NotifyCanExecuteChanged();
        partial void OnEditorPromptChanged(string value) => SaveCommand.NotifyCanExecuteChanged();

        partial void OnEditorScheduleKindChanged(ScheduleKind value)
        {
            OnPropertyChanged(nameof(IsRecurring));
            OnPropertyChanged(nameof(IsOneShot));
        }

        partial void OnStatusKindChanged(StatusKind value) => OnPropertyChanged(nameof(StatusBrush));

        // ── Commands ──────────────────────────────────────────────────

        [RelayCommand]
        private async Task LoadAsync()
        {
            IsLoading = true;
            SetStatus("Loading jobs…", StatusKind.Neutral);
            try
            {
                var fetched = await _api.FetchScheduledJobsAsync();
                string? previouslySelectedId = SelectedJob?.Id;

                Jobs.Clear();
                foreach (var dto in fetched)
                    Jobs.Add(new ScheduledJobItem(dto));

                HookActiveToggles();

                if (previouslySelectedId is not null)
                    SelectedJob = Jobs.FirstOrDefault(j => j.Id == previouslySelectedId);

                if (Jobs.Count == 0)
                {
                    SetStatus("No scheduled jobs yet — add one to get started.", StatusKind.Neutral);
                }
                else
                {
                    SetStatus($"{Jobs.Count} job{(Jobs.Count == 1 ? string.Empty : "s")} loaded.", StatusKind.Positive);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to load jobs: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        [RelayCommand]
        private void NewJob()
        {
            SelectedJob = null;
            IsCreatingNew = true;
            ResetEditorFields();
            EditorLabel = string.Empty;
            EditorPrompt = string.Empty;
            EditorScheduleKind = ScheduleKind.Recurring;
            EditorCron = "0 9 * * 1-5";
            var defaultRun = DateTime.Now.AddHours(1);
            EditorRunAtDate = defaultRun.Date;
            EditorRunAtTime = defaultRun.ToString("HH:mm");
            EditorIsActive = true;
            EditorLastRunSummary = string.Empty;
            EditorNextRunSummary = string.Empty;
            IsEditing = true;
            SetStatus("Creating a new scheduled job.", StatusKind.Neutral);
        }

        [RelayCommand]
        private void ApplyCronPreset(string? cronExpression)
        {
            if (string.IsNullOrWhiteSpace(cronExpression)) return;
            EditorCron = cronExpression!;
            EditorScheduleKind = ScheduleKind.Recurring;
        }

        [RelayCommand]
        private void CancelEdit()
        {
            if (IsCreatingNew)
            {
                IsCreatingNew = false;
                IsEditing = false;
                ResetEditorFields();
                SetStatus(string.Empty, StatusKind.Neutral);
                return;
            }

            if (SelectedJob is not null)
                LoadEditorFromJob(SelectedJob.Dto);
        }

        [RelayCommand(CanExecute = nameof(CanSave))]
        private async Task SaveAsync()
        {
            var label = EditorLabel.Trim();
            var prompt = EditorPrompt.Trim();
            if (string.IsNullOrEmpty(label) || string.IsNullOrEmpty(prompt))
            {
                SetStatus("Label and prompt are required.", StatusKind.Negative);
                return;
            }

            string? cron = EditorScheduleKind == ScheduleKind.Recurring
                ? (string.IsNullOrWhiteSpace(EditorCron) ? null : EditorCron.Trim())
                : null;
            DateTime? runAt = EditorScheduleKind == ScheduleKind.OneShot
                ? CombineDateAndTime(EditorRunAtDate, EditorRunAtTime)?.ToUniversalTime()
                : null;

            IsLoading = true;
            SetStatus("Saving…", StatusKind.Neutral);
            try
            {
                ScheduledJobDto saved;
                if (SelectedJob is { } existing && !IsCreatingNew)
                {
                    saved = await _api.UpdateScheduledJobAsync(
                        existing.Id, label, prompt, cron, runAt, EditorIsActive);
                    existing.Replace(saved);
                    SelectedJob = existing;
                    SetStatus("Job updated.", StatusKind.Positive);
                }
                else
                {
                    saved = await _api.CreateScheduledJobAsync(label, prompt, cron, runAt);
                    var item = new ScheduledJobItem(saved);
                    Jobs.Add(item);
                    HookActiveToggle(item);
                    IsCreatingNew = false;
                    SelectedJob = item;
                    SetStatus("Job created.", StatusKind.Positive);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to save: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanDelete() => SelectedJob is not null && !IsCreatingNew && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanDelete))]
        private async Task DeleteAsync()
        {
            if (SelectedJob is not { } target) return;

            IsLoading = true;
            SetStatus("Deleting…", StatusKind.Neutral);
            try
            {
                await _api.DeleteScheduledJobAsync(target.Id);
                Jobs.Remove(target);
                SelectedJob = null;
                IsEditing = false;
                ResetEditorFields();
                SetStatus("Job deleted.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to delete: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanRunNow() => SelectedJob is not null && !IsCreatingNew && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanRunNow))]
        private async Task RunNowAsync()
        {
            if (SelectedJob is not { } target) return;

            IsLoading = true;
            SetStatus($"Triggering \"{target.Label}\"…", StatusKind.Neutral);
            try
            {
                var updated = await _api.RunScheduledJobNowAsync(target.Id);
                target.Replace(updated);
                if (SelectedJob == target) LoadEditorFromJob(updated);
                SetStatus($"\"{target.Label}\" triggered.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to run job: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        private bool CanRefresh() => !IsLoading;

        [RelayCommand(CanExecute = nameof(CanRefresh))]
        private Task RefreshAsync() => LoadAsync();

        // ── Helpers ───────────────────────────────────────────────────

        private void LoadEditorFromJob(ScheduledJobDto job)
        {
            EditorLabel = job.Label ?? string.Empty;
            EditorPrompt = job.Prompt ?? string.Empty;
            EditorIsActive = job.IsActive;

            if (!string.IsNullOrWhiteSpace(job.CronExpression))
            {
                EditorScheduleKind = ScheduleKind.Recurring;
                EditorCron = job.CronExpression!;
            }
            else if (!string.IsNullOrWhiteSpace(job.RunAt))
            {
                EditorScheduleKind = ScheduleKind.OneShot;
                if (DateTimeOffset.TryParse(job.RunAt, out var dto))
                {
                    var local = dto.LocalDateTime;
                    EditorRunAtDate = local.Date;
                    EditorRunAtTime = local.ToString("HH:mm");
                }
            }
            else
            {
                EditorScheduleKind = ScheduleKind.Recurring;
                EditorCron = "0 9 * * 1-5";
            }

            EditorLastRunSummary = string.IsNullOrWhiteSpace(job.LastRunAt)
                ? "Never run"
                : "Last run: " + FormatDateTime(job.LastRunAt!);
            EditorNextRunSummary = string.IsNullOrWhiteSpace(job.NextRunAt)
                ? "No next run scheduled"
                : "Next run: " + FormatDateTime(job.NextRunAt!);
        }

        private void ResetEditorFields()
        {
            EditorLabel = string.Empty;
            EditorPrompt = string.Empty;
            EditorScheduleKind = ScheduleKind.Recurring;
            EditorCron = "0 9 * * 1-5";
            var defaultRun = DateTime.Now.AddHours(1);
            EditorRunAtDate = defaultRun.Date;
            EditorRunAtTime = defaultRun.ToString("HH:mm");
            EditorIsActive = true;
            EditorLastRunSummary = string.Empty;
            EditorNextRunSummary = string.Empty;
        }

        private static DateTime? CombineDateAndTime(DateTime? date, string? time)
        {
            if (date is null) return null;
            var d = date.Value.Date;
            if (string.IsNullOrWhiteSpace(time)) return d;
            if (TimeSpan.TryParse(time, out var ts))
                return d.Add(ts);
            return d;
        }

        private void HookActiveToggles()
        {
            foreach (var item in Jobs) HookActiveToggle(item);
        }

        private void HookActiveToggle(ScheduledJobItem item)
        {
            item.PropertyChanged -= OnItemActivePropertyChanged;
            item.PropertyChanged += OnItemActivePropertyChanged;
        }

        private async void OnItemActivePropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            if (_suppressActiveToggleSync) return;
            if (e.PropertyName != nameof(ScheduledJobItem.IsActive)) return;
            if (sender is not ScheduledJobItem item) return;
            if (item.IsActive == item.Dto.IsActive) return;

            try
            {
                var dto = item.Dto;
                var runAt = ParseNullableUtcDate(dto.RunAt);
                var updated = await _api.UpdateScheduledJobAsync(
                    dto.Id, dto.Label, dto.Prompt, dto.CronExpression, runAt, item.IsActive);

                _suppressActiveToggleSync = true;
                item.Replace(updated);
                _suppressActiveToggleSync = false;

                if (SelectedJob == item) LoadEditorFromJob(updated);

                SetStatus(updated.IsActive ? $"\"{item.Label}\" activated." : $"\"{item.Label}\" deactivated.",
                    StatusKind.Positive);
            }
            catch (Exception ex)
            {
                _suppressActiveToggleSync = true;
                item.IsActive = item.Dto.IsActive;
                _suppressActiveToggleSync = false;
                SetStatus("Failed to update active state: " + ex.Message, StatusKind.Negative);
            }
        }

        private static DateTime? ParseNullableUtcDate(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            if (DateTime.TryParse(raw, out var dt)) return dt.ToUniversalTime();
            return null;
        }

        internal static string FormatScheduleSummary(ScheduledJobDto job)
        {
            if (!string.IsNullOrWhiteSpace(job.CronExpression))
                return DescribeCron(job.CronExpression!);
            if (!string.IsNullOrWhiteSpace(job.RunAt))
                return "One-time · " + FormatDateTime(job.RunAt!);
            return "No schedule";
        }

        internal static string FormatDateTime(string raw)
        {
            if (DateTimeOffset.TryParse(raw, out var dto))
                return dto.ToLocalTime().ToString("MMM d, yyyy h:mm tt");
            if (DateTime.TryParse(raw, out var dt))
                return dt.ToLocalTime().ToString("MMM d, yyyy h:mm tt");
            return raw;
        }

        private static string DescribeCron(string cron) => cron switch
        {
            "0 9 * * 1-5" => "Every weekday · 9:00 AM",
            "0 0 * * *"   => "Daily · midnight",
            "0 * * * *"   => "Every hour",
            "0 8 * * 1"   => "Mondays · 8:00 AM",
            _             => "Cron · " + cron,
        };

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
