using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using OmniKey.Windows.Skills;

namespace OmniKey.Windows.ViewModels
{
    internal enum SkillsLoadState { Idle, Loading, Loaded, Failed }

    /// <summary>
    /// One row in the Skills list. <see cref="Summary"/> is always the last
    /// server-confirmed state; <see cref="IsEnabled"/> is bound two-way to the
    /// row's switch, so a flip is a request that the view model either
    /// confirms with the server's answer or rolls back.
    /// </summary>
    internal sealed partial class SkillRow : ObservableObject
    {
        private bool _applying;

        public SkillRow(SkillSummary summary) => Apply(summary);

        public SkillSummary Summary { get; private set; } = null!;
        public string Id => Summary.Id;

        [ObservableProperty] private string name = "";
        [ObservableProperty] private string keyword = "";
        [ObservableProperty] private bool isEnabled;
        [ObservableProperty] private int revision;
        /// <summary>A mutation for this row is in flight; its controls are disabled.</summary>
        [ObservableProperty] private bool isBusy;

        public string StateText => IsEnabled ? "Enabled" : "Disabled";
        public string AutomationName => $"{Name}, keyword {Keyword}, {StateText}{(IsBusy ? ", updating" : "")}";

        /// <summary>Set by the view model; called when the user flips the switch.</summary>
        internal Action<SkillRow, bool>? ToggleRequested { get; set; }

        /// <summary>Show exactly the server state (also used for rollback).</summary>
        internal void Apply(SkillSummary summary)
        {
            Summary = summary;
            _applying = true;
            try
            {
                Name = SkillStatusPresentation.DisplayName(summary.Name);
                Keyword = SafeText.SingleLine(summary.Keyword, SkillLimits.KeywordCodePoints, "");
                IsEnabled = summary.Enabled;
                Revision = summary.Revision;
            }
            finally { _applying = false; }
            OnPropertyChanged(nameof(StateText));
            OnPropertyChanged(nameof(AutomationName));
        }

        /// <summary>Show the requested state while the request is pending,
        /// without touching the confirmed <see cref="Summary"/>.</summary>
        internal void ShowPending(bool target)
        {
            _applying = true;
            try { IsEnabled = target; }
            finally { _applying = false; }
        }

        partial void OnIsEnabledChanged(bool value)
        {
            OnPropertyChanged(nameof(StateText));
            OnPropertyChanged(nameof(AutomationName));
            if (_applying || value == Summary.Enabled) return;
            ToggleRequested?.Invoke(this, value);
        }

        partial void OnIsBusyChanged(bool value) => OnPropertyChanged(nameof(AutomationName));
    }

    /// <summary>
    /// State for the Skills page. The backend is the only source of truth:
    /// nothing is cached across launches, nothing is matched locally, and
    /// every mutation is followed by a re-fetch. Responses that arrive after a
    /// newer request for the same slot are dropped (generation tokens).
    /// Platform-neutral (no WPF types) so windows.Tests can exercise it.
    /// Public <c>*Async</c> methods are what the commands run; tests await them.
    /// </summary>
    internal sealed partial class SkillsViewModel : ObservableObject
    {
        public const string CreatedMessage = "Skill created.";
        public const string SavedMessage = "Skill saved.";
        public const string DeletedElsewhereNotice =
            "This skill was deleted elsewhere. Your text is kept; saving will create a new skill.";

        private readonly ISkillsService _service;
        private int _listGeneration;
        private int _detailGeneration;
        private int _editorGeneration;
        private CancellationTokenSource? _listCts;
        private CancellationTokenSource? _detailCts;
        private SkillDto? _editBase;
        private bool _suppressSelection;

        public SkillsViewModel(ISkillsService service) => _service = service;

        public ObservableCollection<SkillRow> Skills { get; } = new();

        // ── List ────────────────────────────────────────────────────────
        [ObservableProperty] private SkillsLoadState listState;
        [ObservableProperty] private string? listError;
        [ObservableProperty] private bool isUpgradeRequired;
        [ObservableProperty] private SkillRow? selectedRow;

