using System.Windows.Controls;
using System.Windows.Input;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    /// <summary>
    /// Token-usage dashboard. Mirrors the macOS UsageView tab: range +
    /// provider filters over <c>GET /api/usage</c>, four headline counters and
    /// three breakdown sections. Cost figures are intentionally absent — the
    /// backend dropped them because provider price estimates can't be
    /// reconciled with invoices.
    /// </summary>
    public partial class UsagePage : Page
    {
        private readonly UsageViewModel _vm;

        public UsagePage()
        {
            InitializeComponent();
            _vm = new UsageViewModel();
            DataContext = _vm;

            // F5 refreshes, matching the rest of the shell's list pages.
            InputBindings.Add(new KeyBinding(_vm.RefreshCommand, Key.F5, ModifierKeys.None));

            Loaded += async (_, _) =>
            {
                if (_vm.RefreshCommand.CanExecute(null))
                    await _vm.RefreshCommand.ExecuteAsync(null);
            };
        }
    }
}
