using System.Threading.Tasks;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace OmniKey.Windows.ViewModels
{
    internal partial class LicenseViewModel : ObservableObject
    {
        [ObservableProperty]
        private string subscriptionKey = string.Empty;

        [ObservableProperty]
        private string statusMessage = string.Empty;

        [ObservableProperty]
        private StatusKind statusKind = StatusKind.Neutral;

        [ObservableProperty]
        private bool isActivating;

        public bool CanActivate => !IsActivating && !string.IsNullOrWhiteSpace(SubscriptionKey);

        /// <summary>When true, the activation form collapses and we show a
        /// "no key required in self-hosted mode" notice instead.</summary>
        public bool IsSelfHosted => ApiClient.IsSelfHosted;

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

        [RelayCommand(CanExecute = nameof(CanActivate))]
        private async Task ActivateAsync()
        {
            var key = SubscriptionKey.Trim();
            if (string.IsNullOrWhiteSpace(key)) return;

            IsActivating = true;
            SetStatus("Activating key…", StatusKind.Neutral);

            var (success, error) = await SubscriptionManager.Instance.UpdateUserKeyAsync(key);

            if (success)
            {
                SetStatus("✓ Activation successful. OmniKey is unlocked.", StatusKind.Positive);
            }
            else
            {
                SetStatus("✕ Activation failed: " + error, StatusKind.Negative);
            }

            IsActivating = false;
        }

        [RelayCommand]
        private void Quit()
        {
            System.Windows.Application.Current.Shutdown();
        }

        private void SetStatus(string text, StatusKind kind)
        {
            StatusMessage = text;
            StatusKind = kind;
        }
    }
}