        // ── Detail ──────────────────────────────────────────────────────
        [ObservableProperty] private SkillDto? detail;
        [ObservableProperty] private SkillsLoadState detailState;
        [ObservableProperty] private string? detailError;

        // ── Editor ──────────────────────────────────────────────────────
        [ObservableProperty] private bool isEditorOpen;
        [ObservableProperty] private bool isCreateMode;
        [ObservableProperty] private string editName = "";
        [ObservableProperty] private string editKeyword = "";
        [ObservableProperty] private string editInstructions = "";
        [ObservableProperty] private bool editEnabled = true;
        [ObservableProperty] private bool isSaving;
        /// <summary>The server rejected the save as stale (409/428). The draft
        /// is kept; the user may reload the latest revision and save again.</summary>
        [ObservableProperty] private bool hasConflict;
        [ObservableProperty] private string? editorError;
        [ObservableProperty] private string? editorNotice;
        [ObservableProperty] private string? nameError;
        [ObservableProperty] private string? keywordError;
        [ObservableProperty] private string? instructionsError;
        [ObservableProperty] private string? enabledError;
        [ObservableProperty] private string? formError;
        [ObservableProperty] private bool nameConflict;
        [ObservableProperty] private bool keywordConflict;
        [ObservableProperty] private bool instructionsConflict;
        [ObservableProperty] private bool enabledConflict;

        // ── Delete / status ─────────────────────────────────────────────
        [ObservableProperty] private SkillRow? pendingDelete;
        /// <summary>Neutral success/info line. Errors use <see cref="ActionError"/>.</summary>
        [ObservableProperty] private string? statusMessage;
        [ObservableProperty] private string? actionError;

        // ── Computed ────────────────────────────────────────────────────

        public bool IsListLoading => ListState == SkillsLoadState.Loading;
        public bool HasListError => ListState == SkillsLoadState.Failed && !IsUpgradeRequired;
        public bool IsEmptyStateVisible => ListState == SkillsLoadState.Loaded && Skills.Count == 0;

        /// <summary>The list can be used (no editor or delete prompt open), so
        /// a draft can never be lost by clicking another row.</summary>
        public bool IsListInteractive => !IsEditorOpen && PendingDelete is null;

        public bool ShowNoSelection => !IsEditorOpen && SelectedRow is null && !IsUpgradeRequired;
        public bool ShowDetail => !IsEditorOpen && SelectedRow is not null;

        /// <summary>The loaded detail matches the selected row's revision (or
        /// is newer). While false, edit/toggle/delete are disabled so no action
        /// targets a revision the user has not seen.</summary>
        public bool IsDetailCurrent =>
            Detail is { } d && SelectedRow is { } row && d.Id == row.Id && d.Revision >= row.Summary.Revision;

        public bool IsDetailLoading => ShowDetail && !IsDetailCurrent && DetailState != SkillsLoadState.Failed;
        public bool HasDetailError => ShowDetail && DetailState == SkillsLoadState.Failed;

        public string DetailName => Detail is { } d ? SkillStatusPresentation.DisplayName(d.Name) : "";
        public string DetailKeyword => Detail?.Keyword ?? "";
        public string DetailInstructions => IsDetailCurrent ? Detail!.Instructions : "";
        public string DetailMeta => Detail is { } d
            ? $"Revision {d.Revision} · {(d.Enabled ? "Enabled" : "Disabled")}"
            : "";
        public string ToggleSelectedLabel => SelectedRow?.Summary.Enabled == true ? "Disable" : "Enable";

        public string EditorTitle => IsCreateMode ? "New Skill" : "Edit Skill";
        public string InstructionsCounter =>
            $"{SkillLimits.CodePoints(NormalizeNewlines(EditInstructions))} / {SkillLimits.InstructionCodePoints} characters";

        public bool HasEditorError => !string.IsNullOrEmpty(EditorError);
        public bool HasEditorNotice => !string.IsNullOrEmpty(EditorNotice);
        public bool HasActionError => !string.IsNullOrEmpty(ActionError);
        public bool HasStatusMessage => !string.IsNullOrEmpty(StatusMessage);
        public bool HasPendingDelete => PendingDelete is not null;
        public string DeleteConfirmText => PendingDelete is not null
            ? $"Delete “{_pendingDeleteName}”? This permanently deletes the skill for this backend. It cannot undo work already done. A task that is already running keeps the version it started with — use Stop to end it."
            : "";

