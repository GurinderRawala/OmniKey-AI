using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using OmniKey.Windows.ViewModels;
using Wpf.Ui.Controls;

namespace OmniKey.Windows.Views.Pages
{
    public partial class SettingsPage : Page
    {
        private readonly SettingsViewModel _vm;

        public SettingsPage()
        {
            InitializeComponent();
            _vm = new SettingsViewModel();
            DataContext = _vm;

            // The Updates and Manual sections are full pages hosted in the right
            // pane. Navigate each frame the first time its section is opened so
            // we don't kick off UpdatesPage's auto version-check until the user
            // actually asks for it.
            _vm.PropertyChanged += OnViewModelPropertyChanged;

            Loaded += async (_, _) =>
            {
                CollapseMainSidebar();
                if (_vm.LoadCommand.CanExecute(null))
                    await _vm.LoadCommand.ExecuteAsync(null);
            };
        }

        /// <summary>
        /// Auto-collapses the app's main navigation pane when the Settings page
        /// opens so the settings sidebar + detail get the full window width. The
        /// user can reopen it with the title-bar pane toggle. Best-effort: walks
        /// up the visual tree to the hosting NavigationView.
        /// </summary>
        private void CollapseMainSidebar()
        {
            DependencyObject? current = this;
            while (current is not null)
            {
                if (current is NavigationView nav)
                {
                    nav.IsPaneOpen = false;
                    return;
                }
                current = VisualTreeHelper.GetParent(current);
            }
        }

        private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName != nameof(SettingsViewModel.SelectedSection)) return;

            if (_vm.SelectedSection == SettingsSection.Updates && UpdatesFrame.Content is null)
                UpdatesFrame.Navigate(new UpdatesPage());
            else if (_vm.SelectedSection == SettingsSection.Manual && ManualFrame.Content is null)
                ManualFrame.Navigate(new ManualPage());
        }
    }
}
