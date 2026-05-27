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
        private readonly Button          _historyButton;
        private readonly Panel           _bottomPanel;

        // Pulsing animation
        private readonly System.Windows.Forms.Timer _pulseTimer;
        private float _pulseAlpha = 1f;
        private bool  _pulseUp    = false;

        private bool _isRunning   = false;
        private int  _stepCount   = 0;
        private bool _allowClose  = false;

        // Sequential section tracking — new SectionCard is created when the type changes.
        private SectionCard? _requestSection;   // singleton, only one request per session
        private SectionCard? _currentSection;
        private string       _currentSectionType = "";

        public CancellationTokenSource CancellationSource { get; } = new();

        public AgentThinkingForm()
        {
            Text            = "OmniAgent Session - OmniKey AI";
            Size            = new Size(780, 640);
            MinimumSize     = new Size(620, 500);
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.Sizable;

            // ── Log area ──────────────────────────────────────────────────
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

            _cancelButton = UIStyles.MakeDangerButton(
                "  Cancel",
                new Size(100, 32),
                WinIcons.StopSquare(12, NordColors.ErrorRed));
            _cancelButton.Location = new Point(122, 10);
            _cancelButton.Visible = false;
            _cancelButton.Click += (_, _) =>
            {
                AgentRunner.CancelCurrentSession();
                CancellationSource.Cancel();
                SetRunning(false);
            };

            _historyButton = UIStyles.MakeSecondaryButton(
                "  History",
                new Size(104, 32),
                WinIcons.ClockIcon(12, NordColors.SecondaryText));
            _historyButton.Location = new Point(14, 10);
            _historyButton.Click += async (_, _) =>
            {
                _historyButton.Enabled = false;
                try   { await AgentSessionService.ShowSessionSettingsAsync(this); }
                catch { }
                finally
                {
                    if (!IsDisposed && IsHandleCreated)
                        _historyButton.Enabled = true;
                }
            };

            _statusLabel = new Label
            {
                Text      = "",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.Accent,
                AutoSize  = true,
                Visible   = false,
                Anchor    = AnchorStyles.Right | AnchorStyles.Top
            };

            _bottomPanel.Controls.Add(_cancelButton);
            _bottomPanel.Controls.Add(_historyButton);
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
            // Directly sum children rather than using GetPreferredSize, which can
            // return a stale value when ContentsResized fires during layout.
            // The trailing slack guarantees the last item stays fully scrollable
            // even when async RTB content resizing lags behind the height calc.
            int h = _logFlow.Padding.Top;
            foreach (Control c in _logFlow.Controls)
                h += c.Height + c.Margin.Vertical;
            h += _logFlow.Padding.Bottom + 140;
            if (_logFlow.Height != h)
                _logFlow.Height = h;
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
                var section = EnsureRequestSection();
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
                var section = GetOrNewSection("reasoning",
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
                var section = GetOrNewSection("web",
                    "Web Search", NordColors.Accent,
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

        public void AppendMcpCall(string text)
        {
            InvokeIfNeeded(() =>
            {
                var section = GetOrNewSection("mcp",
                    "MCP Tool Call", NordColors.AccentGreen,
                    WinIcons.ServerIcon(12, NordColors.AccentGreen));

                section.AddItem(new EntryCard(
                    text,
                    NordColors.PrimaryText,
                    new Font("Consolas", 10),
                    NordColors.AccentGreen,
                    NordColors.GreenSectionFill,
                    NordColors.GreenSectionBorder,
                    section.ItemWidth));
                ScrollToBottom();
            });
        }

        public void AppendTerminalOutput(string text)
        {
            InvokeIfNeeded(() =>
            {
                // Terminal output always starts a new section to pair with the
                // preceding agent reasoning that triggered the script.
                var section = GetOrNewSection("terminal",
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
                _statusLabel.Visible  = true;

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

        /// <summary>
        /// Called by HotkeyForm once the final answer is known.
        /// Shows the response in the log with a copy button in the section header.
        /// </summary>
        internal void SetFinalAnswer(string text)
        {
            InvokeIfNeeded(() =>
            {
                // Break any open sequential section so the final response card
                // always appears as a fresh block at the bottom.
                _currentSection     = null;
                _currentSectionType = "";

                // Final response section — copy button lives in the header (top-right)
                var section = new SectionCard(
                    "Final Response", NordColors.AccentGreen,
                    WinIcons.Checkmark(12, NordColors.AccentGreen),
                    EffectiveFlowWidth());
                section.AddHeaderButton(CreateCopyButton(text));
                WireFinalSection(section);
                _logFlow.Controls.Add(section);

                section.AddItem(new EntryCard(
                    text, NordColors.PrimaryText,
                    new Font("Segoe UI", 10),
                    NordColors.AccentGreen,
                    NordColors.GreenSectionFill,
                    NordColors.GreenSectionBorder,
                    section.ItemWidth,
                    maxTextH: 4000));

                RefreshFlowHeight();
                ScrollToBottom();

                // Deferred scroll: ContentsResized can fire after the initial layout,
                // so force a second scroll 400 ms later to reach the true bottom.
                var t = new System.Windows.Forms.Timer { Interval = 400 };
                t.Tick += (_, _) =>
                {
                    t.Stop(); t.Dispose();
                    if (IsHandleCreated && !IsDisposed)
                    {
                        RefreshFlowHeight();
                        _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
                    }
                };
                t.Start();
            });
        }

        /// <summary>
        /// Called by HotkeyForm when resuming an existing session.
        /// Displays the last assistant reply from that session so the user
        /// can see (and copy) what the agent answered previously.
        /// </summary>
        internal void SetSessionHistory(IList<SessionHistoryEntryDto> history)
        {
            InvokeIfNeeded(() =>
            {
                string? lastAnswer = null;
                for (int i = history.Count - 1; i >= 0; i--)
                {
                    if (string.Equals(history[i].Role, "assistant", StringComparison.OrdinalIgnoreCase) &&
                        !string.IsNullOrWhiteSpace(history[i].Text))
                    {
                        lastAnswer = history[i].Text.Trim();
                        break;
                    }
                }

                if (lastAnswer == null) return;

                var section = new SectionCard(
                    "Previous Session",
                    NordColors.AccentPurple,
                    WinIcons.ClockIcon(12, NordColors.AccentPurple),
                    EffectiveFlowWidth());
                section.AddHeaderButton(CreateCopyButton(lastAnswer));
                WireSection(section);
                _logFlow.Controls.Add(section);

                section.AddItem(new EntryCard(
                    lastAnswer, NordColors.PrimaryText,
                    new Font("Segoe UI", 10),
                    NordColors.AccentPurple,
                    NordColors.PurpleSectionFill,
                    NordColors.PurpleSectionBorder,
                    section.ItemWidth,
                    maxTextH: 4000));

                RefreshFlowHeight();
            });
        }

        // ── Private helpers ────────────────────────────────────────────────

        private SectionCard EnsureRequestSection()
        {
            if (_requestSection != null) return _requestSection;
            _requestSection = new SectionCard(
                "Your Request", NordColors.AccentBlue,
                WinIcons.QuoteIcon(12, NordColors.AccentBlue),
                EffectiveFlowWidth());
            WireSection(_requestSection);
            _logFlow.Controls.Add(_requestSection);
            return _requestSection;
        }

        /// <summary>
        /// Returns the current open section if it matches <paramref name="type"/>;
        /// otherwise closes the old one and starts a fresh section card.
        /// This gives sequential "script sent → output received" grouping
        /// instead of batching all messages of the same type together.
        /// </summary>
        private SectionCard GetOrNewSection(string type, string title, Color accent, Bitmap icon)
        {
            if (_currentSection != null && _currentSectionType == type)
                return _currentSection;

            // Reset per-section step counter whenever a new reasoning block begins
            if (type == "reasoning")
                _stepCount = 0;

            var section = new SectionCard(title, accent, icon, EffectiveFlowWidth());
            WireSection(section);
            _logFlow.Controls.Add(section);
            _currentSection     = section;
            _currentSectionType = type;
            return section;
        }

        private Button CreateCopyButton(string textToCopy)
        {
            var btn = UIStyles.MakeIconButton(
                WinIcons.ClipboardIcon(12, NordColors.SecondaryText),
                new Size(26, 20),
                toolTip: "Copy");
            btn.Click += async (_, _) =>
            {
                btn.Image    = WinIcons.Checkmark(12, NordColors.AccentGreen);
                btn.ForeColor = NordColors.AccentGreen;
                try { Clipboard.SetText(textToCopy); } catch { }
                await System.Threading.Tasks.Task.Delay(2000);
                if (!btn.IsDisposed && btn.IsHandleCreated)
                {
                    btn.Image    = WinIcons.ClipboardIcon(12, NordColors.SecondaryText);
                    btn.ForeColor = NordColors.SecondaryText;
                }
            };
            return btn;
        }

        private void WireSection(SectionCard section)
        {
            section.SizeChanged += (_, _) =>
            {
                RefreshFlowHeight();
                if (!IsHandleCreated) return;
                BeginInvoke(new Action(() =>
                {
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
        }

        // Like WireSection but always scrolls to bottom — used for the final response
        // section so it's always fully visible regardless of current scroll position.
        private void WireFinalSection(SectionCard section)
        {
            section.SizeChanged += (_, _) =>
            {
                RefreshFlowHeight();
                if (!IsHandleCreated) return;
                BeginInvoke(new Action(() =>
                {
                    RefreshFlowHeight();
                    _logPanel.AutoScrollPosition = new Point(0, _logFlow.Height);
                }));
            };
        }

        private void ScrollToBottom()
        {
            RefreshFlowHeight();
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

        private static string FormatTerminalHeader(string raw)
        {
            string t = raw.Trim().TrimStart('[').TrimEnd(']');
            if (t.StartsWith("terminal ", StringComparison.OrdinalIgnoreCase))
                t = "Terminal: " + t["terminal ".Length..];
            return t;
        }

        // Called by HotkeyForm when a new session starts, so the old window is
        // truly closed rather than just hidden.
        internal void ForceClose()
        {
            _allowClose = true;
            Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // When the user clicks X, hide instead of dispose so the content
            // (thinking steps, final answer, _finalAnswer field) is preserved.
            // The tray "OmniAgent Session" item can then re-show the window.
            if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _pulseTimer.Stop();
            _pulseTimer.Dispose();
            CancellationSource.Cancel();
            base.OnFormClosed(e);
        }

        // ── SectionCard ────────────────────────────────────────────────────

        private sealed class SectionCard : Panel
        {
            private const int HeaderH = 28;
            private const int GapTop  =  6;
            private const int GapItem =  6;
            private const int GapBot  =  4;

            private readonly string      _title;
            private readonly Color       _accent;
            private readonly Bitmap      _icon;
            private readonly List<Panel> _items = new();
            private Button?              _headerButton;
            private int _nextY;

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

            // Places a small icon button in the top-right corner of the section header.
            internal void AddHeaderButton(Button btn)
            {
                _headerButton = btn;
                btn.Location = new Point(Width - btn.Width - 4, (HeaderH - btn.Height) / 2);
                btn.Anchor   = AnchorStyles.Top | AnchorStyles.Right;
                Controls.Add(btn);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                var g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;

                if (_icon != null)
                {
                    int iy = (HeaderH - 12) / 2;
                    g.DrawImage(_icon, 0, iy, 12, 12);
                }

                int titleWidth = _headerButton != null
                    ? Width - (_headerButton.Width + 12) - 17
                    : Width - 20;
                TextRenderer.DrawText(g, _title,
                    new Font("Segoe UI", 10f, FontStyle.Bold),
                    new Rectangle(17, 0, titleWidth, HeaderH),
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
                if (_headerButton != null)
                    _headerButton.Location = new Point(width - _headerButton.Width - 4, _headerButton.Location.Y);
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

        private sealed class EntryCard : Panel
        {
            private const int Pad = 8;

            private readonly RichTextBox _rtb;
            private readonly Color       _border;
            private readonly string      _fullText;
            private readonly Font        _font;
            private readonly int         _maxTextH;
            private bool                 _applying;

            internal EntryCard(
                string text, Color textColor, Font font, Color accentColor,
                Color fillColor, Color borderColor, int width, int maxTextH = 150)
            {
                _ = accentColor;
                _border   = borderColor;
                _fullText = text;
                _font     = font;
                _maxTextH = maxTextH;
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
                _rtb.Text = TruncateToHeight(_fullText, _font, innerW, _maxTextH);
                _applying = false;
            }

            private static string TruncateToHeight(string text, Font font, int width, int maxH)
            {
                if (string.IsNullOrEmpty(text)) return text;
                using var g = Graphics.FromHwnd(IntPtr.Zero);
                if (g.MeasureString(text, font, width).Height <= maxH) return text;
                int lo = 0, hi = text.Length;
                while (lo < hi - 1)
                {
                    int mid = (lo + hi) / 2;
                    if (g.MeasureString(text[..mid] + "…", font, width).Height <= maxH)
                        lo = mid;
                    else
                        hi = mid;
                }
                return text[..lo] + "…";
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
                if (_rtb.Width == innerW) return;
                _rtb.Width    = innerW;
                _rtb.Location = new Point(Pad, Pad);
                ApplyText(innerW);
            }
        }

        // ── StepRow ────────────────────────────────────────────────────────

        private sealed class StepRow : Panel
        {
            private const int BadgeSize = 20;
            private const int Gap       =  8;

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
                        accent, fillColor, borderColor, width);
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
                if (_body != null) _body.Width = Width;
            }
        }

        // ── DoubleBufferedPanel ────────────────────────────────────────────

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