        // ── Loading ─────────────────────────────────────────────────────

        /// <summary>First appearance: load once. Re-shown pages refresh unless editing.</summary>
        public Task OnAppearedAsync() =>
            ListState == SkillsLoadState.Idle || !IsEditorOpen ? RefreshAsync() : Task.CompletedTask;

        /// <summary>Re-fetch the list (and the open detail, unless editing).</summary>
        public Task RefreshAsync()
        {
            StatusMessage = null;
            ActionError = null;
            var list = ReloadListAsync();
            if (!IsEditorOpen && SelectedRow is { } row)
                return Task.WhenAll(list, LoadDetailAsync(row.Id));
            return list;
        }

        private async Task ReloadListAsync()
        {
            int generation = ++_listGeneration;
            _listCts?.Cancel();
            var cts = _listCts = new CancellationTokenSource();
            ListState = SkillsLoadState.Loading;
            ListError = null;

            IReadOnlyList<SkillSummary> list;
            try
            {
                list = await _service.ListAsync(cts.Token);
            }
            catch (Exception ex)
            {
                if (generation != _listGeneration) return;
                var err = SkillsApiException.From(ex);
                if (err.Kind == SkillsErrorKind.Cancelled) return;
                ListState = SkillsLoadState.Failed;
                ListError = err.Message;
                if (err.Kind == SkillsErrorKind.UpgradeRequired)
                {
                    IsUpgradeRequired = true;
                    SyncRows(Array.Empty<SkillSummary>());
                }
                return;
            }

            if (generation != _listGeneration) return;
            IsUpgradeRequired = false;
            SyncRows(list);
            ListState = SkillsLoadState.Loaded;

            // The row is newer than the instructions on screen: fetch them so
            // the pane never mixes revisions.
            if (!IsEditorOpen && SelectedRow is { } row && Detail is { } d && d.Id == row.Id &&
                row.Summary.Revision > d.Revision)
                _ = LoadDetailAsync(row.Id);
        }

        partial void OnSelectedRowChanged(SkillRow? value)
        {
            if (_suppressSelection || IsEditorOpen) return;
            if (value is null)
            {
                _detailGeneration++;
                _detailCts?.Cancel();
                Detail = null;
                DetailState = SkillsLoadState.Idle;
                DetailError = null;
                return;
            }
            if (Detail?.Id == value.Id && IsDetailCurrent) return;
            _ = LoadDetailAsync(value.Id);
        }

        /// <summary>Select by id (tests and keyboard helpers); null clears.</summary>
        public void Select(string? id) => SelectedRow = id is null ? null : Skills.FirstOrDefault(r => r.Id == id);

        private async Task LoadDetailAsync(string id)
        {
            int generation = ++_detailGeneration;
            _detailCts?.Cancel();
            var cts = _detailCts = new CancellationTokenSource();
            if (Detail?.Id != id) Detail = null;
            DetailState = SkillsLoadState.Loading;
            DetailError = null;

            SkillDto skill;
            try
            {
                skill = await _service.GetAsync(id, cts.Token);
            }
            catch (Exception ex)
            {
                if (generation != _detailGeneration || SelectedRow?.Id != id) return;
                var err = SkillsApiException.From(ex);
                if (err.Kind == SkillsErrorKind.Cancelled) return;
                DetailState = SkillsLoadState.Failed;
                DetailError = err.Message;
                if (err.Kind == SkillsErrorKind.NotFound)
                {
                    Detail = null;
                    _ = ReloadListAsync();
                }
                return;
            }

            if (generation != _detailGeneration || SelectedRow?.Id != id) return;
            Detail = skill;
            DetailState = SkillsLoadState.Loaded;
            ReplaceSummary(skill.ToSummary());
        }

        // ── Editing ─────────────────────────────────────────────────────

