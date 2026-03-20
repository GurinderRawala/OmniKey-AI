using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentThinkingForm : Form
    {
        private readonly RichTextBox _logBox;
        private readonly Label _statusLabel;
        private readonly Button _cancelButton;
        private readonly Panel _bottomPanel;

        private int _stepCount = 0;
        private bool _isRunning = false;

        public CancellationTokenSource CancellationSource { get; } = new();

        public AgentThinkingForm()
        {
            Text = "OmniAgent Session – OmniKey AI";
            Size = new Size(620, 440);
            MinimumSize = new Size(520, 360);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.Sizable;

            var titleLabel = new Label
            {
                Text = "OmniAgent Session",
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(16, 14)
            };

            var subtitleLabel = new Label
            {
                Text = "You can keep working while the agent plans and runs any commands it needs.",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize = true,
                Location = new Point(16, 44)
            };

            // Horizontal rule matching macOS Divider()
            var separator = new Panel
            {
                BackColor = NordColors.EditorBackground,  // nord2
                Location = new Point(16, 68),
                Size = new Size(572, 1),
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top
            };

            // Log area: editorBackground (nord2) — matches macOS TextEditor background
            _logBox = new RichTextBox
            {
                Location = new Point(16, 78),
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Consolas", 10),
                BorderStyle = BorderStyle.None,
                ReadOnly = true,
                ScrollBars = RichTextBoxScrollBars.Vertical,
                WordWrap = true
            };

            _bottomPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 40,
                BackColor = NordColors.WindowBackground,
                Padding = new Padding(8, 6, 8, 6)
            };

            _cancelButton = new Button
            {
                Text = "Cancel",
                Size = new Size(70, 28),
                Location = new Point(8, 6),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.ErrorRed,
                ForeColor = Color.White,
                Visible = false
            };
            _cancelButton.FlatAppearance.BorderColor = NordColors.ErrorRed;
            _cancelButton.Click += (_, _) =>
            {
                // Explicitly abort the active WebSocket (mirrors macOS
                // AgentRunner.shared.cancelCurrentSession()), then cancel
                // the token so any running shell command is also killed.
                AgentRunner.CancelCurrentSession();
                CancellationSource.Cancel();
                SetRunning(false);
            };

            _statusLabel = new Label
            {
                Text = "Running\u2026",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize = true,
                Location = new Point(8, 12)
            };

            _bottomPanel.Controls.Add(_cancelButton);
            _bottomPanel.Controls.Add(_statusLabel);

            Controls.AddRange(new Control[] { titleLabel, subtitleLabel, separator, _logBox, _bottomPanel });

            SizeChanged += (_, _) => ResizeLog();
            ResizeLog();
        }

        private void ResizeLog()
        {
            int logHeight = ClientSize.Height - 78 - _bottomPanel.Height - 8;
            _logBox.Size = new Size(ClientSize.Width - 32, Math.Max(logHeight, 80));
            var sep = Controls[2] as Panel;
            if (sep != null) sep.Size = new Size(ClientSize.Width - 32, 1);
        }

        // ── Public API called from AgentRunner (may be on background thread) ──

        public void SetInitialRequest(string text)
        {
            InvokeIfNeeded(() =>
            {
                // "Initial input" header in SuccessGreen, matching macOS nord14
                AppendSection("Initial input", NordColors.SuccessGreen);
                AppendText(text + "\n\n", NordColors.PrimaryText);
            });
        }

        public void AppendAgentMessage(string text)
        {
            InvokeIfNeeded(() =>
            {
                if (_stepCount == 0)
                    // "OmniKey reasoning & responses" header in nord8 (AccentBlue)
                    AppendSection("OmniKey reasoning & responses", NordColors.AccentBlue);

                _stepCount++;
                // Step N label: nord9, small (9pt), matches macOS `.system(size: 9, weight: .medium)`
                AppendText($"Step {_stepCount}\n", NordColors.Nord9, bold: true, size: 9f);
                AppendText(text + "\n\n", NordColors.PrimaryText);

                _logBox.ScrollToCaret();
            });
        }

        public void AppendTerminalOutput(string text)
        {
            InvokeIfNeeded(() =>
            {
                var lines = text.Split('\n', 2);
                string header = lines.Length > 0 ? lines[0] : text;
                string body   = lines.Length > 1 ? lines[1] : "";

                // Terminal header: WarningYellow (nord13), bold — matches macOS secondaryText medium
                AppendText(header + "\n", NordColors.WarningYellow, bold: true);
                if (!string.IsNullOrWhiteSpace(body))
                    AppendText(body.TrimEnd() + "\n\n", NordColors.SecondaryText);
                else
                    AppendText("\n", NordColors.PrimaryText);

                _logBox.ScrollToCaret();
            });
        }

        public void SetRunning(bool running)
        {
            InvokeIfNeeded(() =>
            {
                _isRunning = running;
                _cancelButton.Visible = running;
                _statusLabel.Text = running ? "Running\u2026" : "Finished";
                _statusLabel.Location = running
                    ? new Point(_cancelButton.Right + 8, 12)
                    : new Point(8, 12);
            });
        }

        // ── Private rendering helpers ──────────────────────────────────

        private void AppendSection(string title, Color color)
        {
            _logBox.SelectionStart  = _logBox.TextLength;
            _logBox.SelectionLength = 0;
            _logBox.SelectionColor  = color;
            _logBox.SelectionFont   = new Font("Segoe UI", 10, FontStyle.Bold);
            _logBox.AppendText(title + "\n");
            _logBox.SelectionFont   = _logBox.Font;
        }

        private void AppendText(string text, Color color, bool bold = false, float size = 10f)
        {
            _logBox.SelectionStart  = _logBox.TextLength;
            _logBox.SelectionLength = 0;
            _logBox.SelectionColor  = color;

            bool nonDefault = bold || Math.Abs(size - 10f) > 0.01f;
            if (nonDefault)
                _logBox.SelectionFont = new Font("Consolas", size,
                    bold ? FontStyle.Bold : FontStyle.Regular);
            else
                _logBox.SelectionFont = _logBox.Font;

            _logBox.AppendText(text);
            _logBox.SelectionFont = _logBox.Font;
        }

        private void InvokeIfNeeded(Action action)
        {
            if (InvokeRequired)
                Invoke(action);
            else
                action();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            CancellationSource.Cancel();
            base.OnFormClosed(e);
        }
    }
}
