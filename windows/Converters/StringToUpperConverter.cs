using System;
using System.Globalization;
using System.Windows.Data;

namespace OmniKey.Windows.Converters
{
    public sealed class StringToUpperConverter : IValueConverter
    {
        public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value?.ToString()?.ToUpperInvariant();

        public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            throw new NotSupportedException();
    }

    public sealed class InverseBooleanToVisibilityConverter : IValueConverter
    {
        public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value is bool b && b ? System.Windows.Visibility.Collapsed : System.Windows.Visibility.Visible;

        public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value is System.Windows.Visibility v && v != System.Windows.Visibility.Visible;
    }

    /// <summary>
    /// Non-empty string → Visible; null or whitespace → Collapsed.
    /// Used by the OmniAgent session page to show its "waiting on you"
    /// banner only when a pending request is queued.
    /// </summary>
    public sealed class StringToVisibilityConverter : IValueConverter
    {
        public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            string.IsNullOrWhiteSpace(value as string)
                ? System.Windows.Visibility.Collapsed
                : System.Windows.Visibility.Visible;

        public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            throw new NotSupportedException();
    }

    /// <summary>
    /// Flips a bool. Used to bind "disable while running" controls to
    /// the negation of IsRunning without a second VM property.
    /// </summary>
    public sealed class InverseBooleanConverter : IValueConverter
    {
        public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value is bool b ? !b : true;

        public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
            value is bool b ? !b : false;
    }
}
