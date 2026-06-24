using System.ComponentModel;
using System.Collections.Specialized;
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

        /// <summary>Tracks the prior value of <see cref="ChatViewModel.IsLoadingHistory"/>
        /// so we can detect the true → false transition (history finished loading)
        /// and scroll the transcript to the bottom — same behaviour every other
        /// modern chat app has when you re-open an old conversation.</summary>
        private bool _wasLoadingHistory;

        public ChatPage()
        {
            InitializeComponent();
            _vm = new ChatViewModel();
            DataContext = _vm;

            Loaded += OnPageLoaded;
            Unloaded += OnPageUnloaded;

            ComposerInput.PreviewKeyDown += OnComposerKeyDown;

            // Wire scroll-to-bottom behaviour: when the VM finishes loading
            // an old session's history, when a new message is appended
            // (e.g. the user just sent one), and on initial page load.
            _vm.PropertyChanged += OnVmPropertyChanged;
            _vm.Messages.CollectionChanged += OnMessagesCollectionChanged;
        }

        private void OnPageLoaded(object? sender, RoutedEventArgs e)
        {
            _vm.LoadCommand.Execute(null);

            // Chat has its own sidebar — collapse the outer NavigationView
            // pane so we get the full chat surface. The user can re-open it
            // any time via the hamburger toggle in the nav header.
            var nav = FindAncestor<NavigationView>(this);
            if (nav is not null) nav.IsPaneOpen = false;

            // Initial render: if the active session was restored from
            // cached state (no history fetch needed), IsLoadingHistory
            // never flips, so anchor at the bottom here too.
            _wasLoadingHistory = _vm.IsLoadingHistory;
            ScheduleScrollToBottom();
        }

        private void OnPageUnloaded(object? sender, RoutedEventArgs e)
        {
            _vm.PropertyChanged -= OnVmPropertyChanged;
            _vm.Messages.CollectionChanged -= OnMessagesCollectionChanged;
            _vm.Dispose();
        }

        private void OnVmPropertyChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (e.PropertyName != nameof(ChatViewModel.IsLoadingHistory)) return;

            // We only care about the true → false edge — that's the moment
            // a freshly opened session's transcript has been populated.
            bool now = _vm.IsLoadingHistory;
            if (_wasLoadingHistory && !now)
                ScheduleScrollToBottom();
            _wasLoadingHistory = now;
        }

        private void OnMessagesCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
        {
            // A new turn (user sent OR assistant placeholder created)
            // appended a row — keep the conversation pinned to the bottom
            // so the user always sees the latest content, matching the UX
            // of every other modern chat app. We deliberately do NOT
            // auto-scroll on Replace because streaming updates the last
            // row in place; the user may have scrolled up to read history
            // during a streaming response and shouldn't be yanked down.
            if (e.Action == NotifyCollectionChangedAction.Add)
                ScheduleScrollToBottom();
        }

        /// <summary>Defer the scroll until after the FlowDocument has finished
        /// laying out the new content. Loaded priority means we run after
        /// WPF's measure/arrange pass so the ScrollViewer's ScrollableHeight
        /// reflects the final document height.</summary>
        private void ScheduleScrollToBottom()
        {
            Dispatcher.BeginInvoke(
                System.Windows.Threading.DispatcherPriority.Loaded,
                new System.Action(() => TranscriptScroll?.ScrollToBottom()));
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
