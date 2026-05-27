using System;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    internal partial class UpdatesViewModel : ObservableObject
    {
        public string CurrentVersion { get; } = UpdateChecker.CurrentVersion.ToString(3);

        [ObservableProperty]
        private bool isChecking;

        [ObservableProperty]
        private string statusMessage = "Press “Check for updates” to see if a newer version is available.";

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool hasUpdate;

        [ObservableProperty]
        private string newVersion = string.Empty;

        [ObservableProperty]
        private string releaseNotes = string.Empty;

        [ObservableProperty]
        private string downloadUrl = string.Empty;

        public bool CanCheck => !IsChecking;
        public bool CanDownload => HasUpdate && !string.IsNullOrEmpty(DownloadUrl);

        public Brush StatusBrush => StatusKind switch
        {
            StatusKind.Positive => (Brush)System.Windows.Application.Current.Resources["Nord.AccentGreenBrush"],
            StatusKind.Negative => new SolidColorBrush(Color.FromRgb(252, 100, 100)),
            _ => (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"],
        };

        partial void OnIsCheckingChanged(bool value)
        {
            CheckForUpdatesCommand.NotifyCanExecuteChanged();
        }

        partial void OnHasUpdateChanged(bool value)
        {
            DownloadCommand.NotifyCanExecuteChanged();
        }

        partial void OnDownloadUrlChanged(string value)
        {
            DownloadCommand.NotifyCanExecuteChanged();
        }

        partial void OnStatusKindChanged(StatusKind value)
        {
            OnPropertyChanged(nameof(StatusBrush));
        }

        [RelayCommand(CanExecute = nameof(CanCheck))]
        private async Task CheckForUpdatesAsync()
        {
            IsChecking = true;
            HasUpdate = false;
            NewVersion = string.Empty;
            ReleaseNotes = string.Empty;
            DownloadUrl = string.Empty;
            SetStatus("Checking for updates…", StatusKind.Neutral);

            try
            {
                var info = await UpdateChecker.CheckAsync();
                if (info is null)
                {
                    SetStatus($"You’re up to date. OmniKey AI {CurrentVersion} is the latest version.", StatusKind.Positive);
                }
                else
                {
                    NewVersion = info.Version;
                    ReleaseNotes = string.IsNullOrWhiteSpace(info.ReleaseNotes)
                        ? "No release notes provided."
                        : info.ReleaseNotes;
                    DownloadUrl = info.DownloadUrl;
                    HasUpdate = true;
                    SetStatus($"A new version ({info.Version}) is available.", StatusKind.Positive);
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to check for updates: " + ex.Message, StatusKind.Negative);
            }
            finally
            {
                IsChecking = false;
            }
        }

        [RelayCommand(CanExecute = nameof(CanDownload))]
        private void Download()
        {
            if (string.IsNullOrEmpty(DownloadUrl)) return;
            try
            {
                Process.Start(new ProcessStartInfo(DownloadUrl) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                SetStatus("Failed to open download link: " + ex.Message, StatusKind.Negative);
            }
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
