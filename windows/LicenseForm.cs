using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class LicenseForm : Form
    {
        private readonly TextBox _keyBox;
        private readonly Label   _statusLabel;
        private readonly Button  _activateButton;

        public LicenseForm()
        {
            Text            = "Activate OmniKey AI";
            Size            = new Size(520, 330);
            MinimumSize     = new Size(520, 330);
            MaximumSize     = new Size(700, 330);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;

            // ── Zone 1: Header card ───────────────────────────────────────
            var headerPanel = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(0, 0),
                Size      = new Size(520, 110),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var titleLabel = new Label
            {
                Text      = "Activate OmniKey",
                Font      = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 22),
                Size      = new Size(520, 34)
            };

            var descLabel = new Label
            {
                Text      = "Enter your subscription key to unlock all features.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 62),
                Size      = new Size(520, 22)
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(descLabel);

            // Bottom border of header
            var headerBorder = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 109),
                Size      = new Size(520, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            // ── Zone 2: Form area ─────────────────────────────────────────
            var keyLabel = new Label
            {
                Text      = "Subscription Key",
                Font      = new Font("Segoe UI", 8, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = true,
                Location  = new Point(24, 122)
            };

            _keyBox = new TextBox
            {
                Font        = new Font("Consolas", 10),
                Location    = new Point(24, 142),
                Size        = new Size(472, 28),
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                PlaceholderText = "Paste your subscription key here",
                Anchor      = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            if (SubscriptionManager.Instance.HasStoredKey)
                _keyBox.Text = SubscriptionManager.Instance.UserKey ?? "";

            // ── Zone 3: Status + Actions footer ───────────────────────────
            var footerSep = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 186),
                Size      = new Size(520, 1),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            _statusLabel = new Label
            {
                Text      = "",
                Font      = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(24, 194),
                Size      = new Size(472, 18),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            var quitButton = new Button
            {
                Text      = "Quit",
                Location  = new Point(24, 220),
                Size      = new Size(80, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.SecondaryText,
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left
            };
            quitButton.FlatAppearance.BorderColor = NordColors.Border;
            quitButton.Click += (_, _) => Application.Exit();

            _activateButton = new Button
            {
                Text      = "Activate",
                Location  = new Point(416, 220),
                Size      = new Size(80, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.AccentBlue,
                ForeColor = Color.White,
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Right
            };
            _activateButton.FlatAppearance.BorderColor = NordColors.AccentBlue;
            _activateButton.Click += async (_, _) => await ActivateAsync();

            AcceptButton = _activateButton;

            Controls.AddRange(new Control[]
            {
                headerPanel, headerBorder,
                keyLabel, _keyBox,
                footerSep, _statusLabel,
                quitButton, _activateButton
            });
        }

        private async Task ActivateAsync()
        {
            string key = _keyBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(key)) return;

            _activateButton.Enabled = false;
            _statusLabel.Text       = "Activating key...";
            _statusLabel.ForeColor  = NordColors.SecondaryText;

            var (success, error) = await SubscriptionManager.Instance.UpdateUserKeyAsync(key);

            if (success)
            {
                _statusLabel.Text      = "\u2713 Activation successful. OmniKey is unlocked.";
                _statusLabel.ForeColor = NordColors.AccentGreen;
                await Task.Delay(600);
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                _statusLabel.Text      = "\u2715 Activation failed: " + error;
                _statusLabel.ForeColor = NordColors.ErrorRed;
                _activateButton.Enabled = true;
            }
        }
    }
}
