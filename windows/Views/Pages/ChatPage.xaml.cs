using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using OmniKey.Windows.ViewModels;
using Wpf.Ui.Controls;

namespace OmniKey.Windows.Views.Pages
{
    public partial class ChatPage : Page
    {
        private readonly ChatViewModel _vm;

        public ChatPage()
        {
            InitializeComponent();
            _vm = new ChatViewModel();
            DataContext = _vm;

            Loaded += OnPageLoaded;
            Unloaded += OnPageUnloaded;

            ComposerInput.PreviewKeyDown += OnComposerKeyDown;
        }

        private void OnPageLoaded(object? sender, RoutedEventArgs e)
        {
            _vm.LoadCommand.Execute(null);

            // Chat has its own sidebar — collapse the outer NavigationView
            // pane so we get the full chat surface. The user can re-open it
            // any time via the hamburger toggle in the nav header.
            var nav = FindAncestor<NavigationView>(this);
            if (nav is not null) nav.IsPaneOpen = false;
        }

        private void OnPageUnloaded(object? sender, RoutedEventArgs e)
        {
            _vm.Dispose();
        }

        private void OnComposerKeyDown(object sender, KeyEventArgs e)
        {
            // Enter sends; Shift+Enter inserts a newline (default TextBox behavior).
            if (e.Key == Key.Enter && !Keyboard.IsKeyDown(Key.LeftShift) && !Keyboard.IsKeyDown(Key.RightShift))
            {
                if (_vm.SendCommand.CanExecute(null))
                {
                    _vm.SendCommand.Execute(null);
                }
                e.Handled = true;
            }
        }

        /// <summary>
        /// FlowDocumentScrollViewer always handles MouseWheel internally,
        /// even with its own scrollbar disabled, which traps wheel events
        /// over the assistant's final-answer card and prevents the outer
        /// transcript from scrolling. Mark the event handled here and
        /// re-raise it on the parent so it bubbles up to the transcript
        /// ScrollViewer.
        /// </summary>
        private void OnInnerScrollableMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (sender is not UIElement source) return;
            e.Handled = true;
            var bubbling = new MouseWheelEventArgs(e.MouseDevice, e.Timestamp, e.Delta)
            {
                RoutedEvent = MouseWheelEvent,
                Source = sender,
            };
            (VisualTreeHelper.GetParent(source) as UIElement)?.RaiseEvent(bubbling);
        }

        private static T? FindAncestor<T>(DependencyObject start) where T : DependencyObject
        {
            var current = VisualTreeHelper.GetParent(start);
            while (current is not null)
            {
                if (current is T match) return match;
                current = VisualTreeHelper.GetParent(current);
            }
            return null;
        }
    }
}
