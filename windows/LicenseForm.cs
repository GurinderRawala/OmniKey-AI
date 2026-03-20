using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class LicenseForm : Form
    {
        private readonly TextBox _keyBox;
        private readonly Label _statusLabel;
        private readonly Button _activateButton;

        public LicenseForm()
        {
            Text = "Activate OmniKey AI";
            Size = new Size(500, 240);
            MinimumSize = new Size(500, 240);
            MaximumSize = new Size(700, 240);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = NordColors.WindowBackground;

            var titleLabel = new Label
            {
                Text = "Activate OmniKey",
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(20, 16)
            };

            var descLabel = new Label
            {
                Text = "Enter your OmniKey subscription key to unlock enhancements.",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize = true,
                Location = new Point(20, 48)
            };

            var keyLabel = new Label
            {
                Text = "Subscription Key",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(20, 76)
            };

            _keyBox = new TextBox
            {
                Font = new Font("Consolas", 10),
                Location = new Point(20, 96),
                Size = new Size(452, 24),
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                PlaceholderText = "Paste your subscription key here"
            };

            if (SubscriptionManager.Instance.HasStoredKey)
                _keyBox.Text = SubscriptionManager.Instance.UserKey ?? "";

            _statusLabel = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                AutoSize = false,
                Location = new Point(20, 128),
                Size = new Size(452, 18)
            };

            var quitButton = new Button
            {
                Text = "Quit",
                Location = new Point(20, 154),
                Size = new Size(80, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            quitButton.FlatAppearance.BorderColor = NordColors.Border;
            quitButton.Click += (_, _) => Application.Exit();

            _activateButton = new Button
            {
                Text = "Activate",
                Location = new Point(392, 154),
                Size = new Size(80, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.Accent,
                ForeColor = Color.White
            };
            _activateButton.FlatAppearance.BorderColor = NordColors.Accent;
            _activateButton.Click += async (_, _) => await ActivateAsync();

            // Allow pressing Enter to activate
            AcceptButton = _activateButton;

            Controls.AddRange(new Control[]
            {
                titleLabel, descLabel, keyLabel, _keyBox,
                _statusLabel, quitButton, _activateButton
            });
        }

        private async Task ActivateAsync()
        {
            string key = _keyBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(key)) return;

            _activateButton.Enabled = false;
            _statusLabel.Text = "Activating key...";
            _statusLabel.ForeColor = NordColors.SecondaryText;

            var (success, error) = await SubscriptionManager.Instance.UpdateUserKeyAsync(key);

            if (success)
            {
                _statusLabel.Text = "Activation successful. OmniKey is unlocked.";
                _statusLabel.ForeColor = NordColors.SuccessGreen;
                await Task.Delay(600);
                DialogResult = DialogResult.OK;
                Close();
            }
            else
            {
                _statusLabel.Text = "Activation failed: " + error;
                _statusLabel.ForeColor = NordColors.ErrorRed;
                _activateButton.Enabled = true;
            }
        }
    }
}
