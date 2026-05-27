using System;
using System.Windows;
using System.Windows.Media;

namespace OmniKey.Windows.Controls
{
    /// <summary>
    /// Compact circular gauge that draws a background ring plus a
    /// clockwise-sweeping arc whose length equals <see cref="Fraction"/>
    /// (0..1). Mirrors the macOS chat composer's `ContextWindowIndicator`
    /// so the WPF view shows the used portion of the context window
    /// without surfacing the raw token numbers.
    /// </summary>
    public class ContextRing : FrameworkElement
    {
        public static readonly DependencyProperty FractionProperty = DependencyProperty.Register(
            nameof(Fraction),
            typeof(double),
            typeof(ContextRing),
            new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsRender));

        public static readonly DependencyProperty TrackBrushProperty = DependencyProperty.Register(
            nameof(TrackBrush),
            typeof(Brush),
            typeof(ContextRing),
            new FrameworkPropertyMetadata(Brushes.Gray, FrameworkPropertyMetadataOptions.AffectsRender));

        public static readonly DependencyProperty TintBrushProperty = DependencyProperty.Register(
            nameof(TintBrush),
            typeof(Brush),
            typeof(ContextRing),
            new FrameworkPropertyMetadata(Brushes.LimeGreen, FrameworkPropertyMetadataOptions.AffectsRender));

        public static readonly DependencyProperty StrokeThicknessProperty = DependencyProperty.Register(
            nameof(StrokeThickness),
            typeof(double),
            typeof(ContextRing),
            new FrameworkPropertyMetadata(1.8, FrameworkPropertyMetadataOptions.AffectsRender));

        /// <summary>Fraction of the ring that should be filled, 0..1.</summary>
        public double Fraction
        {
            get => (double)GetValue(FractionProperty);
            set => SetValue(FractionProperty, value);
        }

        /// <summary>Background-ring colour (full circle).</summary>
        public Brush TrackBrush
        {
            get => (Brush)GetValue(TrackBrushProperty);
            set => SetValue(TrackBrushProperty, value);
        }

        /// <summary>Foreground-arc colour.</summary>
        public Brush TintBrush
        {
            get => (Brush)GetValue(TintBrushProperty);
            set => SetValue(TintBrushProperty, value);
        }

        public double StrokeThickness
        {
            get => (double)GetValue(StrokeThicknessProperty);
            set => SetValue(StrokeThicknessProperty, value);
        }

        protected override void OnRender(DrawingContext dc)
        {
            double w = ActualWidth;
            double h = ActualHeight;
            if (w <= 0 || h <= 0) return;

            double thickness = Math.Max(0.5, StrokeThickness);
            double r = Math.Max(0, Math.Min(w, h) / 2.0 - thickness / 2.0);
            if (r <= 0) return;

            var center = new Point(w / 2.0, h / 2.0);

            // Background full-circle ring.
            var trackPen = new Pen(TrackBrush, thickness);
            trackPen.Freeze();
            dc.DrawEllipse(null, trackPen, center, r, r);

            double clamped = Math.Min(1.0, Math.Max(0.0, Fraction));
            if (clamped <= 0) return;

            var foregroundPen = new Pen(TintBrush, thickness)
            {
                StartLineCap = PenLineCap.Round,
                EndLineCap = PenLineCap.Round,
            };
            foregroundPen.Freeze();

            // Full circle — just stroke the ellipse and skip the arc maths.
            if (clamped >= 0.999)
            {
                dc.DrawEllipse(null, foregroundPen, center, r, r);
                return;
            }

            double sweepDeg = clamped * 360.0;
            // Start at 12 o'clock; +X axis = 3 o'clock, so subtract 90°.
            double endAngleRad = (sweepDeg - 90.0) * Math.PI / 180.0;
            var start = new Point(center.X, center.Y - r);
            var end = new Point(
                center.X + r * Math.Cos(endAngleRad),
                center.Y + r * Math.Sin(endAngleRad));

            var figure = new PathFigure
            {
                StartPoint = start,
                IsClosed = false,
                IsFilled = false,
            };
            figure.Segments.Add(new ArcSegment
            {
                Point = end,
                Size = new Size(r, r),
                IsLargeArc = sweepDeg > 180.0,
                SweepDirection = SweepDirection.Clockwise,
            });

            var geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            geometry.Freeze();

            dc.DrawGeometry(null, foregroundPen, geometry);
        }
    }
}
