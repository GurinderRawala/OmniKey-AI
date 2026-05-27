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
    /// <summary>
    /// Wraps an <see cref="MCPServerDto"/> so a row in the list can bind to
    /// observable fields (e.g. <see cref="IsEnabled"/> via a toggle switch)
    /// without mutating the backing DTO directly.
    /// </summary>
    internal sealed partial class MCPServerItem : ObservableObject
    {
        public MCPServerDto Dto { get; }

        [ObservableProperty]
        private bool isEnabled;

        [ObservableProperty]
        private string name = string.Empty;

        [ObservableProperty]
        private string transport = "stdio";

        [ObservableProperty]
        private string description = string.Empty;

        public bool IsPersisted => !string.IsNullOrEmpty(Dto.Id);

        /// <summary>Owner is set by the VM so toggles can call back to the API.</summary>
        public MCPServersViewModel? Owner { get; set; }

        public MCPServerItem(MCPServerDto dto)
        {
            Dto = dto;
            Name = dto.Name;
            Transport = dto.Transport;
            Description = dto.Description ?? string.Empty;
            IsEnabled = dto.IsEnabled;
        }

        partial void OnIsEnabledChanged(bool value)
        {
            if (Owner is null) return;
            if (!IsPersisted)
            {
                Dto.IsEnabled = value;
                return;
            }
            if (Dto.IsEnabled == value) return;
            _ = Owner.ToggleEnabledAsync(this, value);
        }
    }

    internal partial class MCPServersViewModel : ObservableObject
    {
        private readonly ApiClient _api = new();

        public ObservableCollection<MCPServerItem> Servers { get; } = new();

        public IReadOnlyList<string> TransportOptions { get; } =
            new[] { "stdio", "http", "sse" };

        [ObservableProperty]
        private MCPServerItem? selectedServer;

        // ── Editor fields (bound to the right pane) ──────────────────────

        [ObservableProperty]
        private string editName = string.Empty;

        [ObservableProperty]
        private string editDescription = string.Empty;

        [ObservableProperty]
        private string editTransport = "stdio";

        [ObservableProperty]
        private string editCommand = string.Empty;

        [ObservableProperty]
        private string editArgs = string.Empty;

        [ObservableProperty]
        private string editUrl = string.Empty;

        [ObservableProperty]
        private bool editEnabled = true;

        // ── Status / loading state ───────────────────────────────────────

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isLoading;

        public bool HasSelection => SelectedServer is not null;
        public bool HasNoSelection => SelectedServer is null;
        public bool IsStdio => string.Equals(EditTransport, "stdio", StringComparison.OrdinalIgnoreCase);
        public bool IsRemote => !IsStdio;
        public bool IsEditingExisting => SelectedServer?.IsPersisted == true;

        public string EditorTitle => SelectedServer is null
            ? "Server"
            : SelectedServer.IsPersisted ? "Edit MCP Server" : "Add MCP Server";

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        public bool CanSave =>
            HasSelection &&
            !IsLoading &&
            !string.IsNullOrWhiteSpace(EditName) &&
            (IsStdio ? !string.IsNullOrWhiteSpace(EditCommand) : !string.IsNullOrWhiteSpace(EditUrl));

        // ── Property change side-effects ─────────────────────────────────

        partial void OnSelectedServerChanged(MCPServerItem? value)
        {
            if (value is null)
            {
                EditName = string.Empty;
                EditDescription = string.Empty;
                EditTransport = "stdio";
                EditCommand = string.Empty;
                EditArgs = string.Empty;
                EditUrl = string.Empty;
                EditEnabled = true;
            }
            else
            {
                var dto = value.Dto;
                EditName = dto.Name;
                EditDescription = dto.Description ?? string.Empty;
                EditTransport = string.IsNullOrEmpty(dto.Transport) ? "stdio" : dto.Transport;
                EditCommand = dto.Command ?? string.Empty;
                EditArgs = string.Join(Environment.NewLine, dto.Args ?? new List<string>());
                EditUrl = dto.Url ?? string.Empty;
                EditEnabled = dto.IsEnabled;
            }

            OnPropertyChanged(nameof(HasSelection));
            OnPropertyChanged(nameof(HasNoSelection));
            OnPropertyChanged(nameof(IsEditingExisting));
            OnPropertyChanged(nameof(EditorTitle));
            RaiseAllCanExecuteChanged();
        }

        partial void OnEditTransportChanged(string value)
        {
            OnPropertyChanged(nameof(IsStdio));
            OnPropertyChanged(nameof(IsRemote));
            SaveCommand.NotifyCanExecuteChanged();
        }

        partial void OnEditNameChanged(string value) => SaveCommand.NotifyCanExecuteChanged();
        partial void OnEditCommandChanged(string value) => SaveCommand.NotifyCanExecuteChanged();
        partial void OnEditUrlChanged(string value) => SaveCommand.NotifyCanExecuteChanged();

        partial void OnIsLoadingChanged(bool value) => RaiseAllCanExecuteChanged();
        partial void OnStatusKindChanged(StatusKind value) => OnPropertyChanged(nameof(StatusBrush));

        // ── Commands ─────────────────────────────────────────────────────

        [RelayCommand]
        private async Task LoadAsync()
        {
            IsLoading = true;
            SetStatus("Loading…", StatusKind.Neutral);
            try
            {
                var fetched = await _api.FetchMCPServersAsync();
                RebuildServers(fetched);
                SetStatus($"{fetched.Count} server(s).", StatusKind.Neutral);
            }
            catch (Exception ex)
            {
                SetStatus("Failed to load: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsLoading = false;
            }
        }

        [RelayCommand]
        private void AddServer()
        {
            // Insert a draft (non-persisted) item; selecting it opens the editor.
            var draft = new MCPServerItem(new MCPServerDto
            {
                Name = string.Empty,
                Transport = "stdio",
                IsEnabled = true,
            })
            {
                Owner = this,
            };
            Servers.Insert(0, draft);
            SelectedServer = draft;
            SetStatus("New draft server — fill in the form and Save.", StatusKind.Neutral);
        }

        private bool CanSaveCmd() => CanSave;

        [RelayCommand(CanExecute = nameof(CanSaveCmd))]
        private async Task SaveAsync()
        {
            if (SelectedServer is not { } current) return;

            var transport = string.IsNullOrWhiteSpace(EditTransport) ? "stdio" : EditTransport.Trim();
            var name = EditName.Trim();
            if (string.IsNullOrWhiteSpace(name))
            {
                SetStatus("Name is required.", StatusKind.Negative);
                return;
            }
            if (transport == "stdio" && string.IsNullOrWhiteSpace(EditCommand))
            {
                SetStatus("Command is required for stdio transport.", StatusKind.Negative);
                return;
            }
            if (transport != "stdio" && string.IsNullOrWhiteSpace(EditUrl))
            {
                SetStatus("URL is required for http/sse transport.", StatusKind.Negative);
                return;
            }

            var payload = new MCPServerDto
            {
                Name = name,
                Description = string.IsNullOrWhiteSpace(EditDescription) ? null : EditDescription.Trim(),
                Transport = transport,
                Command = transport == "stdio" ? EditCommand.Trim() : null,
                Args = transport == "stdio"
                    ? EditArgs
                        .Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(s => s.Trim())
                        .Where(s => s.Length > 0)
                        .ToList()
                    : new List<string>(),
                Env = current.Dto.Env ?? new Dictionary<string, string>(),
                Url = transport != "stdio" ? EditUrl.Trim() : null,
                Headers = current.Dto.Headers ?? new Dictionary<string, string>(),
                IsEnabled = EditEnabled,
            };

            IsLoading = true;
            SetStatus("Saving…", StatusKind.Neutral);
            try
            {
                MCPServerDto saved = current.IsPersisted
                    ? await _api.UpdateMCPServerAsync(current.Dto.Id, payload)
                    : await _api.CreateMCPServerAsync(payload);

                ReplaceOrAdd(current, saved);
                SetStatus("Saved.", StatusKind.Positive);
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

        private bool CanDelete() => HasSelection && !IsLoading;

        [RelayCommand(CanExecute = nameof(CanDelete))]
        private async Task DeleteAsync()
        {
            if (SelectedServer is not { } current) return;

            if (!current.IsPersisted)
            {
                Servers.Remove(current);
                SelectedServer = Servers.FirstOrDefault();
                SetStatus("Draft discarded.", StatusKind.Neutral);
                return;
            }

            IsLoading = true;
            SetStatus("Deleting…", StatusKind.Neutral);
            try
            {
                await _api.DeleteMCPServerAsync(current.Dto.Id);
                Servers.Remove(current);
                SelectedServer = Servers.FirstOrDefault();
                SetStatus("Deleted.", StatusKind.Positive);
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

        [RelayCommand]
        private async Task RefreshAsync() => await LoadAsync();

        // ── Public helpers used by MCPServerItem ────────────────────────

        public async Task ToggleEnabledAsync(MCPServerItem item, bool isEnabled)
        {
            if (!item.IsPersisted) return;
            try
            {
                SetStatus(isEnabled ? "Enabling…" : "Disabling…", StatusKind.Neutral);
                var updated = await _api.ToggleMCPServerAsync(item.Dto.Id, isEnabled);
                item.Dto.IsEnabled = updated.IsEnabled;
                // Reflect server-confirmed state back onto the row without re-firing the partial.
                if (item.IsEnabled != updated.IsEnabled)
                {
                    item.IsEnabled = updated.IsEnabled;
                }
                if (ReferenceEquals(SelectedServer, item))
                {
                    EditEnabled = updated.IsEnabled;
                }
                SetStatus(updated.IsEnabled ? "Enabled." : "Disabled.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                // Revert the toggle locally on failure.
                item.IsEnabled = !isEnabled;
                item.Dto.IsEnabled = !isEnabled;
                SetStatus("Failed to toggle: " + ex.Message, StatusKind.Negative);
            }
        }

        // ── Internal helpers ────────────────────────────────────────────

        private void RebuildServers(List<MCPServerDto> dtos)
        {
            Servers.Clear();
            foreach (var dto in dtos)
            {
                Servers.Add(new MCPServerItem(dto) { Owner = this });
            }
            SelectedServer = null;
        }

        private void ReplaceOrAdd(MCPServerItem current, MCPServerDto saved)
        {
            var fresh = new MCPServerItem(saved) { Owner = this };
            int idx = Servers.IndexOf(current);
            if (idx >= 0)
            {
                Servers[idx] = fresh;
            }
            else
            {
                Servers.Add(fresh);
            }
            SelectedServer = fresh;
        }

        private void RaiseAllCanExecuteChanged()
        {
            SaveCommand.NotifyCanExecuteChanged();
            DeleteCommand.NotifyCanExecuteChanged();
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