        [RelayCommand(CanExecute = nameof(CanStartCreate))]
        private void NewSkill() => StartCreate();

        private bool CanStartCreate() => !IsUpgradeRequired && !IsEditorOpen && PendingDelete is null;

        public void StartCreate()
        {
            if (!CanStartCreate()) return;
            StatusMessage = null;
            ActionError = null;
            _editBase = null;
            OpenEditor(new SkillDraft(), create: true);
        }

        [RelayCommand(CanExecute = nameof(CanStartEdit))]
        private void Edit() => StartEdit();

        private bool CanStartEdit() =>
            !IsEditorOpen && PendingDelete is null && IsDetailCurrent && SelectedRow?.IsBusy == false;

        public void StartEdit()
        {
            if (!CanStartEdit() || Detail is not { } d) return;
            StatusMessage = null;
            ActionError = null;
            _editBase = d;
            OpenEditor(SkillDraft.From(d), create: false);
        }

        [RelayCommand(CanExecute = nameof(CanCancelEdit))]
        public void CancelEdit()
        {
            if (!CanCancelEdit()) return;
            CloseEditor();
            EnsureDetailForSelection();
        }

        private bool CanCancelEdit() => IsEditorOpen && !IsSaving;

        /// <summary>Line endings as the server stores them (CRLF/CR → LF). WPF
        /// text boxes insert CRLF, so the draft is normalized before diffing,
        /// counting and sending; this is the same text the server keeps.</summary>
        public static string NormalizeNewlines(string? text) =>
            (text ?? "").Replace("\r\n", "\n").Replace('\r', '\n');

        public SkillDraft CurrentDraft() =>
            new(EditName, EditKeyword, NormalizeNewlines(EditInstructions), EditEnabled);

        /// <summary>Local checks for obvious mistakes. The server remains authoritative.</summary>
        public static Dictionary<string, string> LocalFieldErrors(SkillDraft draft)
        {
            var errors = new Dictionary<string, string>();
            string name = draft.Name.Trim();
            string keyword = draft.Keyword.Trim();
            if (name.Length == 0)
                errors["name"] = "Enter a name.";
            else if (SkillLimits.CodePoints(name) > SkillLimits.NameCodePoints)
                errors["name"] = $"Use at most {SkillLimits.NameCodePoints} characters.";
            else if (name.IndexOfAny(new[] { '\r', '\n' }) >= 0)
                errors["name"] = "Names must be a single line.";

            if (keyword.Length == 0)
                errors["keyword"] = "Enter a keyword or phrase.";
            else if (SkillLimits.CodePoints(keyword) > SkillLimits.KeywordCodePoints)
                errors["keyword"] = $"Use at most {SkillLimits.KeywordCodePoints} characters.";
            else if (keyword.IndexOfAny(new[] { '\r', '\n' }) >= 0)
                errors["keyword"] = "Keywords must be a single line.";

            string instructions = NormalizeNewlines(draft.Instructions);
            if (instructions.Trim().Length == 0)
                errors["instructions"] = "Enter instructions.";
            else if (SkillLimits.CodePoints(instructions) > SkillLimits.InstructionCodePoints ||
                     SkillLimits.Utf8Bytes(instructions) > SkillLimits.InstructionBytes)
                errors["instructions"] =
                    $"Use at most {SkillLimits.InstructionCodePoints} characters ({SkillLimits.InstructionBytes / 1024} KiB).";
            return errors;
        }

        [RelayCommand(CanExecute = nameof(CanSave))]
        private void Save() => _ = SaveAsync();

        private bool CanSave() => IsEditorOpen && !IsSaving;

