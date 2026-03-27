using System;
using System.Drawing;
using System.Drawing.Drawing2D;
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
        private readonly Panel           _dotPanel;
        private readonly Label           _badgeLabel;

        // Pulsing animation state
        private readonly System.Windows.Forms.Timer _pulseTimer;
        private float  _pulseAlpha = 1f;
        private bool   _pulseUp    = false;

        private int  _stepCount = 0;
        private bool _isRunning = false;

        public CancellationTokenSource CancellationSource { get; } = new();

        public AgentThinkingForm()
        {
            Text            = "OmniAgent Session - OmniKey AI";
            Size            = new Size(680, 500);
            MinimumSize     = new Size(540, 400);
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.Sizable;

            // ── Header ────────────────────────────────────────────────────
            var headerPanel = new Panel
            {
                Location  = new Point(0, 0),
                Size      = new Size(Width, 78),
                BackColor = NordColors.SurfaceBackground,
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            headerPanel.Paint += (_, e) =>
            {
                using var sep = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(sep, 0, headerPanel.Height - 1, headerPanel.Width, headerPanel.Height - 1);
            };

            var titleLabel = new Label
            {
                Text      = "OmniAgent Session",
                Font      = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(20, 14),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(titleLabel);

            var subtitleLabel = new Label
            {
                Text      = "You can keep working while the agent plans and runs any commands it needs.",
                Font      = new Font("Segoe UI", 8.5f),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(20, 42),
                Size      = new Size(440, 18),
                BackColor = Color.Transparent
            };
            headerPanel.Controls.Add(subtitleLabel);

            // Status badge — top right of header
            _statusBadgePanel = new Panel
            {
                Size      = new Size(130, 28),
                Location  = new Point(Width - 150, 24),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right,
                BackColor = NordColors.BadgeBackground
            };
            _statusBadgePanel.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var brush = new SolidBrush(NordColors.BadgeBackground);
                using var pen   = new Pen(NordColors.Border, 1);
                GfxHelpers.FillRoundedRect(e.Graphics, brush,
                    new RectangleF(0, 0, _statusBadgePanel.Width - 1, _statusBadgePanel.Height - 1), 14);
                GfxHelpers.DrawRoundedRect(e.Graphics, pen,
                    new RectangleF(0, 0, _statusBadgePanel.Width - 1, _statusBadgePanel.Height - 1), 14);
            };

            _dotPanel = new Panel
            {
                Size      = new Size(8, 8),
                BackColor = Color.Transparent,
                Location  = new Point(10, 10)
            };
            _dotPanel.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color baseColor = _isRunning ? NordColors.AccentCyan : NordColors.AccentGreen;
                int a = _isRunning ? (int)(255 * _pulseAlpha) : 255;
                using var brush = new SolidBrush(Color.FromArgb(a, baseColor));
                e.Graphics.FillEllipse(brush, 0, 0, _dotPanel.Width - 1, _dotPanel.Height - 1);
            };

            _badgeLabel = new Label
            {
                Text      = "Running...",
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = NordColors.AccentCyan,
                AutoSize  = true,
                Location  = new Point(24, 7),
                BackColor = Color.Transparent
            };

            _statusBadgePanel.Controls.Add(_dotPanel);
            _statusBadgePanel.Controls.Add(_badgeLabel);
            headerPanel.Controls.Add(_statusBadgePanel);
            Controls.Add(headerPanel);

            // ── Log area ─────────────────────────────────────────────────
            var logSurround = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(16, 86),
                Padding   = new Padding(2),
                Anchor    = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };
            logSurround.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var pen = new Pen(NordColors.Border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, pen,
                    new RectangleF(0, 0, logSurround.Width - 1, logSurround.Height - 1), 6);
            };

            _logFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents  = false,
                AutoSize      = true,
                AutoSizeMode  = AutoSizeMode.GrowAndShrink,
                BackColor     = NordColors.EditorBackground,
                Padding       = new Padding(10),
            };

            _logPanel = new Panel
            {
                BackColor  = NordColors.EditorBackground,
                Dock       = DockStyle.Fill,
                AutoScroll = true,
            };
            _logPanel.Controls.Add(_logFlow);
            _logPanel.SizeChanged += (_, _) => UpdateFlowWidth();
            logSurround.Controls.Add(_logPanel);
            Controls.Add(logSurround);

            // ── Bottom panel ──────────────────────────────────────────────
            _bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 52,
                BackColor = NordColors.WindowBackground
            };
            _bottomPanel.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, 0, _bottomPanel.Width, 0);
            };

            _cancelButton = new Button
            {
                Text      = "  Cancel",
                Image     = WinIcons.StopSquare(12, NordColors.ErrorRed),
                ImageAlign = ContentAlignment.MiddleLeft,
                TextImageRelation = TextImageRelation.ImageBeforeText,
                Size      = new Size(100, 32),
                Location  = new Point(14, 10),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.RedSectionFill,
                ForeColor = NordColors.ErrorRed,
                Visible   = false
            };
            _cancelButton.FlatAppearance.BorderColor = NordColors.RedSectionBorder;
            _cancelButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(50, NordColors.ErrorRed);
            _cancelButton.Click += (_, _) =>
            {
                AgentRunner.CancelCurrentSession();
                CancellationSource.Cancel();
                SetRunning(false);
            };

            _statusLabel = new Label
            {
                Text      = "Running...",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.AccentCyan,
                AutoSize  = true,
                Anchor    = AnchorStyles.Right | AnchorStyles.Top
            };

            _bottomPanel.Controls.Add(_cancelButton);
            _bottomPanel.Controls.Add(_statusLabel);
            _bottomPanel.SizeChanged += (_, _) => PositionStatusLabel();
            Controls.Add(_bottomPanel);

            // ── Pulse animation timer ─────────────────────────────────────
            _pulseTimer = new System.Windows.Forms.Timer { Interval = 50 };
            _pulseTimer.Tick += OnPulseTick;
            _pulseTimer.Start();

            SizeChanged += (_, _) => ResizeLog();
            ResizeLog();
            PositionStatusLabel();
            PositionStatusBadge();
        }

        // ── Pulse animation ───────────────────────────────────────────────

        private void OnPulseTick(object? sender, EventArgs e)
        {
            if (!_isRunning) return;
            _pulseAlpha += _pulseUp ? 0.06f : -0.06f;
            if (_pulseAlpha >= 1.0f) { _pulseAlpha = 1.0f; _pulseUp = false; }
            if (_pulseAlpha <= 0.35f) { _pulseAlpha = 0.35f; _pulseUp = true; }
            _dotPanel?.Invalidate();
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
            if (Controls.Count < 2) return;
            var header = Controls[0] as Panel;
            var surround = Controls[1] as Panel;
            if (header == null || surround == null) return;

            header.Size = new Size(ClientSize.Width, 78);

            int logTop    = 86;
            int logHeight = ClientSize.Height - logTop - _bottomPanel.Height - 8;
            surround.Size     = new Size(ClientSize.Width - 32, Math.Max(logHeight, 80));
            surround.Location = new Point(16, logTop);

            PositionStatusBadge();
        }

        private void PositionStatusBadge()
        {
            if (Controls.Count > 0 && Controls[0] is Panel header)
                _statusBadgePanel.Location = new Point(header.Width - _statusBadgePanel.Width - 20, 24);
        }

        private void PositionStatusLabel()
        {
            int right = _bottomPanel.ClientSize.Width - 14;
            _statusLabel.Location = new Point(
                right - _statusLabel.Width,
                (_bottomPanel.Height - _statusLabel.Height) / 2);
        }

        // ── Public API (may be called from background thread) ─────────────

        public void SetInitialRequest(string text)
        {
            InvokeIfNeeded(() =>
            {
                AppendSectionHeader("Your Request", NordColors.AccentBlue, SectionIcon.Request);
                AppendEntry(text, NordColors.PrimaryText, NordColors.AccentBlue,
                    new Font("Consolas", 10));
            });
        }

        public void AppendAgentMessage(string text)
        {
            InvokeIfNeeded(() =>
            {
                if (_stepCount == 0)
                    AppendSectionHeader("Agent Reasoning", NordColors.AccentPurple, SectionIcon.Brain);

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
                AppendEntry("[web] " + text.Trim(), NordColors.SecondaryText,
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
                    _statusLabel.Text      = "Running...";
                    _statusLabel.ForeColor = NordColors.AccentCyan;
                    _badgeLabel.Text       = "Running...";
                    _badgeLabel.ForeColor  = NordColors.AccentCyan;
                    _pulseAlpha = 1f;
                    _pulseUp    = false;
                }
                else
                {
                    _statusLabel.Text      = "Finished";
                    _statusLabel.ForeColor = NordColors.AccentGreen;
                    _badgeLabel.Text       = "Finished";
                    _badgeLabel.ForeColor  = NordColors.AccentGreen;
                    _dotPanel?.Invalidate();
                }

                PositionStatusLabel();
            });
        }

        // ── Private rendering helpers ──────────────────────────────────────

        private enum SectionIcon { Request, Brain, Globe, Terminal }

        private void AppendSectionHeader(string title, Color color, SectionIcon icon)
        {
            // Card-style section header: colored left bar + dot icon + title
            var container = new Panel
            {
                Width     = _logFlow.Width - _logFlow.Padding.Horizontal,
                Height    = 34,
                BackColor = NordColors.EditorBackground,
                Margin    = new Padding(0, 6, 0, 4),
            };
            container.Paint += (_, e) =>
            {
                // Colored left accent bar
                using var barBrush = new SolidBrush(color);
                using var barPath  = GfxHelpers.RoundedPath(new RectangleF(0, 6, 3, 22), 1.5f);
                e.Graphics.FillPath(barBrush, barPath);

                // Small icon badge (filled circle with color)
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var iconBg = new SolidBrush(Color.FromArgb(35, color));
                e.Graphics.FillEllipse(iconBg, 10, 9, 16, 16);

                // Draw icon symbol inside the badge
                DrawSectionIconSymbol(e.Graphics, icon, color, new Rectangle(10, 9, 16, 16));

                // Section title text
                TextRenderer.DrawText(e.Graphics, title,
                    new Font("Segoe UI", 10, FontStyle.Bold),
                    new Rectangle(32, 8, container.Width - 36, 18),
                    color, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            };

            _logFlow.Controls.Add(container);
        }

        private static void DrawSectionIconSymbol(Graphics g, SectionIcon icon, Color color, Rectangle bounds)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float cx = bounds.X + bounds.Width / 2f;
            float cy = bounds.Y + bounds.Height / 2f;
            float r  = bounds.Width * 0.28f;

            using var pen = new Pen(color, 1.2f);
            pen.StartCap = pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;

            switch (icon)
            {
                case SectionIcon.Request:
                    // Quote marks shape
                    g.DrawEllipse(pen, cx - r - 2, cy - r, r * 1.6f, r * 1.6f);
                    break;

                case SectionIcon.Brain:
                    // Simple circle (represents brain/reasoning)
                    g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
                    g.DrawLine(pen, cx, cy - r, cx, cy + r * 0.3f);
                    break;

                case SectionIcon.Globe:
                    // Globe: circle + equator
                    g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
                    g.DrawLine(pen, cx - r, cy, cx + r, cy);
                    break;

                case SectionIcon.Terminal:
                    // Terminal: ">" prompt
                    using (var p2 = new Pen(color, 1.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    {
                        g.DrawLine(p2, cx - r, cy - r * 0.5f, cx + r * 0.4f, cy);
                        g.DrawLine(p2, cx - r, cy + r * 0.5f, cx + r * 0.4f, cy);
                    }
                    break;
            }
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
            if (entryWidth <= 0) entryWidth = _logPanel.ClientSize.Width
                                            - SystemInformation.VerticalScrollBarWidth
                                            - _logFlow.Padding.Horizontal;
            if (entryWidth <= 0) entryWidth = ClientSize.Width - 64;
            if (entryWidth <= 0) entryWidth = 400;

            var entry = new CollapsibleEntryPanel(text, textColor, font, linkColor, entryWidth);
            _logFlow.Controls.Add(entry);
            _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
        }

        private void InvokeIfNeeded(Action action)
        {
            if (InvokeRequired) Invoke(action);
            else action();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _pulseTimer.Stop();
            _pulseTimer.Dispose();
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
                BackColor = NordColors.EditorBackground;
                Margin    = new Padding(0, 0, 0, 6);
                AutoSize  = false;
                Width     = width;

                var words    = text.Split(new[] { ' ', '\t', '\n', '\r' },
                                   StringSplitOptions.RemoveEmptyEntries);
                _fullText    = text;
                _isLong      = words.Length > WordLimit;
                _previewText = _isLong
                    ? string.Join(" ", words.Take(WordLimit)) + "..."
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
                        Font      = new Font("Segoe UI", 8.5f),
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
                if (_rtb == null) return;
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
                _expanded         = !_expanded;
                _rtb.Text         = _expanded ? _fullText : _previewText;
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
