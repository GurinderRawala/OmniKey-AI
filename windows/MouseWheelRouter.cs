using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Media3D;

namespace OmniKey.Windows
{
    /// <summary>
    /// Makes the mouse wheel scroll the nearest scrollable region on every
    /// page, in every window.
    ///
    /// WPF delivers MouseWheel as a routed event starting at the element under
    /// the pointer and bubbling outward, and the first handler to set
    /// <c>Handled</c> ends the journey. Several controls we use mark the event
    /// handled whether or not they actually scrolled anything: a nested
    /// <see cref="ScrollViewer"/> with no overflow still swallows it (WPF's
    /// own long-standing behaviour), and rich-text hosts do the same. The
    /// result is a page whose scrollbar drags perfectly by hand while the
    /// wheel does nothing — exactly the Usage/stats page symptom.
    ///
    /// Rather than hunt every offender, we intercept in the *tunneling*
    /// (Preview) phase at the window root, which runs before any of them, pick
    /// the innermost ScrollViewer that can actually move in the requested
    /// direction, and scroll it ourselves. Picking the innermost one preserves
    /// nested scrolling — the chat transcript and the session sidebar still
    /// scroll independently under the pointer.
    ///
    /// If nothing under the pointer can scroll we leave the event completely
    /// alone, so unrelated wheel consumers (ComboBox dropdowns, sliders, and
    /// anything that legitimately wants the wheel) behave normally.
    /// </summary>
    internal static class MouseWheelRouter
    {
        /// <summary>
        /// WPF's own default: one wheel notch scrolls three lines. Matched
        /// here so the wheel feels identical to every other Windows app
        /// instead of the jumpy "one notch = 120px" that raw delta gives.
        /// </summary>
        private const int LinesPerNotch = 3;

        /// <summary>One notch of a standard wheel.</summary>
        private const int WheelDelta = 120;

        private static bool _installed;

        /// <summary>
        /// Registers the handler once for every <see cref="Window"/> in the
        /// app — main shell, terms dialog, and anything added later — so no
        /// new window has to remember to opt in.
        /// </summary>
        public static void Install()
        {
            if (_installed) return;
            _installed = true;

            EventManager.RegisterClassHandler(
                typeof(Window),
                UIElement.PreviewMouseWheelEvent,
                new MouseWheelEventHandler(OnPreviewMouseWheel),
                handledEventsToo: true);
        }

        private static void OnPreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (e.Delta == 0) return;
            if (e.OriginalSource is not DependencyObject origin) return;

            var target = FindScrollableAncestor(origin, e.Delta);
            if (target is null) return;

            int notches = Math.Max(1, Math.Abs(e.Delta) / WheelDelta);
            int lines = notches * LinesPerNotch;

            for (int i = 0; i < lines; i++)
            {
                if (e.Delta > 0) target.LineUp();
                else target.LineDown();
            }

            e.Handled = true;
        }

        /// <summary>
        /// Walks outward from the element under the pointer and returns the
        /// first <see cref="ScrollViewer"/> with room left in the direction
        /// the user is scrolling.
        ///
        /// The direction check is what lets a nested list hand off to the page
        /// once it hits its own end, instead of trapping the wheel there.
        /// </summary>
        private static ScrollViewer? FindScrollableAncestor(DependencyObject start, int delta)
        {
            for (DependencyObject? node = start; node is not null; node = GetParent(node))
            {
                if (node is not ScrollViewer sv) continue;
                if (sv.ScrollableHeight <= 0) continue;

                bool room = delta > 0
                    ? sv.VerticalOffset > 0                    // scrolling up
                    : sv.VerticalOffset < sv.ScrollableHeight; // scrolling down

                if (room) return sv;
            }

            return null;
        }

        /// <summary>
        /// Visual-tree walk that can also cross into the logical tree.
        /// <see cref="VisualTreeHelper"/> alone stops dead at a
        /// <see cref="ContentElement"/> — the Runs and Paragraphs inside the
        /// MdXaml-rendered chat answers are exactly that, so a wheel over
        /// rendered markdown would otherwise find no ancestor at all.
        /// </summary>
        private static DependencyObject? GetParent(DependencyObject node)
        {
            if (node is Visual or Visual3D)
            {
                var visualParent = VisualTreeHelper.GetParent(node);
                if (visualParent is not null) return visualParent;
            }

            return LogicalTreeHelper.GetParent(node);
        }
    }
}