        public async Task SaveAsync()
        {
            if (!CanSave()) return;
            var draft = CurrentDraft();
            var local = LocalFieldErrors(draft);
            ApplyFieldErrors(local);
            EditorError = null;
            EditorNotice = null;
            if (local.Count > 0) return;

            bool create = IsCreateMode;
            var editBase = _editBase;
            if (!create && editBase is not null && SkillPatch.Diff(editBase, draft).IsEmpty)
            {
                CloseEditor();
                StatusMessage = "No changes to save.";
                EnsureDetailForSelection();
                return;
            }

            int generation = ++_editorGeneration;
            IsSaving = true;
            SkillDto saved;
            try
            {
                saved = create || editBase is null
                    ? await _service.CreateAsync(draft)
                    : await _service.UpdateAsync(editBase.Id, editBase.Revision, SkillPatch.Diff(editBase, draft));
            }
            catch (Exception ex)
            {
                if (generation != _editorGeneration || !IsEditorOpen) return;
                IsSaving = false;
                var err = SkillsApiException.From(ex);
                // Keep the draft in every failure case.
                EditorError = err.Kind == SkillsErrorKind.Cancelled ? null : err.Message;
                ApplyFieldErrors(err.Fields);
                switch (err.Kind)
                {
                    case SkillsErrorKind.RevisionConflict:
                    case SkillsErrorKind.RevisionRequired:
                        HasConflict = true;
                        break;
                    case SkillsErrorKind.NotFound when !create:
                        SwitchToCreateKeepingDraft();
                        break;
                }
                return;
            }

            if (generation != _editorGeneration || !IsEditorOpen) return;
            IsSaving = false;
            CloseEditor();
            StatusMessage = create ? CreatedMessage : SavedMessage;
            var row = ReplaceSummary(saved.ToSummary());
            _detailGeneration++;
            _detailCts?.Cancel();
            _suppressSelection = true;
            try { SelectedRow = row; }
            finally { _suppressSelection = false; }
            Detail = saved;
            DetailState = SkillsLoadState.Loaded;
            DetailError = null;
            await ReloadListAsync();
        }

        [RelayCommand(CanExecute = nameof(CanReloadLatest))]
        private void ReloadLatest() => _ = ReloadLatestKeepingDraftAsync();

        private bool CanReloadLatest() => IsEditorOpen && !IsSaving && !IsCreateMode && _editBase is not null;

        /// <summary>After a conflict: fetch the latest revision and rebase the
        /// draft onto it (three-way merge) without discarding the user's text.</summary>
        public async Task ReloadLatestKeepingDraftAsync()
        {
            if (!CanReloadLatest() || _editBase is not { } originalBase) return;
            int generation = ++_editorGeneration;
            IsSaving = true;
            SkillDto latest;
            try
            {
                latest = await _service.GetAsync(originalBase.Id);
            }
            catch (Exception ex)
            {
                if (generation != _editorGeneration || !IsEditorOpen) return;
                IsSaving = false;
                var err = SkillsApiException.From(ex);
                if (err.Kind == SkillsErrorKind.NotFound)
                {
                    EditorError = null;
                    SwitchToCreateKeepingDraft();
                }
                else if (err.Kind != SkillsErrorKind.Cancelled)
                {
                    EditorError = err.Message;
                }
                return;
            }

            if (generation != _editorGeneration || !IsEditorOpen) return;
            IsSaving = false;
            var rebase = SkillDraftRebase.Merge(CurrentDraft(), originalBase, latest);
            _editBase = latest;
            SetDraft(rebase.Draft);
            SetConflictFields(rebase.Conflicts);
            HasConflict = false;
            EditorError = null;
            ApplyFieldErrors(new Dictionary<string, string>());

            if (rebase.Conflicts.Count > 0)
            {
                string labels = string.Join(", ", rebase.Conflicts.Select(SkillFieldLabels.Label));
                EditorNotice = $"Loaded revision {latest.Revision}. {labels} also changed elsewhere; " +
                               "your version is kept and will replace it if you save. Review before saving.";
            }
            else if (latest.Revision == originalBase.Revision)
            {
                EditorNotice = "Already up to date. Save again to apply your edits.";
            }
            else if (rebase.Adopted.Count == 0)
            {
                EditorNotice = $"Loaded revision {latest.Revision}. Your edits are kept; review and save again.";
            }
            else
            {
                string labels = string.Join(", ", rebase.Adopted.Select(SkillFieldLabels.Label));
                EditorNotice = $"Loaded revision {latest.Revision}. Updated {labels} from the latest version; " +
                               "your edits are kept. Review and save again.";
            }

            ReplaceSummary(latest.ToSummary());
            if (SelectedRow?.Id == latest.Id)
            {
                Detail = latest;
                DetailState = SkillsLoadState.Loaded;
            }
        }

