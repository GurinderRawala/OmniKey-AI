using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentThinkingForm : Form, IAgentSession
    {
        private readonly Panel           _logPanel;
        private readonly FlowLayoutPanel _logFlow;
        private readonly Label           _statusLabel;
        private readonly Button          _cancelButton;
        private readonly Panel           _bottomPanel;

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
            Size            = new Size(780, 640);
            MinimumSize     = new Size(620, 500);
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.Sizable;

            // ── Log area ─────────────────────────────────────────────────
            var logSurround = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Dock      = DockStyle.Fill,
                Padding   = new Padding(0),
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
                BackColor     = NordColors.EditorBackground,
                Padding       = new Padding(12, 20, 12, 16),
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
            Controls.Add(logSurround);

            // ── Pulse animation ───────────────────────────────────────────
            _pulseTimer = new System.Windows.Forms.Timer { Interval = 50 };
            _pulseTimer.Tick += OnPulseTick;
            _pulseTimer.Start();

            PositionStatusLabel();
        }

        // ── Pulse animation ────────────────────────────────────────────────

        private void OnPulseTick(object? sender, EventArgs e)
        {
            if (!_isRunning) return;
            _pulseAlpha += _pulseUp ? 0.06f : -0.06f;
            if (_pulseAlpha >= 1.0f) { _pulseAlpha = 1.0f; _pulseUp = false; }
            if (_pulseAlpha <= 0.35f) { _pulseAlpha = 0.35f; _pulseUp = true; }
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
            // WinForms resets AutoScrollPosition during a layout pass triggered by
            // a resize. Save and restore it so the view doesn't jump to the top.
            var savedScroll = new Point(
                Math.Abs(_logPanel.AutoScrollPosition.X),
                Math.Abs(_logPanel.AutoScrollPosition.Y));

            int w = EffectiveFlowWidth();
            _logFlow.Width = w + _logFlow.Padding.Horizontal;
            foreach (Control c in _logFlow.Controls)
            {
                if (c is SectionCard sc)
                    sc.UpdateWidth(w);
            }
            RefreshFlowHeight();

            _logPanel.AutoScrollPosition = savedScroll;
        }

        private void RefreshFlowHeight()
        {
            int h = _logFlow.GetPreferredSize(new Size(_logFlow.Width, 0)).Height;
            // GetPreferredSize omits Padding.Bottom in some WinForms builds.
            // Adding it explicitly (plus a 32px buffer) guarantees clearance below the last item.
            _logFlow.Height = h + _logFlow.Padding.Bottom + 32;
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
                RefreshFlowHeight();
                ScrollToBottom();
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
                    _pulseAlpha = 1f;
                    _pulseUp    = false;
                }
                else
                {
                    _statusLabel.Text      = "Finished";
                    _statusLabel.ForeColor = NordColors.AccentGreen;
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
            // RTB.ContentsResized fires after the initial render, cascading:
            // RTB → EntryCard → SectionCard.ReLayout().
            // Refresh the flow height and, if already at the bottom, scroll
            // so the newly revealed content stays in view.
            field.SizeChanged += (_, _) =>
            {
                RefreshFlowHeight();
                if (!IsHandleCreated) return;
                BeginInvoke(new Action(() =>
                {
                    // Only follow the scroll if we're already at the bottom
                    // so that a mid-list resize doesn't hijack the scroll position.
                    var vs = _logPanel.VerticalScroll;
                    bool atBottom = !vs.Visible
                                 || vs.Value >= vs.Maximum - vs.LargeChange - 20;
                    if (atBottom)
                    {
                        RefreshFlowHeight();
                        _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
                    }
                }));
            };
            _logFlow.Controls.Add(field);
            return field;
        }

        private void ScrollToBottom()
        {
            RefreshFlowHeight();
            // Defer the actual scroll one message-pump cycle so that any pending
            // ContentsResized / layout events finish before we set the position.
            if (!IsHandleCreated) return;
            BeginInvoke(new Action(() =>
            {
                RefreshFlowHeight();
                _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
            }));
        }

        private void InvokeIfNeeded(Action action)
        {
            if (!IsHandleCreated) return;
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
        // Rounded-rect panel with an inner RichTextBox capped at MaxTextH px.
        // Text that would exceed the cap is pre-truncated with an ellipsis.

        private sealed class EntryCard : Panel
        {
            private const int Pad      = 8;
            private const int MaxTextH = 150;

            private readonly RichTextBox _rtb;
            private readonly Color       _border;
            private readonly string      _fullText;
            private readonly Font        _font;
            private bool                 _applying;

            internal EntryCard(
                string text, Color textColor, Font font, Color accentColor,
                Color fillColor, Color borderColor, int width)
            {
                _ = accentColor; // no longer used
                _border   = borderColor;
                _fullText = text;
                _font     = font;
                Width     = width;
                BackColor = fillColor;
                Margin    = new Padding(0);

                SetStyle(ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.OptimizedDoubleBuffer |
                         ControlStyles.ResizeRedraw, true);

                _rtb = new RichTextBox
                {
                    BackColor   = fillColor,
                    ForeColor   = textColor,
                    Font        = font,
                    BorderStyle = BorderStyle.None,
                    ReadOnly    = true,
                    WordWrap    = true,
                    ScrollBars  = RichTextBoxScrollBars.None,
                    Location    = new Point(Pad, Pad),
                    Width       = Math.Max(width - Pad * 2, 40),
                    Height      = 20,
                };
                _rtb.ContentsResized += (_, e) =>
                {
                    _rtb.Height = e.NewRectangle.Height + 4;
                    Height      = _rtb.Height + Pad * 2;
                };
                Controls.Add(_rtb);

                ApplyText(Math.Max(width - Pad * 2, 40));
            }

            private void ApplyText(int innerW)
            {
                if (_applying) return;
                _applying = true;
                _rtb.Text = TruncateToHeight(_fullText, _font, innerW);
                _applying = false;
            }

            // Uses GDI+ MeasureString to binary-search the longest prefix of
            // `text` whose rendered height fits within MaxTextH, then appends "…".
            private static string TruncateToHeight(string text, Font font, int width)
            {
                if (string.IsNullOrEmpty(text)) return text;
                using var g = Graphics.FromHwnd(IntPtr.Zero);
                if (g.MeasureString(text, font, width).Height <= MaxTextH) return text;
                int lo = 0, hi = text.Length;
                while (lo < hi - 1)
                {
                    int mid = (lo + hi) / 2;
                    if (g.MeasureString(text[..mid] + "\u2026", font, width).Height <= MaxTextH)
                        lo = mid;
                    else
                        hi = mid;
                }
                return text[..lo] + "\u2026";
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
                if (_rtb == null || _applying) return;
                int innerW = Math.Max(Width - Pad * 2, 40);
                if (_rtb.Width == innerW) return; // height-only change — skip
                _rtb.Width    = innerW;
                _rtb.Location = new Point(Pad, Pad);
                ApplyText(innerW);
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
                if (_card == null) return;
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

    }
}
