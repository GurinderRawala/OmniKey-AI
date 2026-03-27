using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class LicenseForm : Form
    {
        private readonly TextBox    _keyBox;
        private readonly PictureBox _statusIconBox;
        private readonly Label      _statusLabel;
        private readonly Panel      _statusRow;
        private readonly Button     _activateButton;

        public LicenseForm()
        {
            Text            = "Activate OmniKey AI";
            Size            = new Size(520, 390);
            MinimumSize     = new Size(520, 390);
            MaximumSize     = new Size(700, 390);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;

            // ── Zone 1: Header card ───────────────────────────────────────
            var headerPanel = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(0, 0),
                Size      = new Size(520, 148),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            // Paint subtle gradient + bottom border on header
            headerPanel.Paint += (_, e) =>
            {
                var r = new RectangleF(0, 0, headerPanel.Width, headerPanel.Height);
                using var grad = new LinearGradientBrush(
                    r,
                    Color.FromArgb(10, NordColors.AccentBlue),
                    Color.Transparent,
                    LinearGradientMode.ForwardDiagonal);
                e.Graphics.FillRectangle(grad, r);
                using var sep = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(sep, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
            };

            // App icon in rounded frame
            var iconWrapper = new Panel
            {
                Size      = new Size(60, 60),
                Location  = new Point((520 - 60) / 2, 16),
                BackColor = Color.Transparent
            };
            iconWrapper.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                var r = new RectangleF(0, 0, 59, 59);
                using var bg = new SolidBrush(Color.FromArgb(30, NordColors.AccentBlue));
                using var border = new Pen(Color.FromArgb(60, NordColors.AccentBlue), 1);
                GfxHelpers.FillRoundedRect(e.Graphics, bg, r, 14);
                GfxHelpers.DrawRoundedRect(e.Graphics, border, r, 14);
            };

            var iconBox = new PictureBox
            {
                Size      = new Size(44, 44),
                Location  = new Point(8, 8),
                SizeMode  = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent
            };

            // Attempt to load the embedded app icon
            try
            {
                var asm = System.Reflection.Assembly.GetExecutingAssembly();
                using var stream = asm.GetManifestResourceStream("OmniKey.Windows.app.ico");
                if (stream != null)
                    iconBox.Image = new Icon(stream, 44, 44).ToBitmap();
            }
            catch { /* fall through — no icon */ }

            if (iconBox.Image == null)
            {
                // Branded gradient placeholder
                var placeholder = new Bitmap(44, 44);
                using var pg = Graphics.FromImage(placeholder);
                pg.SmoothingMode = SmoothingMode.AntiAlias;
                using var grad = new LinearGradientBrush(
                    new Rectangle(0, 0, 44, 44),
                    NordColors.AccentBlue, NordColors.AccentPurple,
                    LinearGradientMode.ForwardDiagonal);
                pg.FillEllipse(grad, 2, 2, 40, 40);
                iconBox.Image = placeholder;
            }

            iconWrapper.Controls.Add(iconBox);
            headerPanel.Controls.Add(iconWrapper);

            var titleLabel = new Label
            {
                Text      = "Activate OmniKey",
                Font      = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 84),
                Size      = new Size(520, 32),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(titleLabel);

            var descLabel = new Label
            {
                Text      = "Enter your subscription key to unlock all features.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 116),
                Size      = new Size(520, 22),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(descLabel);

            // ── Zone 2: Key input ─────────────────────────────────────────
            var keyLabel = new Label
            {
                Text      = "SUBSCRIPTION KEY",
                Font      = new Font("Segoe UI", 7.5f, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = true,
                Location  = new Point(24, 162)
            };

            // Key icon + TextBox styled container
            var keyContainer = new Panel
            {
                Location  = new Point(24, 180),
                Size      = new Size(472, 36),
                BackColor = NordColors.EditorBackground,
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            keyContainer.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var border = new Pen(NordColors.Border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, border,
                    new RectangleF(0, 0, keyContainer.Width - 1, keyContainer.Height - 1), 5);
            };

            var keyIconBox = new PictureBox
            {
                Size      = new Size(16, 16),
                Location  = new Point(10, 10),
                SizeMode  = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent,
                Image     = WinIcons.KeyIcon(16, NordColors.SecondaryText)
            };

            _keyBox = new TextBox
            {
                Font            = new Font("Consolas", 10),
                Location        = new Point(34, 8),
                Size            = new Size(430, 20),
                BackColor       = NordColors.EditorBackground,
                ForeColor       = NordColors.PrimaryText,
                BorderStyle     = BorderStyle.None,
                PlaceholderText = "Paste your subscription key here",
                Anchor          = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            if (SubscriptionManager.Instance.HasStoredKey)
                _keyBox.Text = SubscriptionManager.Instance.UserKey ?? "";

            keyContainer.Controls.Add(keyIconBox);
            keyContainer.Controls.Add(_keyBox);

            // ── Zone 3: Status row ────────────────────────────────────────
            _statusRow = new Panel
            {
                Location  = new Point(24, 226),
                Size      = new Size(472, 30),
                BackColor = NordColors.EditorBackground,
                Visible   = false,
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            _statusRow.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var border = new Pen(NordColors.Border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, border,
                    new RectangleF(0, 0, _statusRow.Width - 1, _statusRow.Height - 1), 5);
            };

            _statusIconBox = new PictureBox
            {
                Size      = new Size(16, 16),
                Location  = new Point(9, 7),
                SizeMode  = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent
            };

            _statusLabel = new Label
            {
                Text      = "",
                Font      = new Font("Segoe UI", 8.5f),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(31, 8),
                Size      = new Size(434, 14),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            _statusRow.Controls.Add(_statusIconBox);
            _statusRow.Controls.Add(_statusLabel);

            // ── Zone 4: Footer ────────────────────────────────────────────
            var footerSep = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 270),
                Size      = new Size(520, 1),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            var quitButton = new Button
            {
                Text      = "Quit",
                Location  = new Point(24, 286),
                Size      = new Size(80, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.SecondaryText,
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left
            };
            quitButton.FlatAppearance.BorderColor        = NordColors.Border;
            quitButton.FlatAppearance.MouseOverBackColor = NordColors.PanelBackground;
            quitButton.Click += (_, _) => Application.Exit();

            _activateButton = new Button
            {
                Text      = "Activate",
                Location  = new Point(398, 286),
                Size      = new Size(98, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.AccentBlue,
                ForeColor = Color.White,
                Image     = WinIcons.Checkmark(14, Color.White),
                ImageAlign = ContentAlignment.MiddleLeft,
                TextImageRelation = TextImageRelation.ImageBeforeText,
                Padding   = new Padding(6, 0, 6, 0),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Right
            };
            _activateButton.FlatAppearance.BorderColor        = NordColors.AccentBlue;
            _activateButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(116, 185, 255);
            _activateButton.Click += async (_, _) => await ActivateAsync();

            AcceptButton = _activateButton;

            Controls.AddRange(new Control[]
            {
                headerPanel, keyLabel, keyContainer, _statusRow,
                footerSep, quitButton, _activateButton
            });
        }

        // ── Activation logic ──────────────────────────────────────────────

        private async Task ActivateAsync()
        {
            string key = _keyBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(key)) return;

            _activateButton.Enabled = false;
            _activateButton.Text    = "Activating...";
            _activateButton.Image   = null;
            ShowStatus("Activating key...", StatusKind.Info);

            var (success, error) = await SubscriptionManager.Instance.UpdateUserKeyAsync(key);

            if (success)
            {
                ShowStatus("Activation successful. OmniKey is unlocked.", StatusKind.Success);
                await Task.Delay(600);
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                ShowStatus("Activation failed: " + error, StatusKind.Error);
                _activateButton.Enabled = true;
                _activateButton.Text    = "Activate";
                _activateButton.Image   = WinIcons.Checkmark(14, Color.White);
            }
        }

        private enum StatusKind { Info, Success, Error }

        private void ShowStatus(string text, StatusKind kind)
        {
            _statusLabel.Text = text;
            _statusRow.Visible = true;

            switch (kind)
            {
                case StatusKind.Success:
                    _statusLabel.ForeColor  = NordColors.AccentGreen;
                    _statusIconBox.Image    = WinIcons.Checkmark(16, NordColors.AccentGreen);
                    _statusRow.BackColor    = NordColors.CyanSectionFill;
                    break;
                case StatusKind.Error:
                    _statusLabel.ForeColor  = NordColors.ErrorRed;
                    _statusIconBox.Image    = WinIcons.Cross(16, NordColors.ErrorRed);
                    _statusRow.BackColor    = NordColors.RedSectionFill;
                    break;
                default:
                    _statusLabel.ForeColor  = NordColors.SecondaryText;
                    _statusIconBox.Image    = null;
                    _statusRow.BackColor    = NordColors.EditorBackground;
                    break;
            }
        }
    }
}
