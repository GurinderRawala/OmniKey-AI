using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentThinkingForm : Form
    {
        // Preview: collapse trigger = 10 words, but show 60-word preview (mirrors macOS CollapsibleText).
        private const int CollapseWordThreshold = 10;
        private const int PreviewWordCount      = 60;

        private readonly Panel           _logPanel;
        private readonly FlowLayoutPanel _logFlow;
        private readonly Label           _statusLabel;
        private readonly Button          _cancelButton;
        private readonly Panel           _bottomPanel;
        private readonly Panel           _statusBadgePanel;
        private readonly Panel           _dotPanel;
        private readonly Label           _badgeLabel;

        // Pulsing animation
        private readonly System.Windows.Forms.Timer _pulseTimer;
        private float _pulseAlpha = 1f;
        private bool  _pulseUp    = false;

        private bool _isRunning = false;
        private int  _stepCount = 0;

        // Lazy section cards — created on first use of each section.
        private SectionCard? _requestSection;
        private SectionCard? _reasoningSection;
        private SectionCard? _webSection;
        private SectionCard? _terminalSection;

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
                e.Graphics.DrawLine(sep, 0, headerPanel.Height - 1,
                                    headerPanel.Width, headerPanel.Height - 1);
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

            // Status badge — top-right of header
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
                Color baseColor = _isRunning ? NordColors.Accent : NordColors.AccentGreen;
                int a = _isRunning ? (int)(255 * _pulseAlpha) : 255;
                using var brush = new SolidBrush(Color.FromArgb(a, baseColor));
                e.Graphics.FillEllipse(brush, 0, 0, _dotPanel.Width - 1, _dotPanel.Height - 1);
            };

            _badgeLabel = new Label
            {
                Text      = "Running",
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = NordColors.Accent,
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
                Padding       = new Padding(12),
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
            _cancelButton.FlatAppearance.BorderColor        = NordColors.RedSectionBorder;
            _cancelButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(40, NordColors.ErrorRed);
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
                ForeColor = NordColors.Accent,
                AutoSize  = true,
                Anchor    = AnchorStyles.Right | AnchorStyles.Top
            };

            _bottomPanel.Controls.Add(_cancelButton);
            _bottomPanel.Controls.Add(_statusLabel);
            _bottomPanel.SizeChanged += (_, _) => PositionStatusLabel();
            Controls.Add(_bottomPanel);

            // ── Pulse animation ───────────────────────────────────────────
            _pulseTimer = new System.Windows.Forms.Timer { Interval = 50 };
            _pulseTimer.Tick += OnPulseTick;
            _pulseTimer.Start();

            SizeChanged += (_, _) => ResizeLog();
            ResizeLog();
            PositionStatusLabel();
            PositionStatusBadge();
        }

        // ── Pulse animation ────────────────────────────────────────────────

        private void OnPulseTick(object? sender, EventArgs e)
        {
            if (!_isRunning) return;
            _pulseAlpha += _pulseUp ? 0.06f : -0.06f;
            if (_pulseAlpha >= 1.0f) { _pulseAlpha = 1.0f; _pulseUp = false; }
            if (_pulseAlpha <= 0.35f) { _pulseAlpha = 0.35f; _pulseUp = true; }
            _dotPanel?.Invalidate();
        }

        // ── Layout helpers ─────────────────────────────────────────────────

        private int EffectiveFlowWidth()
        {
            int w = _logPanel.ClientSize.Width
                  - SystemInformation.VerticalScrollBarWidth
                  - _logFlow.Padding.Horizontal;
            return w > 0 ? w : Math.Max(ClientSize.Width - 64, 200);
        }

        private void UpdateFlowWidth()
        {
            int w = EffectiveFlowWidth();
            _logFlow.Width = w + _logFlow.Padding.Horizontal;
            foreach (Control c in _logFlow.Controls)
            {
                if (c is SectionCard sc)
                    sc.UpdateWidth(w);
                else if (c is CollapsibleEntryPanel ep)
                    ep.Width = w;
            }
        }

        private void ResizeLog()
        {
            if (Controls.Count < 2) return;
            var header   = Controls[0] as Panel;
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
                _statusBadgePanel.Location =
                    new Point(header.Width - _statusBadgePanel.Width - 20, 24);
        }

        private void PositionStatusLabel()
        {
            int right = _bottomPanel.ClientSize.Width - 14;
            _statusLabel.Location = new Point(
                right - _statusLabel.Width,
                (_bottomPanel.Height - _statusLabel.Height) / 2);
        }

        // ── Public API (may be called from background thread) ──────────────

        public void SetInitialRequest(string text)
        {
            InvokeIfNeeded(() =>
            {
                var section = EnsureSection(ref _requestSection,
                    "Your Request", NordColors.AccentBlue,
                    WinIcons.QuoteIcon(12, NordColors.AccentBlue));

                section.AddItem(new EntryCard(
                    text, NordColors.PrimaryText,
                    new Font("Consolas", 10),
                    NordColors.AccentBlue,
                    NordColors.BlueSectionFill,
                    NordColors.BlueSectionBorder,
                    section.ItemWidth));
            });
        }

        public void AppendAgentMessage(string text)
        {
            InvokeIfNeeded(() =>
            {
                var section = EnsureSection(ref _reasoningSection,
                    "Agent Reasoning", NordColors.AccentPurple,
                    WinIcons.BrainIcon(12, NordColors.AccentPurple));

                _stepCount++;
                section.AddItem(new StepRow(
                    _stepCount, text.Trim(),
                    NordColors.AccentPurple,
                    NordColors.PurpleSectionFill,
                    NordColors.PurpleSectionBorder,
                    section.ItemWidth));

                ScrollToBottom();
            });
        }

        public void AppendWebCall(string text)
        {
            InvokeIfNeeded(() =>
            {
                var section = EnsureSection(ref _webSection,
                    "Web Searches", NordColors.Accent,
                    WinIcons.Globe(12, NordColors.Accent));

                section.AddItem(new EntryCard(
                    StripWebPrefix(text),
                    NordColors.PrimaryText,
                    new Font("Consolas", 10),
                    NordColors.Accent,
                    NordColors.BlueSectionFill,
                    NordColors.BlueSectionBorder,
                    section.ItemWidth));

                ScrollToBottom();
            });
        }

        public void AppendTerminalOutput(string text)
        {
            InvokeIfNeeded(() =>
            {
                var section = EnsureSection(ref _terminalSection,
                    "Terminal Output", NordColors.AccentAmber,
                    WinIcons.TerminalIcon(12, NordColors.AccentAmber));

                var lines  = text.Split('\n', 2);
                string header = FormatTerminalHeader(lines.Length > 0 ? lines[0] : text);
                string body   = lines.Length > 1 ? lines[1].TrimEnd() : "";

                section.AddItem(new TerminalRow(
                    header, body,
                    NordColors.AccentAmber,
                    NordColors.AmberSectionFill,
                    NordColors.AmberSectionBorder,
                    section.ItemWidth));

                ScrollToBottom();
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
                    _statusLabel.ForeColor = NordColors.Accent;
                    _badgeLabel.Text       = "Running";
                    _badgeLabel.ForeColor  = NordColors.Accent;
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

        // ── Private helpers ────────────────────────────────────────────────

        private SectionCard EnsureSection(
            ref SectionCard? field, string title, Color accent, Bitmap icon)
        {
            if (field != null) return field;
            field = new SectionCard(title, accent, icon, EffectiveFlowWidth());
            _logFlow.Controls.Add(field);
            return field;
        }

        private void ScrollToBottom()
            => _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);

        private void InvokeIfNeeded(Action action)
        {
            if (InvokeRequired) Invoke(action);
            else action();
        }

        /// <summary>
        /// Strips [web_search], [web_call], [web] prefixes from the raw server content.
        /// </summary>
        private static string StripWebPrefix(string text)
        {
            string t = text.Trim();
            foreach (string prefix in new[] { "[web_search]", "[web_call]", "[web]" })
            {
                if (t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    t = t[prefix.Length..].TrimStart();
                    break;
                }
            }
            return t;
        }

        /// <summary>
        /// Converts "[terminal success]" → "Terminal: success" etc.
        /// </summary>
        private static string FormatTerminalHeader(string raw)
        {
            string t = raw.Trim().TrimStart('[').TrimEnd(']');
            if (t.StartsWith("terminal ", StringComparison.OrdinalIgnoreCase))
                t = "Terminal: " + t["terminal ".Length..];
            return t;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _pulseTimer.Stop();
            _pulseTimer.Dispose();
            CancellationSource.Cancel();
            base.OnFormClosed(e);
        }

        // ── SectionCard ────────────────────────────────────────────────────
        // Mirrors macOS sectionCard() — icon + title header, then stacked item rows.

        private sealed class SectionCard : Panel
        {
            private const int HeaderH  = 28;
            private const int GapTop   =  6;
            private const int GapItem  =  6;
            private const int GapBot   =  4;

            private readonly string _title;
            private readonly Color  _accent;
            private readonly Bitmap _icon;
            private readonly List<Panel> _items = new();
            private int _nextY;

            /// <summary>Width available for items inside this card.</summary>
            internal int ItemWidth => Width;

            internal SectionCard(string title, Color accent, Bitmap icon, int width)
            {
                _title  = title;
                _accent = accent;
                _icon   = icon;
                Width   = width;
                Height  = HeaderH + GapTop + GapBot;
                _nextY  = HeaderH + GapTop;

                BackColor = NordColors.EditorBackground;
                AutoSize  = false;
                Margin    = new Padding(0, 8, 0, 4);

                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer |
                         ControlStyles.ResizeRedraw, true);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                var g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;

                // Icon (12×12, vertically centred in header row)
                if (_icon != null)
                {
                    int iy = (HeaderH - 12) / 2;
                    g.DrawImage(_icon, 0, iy, 12, 12);
                }

                // Title in SecondaryText, semibold — matches macOS secondaryText
                TextRenderer.DrawText(g, _title,
                    new Font("Segoe UI", 10f, FontStyle.Bold),
                    new Rectangle(17, 0, Width - 20, HeaderH),
                    NordColors.SecondaryText,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            }

            internal void AddItem(Panel item)
            {
                item.Location = new Point(0, _nextY);
                item.Width    = Width;
                _items.Add(item);
                Controls.Add(item);

                _nextY += item.Height + GapItem;
                Height  = _nextY - GapItem + GapBot;

                item.SizeChanged += (_, _) => ReLayout();
            }

            internal void UpdateWidth(int width)
            {
                if (Width == width) return;
                Width = width;
                foreach (var item in _items)
                    item.Width = width;
                Invalidate();
            }

            private void ReLayout()
            {
                int y = HeaderH + GapTop;
                foreach (var item in _items)
                {
                    item.Location = new Point(0, y);
                    y += item.Height + GapItem;
                }
                _nextY = y;
                Height = Math.Max(y - GapItem + GapBot, HeaderH + GapBot);
            }
        }

        // ── EntryCard ──────────────────────────────────────────────────────
        // Rounded-rect panel (fill + border) wrapping a CollapsibleEntryPanel.
        // Mirrors macOS: .padding(8).background(RoundedRectangle.fill).overlay(strokeBorder).

        private sealed class EntryCard : Panel
        {
            private const int Pad = 8;
            private readonly CollapsibleEntryPanel _content;
            private readonly Color _fill;
            private readonly Color _border;

            internal EntryCard(
                string text, Color textColor, Font font, Color accentColor,
                Color fillColor, Color borderColor, int width)
            {
                _fill   = fillColor;
                _border = borderColor;
                Width   = width;
                BackColor = fillColor;
                Margin    = new Padding(0, 0, 0, 0);

                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer |
                         ControlStyles.ResizeRedraw, true);

                _content = new CollapsibleEntryPanel(
                    text, textColor, font, accentColor,
                    Math.Max(width - Pad * 2, 40));
                _content.Location  = new Point(Pad, Pad);
                _content.BackColor = fillColor;
                Controls.Add(_content);

                _content.SizeChanged += (_, _) => Height = _content.Height + Pad * 2;
                Height = _content.Height + Pad * 2;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var pen = new Pen(_border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, pen,
                    new RectangleF(0, 0, Width - 1, Height - 1), 6);
            }

            protected override void OnSizeChanged(EventArgs e)
            {
                base.OnSizeChanged(e);
                int innerW = Math.Max(Width - Pad * 2, 40);
                _content.Width    = innerW;
                _content.Location = new Point(Pad, Pad);
            }
        }

        // ── StepRow ────────────────────────────────────────────────────────
        // Numbered step badge on the left + EntryCard on the right.
        // Mirrors macOS HStack with the step index badge and CollapsibleText card.

        private sealed class StepRow : Panel
        {
            private const int BadgeSize = 20;
            private const int Gap       = 8;

            private readonly Panel     _badge;
            private readonly EntryCard _card;
            private readonly int       _step;
            private readonly Color     _accent;
            private readonly Color     _fill;
            private readonly Color     _border;

            internal StepRow(
                int step, string text,
                Color accent, Color fillColor, Color borderColor, int width)
            {
                _step   = step;
                _accent = accent;
                _fill   = fillColor;
                _border = borderColor;
                Width     = width;
                BackColor = NordColors.EditorBackground;

                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer |
                         ControlStyles.ResizeRedraw, true);

                // Step badge
                _badge = new DoubleBufferedPanel
                {
                    Size      = new Size(BadgeSize, BadgeSize),
                    BackColor = fillColor,
                    Location  = new Point(0, 0)
                };
                _badge.Paint += (_, e) =>
                {
                    var g = e.Graphics;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using var brush = new SolidBrush(_fill);
                    using var pen   = new Pen(_border, 1);
                    GfxHelpers.FillRoundedRect(g, brush,
                        new RectangleF(0, 0, BadgeSize - 1, BadgeSize - 1), 5);
                    GfxHelpers.DrawRoundedRect(g, pen,
                        new RectangleF(0, 0, BadgeSize - 1, BadgeSize - 1), 5);
                    TextRenderer.DrawText(g, _step.ToString(),
                        new Font("Segoe UI", 8.5f, FontStyle.Bold),
                        new Rectangle(0, 0, BadgeSize, BadgeSize),
                        _accent,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                };
                Controls.Add(_badge);

                int cardWidth = Math.Max(width - BadgeSize - Gap, 40);
                _card = new EntryCard(
                    text, NordColors.PrimaryText,
                    new Font("Consolas", 10),
                    accent, fillColor, borderColor, cardWidth);
                _card.Location = new Point(BadgeSize + Gap, 0);
                Controls.Add(_card);

                _card.SizeChanged += (_, _) =>
                {
                    Height = Math.Max(BadgeSize, _card.Height);
                    // Centre badge vertically relative to the card
                    _badge.Location = new Point(0, (_card.Height - BadgeSize) / 2);
                };
                Height = Math.Max(BadgeSize, _card.Height);
            }

            protected override void OnSizeChanged(EventArgs e)
            {
                base.OnSizeChanged(e);
                int cardWidth = Math.Max(Width - BadgeSize - Gap, 40);
                _card.Width = cardWidth;
            }
        }

        // ── TerminalRow ────────────────────────────────────────────────────
        // Status header label (amber) + optional body EntryCard below.
        // Mirrors macOS VStack with header Text + CollapsibleText body card.

        private sealed class TerminalRow : Panel
        {
            private const int Gap = 4;
            private readonly Label      _header;
            private readonly EntryCard? _body;

            internal TerminalRow(
                string headerText, string bodyText,
                Color accent, Color fillColor, Color borderColor, int width)
            {
                Width     = width;
                BackColor = NordColors.EditorBackground;

                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer |
                         ControlStyles.ResizeRedraw, true);

                _header = new Label
                {
                    Text      = headerText,
                    Font      = new Font("Segoe UI", 10f, FontStyle.Bold),
                    ForeColor = accent,
                    AutoSize  = true,
                    Location  = new Point(0, 0),
                    BackColor = Color.Transparent
                };
                Controls.Add(_header);

                int totalH = _header.PreferredHeight;

                if (!string.IsNullOrWhiteSpace(bodyText))
                {
                    _body = new EntryCard(
                        bodyText, NordColors.PrimaryText,
                        new Font("Consolas", 10),
                        accent, fillColor, borderColor,
                        width);
                    _body.Location = new Point(0, _header.PreferredHeight + Gap);
                    Controls.Add(_body);

                    _body.SizeChanged += (_, _) =>
                        Height = _header.PreferredHeight + Gap + _body.Height;

                    totalH += Gap + _body.Height;
                }

                Height = totalH;
            }

            protected override void OnSizeChanged(EventArgs e)
            {
                base.OnSizeChanged(e);
                if (_body != null)
                    _body.Width = Width;
            }
        }

        // ── DoubleBufferedPanel ────────────────────────────────────────────
        // Thin Panel subclass that enables double-buffering via SetStyle (which
        // is protected on Control and cannot be called on an external instance).

        private sealed class DoubleBufferedPanel : Panel
        {
            internal DoubleBufferedPanel()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer, true);
            }
        }

        // ── CollapsibleEntryPanel ──────────────────────────────────────────
        // Shows a RichTextBox preview with an optional "Show more / Show less" link.
        // Preview = 60 words (matches macOS previewWordCount = 60).

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
                BackColor = Color.Transparent;
                Margin    = new Padding(0);
                AutoSize  = false;
                Width     = width;

                var words    = text.Split(new[] { ' ', '\t', '\n', '\r' },
                                   StringSplitOptions.RemoveEmptyEntries);
                _fullText    = text;
                _isLong      = words.Length > CollapseWordThreshold;
                _previewText = _isLong
                    ? string.Join(" ", words.Take(PreviewWordCount)) + "\u2026"
                    : text;
                _expanded = false;

                _rtb = new RichTextBox
                {
                    BackColor   = Color.Transparent,
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
                    int wordCount = words.Length;
                    _toggleLink = new LinkLabel
                    {
                        Text      = $"Show more ({wordCount} words)",
                        Font      = new Font("Segoe UI", 8.5f),
                        LinkColor = linkColor,
                        AutoSize  = true,
                        Location  = new Point(0, _rtb.Bottom + 2),
                    };
                    _toggleLink.LinkClicked += (_, _) => Toggle(wordCount);
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

            private void Toggle(int wordCount)
            {
                _expanded         = !_expanded;
                _rtb.Text         = _expanded ? _fullText : _previewText;
                _toggleLink!.Text = _expanded
                    ? "Show less"
                    : $"Show more ({wordCount} words)";
            }

            protected override void OnSizeChanged(EventArgs e)
            {
                base.OnSizeChanged(e);
                LayoutControls();
            }
        }
    }
}