        // ── Toggle ──────────────────────────────────────────────────────

        [RelayCommand(CanExecute = nameof(CanToggleSelected))]
        private void ToggleSelected()
        {
            if (SelectedRow is { } row) _ = ToggleAsync(row, !row.Summary.Enabled);
        }

        private bool CanToggleSelected() =>
            SelectedRow is { IsBusy: false } && IsDetailCurrent && !IsEditorOpen && PendingDelete is null;

        /// <summary>
        /// Request <paramref name="target"/> for a row. Pending: the row is
        /// busy (disabled) until the server answers; success shows the server
        /// state, failure rolls the switch back to the last confirmed state.
        /// The revision sent is the one the user is looking at, so an unseen
        /// newer revision gets a 409 instead of a silent overwrite.
        /// </summary>
        public async Task ToggleAsync(SkillRow row, bool target)
        {
            if (row.IsBusy || IsEditorOpen || PendingDelete is not null || ShowsStaleDetail(row) ||
                target == row.Summary.Enabled)
            {
                row.Apply(row.Summary);
                return;
            }

            int revision = row.Summary.Revision;
            row.IsBusy = true;
            row.ShowPending(target);
            ActionError = null;
            StatusMessage = null;
            NotifyComputed();

            SkillDto updated;
            try
            {
                updated = await _service.UpdateAsync(row.Id, revision, new SkillPatch(Enabled: target));
            }
            catch (Exception ex)
            {
                row.IsBusy = false;
                var err = SkillsApiException.From(ex);
                // Roll back to the last server-confirmed state.
                row.Apply(row.Summary);
                if (err.Kind == SkillsErrorKind.Cancelled) { NotifyComputed(); return; }
                ActionError = err.Message;
                NotifyComputed();
                var reload = ReloadListAsync();
                if (!IsEditorOpen && SelectedRow?.Id == row.Id) await Task.WhenAll(reload, LoadDetailAsync(row.Id));
                else await reload;
                return;
            }

            row.IsBusy = false;
            ReplaceSummary(updated.ToSummary());
            if (Detail?.Id == updated.Id && !IsEditorOpen)
            {
                Detail = updated;
                DetailState = SkillsLoadState.Loaded;
            }
            string name = SkillStatusPresentation.DisplayName(updated.Name);
            StatusMessage = updated.Enabled ? $"Enabled “{name}”." : $"Disabled “{name}”.";
            NotifyComputed();
            await ReloadListAsync();
        }

        // ── Delete ──────────────────────────────────────────────────────

        [RelayCommand(CanExecute = nameof(CanRequestDelete))]
        private void RequestDelete()
        {
            if (SelectedRow is { } row) RequestDeleteFor(row);
        }

        private bool CanRequestDelete() =>
            SelectedRow is { IsBusy: false } && IsDetailCurrent && !IsEditorOpen && PendingDelete is null;

        public void RequestDeleteFor(SkillRow row)
        {
            if (row.IsBusy || IsEditorOpen || ShowsStaleDetail(row)) return;
            // Pin what the user is confirming. A refresh while the prompt is
            // open may advance the row, but the DELETE still sends this
            // revision, so a newer unseen version gets a 409 instead of
            // being deleted silently.
            _pendingDeleteRevision = row.Summary.Revision;
            _pendingDeleteName = row.Name;
            PendingDelete = row;
        }

        private int _pendingDeleteRevision;
        private string _pendingDeleteName = "";

        [RelayCommand(CanExecute = nameof(HasPendingDelete))]
        public void CancelDelete() => PendingDelete = null;

        [RelayCommand(CanExecute = nameof(HasPendingDelete))]
        private void ConfirmDelete() => _ = ConfirmDeleteAsync();

