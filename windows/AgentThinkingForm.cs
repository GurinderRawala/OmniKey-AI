using System;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentThinkingForm : Form
    {
        private const int WordLimit = 10;

        private readonly Panel           _logPanel;
        private readonly FlowLayoutPanel _logFlow;
        private readonly Label           _statusLabel;
        private readonly Button          _cancelButton;
        private readonly Panel           _bottomPanel;
        private readonly Panel           _statusBadgePanel;

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

            // ── Log area ─────────────────────────────────────────────────
            var logSurround = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(16, 82),
                Padding   = new Padding(2),
                Anchor    = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };

            // Flow panel that stacks entries top-to-bottom and grows vertically
            _logFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents  = false,
                AutoSize      = true,
                AutoSizeMode  = AutoSizeMode.GrowAndShrink,
                BackColor     = NordColors.EditorBackground,
                Padding       = new Padding(8),
            };

            // Scrollable container for the flow panel
            _logPanel = new Panel
            {
                BackColor  = NordColors.EditorBackground,
                Dock       = DockStyle.Fill,
                AutoScroll = true,
            };
            _logPanel.Controls.Add(_logFlow);
            _logPanel.SizeChanged += (_, _) => UpdateFlowWidth();

            logSurround.Controls.Add(_logPanel);

            // ── Bottom panel ──────────────────────────────────────────────
            _bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 50,
                BackColor = NordColors.WindowBackground
            };

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

        // ── Layout helpers ────────────────────────────────────────────────

        private void UpdateFlowWidth()
        {
            int w = _logPanel.ClientSize.Width
                  - SystemInformation.VerticalScrollBarWidth
                  - _logFlow.Padding.Horizontal;
            _logFlow.Width = w + _logFlow.Padding.Horizontal;
            foreach (Control c in _logFlow.Controls)
                if (c is CollapsibleEntryPanel ep)
                    ep.Width = w;
        }

        private void ResizeLog()
        {
            int logTop    = 82;
            int logHeight = ClientSize.Height - logTop - _bottomPanel.Height - 8;
            if (Controls.Count > 4 && Controls[4] is Panel surround)
            {
                surround.Size     = new Size(ClientSize.Width - 32, Math.Max(logHeight, 80));
                surround.Location = new Point(16, logTop);
            }
            if (Controls.Count > 3 && Controls[3] is Panel sep)
                sep.Size = new Size(ClientSize.Width, 1);
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
                AppendSectionHeader("Initial input", NordColors.AccentCyan);
                AppendEntry(text, NordColors.PrimaryText, NordColors.AccentCyan,
                    new Font("Consolas", 10));
            });
        }

        public void AppendAgentMessage(string text)
        {
            InvokeIfNeeded(() =>
            {
                if (_stepCount == 0)
                    AppendSectionHeader("OmniKey reasoning & responses", NordColors.AccentPurple);

                _stepCount++;
                AppendInlineLabel($"Step {_stepCount}", NordColors.Nord9,
                    new Font("Consolas", 9, FontStyle.Bold));
                AppendEntry(text, NordColors.PrimaryText, NordColors.AccentPurple,
                    new Font("Consolas", 10));
            });
        }

        public void AppendWebCall(string text)
        {
            InvokeIfNeeded(() =>
            {
                AppendEntry("[web_call] " + text.Trim(), NordColors.SecondaryText,
                    NordColors.AccentCyan, new Font("Consolas", 10));
            });
        }

        public void AppendTerminalOutput(string text)
        {
            InvokeIfNeeded(() =>
            {
                var lines  = text.Split('\n', 2);
                string header = lines.Length > 0 ? lines[0] : text;
                string body   = lines.Length > 1 ? lines[1] : "";

                AppendInlineLabel(header, NordColors.AccentAmber,
                    new Font("Consolas", 10, FontStyle.Bold));

                if (!string.IsNullOrWhiteSpace(body))
                    AppendEntry(body.TrimEnd(), NordColors.SecondaryText,
                        NordColors.AccentAmber, new Font("Consolas", 10));
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
                    _statusLabel.Text      = "\u25cf Running\u2026";
                    _statusLabel.ForeColor = NordColors.AccentCyan;
                }
                else
                {
                    _statusLabel.Text      = "\u2713 Finished";
                    _statusLabel.ForeColor = NordColors.AccentGreen;
                }

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

        private void AppendSectionHeader(string title, Color color)
        {
            var label = new Label
            {
                Text      = $"\u258c {title}",
                Font      = new Font("Segoe UI", 10, FontStyle.Bold),
                ForeColor = color,
                AutoSize  = true,
                Margin    = new Padding(0, 6, 0, 4),
            };
            _logFlow.Controls.Add(label);
        }

        private void AppendInlineLabel(string text, Color color, Font font)
        {
            var label = new Label
            {
                Text      = text,
                Font      = font,
                ForeColor = color,
                AutoSize  = true,
                Margin    = new Padding(0, 2, 0, 2),
            };
            _logFlow.Controls.Add(label);
        }

        private void AppendEntry(string text, Color textColor, Color linkColor, Font font)
        {
            int entryWidth = _logFlow.Width - _logFlow.Padding.Horizontal;
            var entry = new CollapsibleEntryPanel(text, textColor, font, linkColor, entryWidth);
            _logFlow.Controls.Add(entry);
            _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
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

        // ── Collapsible entry panel ────────────────────────────────────────

        private sealed class CollapsibleEntryPanel : Panel
        {
            private readonly RichTextBox _rtb;
            private readonly LinkLabel?  _toggleLink;
            private readonly string      _fullText;
            private readonly string      _previewText;
            private readonly bool        _isLong;
            private bool                 _expanded;

            internal CollapsibleEntryPanel(
                string text, Color textColor, Font font, Color linkColor, int width)
            {
                BackColor    = NordColors.EditorBackground;
                Margin       = new Padding(0, 0, 0, 8);
                Padding      = Padding.Empty;
                AutoSize     = false;
                Width        = width;

                var words    = text.Split(new[] { ' ', '\t', '\n', '\r' },
                                   StringSplitOptions.RemoveEmptyEntries);
                _fullText    = text;
                _isLong      = words.Length > WordLimit;
                _previewText = _isLong
                    ? string.Join(" ", words.Take(WordLimit)) + "\u2026"
                    : text;
                _expanded    = false;

                _rtb = new RichTextBox
                {
                    BackColor   = NordColors.EditorBackground,
                    ForeColor   = textColor,
                    Font        = font,
                    BorderStyle = BorderStyle.None,
                    ReadOnly    = true,
                    WordWrap    = true,
                    ScrollBars  = RichTextBoxScrollBars.None,
                    Text        = _isLong ? _previewText : _fullText,
                    Location    = new Point(0, 0),
                    Width       = width,
                    Height      = 20,
                };
                _rtb.ContentsResized += (_, e) =>
                {
                    _rtb.Height = e.NewRectangle.Height + 4;
                    LayoutControls();
                };
                Controls.Add(_rtb);

                if (_isLong)
                {
                    _toggleLink = new LinkLabel
                    {
                        Text      = "Show more",
                        Font      = new Font("Segoe UI", 9),
                        LinkColor = linkColor,
                        AutoSize  = true,
                        Location  = new Point(0, _rtb.Bottom + 2),
                    };
                    _toggleLink.LinkClicked += (_, _) => Toggle();
                    Controls.Add(_toggleLink);
                }

                LayoutControls();
            }

            private void LayoutControls()
            {
                _rtb.Width = Width;
                if (_toggleLink != null)
                {
                    _toggleLink.Location = new Point(0, _rtb.Bottom + 2);
                    Height = _toggleLink.Bottom + 2;
                }
                else
                {
                    Height = _rtb.Bottom + 2;
                }
            }

            private void Toggle()
            {
                _expanded        = !_expanded;
                _rtb.Text        = _expanded ? _fullText : _previewText;
                _toggleLink!.Text = _expanded ? "Show less" : "Show more";
            }

            protected override void OnSizeChanged(EventArgs e)
            {
                base.OnSizeChanged(e);
                LayoutControls();
            }
        }
    }
}
