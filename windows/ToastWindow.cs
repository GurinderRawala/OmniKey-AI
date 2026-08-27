using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    /// <summary>
    /// Small self-dismissing status toast anchored to the bottom-right of the
    /// work area.
    ///
    /// Replaces <c>NotifyIcon.ShowBalloonTip(timeout)</c> for hotkey feedback.
    /// The balloon API's timeout argument is documented as advisory and is
    /// ignored outright on Windows 10/11, where shell balloons are rerouted
    /// through the toast/Action Center pipeline and pinned to the system
    /// notification duration (5s by default, and up to 5 minutes if the user
    /// has raised "Show notifications for" in Accessibility settings). That
    /// made short-lived acknowledgements like "Text updated." linger long
    /// after the paste had already landed, with no in-app way to shorten it.
    /// Owning the window means <see cref="Show"/>'s duration is honoured
    /// exactly.
    ///
    /// The window is deliberately non-activating (WS_EX_NOACTIVATE) and a tool
    /// window (WS_EX_TOOLWINDOW, so it stays out of Alt-Tab). That matters
    /// beyond tidiness: <see cref="HotkeyForm.HandleHotkeyAsync"/> captures the
    /// user's selection by synthesising Ctrl+C into whatever window had focus,
    /// so a toast that grabbed focus would break clipboard capture outright.
    /// Shell balloons could take focus on appearance; this cannot.
    /// </summary>
    internal sealed class ToastWindow : Form
    {
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;

        /// <summary>
        /// Fixed outer width. The toast used to size itself to its content,
        /// which meant the popup changed width with every message — "Text
        /// updated." rendered as a narrow stub while a backend error stretched
        /// it wide — and since it is pinned to the bottom-right corner, the
        /// left edge visibly jumped between consecutive hotkey presses. A
        /// constant width keeps it anchored; height still tracks the wrapped
        /// text.
        /// </summary>
        private const int FixedWidth = 250;

        private const int PaddingX = 14;
        private const int PaddingY = 12;
        private const int AccentBarWidth = 3;
        private const int CornerRadius = 8;
        private const int ScreenMargin = 16;

        private readonly Timer _dismissTimer;
        private readonly Font _titleFont;
        private readonly Font _bodyFont;

        private string _title = string.Empty;
        private string _body = string.Empty;

        public ToastWindow()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = NordColors.PanelBackground;
            DoubleBuffered = true;
            Visible = false;

            _titleFont = new Font("Segoe UI", 9f, FontStyle.Bold);
            _bodyFont = new Font("Segoe UI", 9f, FontStyle.Regular);

            _dismissTimer = new Timer();
            _dismissTimer.Tick += (_, _) =>
            {
                _dismissTimer.Stop();
                Hide();
            };
        }

        /// <summary>Never take focus from the user's active window.</summary>
        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        /// <summary>
        /// Shows (or re-shows) the toast with the given text for
        /// <paramref name="duration"/>. Calling this while a toast is already
        /// on screen replaces its content and restarts the countdown rather
        /// than queueing, so a burst of hotkey presses can't stack windows.
        /// Must be called on the UI thread.
        /// </summary>
        public void Show(string title, string body, TimeSpan duration)
        {
            _title = title ?? string.Empty;
            _body = body ?? string.Empty;

            MeasureContent(out var size);
            Size = size;
            ApplyRoundedRegion();
            PositionBottomRight();

            _dismissTimer.Stop();
            // Timer.Interval is int milliseconds and must be >= 1.
            _dismissTimer.Interval = Math.Max(1, (int)duration.TotalMilliseconds);
            _dismissTimer.Start();

            if (!Visible) Show();
            Invalidate();
        }

        /// <summary>
        /// Measures the content and returns the window size to use. Named
        /// MeasureContent, not Layout — <see cref="Control.Layout"/> is an
        /// inherited event, and a same-named method would shadow it.
        /// </summary>
        private void MeasureContent(out Size size)
        {
            int textLeft = AccentBarWidth + PaddingX;
            int textWidth = FixedWidth - textLeft - PaddingX;

            // Only the height is derived now — both strings wrap inside the
            // constant text column, so a long message grows downwards instead
            // of sideways.
            var titleSize = TextRenderer.MeasureText(
                _title, _titleFont, new Size(textWidth, int.MaxValue), TextFormatFlags.WordBreak);
            var bodySize = TextRenderer.MeasureText(
                _body, _bodyFont, new Size(textWidth, int.MaxValue), TextFormatFlags.WordBreak);

            int height = PaddingY + titleSize.Height + 4 + bodySize.Height + PaddingY;

            size = new Size(FixedWidth, height);
        }

        private void PositionBottomRight()
        {
            var workArea = Screen.PrimaryScreen?.WorkingArea
                           ?? Screen.GetWorkingArea(Point.Empty);
            Location = new Point(
                workArea.Right - Width - ScreenMargin,
                workArea.Bottom - Height - ScreenMargin);
        }

        private void ApplyRoundedRegion()
        {
            using var path = new GraphicsPath();
            int d = CornerRadius * 2;
            var r = new Rectangle(0, 0, Width, Height);
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            Region?.Dispose();
            Region = new Region(path);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(NordColors.PanelBackground);

            // Accent strip down the left edge, matching the section-card
            // vocabulary used by the WPF pages.
            using (var accent = new SolidBrush(NordColors.Accent))
                g.FillRectangle(accent, 0, 0, AccentBarWidth, Height);

            using (var border = new Pen(NordColors.Border))
                g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);

            int textLeft = AccentBarWidth + PaddingX;
            int maxTextWidth = Width - textLeft - PaddingX;

            var titleSize = TextRenderer.MeasureText(
                _title, _titleFont, new Size(maxTextWidth, int.MaxValue), TextFormatFlags.WordBreak);

            TextRenderer.DrawText(
                g, _title, _titleFont,
                new Rectangle(textLeft, PaddingY, maxTextWidth, titleSize.Height),
                NordColors.PrimaryText, TextFormatFlags.WordBreak);

            TextRenderer.DrawText(
                g, _body, _bodyFont,
                new Rectangle(textLeft, PaddingY + titleSize.Height + 4,
                              maxTextWidth, Height - PaddingY - titleSize.Height - 4 - PaddingY),
                NordColors.SecondaryText, TextFormatFlags.WordBreak);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _dismissTimer.Stop();
                _dismissTimer.Dispose();
                _titleFont.Dispose();
                _bodyFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
