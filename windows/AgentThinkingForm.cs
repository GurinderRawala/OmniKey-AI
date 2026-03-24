using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentThinkingForm : Form
    {
        private readonly RichTextBox _logBox;
        private readonly Label       _statusLabel;
        private readonly Button      _cancelButton;
        private readonly Panel       _bottomPanel;
        private readonly Panel       _statusBadgePanel;

        private int  _stepCount = 0;
        private bool _isRunning = false;

        public CancellationTokenSource CancellationSource { get; } = new();

        public AgentThinkingForm()
        {
            Text            = "OmniAgent Session \u2013 OmniKey AI";
            Size            = new Size(660, 480);
            MinimumSize     = new Size(520, 380);
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.Sizable;

            // ── Header ────────────────────────────────────────────────────
            var titleLabel = new Label
            {
                Text      = "OmniAgent Session",
                Font      = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(20, 16)
            };

            var subtitleLabel = new Label
            {
                Text      = "You can keep working while the agent plans and runs any commands it needs.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(20, 44),
                Size      = new Size(440, 20)
            };

            // Status badge — top right
            _statusBadgePanel = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Size      = new Size(130, 28),
                Location  = new Point(Width - 150, 14),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right
            };

            var dotPanel = new Panel
            {
                Size      = new Size(10, 10),
                BackColor = NordColors.AccentCyan,
                Location  = new Point(8, 9)
            };
            dotPanel.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using var brush = new SolidBrush(NordColors.AccentCyan);
                e.Graphics.FillEllipse(brush, 0, 0, dotPanel.Width - 1, dotPanel.Height - 1);
            };

            var badgeLabel = new Label
            {
                Text      = "Running\u2026",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.AccentCyan,
                AutoSize  = true,
                Location  = new Point(24, 6)
            };

            _statusBadgePanel.Controls.Add(dotPanel);
            _statusBadgePanel.Controls.Add(badgeLabel);

            // Thin separator line at y=74
            var separator = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 74),
                Size      = new Size(Width, 1),
                Anchor    = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top
            };

            // ── Log area surround ─────────────────────────────────────────
            var logSurround = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(16, 82),
                Padding   = new Padding(2),
                Anchor    = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            _logBox = new RichTextBox
            {
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                Font        = new Font("Consolas", 10),
                BorderStyle = BorderStyle.None,
                ReadOnly    = true,
                ScrollBars  = RichTextBoxScrollBars.Vertical,
                WordWrap    = true,
                Dock        = DockStyle.Fill
            };
            logSurround.Controls.Add(_logBox);

            // ── Bottom panel ──────────────────────────────────────────────
            _bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 50,
                BackColor = NordColors.WindowBackground
            };

            // 1px top border on bottom panel
            var bottomSep = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 0),
                Size      = new Size(Width, 1),
                Anchor    = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top
            };

            _cancelButton = new Button
            {
                Text      = "\u25a0 Cancel",
                Size      = new Size(90, 30),
                Location  = new Point(16, 10),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.RedSectionFill,
                ForeColor = NordColors.ErrorRed,
                Visible   = false
            };
            _cancelButton.FlatAppearance.BorderColor = NordColors.RedSectionBorder;
            _cancelButton.Click += (_, _) =>
            {
                AgentRunner.CancelCurrentSession();
                CancellationSource.Cancel();
                SetRunning(false);
            };

            _statusLabel = new Label
            {
                Text      = "\u25cf Running\u2026",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.AccentCyan,
                AutoSize  = true,
                Location  = new Point(16, 16),
                Anchor    = AnchorStyles.Right | AnchorStyles.Top
            };

            _bottomPanel.Controls.Add(bottomSep);
            _bottomPanel.Controls.Add(_cancelButton);
            _bottomPanel.Controls.Add(_statusLabel);
            _bottomPanel.SizeChanged += (_, _) => PositionStatusLabel();

            Controls.AddRange(new Control[]
            {
                titleLabel, subtitleLabel, _statusBadgePanel, separator, logSurround, _bottomPanel
            });

            SizeChanged += (_, _) => ResizeLog();
            ResizeLog();
            PositionStatusLabel();
        }

        private void ResizeLog()
        {
            int logTop = 82;
            int logHeight = ClientSize.Height - logTop - _bottomPanel.Height - 8;
            // logSurround is Controls[4]
            if (Controls.Count > 4 && Controls[4] is Panel surround)
            {
                surround.Size     = new Size(ClientSize.Width - 32, Math.Max(logHeight, 80));
                surround.Location = new Point(16, logTop);
            }
            // separator is Controls[3]
            if (Controls.Count > 3 && Controls[3] is Panel sep)
                sep.Size = new Size(ClientSize.Width, 1);
            // bottomSep inside _bottomPanel
            if (_bottomPanel.Controls.Count > 0 && _bottomPanel.Controls[0] is Panel bsep)
                bsep.Size = new Size(_bottomPanel.ClientSize.Width, 1);

            PositionStatusBadge();
        }

        private void PositionStatusBadge()
        {
            _statusBadgePanel.Location = new Point(ClientSize.Width - _statusBadgePanel.Width - 20, 14);
        }

        private void PositionStatusLabel()
        {
            int right = _bottomPanel.ClientSize.Width - 16;
            _statusLabel.Location = new Point(right - _statusLabel.Width, (_bottomPanel.Height - _statusLabel.Height) / 2);
        }

        // ── Public API called from AgentRunner (may be on background thread) ──

        public void SetInitialRequest(string text)
        {
            InvokeIfNeeded(() =>
            {
                AppendSection("Initial input", NordColors.AccentCyan);
                AppendText(text + "\n\n", NordColors.PrimaryText);
            });
        }

        public void AppendAgentMessage(string text)
        {
            InvokeIfNeeded(() =>
            {
                if (_stepCount == 0)
                    AppendSection("OmniKey reasoning & responses", NordColors.AccentPurple);

                _stepCount++;
                AppendText($"Step {_stepCount}\n", NordColors.Nord9, bold: true, size: 9f);
                AppendText(text + "\n\n", NordColors.PrimaryText);

                _logBox.ScrollToCaret();
            });
        }

        public void AppendWebCall(string text)
        {
            InvokeIfNeeded(() =>
            {
                AppendText("[web_call] ", NordColors.AccentCyan, bold: true);
                AppendText(text.Trim() + "\n\n", NordColors.SecondaryText);
                _logBox.ScrollToCaret();
            });
        }

        public void AppendTerminalOutput(string text)
        {
            InvokeIfNeeded(() =>
            {
                var lines  = text.Split('\n', 2);
                string header = lines.Length > 0 ? lines[0] : text;
                string body   = lines.Length > 1 ? lines[1] : "";

                AppendText(header + "\n", NordColors.AccentAmber, bold: true);
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

                if (running)
                {
                    _statusLabel.Text     = "\u25cf Running\u2026";
                    _statusLabel.ForeColor = NordColors.AccentCyan;
                }
                else
                {
                    _statusLabel.Text     = "\u2713 Finished";
                    _statusLabel.ForeColor = NordColors.AccentGreen;
                }

                // Update badge label text to match
                if (_statusBadgePanel.Controls.Count > 1 && _statusBadgePanel.Controls[1] is Label bl)
                {
                    bl.Text      = running ? "Running\u2026" : "Finished";
                    bl.ForeColor = running ? NordColors.AccentCyan : NordColors.AccentGreen;
                }
                if (_statusBadgePanel.Controls.Count > 0 && _statusBadgePanel.Controls[0] is Panel dot)
                    dot.BackColor = running ? NordColors.AccentCyan : NordColors.AccentGreen;

                PositionStatusLabel();
            });
        }

        // ── Private rendering helpers ──────────────────────────────────────

        private void AppendSection(string title, Color color)
        {
            _logBox.SelectionStart  = _logBox.TextLength;
            _logBox.SelectionLength = 0;

            // Accent bar prefix "▌ " in the accent colour
            _logBox.SelectionFont  = new Font("Segoe UI", 10, FontStyle.Bold);
            _logBox.SelectionColor = color;
            _logBox.AppendText("\u258c ");

            // Title text
            _logBox.SelectionColor = color;
            _logBox.SelectionFont  = new Font("Segoe UI", 10, FontStyle.Bold);
            _logBox.AppendText(title + "\n");
            _logBox.SelectionFont  = _logBox.Font;
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
