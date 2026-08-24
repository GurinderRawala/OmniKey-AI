using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using OmniKey.Windows.Views.Pages;

namespace OmniKey.Windows.ViewModels
{
    internal partial class LicenseViewModel : ObservableObject
    {
        public IReadOnlyList<SelfHostedProviderOption> ProviderOptions { get; } =
            SelfHostedBootstrap.ProviderOptions;

        [ObservableProperty]
        private string subscriptionKey = string.Empty;

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isActivating;

        [ObservableProperty]
        private bool isCheckingSetup = true;

        [ObservableProperty]
        private bool showOnboarding;

        [ObservableProperty]
        private int selectedOnboardingTabIndex;

        [ObservableProperty]
        private int setupStep;

        [ObservableProperty]
        private SelfHostedProviderOption selectedProvider = SelfHostedBootstrap.ProviderOptions[0];

        [ObservableProperty]
        private string apiKeyInput = string.Empty;

        [ObservableProperty]
        private string baseUrlInput = string.Empty;

        [ObservableProperty]
        private bool responsesApiEnabledInput;

        [ObservableProperty]
        private bool isStartingDaemon;

        [ObservableProperty]
        private bool isInstallingCli;

        [ObservableProperty]
        private bool showWindowsDaemonInstructions;

        [ObservableProperty]
        private string windowsDaemonCommand = string.Empty;

        private int? windowsDaemonPort;

        public bool CanActivate => !IsActivating && !string.IsNullOrWhiteSpace(SubscriptionKey);
        public bool CanInstallCli => !IsStartingDaemon && !IsInstallingCli;
        public bool CanMoveNext => !IsStartingDaemon && !IsInstallingCli;
        public bool CanStartDaemon =>
            !IsStartingDaemon &&
            !IsInstallingCli &&
            SelectedProvider is not null &&
            !string.IsNullOrWhiteSpace(ApiKeyInput);
        public string InstallCliButtonText => IsInstallingCli ? "Checking omnikey-cli..." : "Install omnikey-cli";
        public string StartDaemonButtonText => ShowWindowsDaemonInstructions ? "Check Daemon" : "Show Admin Command";

        public bool IsSelfHosted => ApiClient.IsSelfHosted;
        public bool ShowSubscriptionForm => !IsCheckingSetup && !ShowOnboarding && !IsSelfHosted;
        public bool ShowSelfHostedNotice => !IsCheckingSetup && !ShowOnboarding && IsSelfHosted;
        public bool IsInstallStep => SetupStep == 0;
        public bool IsConfigureStep => SetupStep == 1;
        public bool ShowOpenModelBaseUrl => SelectedProvider?.SupportsBaseUrl == true;
        public bool ShowOpenModelResponsesApi => SelectedProvider?.SupportsResponsesApiToggle == true;

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        public LicenseViewModel()
        {
            if (SubscriptionManager.Instance.HasStoredKey)
                SubscriptionKey = SubscriptionManager.Instance.UserKey ?? string.Empty;
        }

        partial void OnSubscriptionKeyChanged(string value) => ActivateCommand.NotifyCanExecuteChanged();
        partial void OnIsActivatingChanged(bool value) => ActivateCommand.NotifyCanExecuteChanged();
        partial void OnStatusKindChanged(StatusKind value) => OnPropertyChanged(nameof(StatusBrush));

        partial void OnIsCheckingSetupChanged(bool value) => NotifyVisibilityChanged();
        partial void OnShowOnboardingChanged(bool value) => NotifyVisibilityChanged();
        partial void OnSetupStepChanged(int value)
        {
            OnPropertyChanged(nameof(IsInstallStep));
            OnPropertyChanged(nameof(IsConfigureStep));
        }

        partial void OnSelectedProviderChanged(SelfHostedProviderOption value)
        {
            ClearWindowsDaemonInstructions();
            OnPropertyChanged(nameof(ShowOpenModelBaseUrl));
            OnPropertyChanged(nameof(ShowOpenModelResponsesApi));
            StartDaemonCommand.NotifyCanExecuteChanged();
        }

        partial void OnApiKeyInputChanged(string value)
        {
            ClearWindowsDaemonInstructions();
            StartDaemonCommand.NotifyCanExecuteChanged();
        }

        partial void OnBaseUrlInputChanged(string value) => ClearWindowsDaemonInstructions();
        partial void OnResponsesApiEnabledInputChanged(bool value) => ClearWindowsDaemonInstructions();

        partial void OnIsStartingDaemonChanged(bool value)
        {
            InstallCliCommand.NotifyCanExecuteChanged();
            NextSetupCommand.NotifyCanExecuteChanged();
            BackSetupCommand.NotifyCanExecuteChanged();
            StartDaemonCommand.NotifyCanExecuteChanged();
        }

        partial void OnIsInstallingCliChanged(bool value)
        {
            OnPropertyChanged(nameof(InstallCliButtonText));
            InstallCliCommand.NotifyCanExecuteChanged();
            NextSetupCommand.NotifyCanExecuteChanged();
            BackSetupCommand.NotifyCanExecuteChanged();
            StartDaemonCommand.NotifyCanExecuteChanged();
        }

        partial void OnShowWindowsDaemonInstructionsChanged(bool value)
        {
            OnPropertyChanged(nameof(StartDaemonButtonText));
            StartDaemonCommand.NotifyCanExecuteChanged();
        }

