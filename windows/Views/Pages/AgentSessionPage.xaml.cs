using System.Windows.Controls;
using System.Windows.Input;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    /// <summary>
    /// WPF host for the OmniAgent session UI. Replaces the legacy
    /// <c>AgentThinkingForm</c> WinForms window. DataContext is the
    /// process-wide <see cref="AgentSessionViewModel.Shared"/> so a run
    /// triggered by Ctrl+T continues even while the user navigates
    /// elsewhere and returns.
    /// </summary>
    public partial class AgentSessionPage : Page
    {
        public AgentSessionPage()
        {
            InitializeComponent();
            DataContext = AgentSessionViewModel.Shared;

            // Refresh the dropdown each time the page becomes visible so a
            // session minted in another flow (Agent Chat, scheduled jobs)
            // shows up without forcing the user to reopen the app.
            Loaded += async (_, _) => await AgentSessionViewModel.Shared.LoadSessionsAsync();
        }

        /// <summary>
        /// Tunnel mouse-wheel events directly into the body ScrollViewer
        /// regardless of which descendant is under the cursor. Inner
        /// elements (ui:Expander for the history card, ComboBoxes that
        /// might enter the body via dropdowns, etc.) otherwise swallow
        /// the wheel and prevent the section log from scrolling. This
        /// scope is the body only — the sticky header lives outside this
        /// ScrollViewer and is unaffected.
        /// </summary>
        private void OnLogScrollPreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (sender is not ScrollViewer sv) return;
            sv.ScrollToVerticalOffset(sv.VerticalOffset - e.Delta);
            e.Handled = true;
        }
    }
}
