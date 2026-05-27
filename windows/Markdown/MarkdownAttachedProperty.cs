using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using OmniKey.Windows.MarkdownRender;

namespace OmniKey.Windows.MarkdownRender
{
    /// <summary>
    /// Attached property that turns a <see cref="FlowDocumentScrollViewer"/>
    /// into a one-way markdown sink. Bind <c>md:Markdown.Source="{Binding Text}"</c>
    /// on the viewer and it re-renders whenever the bound text changes.
    /// </summary>
    public static class Markdown
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.RegisterAttached(
                "Source",
                typeof(string),
                typeof(Markdown),
                new PropertyMetadata(string.Empty, OnSourceChanged));

        public static string GetSource(DependencyObject obj) => (string)obj.GetValue(SourceProperty);
        public static void SetSource(DependencyObject obj, string value) => obj.SetValue(SourceProperty, value);

        private static void OnSourceChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is not FlowDocumentScrollViewer viewer) return;
            var text = e.NewValue as string ?? string.Empty;

            var bodyFont = (FontFamily)System.Windows.Application.Current.Resources["OK.FontFamily"];
            var monoFont = (FontFamily)System.Windows.Application.Current.Resources["OK.MonoFontFamily"];
            var primary = (Brush)System.Windows.Application.Current.Resources["Nord.PrimaryTextBrush"];
            var secondary = (Brush)System.Windows.Application.Current.Resources["Nord.SecondaryTextBrush"];
            var border = (Brush)System.Windows.Application.Current.Resources["Nord.BorderBrush"];
            var accent = (Brush)System.Windows.Application.Current.Resources["Nord.AccentBrush"];
            var codeBg = new SolidColorBrush(Color.FromRgb(0x10, 0x10, 0x12));

            viewer.Document = MarkdownFlowDocumentRenderer.Render(text, bodyFont, monoFont, primary, secondary, codeBg, border, accent);
        }
    }
}