        [RelayCommand]
        private async Task LoadAsync()
        {
            IsCheckingSetup = true;
            try
            {
                ShowOnboarding = await SelfHostedBootstrap.ShouldShowFirstRunOnboardingAsync();
                if (ShowOnboarding)
                    SetStatus("Choose Self-hosted to run OmniKey free on this machine.", StatusKind.Neutral);
            }
            catch (Exception ex)
            {
                ShowOnboarding = false;
                SetStatus("Setup check failed: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsCheckingSetup = false;
            }
        }

        [RelayCommand(CanExecute = nameof(CanActivate))]
        private async Task ActivateAsync()
        {
            var key = SubscriptionKey.Trim();
            if (string.IsNullOrWhiteSpace(key)) return;

            IsActivating = true;
            SetStatus("Activating key...", StatusKind.Neutral);

            var (success, error) = await SubscriptionManager.Instance.UpdateUserKeyAsync(key);

            if (success)
            {
                SetStatus("Activation successful. OmniKey is unlocked.", StatusKind.Positive);
                Program.NotifyAuthorizationSucceeded();
            }
            else
            {
                SetStatus("Activation failed: " + error, StatusKind.Negative);
            }

            IsActivating = false;
        }

        [RelayCommand(CanExecute = nameof(CanInstallCli))]
        private async Task InstallCliAsync()
        {
            try
            {
                IsInstallingCli = true;
                SetStatus("Checking omnikey-cli and installing the latest version if needed...", StatusKind.Neutral);

                CliInstallResult result = await SelfHostedBootstrap.InstallOrUpdateCliAsync();
                SetStatus(result.Message, StatusKind.Positive);
            }
            catch (Exception ex)
            {
                SetStatus("Install failed: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsInstallingCli = false;
            }
        }

        [RelayCommand(CanExecute = nameof(CanMoveNext))]
        private void NextSetup()
        {
            SetupStep = 1;
        }

        [RelayCommand(CanExecute = nameof(CanMoveNext))]
        private void BackSetup()
        {
            SetupStep = 0;
        }

        [RelayCommand(CanExecute = nameof(CanStartDaemon))]
        private async Task StartDaemonAsync()
        {
            if (ShowWindowsDaemonInstructions && windowsDaemonPort is int pendingPort)
            {
                await CheckManualDaemonAsync(pendingPort);
                return;
            }

            string apiKey = ApiKeyInput.Trim();
            if (string.IsNullOrWhiteSpace(apiKey)) return;

            IsStartingDaemon = true;
            int port = SelfHostedBootstrap.FindAvailablePort();
            SetStatus("Checking omnikey-cli before starting the daemon...", StatusKind.Neutral);

            try
            {
                await SelfHostedBootstrap.InstallOrUpdateCliAsync();
            }
            catch (Exception ex)
            {
                IsStartingDaemon = false;
                SetStatus("Install failed: " + ex.Message, StatusKind.Negative);
                return;
            }

            SetStatus($"Writing local config for daemon port {port}...", StatusKind.Neutral);

            try
            {
                SelfHostedBootstrap.WriteSelfHostedConfig(
                    SelectedProvider,
                    apiKey,
                    BaseUrlInput,
                    ResponsesApiEnabledInput,
                    port);
                ApiClient.ReloadRuntimeConfiguration();

                windowsDaemonPort = port;
                WindowsDaemonCommand = $"omnikey daemon --port {port}";
                ShowWindowsDaemonInstructions = true;
                SetStatus("Config saved. Open PowerShell as Administrator, run the command below, then click Check Daemon.", StatusKind.Positive);
            }
            catch (Exception ex)
            {
                IsStartingDaemon = false;
                SetStatus("Daemon instructions failed: " + ex.Message, StatusKind.Negative);
                return;
            }

            IsStartingDaemon = false;
        }

        private async Task CheckManualDaemonAsync(int port)
        {
            IsStartingDaemon = true;
            SetStatus($"Checking local daemon on port {port}...", StatusKind.Neutral);

            bool running = await SelfHostedBootstrap.WaitForDaemonAsync(port, TimeSpan.FromSeconds(8));
            if (!running)
            {
                IsStartingDaemon = false;
                SetStatus("Could not reach the local daemon yet. Make sure the Administrator terminal command finished successfully, then click Check Daemon again.", StatusKind.Negative);
                return;
            }

            SetStatus("Daemon is ready. Finishing local sign-in...", StatusKind.Positive);
            bool activated = await SubscriptionManager.Instance.ActivateStoredKeyAsync();
            IsStartingDaemon = false;

            if (activated)
            {
                SetStatus("Local setup successful. OmniKey is ready.", StatusKind.Positive);
                ShowOnboarding = false;
                Program.NotifyAuthorizationSucceeded();
                Program.ShowMainWindow<ChatPage>();
            }
            else
            {
                SetStatus("Daemon is running, but local sign-in failed. Try Start Daemon again.", StatusKind.Negative);
            }
        }

        [RelayCommand]
        private void Quit()
        {
            System.Windows.Application.Current.Shutdown();
        }

        private void NotifyVisibilityChanged()
        {
            OnPropertyChanged(nameof(IsSelfHosted));
            OnPropertyChanged(nameof(ShowSubscriptionForm));
            OnPropertyChanged(nameof(ShowSelfHostedNotice));
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }

        private void ClearWindowsDaemonInstructions()
        {
            if (!ShowWindowsDaemonInstructions && string.IsNullOrEmpty(WindowsDaemonCommand) && windowsDaemonPort == null)
                return;

            windowsDaemonPort = null;
            WindowsDaemonCommand = string.Empty;
            ShowWindowsDaemonInstructions = false;
        }
    }
}
