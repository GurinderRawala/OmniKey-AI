using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>Sidebar items in the redesigned Settings page. Mirrors the
    /// macOS SettingsShell.SettingsTab enum (providers / agent access /
    /// updates / manual) so both platforms expose the same surface.</summary>
    public enum SettingsSection
    {
        Providers,
        AgentAccess,
        Updates,
        Manual,
    }

    /// <summary>Sub-mode of the Providers section: the 4-tile list or a
    /// per-provider editor reached by clicking a tile. The editor lives in
    /// the same right-hand pane and surfaces a Back button.</summary>
    public enum ProvidersMode
    {
        List,
        Edit,
    }

    internal sealed partial class AIProviderItem : ObservableObject
    {
        public AIProviderDto Dto { get; private set; }

        public AIProviderItem(AIProviderDto dto) => Dto = dto;

        public string Provider => Dto.Provider;
        public string DisplayName => Dto.Provider switch
        {
            "openai" => "OpenAI",
            "anthropic" => "Anthropic",
            "gemini" => "Google Gemini",
            "nemotron" => "NVIDIA Nemotron",
            _ => Dto.Provider
        };
        public bool IsConfigured => Dto.IsConfigured;
        public string ApiKeyMasked => Dto.ApiKeyMasked ?? "Not configured";
        public string BaseUrl => Dto.BaseUrl ?? "Default endpoint";
        public string Model => Dto.Model ?? "Server default";
        public bool SupportsBaseUrl => Provider == "nemotron";
        public bool SupportsModel => Provider == "openai";

        /// <summary>Whether this provider is the one currently activated
        /// (AI_PROVIDER in config.json). Set by the view-model after a fetch
        /// or activation; drives the status dot / "Active" badge so the list
        /// mirrors the macOS provider rows.</summary>
        private bool _isActive;
        public bool IsActive
        {
            get => _isActive;
            // A change ripples into StatusBadge / StatusBrush / TileBorderBrush
            // so refresh every binding on this row.
            set { if (SetProperty(ref _isActive, value)) OnPropertyChanged(string.Empty); }
        }

        /// <summary>The saved (masked) key plus base URL when present, or a
        /// "No key saved" placeholder.</summary>
        public string KeyDisplay
        {
            get
            {
                string key = IsConfigured
                    ? (string.IsNullOrEmpty(Dto.ApiKeyMasked) ? "••••••••" : Dto.ApiKeyMasked)
                    : "No key saved";
                return string.IsNullOrWhiteSpace(Dto.BaseUrl) ? key : $"{key}  ·  {Dto.BaseUrl}";
            }
        }

        /// <summary>Trailing badge: "Active" for the live provider, "Not
        /// configured" when no key is saved, "Configured" otherwise.</summary>
        public string StatusBadge => IsActive
            ? "Active"
            : (IsConfigured ? "Configured" : "Not configured");

        /// <summary>Status-dot colour: green when active, blue when configured,
        /// muted otherwise.</summary>
        public Brush StatusBrush
        {
            get
            {
                string key = IsActive && IsConfigured ? "Nord.AccentGreenBrush"
                    : IsConfigured ? "Nord.AccentBlueBrush"
                    : "Nord.SecondaryTextBrush";
                return System.Windows.Application.Current?.Resources[key] as Brush
                       ?? Brushes.Gray;
            }
        }

        /// <summary>Outline colour for the provider tile. Highlights the
        /// active provider with the green accent so it pops out of the grid.</summary>
        public Brush TileBorderBrush
        {
            get
            {
                string key = IsActive && IsConfigured ? "Nord.AccentGreenBrush" : "Nord.BorderBrush";
                return System.Windows.Application.Current?.Resources[key] as Brush
                       ?? Brushes.Gray;
            }
        }

        public double TileBorderThickness => IsActive && IsConfigured ? 1.5 : 1.0;

        public void Replace(AIProviderDto dto)
        {
            Dto = dto;
            OnPropertyChanged(string.Empty);
        }
    }

    internal partial class SettingsViewModel : ObservableObject
    {
        private readonly ApiClient _api = new();

        public ObservableCollection<AIProviderItem> Providers { get; } = new();

        /// <summary>Smart-tier OpenAI models offered in the model dropdown.
        /// The picker is editable so any model id can still be typed; the
        /// server falls back to its own default (gpt-5.5) when the field is
        /// left blank.</summary>
        public System.Collections.Generic.IReadOnlyList<string> OpenAiModelOptions { get; } =
            new[] { "gpt-5.5", "gpt-5.1" };

        // Sidebar / pane navigation --------------------------------------------
        [ObservableProperty] private SettingsSection selectedSection = SettingsSection.Providers;
        [ObservableProperty] private ProvidersMode providersMode = ProvidersMode.List;

        // Provider edit state --------------------------------------------------
        [ObservableProperty] private AIProviderItem? selectedProvider;
        [ObservableProperty] private string activeProvider = "openai";
        [ObservableProperty] private string? runtimeProvider;
        [ObservableProperty] private string apiKeyInput = string.Empty;
        [ObservableProperty] private string baseUrlInput = string.Empty;
        [ObservableProperty] private string openAiModelInput = string.Empty;

        // Agent-access state ---------------------------------------------------
        // The loaded values reflect what's currently persisted in config.json.
        // The Pending* mirrors are what the user has tweaked in the UI but not
        // yet saved. We compare the two to decide whether Save is enabled and
        // which sub-API calls to make.
        [ObservableProperty] private string terminalAccess = "limited";
        [ObservableProperty] private bool webSearchEnabled;
        [ObservableProperty] private bool browserAccessEnabled;
        [ObservableProperty] private string browserAccessSummary = "Not loaded";

        [ObservableProperty] private string pendingTerminalAccess = "limited";
        [ObservableProperty] private bool pendingWebSearchEnabled;
        [ObservableProperty] private bool pendingBrowserAccessEnabled;

        // Status / busy --------------------------------------------------------
        [ObservableProperty] private bool isBusy;
        [ObservableProperty] private string statusMessage = "Load settings to manage AI providers and agent access.";
        [ObservableProperty] private StatusKind statusKind = StatusKind.Neutral;

        public string CurrentVersion { get; } = UpdateChecker.CurrentVersion.ToString(3);
        public bool CanRun => !IsBusy;
        public bool CanSaveProvider => !IsBusy && SelectedProvider is not null && !string.IsNullOrWhiteSpace(ApiKeyInput);
        public bool CanActivateProvider => !IsBusy && SelectedProvider is { IsConfigured: true } && SelectedProvider.Provider != ActiveProvider;
        public bool CanDeleteProvider => !IsBusy && SelectedProvider is { IsConfigured: true } && SelectedProvider.Provider != ActiveProvider;
        public bool CanSaveModel => !IsBusy && ModelDirty;

        /// <summary>The model the picker should fall back to when a provider has
        /// no explicit model saved — the first (default) entry, gpt-5.5. Mirrors
        /// macOS <c>openAISmartModels[0]</c>.</summary>
        private string DefaultOpenAiModel =>
            OpenAiModelOptions.Count > 0 ? OpenAiModelOptions[0] : "gpt-5.5";

        /// <summary>The OpenAI model currently persisted for the selected
        /// provider, normalised to the default when none is stored.</summary>
        private string CurrentOpenAiModel =>
            SelectedProvider is { } p && !string.IsNullOrEmpty(p.Dto.Model)
                ? p.Dto.Model!
                : DefaultOpenAiModel;

        /// <summary>True when the picked model differs from what's saved — drives
        /// the Apply/Save Model button so it only appears after a real change,
        /// mirroring the macOS settings card.</summary>
        public bool ModelDirty =>
            SelectedProvider is { SupportsModel: true }
            && !string.IsNullOrWhiteSpace(OpenAiModelInput)
            && !string.Equals(OpenAiModelInput.Trim(), CurrentOpenAiModel, StringComparison.Ordinal);

        /// <summary>True when any agent-access toggle differs from the loaded
        /// value, i.e. the Save button has work to do.</summary>
        public bool AgentAccessDirty =>
            PendingTerminalAccess != TerminalAccess
            || PendingWebSearchEnabled != WebSearchEnabled
            || PendingBrowserAccessEnabled != BrowserAccessEnabled;

        public bool CanSaveAgentAccess => !IsBusy && AgentAccessDirty;

        // ---- Sidebar selection helpers (bool bindings for sidebar buttons) ---
        public bool IsProvidersSelected => SelectedSection == SettingsSection.Providers;
        public bool IsAgentAccessSelected => SelectedSection == SettingsSection.AgentAccess;
        public bool IsUpdatesSelected => SelectedSection == SettingsSection.Updates;
        public bool IsManualSelected => SelectedSection == SettingsSection.Manual;

        public bool IsProvidersList => SelectedSection == SettingsSection.Providers && ProvidersMode == ProvidersMode.List;
        public bool IsProvidersEdit => SelectedSection == SettingsSection.Providers && ProvidersMode == ProvidersMode.Edit;

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        // ---- Property-changed plumbing --------------------------------------
        partial void OnSelectedSectionChanged(SettingsSection value)
        {
            // Whenever the sidebar selection changes, drop any in-progress
            // provider editor back to the list view so the user always lands
            // on the grid of tiles when re-opening Providers.
            ProvidersMode = ProvidersMode.List;
            OnPropertyChanged(nameof(IsProvidersSelected));
            OnPropertyChanged(nameof(IsAgentAccessSelected));
            OnPropertyChanged(nameof(IsUpdatesSelected));
            OnPropertyChanged(nameof(IsManualSelected));
            OnPropertyChanged(nameof(IsProvidersList));
            OnPropertyChanged(nameof(IsProvidersEdit));
        }

        partial void OnProvidersModeChanged(ProvidersMode value)
        {
            OnPropertyChanged(nameof(IsProvidersList));
            OnPropertyChanged(nameof(IsProvidersEdit));
        }

        partial void OnSelectedProviderChanged(AIProviderItem? value)
        {
            ApiKeyInput = string.Empty;
            BaseUrlInput = value?.Dto.BaseUrl ?? string.Empty;
            // Pre-select the saved model; for OpenAI with nothing saved, show the
            // default (gpt-5.5) so the dropdown always has a valid selection and
            // ModelDirty reads false until the user actually changes it — mirrors
            // macOS where the picker defaults to openAISmartModels[0].
            OpenAiModelInput = !string.IsNullOrEmpty(value?.Dto.Model)
                ? value!.Dto.Model!
                : (value?.SupportsModel == true ? DefaultOpenAiModel : string.Empty);
            NotifyCommandStates();
        }

        partial void OnApiKeyInputChanged(string value) => SaveProviderCommand.NotifyCanExecuteChanged();
        partial void OnOpenAiModelInputChanged(string value)
        {
            OnPropertyChanged(nameof(ModelDirty));
            OnPropertyChanged(nameof(CanSaveModel));
            SaveModelCommand.NotifyCanExecuteChanged();
        }
        partial void OnIsBusyChanged(bool value) => NotifyCommandStates();
        partial void OnActiveProviderChanged(string value)
        {
            foreach (var p in Providers) p.IsActive = p.Provider == value;
            NotifyCommandStates();
        }
        partial void OnStatusKindChanged(StatusKind value) => OnPropertyChanged(nameof(StatusBrush));

        partial void OnTerminalAccessChanged(string value) => RefreshAgentAccessDirty();
        partial void OnWebSearchEnabledChanged(bool value) => RefreshAgentAccessDirty();
        partial void OnBrowserAccessEnabledChanged(bool value) => RefreshAgentAccessDirty();
        partial void OnPendingTerminalAccessChanged(string value) => RefreshAgentAccessDirty();
        partial void OnPendingWebSearchEnabledChanged(bool value) => RefreshAgentAccessDirty();
        partial void OnPendingBrowserAccessEnabledChanged(bool value) => RefreshAgentAccessDirty();

        private void RefreshAgentAccessDirty()
        {
            OnPropertyChanged(nameof(AgentAccessDirty));
            OnPropertyChanged(nameof(CanSaveAgentAccess));
            SaveAgentAccessCommand.NotifyCanExecuteChanged();
        }

        // ---- Commands --------------------------------------------------------

        [RelayCommand]
        private void SelectSection(SettingsSection section) => SelectedSection = section;

        /// <summary>Open the editor for a specific provider tile. Mirrors
        /// macOS startEditing(_:) — switches the right pane from the grid of
        /// tiles to the per-provider edit form.</summary>
        [RelayCommand]
        private void OpenProvider(AIProviderItem? item)
        {
            if (item is null) return;
            SelectedProvider = item;
            ProvidersMode = ProvidersMode.Edit;
        }

        /// <summary>Return from the provider editor back to the 4-tile list,
        /// discarding any unsaved input.</summary>
        [RelayCommand]
        private void BackToProviders()
        {
            ProvidersMode = ProvidersMode.List;
            ApiKeyInput = string.Empty;
        }

        [RelayCommand(CanExecute = nameof(CanRun))]
        public async Task LoadAsync()
        {
            await RunAsync(async () =>
            {
                var providers = await _api.FetchAIProvidersAsync();
                Providers.Clear();
                foreach (var dto in providers.Providers)
                    Providers.Add(new AIProviderItem(dto));
                ActiveProvider = providers.ActiveProvider;
                RuntimeProvider = providers.RuntimeProvider;
                foreach (var p in Providers) p.IsActive = p.Provider == ActiveProvider;
                SelectedProvider ??= Providers.FirstOrDefault(p => p.Provider == ActiveProvider) ?? Providers.FirstOrDefault();

                var settings = await _api.FetchAppSettingsAsync();
                TerminalAccess = settings.TerminalAccess;
                WebSearchEnabled = settings.WebSearchEnabled;
                BrowserAccessEnabled = settings.BrowserAccessEnabled;
                // Reset the pending values to whatever's persisted so the
                // Save button only lights up after the user actually changes
                // something.
                PendingTerminalAccess = TerminalAccess;
                PendingWebSearchEnabled = WebSearchEnabled;
                PendingBrowserAccessEnabled = BrowserAccessEnabled;
                BrowserAccessSummary = settings.BrowserAccessEnabled
                    ? $"Configured: {settings.BrowserDebugBrowserName ?? "browser"}" + (settings.BrowserDebugPort is int port ? $" • port {port}" : string.Empty)
                    : "Disabled";
                SetStatus("Settings loaded.", StatusKind.Positive);
            }, "Failed to load settings");
        }

        [RelayCommand(CanExecute = nameof(CanSaveProvider))]
        private async Task SaveProviderAsync()
        {
            if (SelectedProvider is null) return;
            await RunAsync(async () =>
            {
                var result = await _api.SaveAIProviderKeyAsync(SelectedProvider.Provider, ApiKeyInput.Trim(), BaseUrlInput.Trim());
                SetStatus(result.Message ?? $"Saved {SelectedProvider.DisplayName} API key.", StatusKind.Positive);
                await LoadAsync();
            }, "Failed to save provider");
        }

        [RelayCommand(CanExecute = nameof(CanActivateProvider))]
        private async Task ActivateProviderAsync()
        {
            if (SelectedProvider is null) return;
            await RunAsync(async () =>
            {
                var result = await _api.ActivateAIProviderAsync(SelectedProvider.Provider);
                ActiveProvider = result.ActiveProvider ?? SelectedProvider.Provider;
                SetStatus(result.Message ?? $"Activated {SelectedProvider.DisplayName}. Restart scheduled.", StatusKind.Positive);
                await LoadAsync();
            }, "Failed to activate provider");
        }

        [RelayCommand(CanExecute = nameof(CanDeleteProvider))]
        private async Task DeleteProviderAsync()
        {
            if (SelectedProvider is null) return;
            await RunAsync(async () =>
            {
                await _api.DeleteAIProviderKeyAsync(SelectedProvider.Provider);
                SetStatus($"Removed {SelectedProvider.DisplayName} API key.", StatusKind.Positive);
                await LoadAsync();
            }, "Failed to remove provider");
        }

        [RelayCommand(CanExecute = nameof(CanSaveModel))]
        private async Task SaveModelAsync()
        {
            if (SelectedProvider is null) return;
            await RunAsync(async () =>
            {
                var result = await _api.UpdateProviderModelAsync(SelectedProvider.Provider, OpenAiModelInput.Trim());
                SetStatus(result.Message ?? "OpenAI model updated. Restart scheduled.", StatusKind.Positive);
                await LoadAsync();
            }, "Failed to update model");
        }

        /// <summary>Applies any pending agent-access edits in one shot. Each
        /// dimension (terminal / web search / browser) only hits its API when
        /// it actually changed, so users only pay for restarts they intended.</summary>
        [RelayCommand(CanExecute = nameof(CanSaveAgentAccess))]
        private async Task SaveAgentAccessAsync()
        {
            await RunAsync(async () =>
            {
                string? termArg = PendingTerminalAccess != TerminalAccess ? PendingTerminalAccess : null;
                bool? webArg = PendingWebSearchEnabled != WebSearchEnabled ? PendingWebSearchEnabled : (bool?)null;

                if (termArg is not null || webArg is not null)
                {
                    var result = await _api.UpdateAppSettingsAsync(termArg, webArg);
                    SetStatus(result.Message ?? "Agent access updated. Restart scheduled.", StatusKind.Positive);
                }

                bool launchingBrowserWizard = false;
                if (PendingBrowserAccessEnabled != BrowserAccessEnabled)
                {
                    if (PendingBrowserAccessEnabled)
                    {
                        // Enable: the Windows daemon runs as a session-0 service
                        // and can't surface the interactive wizard, so the app
                        // launches `omnikey grant-browser-access` in a console in
                        // the user's session. The CLI writes the browser config
                        // and restarts the daemon when the user finishes, so we
                        // don't call the backend here.
                        BrowserAccessSetup.LaunchInteractiveSetup();
                        launchingBrowserWizard = true;
                        SetStatus(
                            "Follow the prompts in the terminal window to finish browser setup. " +
                            "It applies automatically when you're done.",
                            StatusKind.Positive);
                    }
                    else
                    {
                        var response = await _api.SetBrowserAccessEnabledAsync(false);
                        SetStatus(response.Message ?? "Browser access disabled.", StatusKind.Positive);
                    }
                }

                await LoadAsync();

                // The wizard runs out-of-process and hasn't written its config
                // yet, so the reload above would have reset the toggle to off.
                // Keep it visually on (and non-dirty) until the user finishes;
                // a later reload reflects the real state once setup completes.
                if (launchingBrowserWizard)
                {
                    BrowserAccessEnabled = true;
                    PendingBrowserAccessEnabled = true;
                    BrowserAccessSummary = "Setup in progress — finish the prompts in the terminal window.";
                }
            }, "Failed to save agent access");
        }

        private async Task RunAsync(Func<Task> action, string errorPrefix)
        {
            IsBusy = true;
            try { await action(); }
            catch (Exception ex) { SetStatus($"{errorPrefix}: {ex.Message}", StatusKind.Negative); }
            finally { IsBusy = false; }
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }

        private void NotifyCommandStates()
        {
            LoadCommand.NotifyCanExecuteChanged();
            SaveProviderCommand.NotifyCanExecuteChanged();
            ActivateProviderCommand.NotifyCanExecuteChanged();
            DeleteProviderCommand.NotifyCanExecuteChanged();
            SaveModelCommand.NotifyCanExecuteChanged();
            SaveAgentAccessCommand.NotifyCanExecuteChanged();
            OnPropertyChanged(nameof(CanSaveProvider));
            OnPropertyChanged(nameof(CanActivateProvider));
            OnPropertyChanged(nameof(CanDeleteProvider));
            OnPropertyChanged(nameof(ModelDirty));
            OnPropertyChanged(nameof(CanSaveModel));
            OnPropertyChanged(nameof(CanSaveAgentAccess));
        }
    }
}
