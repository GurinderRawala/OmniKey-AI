using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal static class UIStyles
    {
        private static Icon? _cachedAppIcon;

        public static Icon? AppIcon
        {
            get
            {
                if (_cachedAppIcon != null) return _cachedAppIcon;
                try
                {
                    var assembly = System.Reflection.Assembly.GetExecutingAssembly();
                    using var stream = assembly.GetManifestResourceStream("OmniKey.Windows.app.ico");
                    if (stream != null) _cachedAppIcon = new Icon(stream);
                }
                catch
                {
                }
                return _cachedAppIcon;
            }
        }

        public static Button MakePrimaryButton(string text, Size? size = null, Image? icon = null)
        {
            var back = NordColors.Accent;
            return MakeStyledButton(
                text,
                size ?? new Size(104, 32),
                back,
                Hover(back, 0.12f),
                Pressed(back, 0.10f),
                NordColors.WindowBackground,
                back,
                12,
                icon,
                borderSize: 0);
        }

        public static Button MakeSecondaryButton(string text, Size? size = null, Image? icon = null)
        {
            var back = NordColors.SurfaceBackground;
            return MakeStyledButton(
                text,
                size ?? new Size(104, 32),
                back,
                Hover(back, 0.08f),
                Pressed(back, 0.08f),
                NordColors.PrimaryText,
                NordColors.Border,
                12,
                icon);
        }

        public static Button MakeDangerButton(string text, Size? size = null, Image? icon = null)
        {
            var back = NordColors.RedSectionFill;
            return MakeStyledButton(
                text,
                size ?? new Size(112, 32),
                back,
                Hover(back, 0.12f, NordColors.ErrorRed),
                Pressed(back, 0.10f),
                NordColors.ErrorRed,
                NordColors.RedSectionBorder,
                12,
                icon);
        }

        public static Button MakeIconButton(
            Func<int, Color, Bitmap> glyph,
            int iconSize = 14,
            Size? size = null,
            Color? iconColor = null,
            string text = "",
            string? toolTip = null)
        {
            var color = iconColor ?? NordColors.PrimaryText;
            var button = MakeIconButton(glyph(iconSize, color), size, text, toolTip);
            button.ForeColor = color;
            return button;
        }

        public static Button MakeIconButton(
            Image? icon = null,
            Size? size = null,
            string text = "",
            string? toolTip = null)
        {
            var back = NordColors.BadgeBackground;
            var button = MakeStyledButton(
                text,
                size ?? new Size(30, 30),
                back,
                Hover(back, 0.10f),
                Pressed(back, 0.08f),
                NordColors.PrimaryText,
                NordColors.Border,
                6,
                icon);

            button.ImageAlign = ContentAlignment.MiddleCenter;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.Padding = Padding.Empty;

            if (!string.IsNullOrWhiteSpace(toolTip))
            {
                var tip = new ToolTip
                {
                    BackColor = NordColors.PanelBackground,
                    ForeColor = NordColors.PrimaryText,
                };
                tip.SetToolTip(button, toolTip);
            }

            return button;
        }

        public static Button MakeCapsulePill(string text, Size? size = null, Image? icon = null)
        {
            var back = NordColors.BadgeBackground;
            return MakeStyledButton(
                text,
                size ?? new Size(120, 28),
                back,
                Hover(back, 0.08f),
                Pressed(back, 0.08f),
                NordColors.SecondaryText,
                NordColors.Border,
                999,
                icon);
        }

        private static Button MakeStyledButton(
            string text,
            Size size,
            Color back,
            Color hover,
            Color pressed,
            Color fore,
            Color border,
            int radius,
            Image? icon,
            int borderSize = 1)
        {
            var button = new RoundedButton
            {
                Text = text,
                Size = size,
                AutoSize = false,
                BackColor = back,
                ForeColor = fore,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                Cursor = Cursors.Hand,
                UseVisualStyleBackColor = false,
                CornerRadius = radius,
                Image = icon,
                ImageAlign = ContentAlignment.MiddleLeft,
                TextAlign = ContentAlignment.MiddleCenter,
                TextImageRelation = icon == null
                    ? TextImageRelation.Overlay
                    : TextImageRelation.ImageBeforeText,
                Padding = icon == null ? Padding.Empty : new Padding(8, 0, 8, 0),
            };

            button.FlatAppearance.BorderSize = borderSize;
            button.FlatAppearance.BorderColor = border;
            button.FlatAppearance.MouseOverBackColor = hover;
            button.FlatAppearance.MouseDownBackColor = pressed;

            return button;
        }

        private static Color Hover(Color baseColor, float amount, Color? tint = null) =>
            Blend(tint ?? NordColors.PrimaryText, baseColor, amount);

        private static Color Pressed(Color baseColor, float amount) =>
            Blend(NordColors.WindowBackground, baseColor, amount);

        private static Color Blend(Color foreground, Color background, float amount)
        {
            amount = Math.Max(0f, Math.Min(1f, amount));
            int r = (int)Math.Round(background.R + (foreground.R - background.R) * amount);
            int g = (int)Math.Round(background.G + (foreground.G - background.G) * amount);
            int b = (int)Math.Round(background.B + (foreground.B - background.B) * amount);
            return Color.FromArgb(r, g, b);
        }

        private sealed class RoundedButton : Button
        {
            private int _cornerRadius = 12;

            [Browsable(false)]
            [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public int CornerRadius
            {
                get => _cornerRadius;
                set
                {
                    _cornerRadius = value;
                    UpdateRegion();
                    Invalidate();
                }
            }

            protected override void OnResize(EventArgs e)
            {
                base.OnResize(e);
                UpdateRegion();
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                    Region?.Dispose();

                base.Dispose(disposing);
            }

            private void UpdateRegion()
            {
                if (Width <= 0 || Height <= 0)
                    return;

                Region?.Dispose();
                using var path = BuildRoundedPath(
                    new RectangleF(0, 0, Width, Height),
                    Math.Min(CornerRadius, Height / 2f));
                Region = new Region(path);
            }

            // Inlined from the now-deleted GfxHelpers helper. This Region
            // factory is the sole remaining consumer.
            private static GraphicsPath BuildRoundedPath(RectangleF r, float radius)
            {
                float maxRadius = Math.Min(r.Width, r.Height) / 2f;
                radius = Math.Max(0, Math.Min(radius, maxRadius));

                var p = new GraphicsPath();
                if (radius <= 0 || r.Width <= 0 || r.Height <= 0)
                {
                    if (r.Width > 0 && r.Height > 0) p.AddRectangle(r);
                    return p;
                }

                float d = radius * 2;
                p.AddArc(r.X, r.Y, d, d, 180, 90);
                p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
                p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
                p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
                p.CloseFigure();
                return p;
            }
        }
    }
}
