using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class SkillsPage : Page
    {
        private readonly SkillsViewModel _vm;

        public SkillsPage()
        {
            InitializeComponent();
            _vm = new SkillsViewModel(ApiClient.CreateSkillsService());
            DataContext = _vm;
            _vm.PropertyChanged += OnViewModelPropertyChanged;
            // Fetch on every appearance (unless an edit is open) so changes
            // made by the CLI or another client show up; no polling.
            Loaded += async (_, _) => await _vm.OnAppearedAsync();
            PreviewKeyDown += OnPreviewKeyDown;
        }

        /// <summary>Esc closes the delete prompt first, then the editor.</summary>
        private void OnPreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape) return;
            if (_vm.HasPendingDelete)
            {
                _vm.CancelDelete();
                SkillsList.Focus();
                e.Handled = true;
            }
            else if (_vm.CancelEditCommand.CanExecute(null))
            {
                _vm.CancelEdit();
                SkillsList.Focus();
                e.Handled = true;
            }
        }

        /// <summary>Move keyboard focus to the surface that just opened.</summary>
        private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName == nameof(SkillsViewModel.HasPendingDelete) && _vm.HasPendingDelete)
                FocusLater(CancelDeleteButton);
            else if (e.PropertyName == nameof(SkillsViewModel.IsEditorOpen) && _vm.IsEditorOpen)
                FocusLater(NameBox);
        }

        private void FocusLater(IInputElement target) =>
            Dispatcher.BeginInvoke(DispatcherPriority.Input, new System.Action(() => Keyboard.Focus(target)));
    }
}
