using System;
using OmniKey.Windows.ViewModels;
using OmniKey.Windows.Views.Pages;
using Wpf.Ui.Controls;

namespace OmniKey.Windows.Views
{
    public partial class MainWindow : FluentWindow
    {
        public MainWindow()
        {
            InitializeComponent();
            DataContext = new MainWindowViewModel();
            Loaded += (_, _) => RootNavigation.Navigate(typeof(ChatPage));
        }

        /// <summary>
        /// Programmatic navigation hook used by the tray-icon menu so the user
        /// lands directly on the page they clicked (e.g. "Subscription" →
        /// LicensePage). Falls back silently if the navigation frame isn't
        /// ready or the type is invalid.
        /// </summary>
        public void NavigateTo(Type pageType)
        {
            try
            {
                RootNavigation?.Navigate(pageType);
            }
            catch (Exception)
            {
                // Navigation can throw if the nav view is mid-teardown; we
                // tolerate that — the user can re-click the menu item.
            }
        }

        private void OnPaneToggleClick(object sender, System.Windows.RoutedEventArgs e)
        {
            if (RootNavigation is null) return;
            RootNavigation.IsPaneOpen = !RootNavigation.IsPaneOpen;
        }
    }
}
