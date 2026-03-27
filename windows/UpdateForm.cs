using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    /// <summary>
    /// Displays available update information and lets the user open the download URL.
    /// </summary>
    internal sealed class UpdateForm : Form
    {
        public UpdateForm(UpdateInfo info)
        {
            Text            = "OmniKey AI - Update Available";
            Size            = new Size(520, 360);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;

            // ── Header card ───────────────────────────────────────────────
            var headerPanel = new Panel
            {
                Location  = new Point(0, 0),
                Size      = new Size(520, 90),
                BackColor = NordColors.SurfaceBackground
            };
            headerPanel.Paint += (_, e) =>
            {
                // Gradient overlay
                using var grad = new LinearGradientBrush(
                    new Rectangle(0, 0, headerPanel.Width, headerPanel.Height),
                    Color.FromArgb(12, NordColors.AccentGreen),
                    Color.Transparent,
                    LinearGradientMode.ForwardDiagonal);
                e.Graphics.FillRectangle(grad, 0, 0, headerPanel.Width, headerPanel.Height);

                // Bottom border
                using var sep = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(sep, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
            };

            // Update icon badge
            var iconPanel = new Panel
            {
                Size      = new Size(42, 42),
                Location  = new Point(20, 24),
                BackColor = Color.Transparent
            };
            iconPanel.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var bg     = new SolidBrush(Color.FromArgb(35, NordColors.AccentGreen));
                using var border = new Pen(Color.FromArgb(70, NordColors.AccentGreen), 1);
                GfxHelpers.FillRoundedRect(e.Graphics, bg,     new RectangleF(0, 0, 41, 41), 10);
                GfxHelpers.DrawRoundedRect(e.Graphics, border, new RectangleF(0, 0, 41, 41), 10);

                // Arrow-up icon inside badge
                using var arrowPen = new Pen(NordColors.AccentGreen, 2f)
                    { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
                float cx = 20.5f, top = 10f, bot = 31f, hs = 8f;
                e.Graphics.DrawLine(arrowPen, cx, bot, cx, top);
                e.Graphics.DrawLine(arrowPen, cx - hs, top + hs, cx, top);
                e.Graphics.DrawLine(arrowPen, cx + hs, top + hs, cx, top);
            };
            headerPanel.Controls.Add(iconPanel);

            var titleLabel = new Label
            {
                Text      = "A new version of OmniKey AI is available!",
                Font      = new Font("Segoe UI", 12, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(72, 18),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(titleLabel);

            // Version pill
            string currentVer = UpdateChecker.CurrentVersion.ToString(3);
            var versionLabel = new Label
            {
                Text      = $"v{currentVer}",
                Font      = new Font("Segoe UI", 8.5f),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = true,
                Location  = new Point(72, 48),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(versionLabel);

            var arrowIconBox = new PictureBox
            {
                Image    = WinIcons.ArrowRight(14, NordColors.AccentGreen),
                Size     = new Size(14, 14),
                Location = new Point(72 + versionLabel.PreferredWidth + 6, 50),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(arrowIconBox);

            var newVersionLabel = new Label
            {
                Text      = $"v{info.Version}",
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = NordColors.AccentGreen,
                AutoSize  = true,
                Location  = new Point(72 + versionLabel.PreferredWidth + 26, 48),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(newVersionLabel);

            Controls.Add(headerPanel);

            // ── Release notes ─────────────────────────────────────────────
            var notesLabel = new Label
            {
                Text      = "Release notes:",
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = true,
                Location  = new Point(20, 102),
            };
            Controls.Add(notesLabel);

            var notesContainer = new Panel
            {
                Location  = new Point(20, 120),
                Size      = new Size(472, 158),
                BackColor = NordColors.EditorBackground
            };
            notesContainer.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var pen = new Pen(NordColors.Border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, pen,
                    new RectangleF(0, 0, notesContainer.Width - 1, notesContainer.Height - 1), 6);
            };

            var notesBox = new RichTextBox
            {
                Text        = string.IsNullOrWhiteSpace(info.ReleaseNotes)
                                  ? "No release notes provided."
                                  : info.ReleaseNotes,
                Font        = new Font("Segoe UI", 9),
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                BorderStyle = BorderStyle.None,
                ReadOnly    = true,
                ScrollBars  = RichTextBoxScrollBars.Vertical,
                Dock        = DockStyle.Fill,
                Padding     = new Padding(8),
            };
            notesContainer.Controls.Add(notesBox);
            Controls.Add(notesContainer);

            // ── Footer separator ──────────────────────────────────────────
            var footerSep = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 290),
                Size      = new Size(520, 1)
            };
            Controls.Add(footerSep);

            // ── Buttons ───────────────────────────────────────────────────
            var laterButton = new Button
            {
                Text      = "Later",
                Location  = new Point(20, 306),
                Size      = new Size(80, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.SecondaryText,
                Font      = new Font("Segoe UI", 8.5f)
            };
            laterButton.FlatAppearance.BorderColor        = NordColors.Border;
            laterButton.FlatAppearance.MouseOverBackColor = NordColors.PanelBackground;
            laterButton.Click += (_, _) => Close();
            Controls.Add(laterButton);

            var downloadButton = new Button
            {
                Text      = "Download Update",
                Location  = new Point(376, 306),
                Size      = new Size(116, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.AccentGreen,
                ForeColor = Color.FromArgb(10, 12, 26),
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                Image     = WinIcons.ArrowRight(14, Color.FromArgb(10, 12, 26)),
                ImageAlign = ContentAlignment.MiddleLeft,
                TextImageRelation = TextImageRelation.ImageBeforeText,
                Padding   = new Padding(6, 0, 6, 0)
            };
            downloadButton.FlatAppearance.BorderColor        = NordColors.AccentGreen;
            downloadButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(72, 231, 173);
            downloadButton.Click += (_, _) =>
            {
                if (!string.IsNullOrEmpty(info.DownloadUrl))
                    Process.Start(new ProcessStartInfo(info.DownloadUrl) { UseShellExecute = true });
                Close();
            };
            Controls.Add(downloadButton);

            AcceptButton = downloadButton;
            CancelButton = laterButton;
        }
    }
}
