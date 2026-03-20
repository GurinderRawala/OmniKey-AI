using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    /// <summary>
    /// Displays available update information and lets the user open the download URL.
    /// Mirrors the macOS Sparkle update window in style and intent.
    /// </summary>
    internal sealed class UpdateForm : Form
    {
        public UpdateForm(UpdateInfo info)
        {
            Text            = "OmniKey AI \u2013 Update Available";
            Size            = new Size(520, 340);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;

            // ── Title ────────────────────────────────────────────────────
            var titleLabel = new Label
            {
                Text      = "A new version of OmniKey AI is available!",
                Font      = new Font("Segoe UI", 13, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(20, 18),
            };

            // ── Version line ─────────────────────────────────────────────
            string currentVer = UpdateChecker.CurrentVersion.ToString(3);
            var versionLabel = new Label
            {
                Text      = $"Current: {currentVer}    \u2192    New: {info.Version}",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.AccentBlue,
                AutoSize  = true,
                Location  = new Point(20, 54),
            };

            // ── Release notes label ───────────────────────────────────────
            var notesLabel = new Label
            {
                Text      = "Release notes:",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = true,
                Location  = new Point(20, 82),
            };

            // ── Release notes box ─────────────────────────────────────────
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
                Location    = new Point(20, 102),
                Size        = new Size(472, 140),
            };

            // ── Buttons ───────────────────────────────────────────────────
            var laterButton = new Button
            {
                Text      = "Later",
                Location  = new Point(20, 268),
                Size      = new Size(90, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
            };
            laterButton.FlatAppearance.BorderColor = NordColors.Border;
            laterButton.Click += (_, _) => Close();

            var downloadButton = new Button
            {
                Text      = "Download Update",
                Location  = new Point(382, 268),
                Size      = new Size(110, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.Accent,
                ForeColor = Color.White,
            };
            downloadButton.FlatAppearance.BorderColor = NordColors.Accent;
            downloadButton.Click += (_, _) =>
            {
                if (!string.IsNullOrEmpty(info.DownloadUrl))
                    Process.Start(new ProcessStartInfo(info.DownloadUrl) { UseShellExecute = true });
                Close();
            };

            AcceptButton = downloadButton;
            CancelButton = laterButton;

            Controls.AddRange(new Control[]
            {
                titleLabel, versionLabel, notesLabel, notesBox,
                laterButton, downloadButton,
            });
        }
    }
}
