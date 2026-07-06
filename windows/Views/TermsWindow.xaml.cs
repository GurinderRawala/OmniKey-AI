using System.ComponentModel;
using System.Windows;
using Wpf.Ui.Controls;

namespace OmniKey.Windows.Views
{
    /// <summary>
    /// First-launch Terms &amp; Conditions dialog for the Windows client.
    /// Replaces the earlier WinForms <c>TermsForm</c> so the terms are
    /// rendered by the same MdXaml-backed markdown pipeline
    /// (<see cref="MarkdownRender.Markdown"/>) that ChatPage uses for LLM
    /// answers — the user sees consistent typography, headings, lists,
    /// and inline formatting instead of a raw text dump.
    ///
    /// Contract mirrors the previous WinForms form:
    ///   - <see cref="Window.DialogResult"/> == <c>true</c>  → user accepted;
    ///     <see cref="TermsAcceptance.RecordAcceptance"/> has been called.
    ///   - Anything else → caller should exit the process.
    /// </summary>
    public partial class TermsWindow : FluentWindow
    {
        /// <summary>
        /// Bound to <c>md:Markdown.Source</c> in XAML so the FlowDocument
        /// re-renders when the property is assigned. Set to the packaged
        /// terms text in the constructor.
        /// </summary>
        public string TermsMarkdown { get; }

        public TermsWindow()
        {
            TermsMarkdown = TermsContent.Text;
            InitializeComponent();
        }

        private void OnAcceptClick(object sender, RoutedEventArgs e)
        {
            TermsAcceptance.RecordAcceptance();
            DialogResult = true;
            Close();
        }

        private void OnDeclineClick(object sender, RoutedEventArgs e)
        {
            DialogResult = false;
            Close();
        }

        /// <summary>
        /// Closing the window (title-bar close button) without an explicit
        /// choice is treated as "decline" so the caller can exit the
        /// process. DialogResult defaults to false when unset.
        /// </summary>
        protected override void OnClosing(CancelEventArgs e)
        {
            if (DialogResult == null)
                DialogResult = false;
            base.OnClosing(e);
        }
    }
}