        public async Task ConfirmDeleteAsync()
        {
            if (PendingDelete is not { } row) return;
            int revision = _pendingDeleteRevision;
            string name = _pendingDeleteName;
            PendingDelete = null;
            if (row.IsBusy) return;
            row.IsBusy = true;
            ActionError = null;
            StatusMessage = null;
            NotifyComputed();

            try
            {
                await _service.DeleteAsync(row.Id, revision);
                row.IsBusy = false;
                RemoveLocally(row);
                StatusMessage = $"Deleted “{name}”.";
            }
            catch (Exception ex)
            {
                row.IsBusy = false;
                var err = SkillsApiException.From(ex);
                switch (err.Kind)
                {
                    case SkillsErrorKind.Cancelled:
                        NotifyComputed();
                        return;
                    case SkillsErrorKind.NotFound:
                        RemoveLocally(row);
                        StatusMessage = $"“{name}” was already deleted.";
                        break;
                    default:
                        ActionError = err.Message;
                        break;
                }
            }
            NotifyComputed();
            await ReloadListAsync();
        }

        [RelayCommand]
        private void Refresh() => _ = RefreshAsync();

        // ── Helpers ─────────────────────────────────────────────────────

        /// <summary>The open detail for this skill is older than its row;
        /// mutating now would target a revision the user hasn't read.</summary>
        private bool ShowsStaleDetail(SkillRow row) =>
            SelectedRow?.Id == row.Id && Detail is { } d && d.Id == row.Id && d.Revision < row.Summary.Revision;

        private void OpenEditor(SkillDraft draft, bool create)
        {
            _editorGeneration++;
            IsCreateMode = create;
            SetDraft(draft);
            SetConflictFields(Array.Empty<SkillField>());
            ApplyFieldErrors(new Dictionary<string, string>());
            HasConflict = false;
            EditorError = null;
            EditorNotice = null;
            IsSaving = false;
            IsEditorOpen = true;
        }

        private void CloseEditor()
        {
            _editorGeneration++;
            IsEditorOpen = false;
            IsSaving = false;
            HasConflict = false;
            EditorError = null;
            EditorNotice = null;
            _editBase = null;
            SetConflictFields(Array.Empty<SkillField>());
            ApplyFieldErrors(new Dictionary<string, string>());
        }

        private void SwitchToCreateKeepingDraft()
        {
            IsCreateMode = true;
            _editBase = null;
            HasConflict = false;
            SetConflictFields(Array.Empty<SkillField>());
            EditorNotice = DeletedElsewhereNotice;
        }

        private void EnsureDetailForSelection()
        {
            if (SelectedRow is { } row && !IsDetailCurrent) _ = LoadDetailAsync(row.Id);
            NotifyComputed();
        }

        private void SetDraft(SkillDraft draft)
        {
            EditName = draft.Name;
            EditKeyword = draft.Keyword;
            EditInstructions = draft.Instructions;
            EditEnabled = draft.Enabled;
        }

        private void SetConflictFields(IReadOnlyCollection<SkillField> fields)
        {
            NameConflict = fields.Contains(SkillField.Name);
            KeywordConflict = fields.Contains(SkillField.Keyword);
            InstructionsConflict = fields.Contains(SkillField.Instructions);
            EnabledConflict = fields.Contains(SkillField.Enabled);
        }

        private void ApplyFieldErrors(IReadOnlyDictionary<string, string> fields)
        {
            NameError = fields.TryGetValue("name", out var n) ? n : null;
            KeywordError = fields.TryGetValue("keyword", out var k) ? k : null;
            InstructionsError = fields.TryGetValue("instructions", out var i) ? i : null;
            EnabledError = fields.TryGetValue("enabled", out var e) ? e : null;
            FormError = fields.TryGetValue("body", out var b) ? b : null;
        }

        /// <summary>Upsert a server summary, never replacing a newer one.</summary>
        private SkillRow ReplaceSummary(SkillSummary summary)
        {
            var row = Skills.FirstOrDefault(r => r.Id == summary.Id);
            if (row is null)
            {
                row = NewRow(summary);
                Skills.Add(row);
                NotifyComputed();
            }
            else if (row.Summary.Revision <= summary.Revision && !row.IsBusy)
            {
                row.Apply(summary);
            }
            return row;
        }

        private SkillRow NewRow(SkillSummary summary) =>
            new(summary) { ToggleRequested = (r, target) => _ = ToggleAsync(r, target) };

        /// <summary>Make the rows match the server list in order, reusing row
        /// instances so selection and focus survive a refresh.</summary>
        private void SyncRows(IReadOnlyList<SkillSummary> list)
        {
            var existing = Skills.ToDictionary(r => r.Id, StringComparer.Ordinal);
            for (int i = 0; i < list.Count; i++)
            {
                var summary = list[i];
                if (existing.TryGetValue(summary.Id, out var row))
                {
                    // A list response that was already in flight may predate
                    // a save/toggle; revisions only move forward.
                    if (!row.IsBusy && row.Summary.Revision <= summary.Revision) row.Apply(summary);
                    int at = Skills.IndexOf(row);
                    if (at != i) Skills.Move(at, i);
                }
                else
                {
                    Skills.Insert(i, NewRow(summary));
                }
            }
            while (Skills.Count > list.Count)
            {
                var gone = Skills[^1];
                if (ReferenceEquals(PendingDelete, gone)) PendingDelete = null;
                Skills.RemoveAt(Skills.Count - 1);
                if (ReferenceEquals(SelectedRow, gone)) SelectedRow = null;
            }
            NotifyComputed();
        }

        private void RemoveLocally(SkillRow row)
        {
            bool wasSelected = ReferenceEquals(SelectedRow, row);
            Skills.Remove(row);
            if (wasSelected) SelectedRow = null;
            NotifyComputed();
        }

        protected override void OnPropertyChanged(PropertyChangedEventArgs e)
        {
            base.OnPropertyChanged(e);
            switch (e.PropertyName)
            {
                case nameof(EditInstructions):
                    base.OnPropertyChanged(new PropertyChangedEventArgs(nameof(InstructionsCounter)));
                    return;
                case nameof(EditName):
                case nameof(EditKeyword):
                case nameof(EditEnabled):
                    return;
                case nameof(ListState):
                case nameof(IsUpgradeRequired):
                case nameof(SelectedRow):
                case nameof(Detail):
                case nameof(DetailState):
                case nameof(IsEditorOpen):
                case nameof(IsCreateMode):
                case nameof(IsSaving):
                case nameof(EditorError):
                case nameof(EditorNotice):
                case nameof(PendingDelete):
                case nameof(StatusMessage):
                case nameof(ActionError):
                    NotifyComputed();
                    break;
            }
        }

        private static readonly string[] ComputedNames =
        {
            nameof(IsListLoading), nameof(HasListError), nameof(IsEmptyStateVisible), nameof(IsListInteractive),
            nameof(ShowNoSelection), nameof(ShowDetail), nameof(IsDetailCurrent), nameof(IsDetailLoading),
            nameof(HasDetailError), nameof(DetailName), nameof(DetailKeyword), nameof(DetailInstructions),
            nameof(DetailMeta), nameof(ToggleSelectedLabel), nameof(EditorTitle), nameof(HasEditorError),
            nameof(HasEditorNotice), nameof(HasActionError), nameof(HasStatusMessage), nameof(HasPendingDelete),
            nameof(DeleteConfirmText),
        };

        private void NotifyComputed()
        {
            foreach (var name in ComputedNames)
                base.OnPropertyChanged(new PropertyChangedEventArgs(name));
            NewSkillCommand.NotifyCanExecuteChanged();
            EditCommand.NotifyCanExecuteChanged();
            CancelEditCommand.NotifyCanExecuteChanged();
            SaveCommand.NotifyCanExecuteChanged();
            ReloadLatestCommand.NotifyCanExecuteChanged();
            ToggleSelectedCommand.NotifyCanExecuteChanged();
            RequestDeleteCommand.NotifyCanExecuteChanged();
            CancelDeleteCommand.NotifyCanExecuteChanged();
            ConfirmDeleteCommand.NotifyCanExecuteChanged();
        }
    }
}
