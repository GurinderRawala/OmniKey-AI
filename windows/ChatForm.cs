using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Text;
using System.Windows.Forms;
using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    internal sealed class ChatForm : Form, IAgentSession
    {
        private const int SidebarExpandedWidth = 240;
        private const int SidebarCollapsedWidth = 56;
        private const int ConversationMaxWidth = 820;
        private const int ComposerMaxWidth = 820;
        private const string RegistrySubKey = @"SOFTWARE\OmniKeyAI";
        private const string SidebarCollapsedValueName = "ChatSidebarCollapsed";

        private readonly ChatModel _model = ChatModel.Shared;

        // Sidebar
        private Panel _sidebar = null!;
        private Panel _sidebarHeader = null!;
        private Label _sidebarTitle = null!;
        private TextBox _searchBox = null!;
        private Panel _searchBoxHost = null!;
        private FlowLayoutPanel _sessionList = null!;
        private GhostButton _newChatButton = null!;
        private GhostButton _collapseButton = null!;

        // Header
        private Panel _header = null!;
        private GhostButton _headerSidebarToggle = null!;
        private Label _titleLabel = null!;
        private RunningPill _runningPill = null!;
        private StopPill _stopPill = null!;

        // Body
        private Panel _contentHost = null!;
        private Panel _messageScroll = null!;
        private FlowLayoutPanel _messageFlow = null!;
        private Panel _landingPanel = null!;
        private ErrorBanner _errorBanner = null!;

        // Composer
        private Panel _composerOuter = null!;
        private RoundedPanel _composerCard = null!;
        private TextBox _inputBox = null!;
        private SeparatorLine _composerDivider = null!;
        private Panel _composerFooter = null!;
        private TemplatePillButton _templatePill = null!;
        private ContextWindowIndicator _contextIndicator = null!;
        private CircleButton _sendButton = null!;

        private readonly Timer _pulseTimer;
        private bool _sidebarCollapsed;
        private bool _syncingInput;
        private bool _composerFocused;

        public ChatForm()
        {
            Text = "OmniAgent Chat - OmniKey AI";
            Size = new Size(1080, 740);
            MinimumSize = new Size(880, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = NordColors.WindowBackground;
            DoubleBuffered = true;
            Icon = UIStyles.AppIcon;

            _model.BindToCurrentThread();
            _model.StateChanged += OnModelStateChanged;

            _sidebarCollapsed = ReadSidebarCollapsed();

            _sidebar = BuildSidebar();
            Controls.Add(_sidebar);

            var body = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.EditorBackground,
            };
            Controls.Add(body);

            _header = BuildHeader();
            _composerOuter = BuildComposer();
            _contentHost = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.EditorBackground,
            };

            _messageFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                BackColor = NordColors.EditorBackground,
                Padding = new Padding(0, 14, 0, 22),
            };

            _messageScroll = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.EditorBackground,
                AutoScroll = true,
            };
            _messageScroll.Controls.Add(_messageFlow);
            _messageScroll.SizeChanged += (_, _) =>
            {
                UpdateMessageFlowWidth();
                RenderMessages();
            };

            _landingPanel = BuildLandingPanel();

            _contentHost.Controls.Add(_messageScroll);
            _contentHost.Controls.Add(_landingPanel);

            _errorBanner = new ErrorBanner();
            _errorBanner.Dismissed += (_, _) => _model.DismissError();

            // Add in order: header(Top), errorBanner(Top), composer(Bottom), content(Fill).
            // Reverse-Z dock layout places earlier-added Top controls farther from edge,
            // so header(0) sits below errorBanner(1) WITHOUT BringToFront, but we want
            // header at the very top — add header LAST among Top entries.
            body.Controls.Add(_composerOuter);
            body.Controls.Add(_contentHost);
            body.Controls.Add(_errorBanner);
            body.Controls.Add(_header);

            _pulseTimer = new Timer { Interval = 50 };
            _pulseTimer.Tick += (_, _) => _runningPill.Tick();
            _pulseTimer.Start();

            ApplySidebarState();
            body.Layout += (_, _) =>
            {
                LayoutHeader();
                LayoutComposer();
                LayoutLanding();
            };

            Shown += (_, _) =>
            {
                _model.RefreshSessions();
                _model.FetchDefaultTaskTemplate();
                RenderAll();
            };

            FormClosed += (_, _) =>
            {
                _pulseTimer.Stop();
                _pulseTimer.Dispose();
                _model.StateChanged -= OnModelStateChanged;
            };
        }

        // ─── Sidebar ────────────────────────────────────────────────────

        private Panel BuildSidebar()
        {
            var sidebar = new Panel
            {
                Dock = DockStyle.Left,
                Width = _sidebarCollapsed ? SidebarCollapsedWidth : SidebarExpandedWidth,
                BackColor = NordColors.PanelBackground,
            };
            sidebar.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
            };

            _sidebarHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 52,
                BackColor = NordColors.PanelBackground,
            };

            _sidebarTitle = new Label
            {
                Text = "OmniAgent",
                AutoSize = false,
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                TextAlign = ContentAlignment.MiddleLeft,
            };

            _newChatButton = MakeGhostIconButton(WinIcons.SquareAndPencil, "New chat");
            _newChatButton.Click += (_, _) => _model.StartNewChat();

            _collapseButton = MakeGhostIconButton(WinIcons.SidebarLeft, "Collapse sidebar");
            _collapseButton.Click += (_, _) =>
            {
                _sidebarCollapsed = !_sidebarCollapsed;
                WriteSidebarCollapsed(_sidebarCollapsed);
                ApplySidebarState();
            };

            _sidebarHeader.Controls.Add(_sidebarTitle);
            _sidebarHeader.Controls.Add(_newChatButton);
            _sidebarHeader.Controls.Add(_collapseButton);
            _sidebarHeader.SizeChanged += (_, _) => LayoutSidebarHeader();

            // Search bar: padded outer host + a single rounded inner panel
            _searchBoxHost = new Panel
            {
                Dock = DockStyle.Top,
                Height = 44,
                Padding = new Padding(10, 6, 10, 10),
                BackColor = NordColors.PanelBackground,
            };
            var searchInner = new RoundedPanel
            {
                Dock = DockStyle.Fill,
                FillColor = NordColors.BadgeBackground,
                BorderColor = NordColors.Border,
                Radius = 7,
                Padding = new Padding(10, 5, 8, 5),
                BackColor = NordColors.PanelBackground,
            };

            var searchIcon = new PictureBox
            {
                Image = WinIcons.MagnifyingGlass(11, NordColors.SecondaryText),
                SizeMode = PictureBoxSizeMode.CenterImage,
                Size = new Size(18, 22),
                Dock = DockStyle.Left,
                BackColor = Color.Transparent,
            };

            _searchBox = new TextBox
            {
                Dock = DockStyle.Fill,
                BorderStyle = BorderStyle.None,
                PlaceholderText = "Search chats",
                BackColor = NordColors.BadgeBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Segoe UI", 9),
            };
            _searchBox.TextChanged += (_, _) =>
            {
                if (_model.SessionSearchQuery != _searchBox.Text)
                    _model.SessionSearchQuery = _searchBox.Text;
            };
            _searchBox.KeyDown += (_, e) =>
            {
                if (e.KeyCode == Keys.Escape)
                {
                    _model.ClearSessionSearch();
                    e.SuppressKeyPress = true;
                }
            };

            searchInner.Controls.Add(_searchBox);
            searchInner.Controls.Add(searchIcon);
            _searchBoxHost.Controls.Add(searchInner);

            _sessionList = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                BackColor = NordColors.PanelBackground,
                Padding = new Padding(0, 6, 0, 16),
            };

            // Add in reverse order so dock places header at top, search below, list fills.
            sidebar.Controls.Add(_sessionList);
            sidebar.Controls.Add(_searchBoxHost);
            sidebar.Controls.Add(_sidebarHeader);

            return sidebar;
        }

        private GhostButton MakeGhostIconButton(Func<int, Color, Bitmap> glyph, string toolTip)
        {
            var button = new GhostButton
            {
                Image = glyph(13, NordColors.SecondaryText),
                Size = new Size(28, 28),
            };
            var tip = new ToolTip();
            tip.SetToolTip(button, toolTip);
            return button;
        }

        // ─── Header ─────────────────────────────────────────────────────

        private Panel BuildHeader()
        {
            var header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 56,
                BackColor = NordColors.EditorBackground,
            };
            header.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
            };

            _headerSidebarToggle = MakeGhostIconButton(WinIcons.SidebarLeft, "Toggle sidebar");
            _headerSidebarToggle.Size = new Size(30, 30);
            _headerSidebarToggle.Click += (_, _) =>
            {
                _sidebarCollapsed = !_sidebarCollapsed;
                WriteSidebarCollapsed(_sidebarCollapsed);
                ApplySidebarState();
            };

            _titleLabel = new Label
            {
                AutoSize = false,
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = Color.Transparent,
                TextAlign = ContentAlignment.MiddleLeft,
            };

            _runningPill = new RunningPill { Visible = false };
            _stopPill = new StopPill { Visible = false };
            _stopPill.Click += (_, _) => _model.CancelCurrentTurn();

            header.Controls.Add(_headerSidebarToggle);
            header.Controls.Add(_titleLabel);
            header.Controls.Add(_runningPill);
            header.Controls.Add(_stopPill);
            header.SizeChanged += (_, _) => LayoutHeader();
            return header;
        }

        // ─── Composer ───────────────────────────────────────────────────

        private Panel BuildComposer()
        {
            var outer = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 122,
                BackColor = NordColors.EditorBackground,
                Padding = new Padding(22, 12, 22, 14),
            };

            _composerCard = new RoundedPanel
            {
                FillColor = NordColors.EditorBackground,
                BorderColor = NordColors.Border,
                Radius = 14,
                BackColor = NordColors.EditorBackground,
            };
            outer.Controls.Add(_composerCard);

            _inputBox = new TextBox
            {
                BorderStyle = BorderStyle.None,
                Multiline = true,
                AcceptsReturn = true,
                AcceptsTab = false,
                ScrollBars = ScrollBars.Vertical,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Segoe UI", 10),
                PlaceholderText = "Ask OmniAgent anything…",
            };
            _inputBox.TextChanged += (_, _) =>
            {
                if (_syncingInput) return;
                _model.InputText = _inputBox.Text;
                UpdateSendButton();
            };
            _inputBox.KeyDown += OnInputKeyDown;
            _inputBox.GotFocus += (_, _) => { _composerFocused = true; UpdateComposerFocusVisual(); };
            _inputBox.LostFocus += (_, _) => { _composerFocused = false; UpdateComposerFocusVisual(); };
            _composerCard.Controls.Add(_inputBox);

            _composerDivider = new SeparatorLine
            {
                BackColor = NordColors.EditorBackground,
            };
            _composerCard.Controls.Add(_composerDivider);

            _composerFooter = new Panel { BackColor = NordColors.EditorBackground };
            _composerCard.Controls.Add(_composerFooter);

            _templatePill = new TemplatePillButton();
            _templatePill.Clicked += OnTemplatePillClicked;
            _composerFooter.Controls.Add(_templatePill);

            _contextIndicator = new ContextWindowIndicator
            {
                BackColor = NordColors.EditorBackground,
                Size = new Size(18, 18),
            };
            _composerFooter.Controls.Add(_contextIndicator);

            _sendButton = new CircleButton
            {
                Size = new Size(30, 30),
                Image = WinIcons.ArrowUp(13, Color.White),
            };
            _sendButton.Click += (_, _) => SendOrStop();
            _composerFooter.Controls.Add(_sendButton);

            outer.SizeChanged += (_, _) => LayoutComposer();
            _composerCard.SizeChanged += (_, _) => LayoutComposerCard();
            return outer;
        }

        private void UpdateComposerFocusVisual()
        {
            _composerCard.BorderColor = _composerFocused
                ? BlendColor(NordColors.Accent, NordColors.EditorBackground, 0.55f)
                : NordColors.Border;
            _composerCard.Invalidate();
        }

        private void OnTemplatePillClicked(object? sender, EventArgs e)
        {
            if (_model.IsUpdatingDefaultTaskTemplate) return;

            var menu = new ContextMenuStrip
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
                ShowImageMargin = false,
                Renderer = new ToolStripProfessionalRenderer(new DarkMenuColors()),
            };

            string? currentId = _model.DefaultTaskTemplate?.Id;
            foreach (var template in _model.AvailableTaskTemplates)
            {
                var item = menu.Items.Add(template.Heading);
                item.ForeColor = NordColors.PrimaryText;
                if (template.Id == currentId)
                    item.Font = new Font(item.Font, FontStyle.Bold);
                item.Click += (_, _) => _model.SetDefaultTaskTemplate(template.Id);
            }
            if (_model.AvailableTaskTemplates.Count > 0)
                menu.Items.Add(new ToolStripSeparator());

            var none = menu.Items.Add("No instruction");
            none.ForeColor = NordColors.SecondaryText;
            none.Click += (_, _) => _model.SetDefaultTaskTemplate(null);

            menu.Show(_templatePill, new Point(0, -menu.PreferredSize.Height));
        }

        // ─── Landing ────────────────────────────────────────────────────

        private Panel BuildLandingPanel()
        {
            var landing = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.EditorBackground,
            };

            var sparkle = new PictureBox
            {
                Image = WinIcons.Sparkles(28, NordColors.AccentPurple),
                SizeMode = PictureBoxSizeMode.CenterImage,
                Size = new Size(40, 40),
                BackColor = NordColors.EditorBackground,
                Name = "sparkle",
            };

            var title = new Label
            {
                Name = "title",
                Text = "What can I help with?",
                AutoSize = false,
                Font = new Font("Segoe UI", 18, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.EditorBackground,
                TextAlign = ContentAlignment.MiddleCenter,
            };

            var mcpTile = new FeatureTile(
                "MCP Servers",
                "Connect external tools and APIs via Model Context Protocol",
                WinIcons.ServerRack(15, NordColors.Accent));
            mcpTile.Name = "mcp";
            mcpTile.Click += (_, _) => new MCPServersForm().Show(this);

            var jobsTile = new FeatureTile(
                "Scheduled Jobs",
                "Run agent tasks automatically on a recurring schedule",
                WinIcons.CalendarBadgeClock(15, NordColors.Accent));
            jobsTile.Name = "jobs";
            jobsTile.Click += (_, _) => new ScheduledJobsForm().Show(this);

            var taskTile = new FeatureTile(
                "Task Instructions",
                "Configure default agent instructions for new chats",
                WinIcons.TextBadgeStar(15, NordColors.AccentPurple));
            taskTile.Name = "task";
            taskTile.Click += (_, _) => new TaskInstructionsForm().Show(this);

            landing.Controls.Add(sparkle);
            landing.Controls.Add(title);
            landing.Controls.Add(taskTile);
            landing.Controls.Add(mcpTile);
            landing.Controls.Add(jobsTile);
            landing.SizeChanged += (_, _) => LayoutLanding();
            return landing;
        }

        // ─── Rendering ──────────────────────────────────────────────────

        private void OnModelStateChanged(object? sender, EventArgs e)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action(RenderAll));
                return;
            }

            RenderAll();
        }

        private void RenderAll()
        {
            _titleLabel.Text = _model.ActiveSessionTitle;
            _runningPill.Visible = _model.IsRunning;
            _stopPill.Visible = _model.IsRunning;

            _errorBanner.Message = _model.LastErrorMessage ?? "";
            _errorBanner.Visible = !string.IsNullOrWhiteSpace(_model.LastErrorMessage);

            if (_searchBox.Text != _model.SessionSearchQuery)
                _searchBox.Text = _model.SessionSearchQuery;

            _syncingInput = true;
            if (_inputBox.Text != _model.InputText)
                _inputBox.Text = _model.InputText;
            _syncingInput = false;

            UpdateTemplatePill();
            RenderSidebarSessions();
            RenderMessages();
            UpdateSendButton();
            UpdateContextIndicator();
            LayoutHeader();
            LayoutComposer();
        }

        private void RenderSidebarSessions()
        {
            _sessionList.SuspendLayout();
            _sessionList.Controls.Clear();

            if (_sidebarCollapsed)
            {
                RenderCollapsedRail();
                _sessionList.ResumeLayout();
                return;
            }

            var sessions = _model.FilteredSessions;
            int rowWidth = Math.Max(80, _sessionList.ClientSize.Width - 4);

            if (sessions.Count == 0)
            {
                _sessionList.Controls.Add(new Label
                {
                    Text = _model.IsSessionSearchActive ? "No matches" : "No chats yet",
                    AutoSize = false,
                    Size = new Size(rowWidth, 28),
                    ForeColor = NordColors.SecondaryText,
                    BackColor = NordColors.PanelBackground,
                    TextAlign = ContentAlignment.MiddleLeft,
                    Font = new Font("Segoe UI", 9),
                    Margin = new Padding(12, 16, 0, 0),
                });
                _sessionList.ResumeLayout();
                return;
            }

            foreach (var session in sessions)
                _sessionList.Controls.Add(new SessionRow(session, _model, rowWidth));

            _sessionList.ResumeLayout();
        }

        private void RenderCollapsedRail()
        {
            int width = Math.Max(36, _sessionList.ClientSize.Width - 4);

            var newChatBtn = new GhostButton
            {
                Image = WinIcons.SquareAndPencil(15, NordColors.Accent),
                Size = new Size(36, 36),
                Margin = new Padding((width - 36) / 2, 8, 0, 4),
            };
            newChatBtn.HoverFill = BlendColor(NordColors.Accent, NordColors.PanelBackground, 0.10f);
            newChatBtn.Click += (_, _) => _model.StartNewChat();
            _sessionList.Controls.Add(newChatBtn);

            var divider = new Panel
            {
                Width = width - 16,
                Height = 1,
                BackColor = NordColors.Border,
                Margin = new Padding(8, 8, 0, 10),
            };
            _sessionList.Controls.Add(divider);

            foreach (var session in _model.Sessions.Take(12))
            {
                var dot = new SessionDot(session, _model)
                {
                    Margin = new Padding((width - 34) / 2, 0, 0, 6),
                };
                _sessionList.Controls.Add(dot);
            }
        }

        private void RenderMessages()
        {
            bool landing = _model.ActiveSessionId == null
                && _model.Messages.Count == 0
                && !_model.IsLoadingSessionHistory
                && !_model.IsRunning;
            _landingPanel.Visible = landing;
            _messageScroll.Visible = !landing;

            if (landing)
            {
                LayoutLanding();
                return;
            }

            int width = EffectiveConversationWidth();
            _messageFlow.SuspendLayout();
            _messageFlow.Controls.Clear();

            if (_model.IsLoadingSessionHistory && _model.Messages.Count == 0)
                _messageFlow.Controls.Add(CreateNotice("Opening chat…", width));
            else if (_model.TrimmedOlderMessageCount > 0)
                _messageFlow.Controls.Add(CreateTrimmedNotice(width));

            if (!_model.IsLoadingSessionHistory && _model.Messages.Count == 0 && _model.ActiveSessionId != null)
                _messageFlow.Controls.Add(CreateNotice("No messages in this chat yet.", width));

            foreach (var message in _model.Messages)
            {
                Control row = message.Role switch
                {
                    ChatMessageRole.User => CreateUserMessageRow(message, width),
                    ChatMessageRole.Assistant => CreateAssistantMessageRow(message, width),
                    _ => CreateNotice(message.Text, width),
                };
                _messageFlow.Controls.Add(row);
            }

            _messageFlow.ResumeLayout();
            ScrollTranscriptToBottom();
        }

        private Control CreateNotice(string text, int width)
        {
            return new Label
            {
                Text = text,
                AutoSize = false,
                Size = new Size(width, 36),
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.EditorBackground,
                Margin = new Padding(0, 0, 0, 8),
            };
        }

        private Control CreateTrimmedNotice(int width)
        {
            var pill = new RoundedPanel
            {
                FillColor = NordColors.BadgeBackground,
                BorderColor = NordColors.Border,
                Radius = 999,
                AutoSize = true,
                Padding = new Padding(12, 5, 12, 5),
                Margin = new Padding(0, 4, 0, 12),
                BackColor = NordColors.EditorBackground,
            };
            var label = new Label
            {
                AutoSize = true,
                Text = $"Showing the latest {ChatModel.MaxVisibleMessages} of {ChatModel.MaxVisibleMessages + _model.TrimmedOlderMessageCount} messages",
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                BackColor = Color.Transparent,
                Margin = Padding.Empty,
            };
            pill.Controls.Add(label);

            // Wrap in a row that centers the pill.
            var row = new TableLayoutPanel
            {
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 3,
                RowCount = 1,
                BackColor = NordColors.EditorBackground,
                Width = width,
                Margin = new Padding(0, 0, 0, 6),
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            row.Controls.Add(new Panel { Dock = DockStyle.Fill, BackColor = NordColors.EditorBackground }, 0, 0);
            row.Controls.Add(pill, 1, 0);
            row.Controls.Add(new Panel { Dock = DockStyle.Fill, BackColor = NordColors.EditorBackground }, 2, 0);
            return row;
        }

        private Control CreateUserMessageRow(ChatMessage message, int width)
        {
            // Tinted accent bubble, right-aligned, max 560 wide.
            int bubbleMax = Math.Max(220, Math.Min(560, (int)(width * 0.78)));

            var label = new Label
            {
                Text = message.Text,
                AutoSize = true,
                MaximumSize = new Size(bubbleMax - 28, 0),
                Font = new Font("Segoe UI", 10),
                ForeColor = NordColors.PrimaryText,
                BackColor = Color.Transparent,
                Margin = Padding.Empty,
            };

            Color fill = NordColors.IsDarkMode
                ? BlendColor(NordColors.Accent, NordColors.WindowBackground, 0.20f)
                : BlendColor(NordColors.Accent, NordColors.WindowBackground, 0.11f);
            Color border = NordColors.IsDarkMode
                ? BlendColor(NordColors.Accent, NordColors.WindowBackground, 0.34f)
                : BlendColor(NordColors.Accent, NordColors.WindowBackground, 0.24f);

            var bubble = new RoundedPanel
            {
                AutoSize = true,
                Padding = new Padding(14, 10, 14, 10),
                FillColor = fill,
                BorderColor = border,
                Radius = 14,
                Margin = Padding.Empty,
                BackColor = NordColors.EditorBackground,
            };
            bubble.Controls.Add(label);

            var row = new TableLayoutPanel
            {
                Width = width,
                MinimumSize = new Size(width, 0),
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                ColumnCount = 2,
                RowCount = 1,
                BackColor = NordColors.EditorBackground,
                Margin = new Padding(0, 6, 0, 12),
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            row.Controls.Add(new Panel { Dock = DockStyle.Fill, BackColor = NordColors.EditorBackground }, 0, 0);
            row.Controls.Add(bubble, 1, 0);
            return row;
        }

        private Control CreateAssistantMessageRow(ChatMessage message, int width)
        {
            var container = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Width = width,
                MinimumSize = new Size(width, 0),
                BackColor = NordColors.EditorBackground,
                Margin = new Padding(0, 4, 0, 16),
            };

            var thinking = message.Blocks.Where(b => b.Kind != ChatBlockKind.FinalAnswer).ToList();
            var finals = message.Blocks.Where(b => b.Kind == ChatBlockKind.FinalAnswer).ToList();

            bool isStreaming = _model.IsRunning && ReferenceEquals(_model.Messages.LastOrDefault(), message);

            if (message.Blocks.Count == 0 && _model.IsRunning)
            {
                container.Controls.Add(CreateTypingDots(width));
            }
            else
            {
                if (thinking.Count > 0)
                    container.Controls.Add(new ThinkingSection(thinking, isStreaming, width));

                foreach (var block in finals)
                    container.Controls.Add(CreateFinalAnswerView(block.Text, width));
            }

            return container;
        }

        private Control CreateTypingDots(int width)
        {
            var panel = new Panel
            {
                Width = width,
                Height = 28,
                BackColor = NordColors.EditorBackground,
                Margin = new Padding(0, 4, 0, 4),
            };
            var dots = new TypingDots
            {
                Location = new Point(2, 4),
                Size = new Size(70, 20),
            };
            panel.Controls.Add(dots);
            return panel;
        }

        private Control CreateFinalAnswerView(string markdown, int width)
        {
            Color paperFill = NordColors.IsDarkMode
                ? Color.FromArgb(50, 50, 54)
                : Color.FromArgb(252, 252, 254);

            var paper = new RoundedPanel
            {
                Width = width,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                MinimumSize = new Size(width, 0),
                Padding = new Padding(16, 14, 16, 14),
                FillColor = paperFill,
                BorderColor = NordColors.Border,
                Radius = 12,
                Margin = new Padding(0, 0, 0, 4),
                BackColor = NordColors.EditorBackground,
            };

            var markdownPanel = CreateMarkdownPanel(markdown, width - 32);
            markdownPanel.Dock = DockStyle.Top;
            markdownPanel.Margin = Padding.Empty;
            paper.Controls.Add(markdownPanel);
            return paper;
        }

        private static readonly MarkdownPipeline MarkdownPipeline = new MarkdownPipelineBuilder()
            .UsePipeTables()
            .UseAutoLinks()
            .UseEmphasisExtras()
            .Build();

        private FlowLayoutPanel CreateMarkdownPanel(string markdown, int width)
        {
            var panel = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Width = width,
                BackColor = Color.Transparent,
            };

            MarkdownDocument doc;
            try { doc = Markdown.Parse(markdown ?? "", MarkdownPipeline); }
            catch { doc = new MarkdownDocument(); }

            foreach (var block in doc)
            {
                var rendered = RenderMarkdownBlock(block, width);
                if (rendered != null) panel.Controls.Add(rendered);
            }

            return panel;
        }

        private Control? RenderMarkdownBlock(Block block, int width)
        {
            switch (block)
            {
                case HeadingBlock h:
                    return RenderHeading(h, width);
                case ParagraphBlock p:
                    return RenderParagraph(p, width);
                case FencedCodeBlock fc:
                    return new CodeBlockView(fc.Lines.ToString(), fc.Info ?? "", width);
                case CodeBlock cb:
                    return new CodeBlockView(cb.Lines.ToString(), "", width);
                case ListBlock lb:
                    return RenderList(lb, width);
                case QuoteBlock qb:
                    return RenderQuote(qb, width);
                case ThematicBreakBlock _:
                    return new SeparatorLine { Width = width, Height = 14, Margin = new Padding(0, 4, 0, 8) };
                case Table tb:
                    return RenderTable(tb, width);
                default:
                    return null;
            }
        }

        private Control RenderHeading(HeadingBlock h, int width)
        {
            string text = InlineToPlainText(h.Inline);
            float size = h.Level switch { 1 => 15f, 2 => 13f, 3 => 11.5f, _ => 10.5f };
            var label = CreateWrappedLabel(text, new Font("Segoe UI", size, FontStyle.Bold), NordColors.PrimaryText, width);
            label.Margin = new Padding(0, h.Level <= 2 ? 6 : 2, 0, 4);
            return label;
        }

        private Control RenderParagraph(ParagraphBlock p, int width)
        {
            string text = InlineToPlainText(p.Inline);
            return CreateWrappedLabel(text, new Font("Segoe UI", 10), NordColors.PrimaryText, width);
        }

        private Control RenderList(ListBlock lb, int width)
        {
            var container = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Width = width,
                BackColor = Color.Transparent,
                Margin = new Padding(0, 2, 0, 6),
            };

            int ordinal = 1;
            foreach (var child in lb)
            {
                if (child is not ListItemBlock item) continue;
                string marker = lb.IsOrdered ? $"{ordinal}." : "•";
                container.Controls.Add(RenderListItem(item, marker, width));
                ordinal++;
            }
            return container;
        }

        private Control RenderListItem(ListItemBlock item, string marker, int width)
        {
            // Two-column layout: marker (auto) + content (fill).
            int markerWidth = 24;
            var row = new TableLayoutPanel
            {
                ColumnCount = 2,
                RowCount = 1,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Width = width,
                BackColor = Color.Transparent,
                Margin = new Padding(0, 1, 0, 1),
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, markerWidth));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

            var markerLabel = new Label
            {
                Text = marker,
                AutoSize = false,
                Size = new Size(markerWidth, 22),
                Font = new Font("Segoe UI", 10),
                ForeColor = NordColors.SecondaryText,
                BackColor = Color.Transparent,
                TextAlign = ContentAlignment.TopLeft,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
            };
            row.Controls.Add(markerLabel, 0, 0);

            var contentPanel = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                BackColor = Color.Transparent,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
            };
            int contentWidth = Math.Max(40, width - markerWidth - 4);
            foreach (var child in item)
            {
                var rendered = RenderMarkdownBlock(child, contentWidth);
                if (rendered != null) contentPanel.Controls.Add(rendered);
            }
            row.Controls.Add(contentPanel, 1, 0);
            return row;
        }

        private Control RenderQuote(QuoteBlock qb, int width)
        {
            var quote = new RoundedPanel
            {
                Width = width,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(12, 8, 12, 8),
                FillColor = NordColors.BadgeBackground,
                BorderColor = NordColors.Border,
                Radius = 6,
                Margin = new Padding(0, 4, 0, 6),
                BackColor = Color.Transparent,
            };

            var inner = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                BackColor = Color.Transparent,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                Dock = DockStyle.Top,
            };
            int innerW = width - 24;
            foreach (var child in qb)
            {
                if (child is ParagraphBlock p)
                {
                    string text = InlineToPlainText(p.Inline);
                    inner.Controls.Add(CreateWrappedLabel(text, new Font("Segoe UI", 9, FontStyle.Italic), NordColors.SecondaryText, innerW));
                }
                else
                {
                    var rendered = RenderMarkdownBlock(child, innerW);
                    if (rendered != null) inner.Controls.Add(rendered);
                }
            }
            quote.Controls.Add(inner);
            return quote;
        }

        private Control RenderTable(Table tb, int width)
        {
            var rows = new List<List<string>>();
            var header = new List<string>();
            int columnCount = 0;

            foreach (var block in tb)
            {
                if (block is not TableRow row) continue;
                var cells = new List<string>();
                foreach (var cellBlock in row)
                {
                    if (cellBlock is TableCell cell)
                    {
                        var sb = new StringBuilder();
                        foreach (var inner in cell)
                            if (inner is ParagraphBlock p) sb.Append(InlineToPlainText(p.Inline));
                        cells.Add(sb.ToString());
                    }
                }
                if (cells.Count > columnCount) columnCount = cells.Count;
                if (row.IsHeader && header.Count == 0) header = cells;
                else rows.Add(cells);
            }

            if (columnCount == 0)
                return new Label { Text = "", AutoSize = true };

            var table = new TableLayoutPanel
            {
                ColumnCount = columnCount,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                CellBorderStyle = TableLayoutPanelCellBorderStyle.Single,
                BackColor = NordColors.PanelBackground,
                Margin = new Padding(0, 4, 0, 8),
                Padding = Padding.Empty,
            };
            for (int c = 0; c < columnCount; c++)
                table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f / columnCount));

            void AddRow(List<string> cells, bool isHeader)
            {
                table.RowCount++;
                table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                for (int i = 0; i < columnCount; i++)
                {
                    var cellText = i < cells.Count ? cells[i] : "";
                    var label = new Label
                    {
                        Text = cellText,
                        AutoSize = false,
                        Dock = DockStyle.Fill,
                        Font = new Font("Segoe UI", isHeader ? 9 : 9, isHeader ? FontStyle.Bold : FontStyle.Regular),
                        ForeColor = isHeader ? NordColors.PrimaryText : NordColors.SecondaryText,
                        BackColor = isHeader ? NordColors.BadgeBackground : NordColors.PanelBackground,
                        Padding = new Padding(8, 6, 8, 6),
                        TextAlign = ContentAlignment.MiddleLeft,
                        AutoEllipsis = false,
                        UseCompatibleTextRendering = false,
                        MinimumSize = new Size(0, 28),
                    };
                    table.Controls.Add(label, i, table.RowCount - 1);
                }
            }

            if (header.Count > 0) AddRow(header, true);
            foreach (var r in rows) AddRow(r, false);
            return table;
        }

        private static string InlineToPlainText(ContainerInline? container)
        {
            if (container == null) return "";
            var sb = new StringBuilder();
            AppendInline(container, sb);
            return sb.ToString();
        }

        private static void AppendInline(ContainerInline container, StringBuilder sb)
        {
            foreach (var inline in container)
            {
                switch (inline)
                {
                    case LiteralInline lit:
                        sb.Append(lit.Content.ToString());
                        break;
                    case CodeInline code:
                        sb.Append(code.Content);
                        break;
                    case LineBreakInline lb:
                        sb.Append(lb.IsHard ? "\n" : " ");
                        break;
                    case AutolinkInline auto:
                        sb.Append(auto.Url);
                        break;
                    case LinkInline link when link.IsImage:
                        // skip the underlying alt; image not rendered.
                        break;
                    case ContainerInline c:
                        AppendInline(c, sb);
                        break;
                }
            }
        }

        private static Label CreateWrappedLabel(string text, Font font, Color color, int width)
        {
            return new Label
            {
                Text = text,
                AutoSize = true,
                MaximumSize = new Size(Math.Max(80, width), 0),
                Font = font,
                ForeColor = color,
                BackColor = Color.Transparent,
                Margin = new Padding(0, 2, 0, 6),
            };
        }

        private void UpdateTemplatePill()
        {
            _templatePill.Heading = _model.DefaultTaskTemplate?.Heading;
            _templatePill.Enabled = !_model.IsUpdatingDefaultTaskTemplate;
        }

        private void UpdateSendButton()
        {
            bool running = _model.IsRunning;
            bool hasInput = !string.IsNullOrWhiteSpace(_model.InputText);

            Color circleFill;
            Color iconColor;
            if (running)
            {
                circleFill = NordColors.ErrorRed;
                iconColor = Color.White;
            }
            else if (!hasInput)
            {
                circleFill = NordColors.Border;
                iconColor = NordColors.SecondaryText;
            }
            else
            {
                circleFill = NordColors.Accent;
                iconColor = Color.White;
            }

            _sendButton.FillColor = circleFill;
            _sendButton.Image = running
                ? WinIcons.StopFill(13, iconColor)
                : WinIcons.ArrowUp(13, iconColor);
            _sendButton.Enabled = running || hasInput;
            _sendButton.Invalidate();
        }

        private void UpdateContextIndicator()
        {
            var session = _model.ActiveSession;
            _contextIndicator.ContextBudget = session?.ContextBudget ?? 0;
            _contextIndicator.RemainingTokens = session?.RemainingContextTokens ?? 0;
            _contextIndicator.Visible = (session?.ContextBudget ?? 0) > 0;
            _contextIndicator.Invalidate();
        }

        private void SendOrStop()
        {
            if (_model.IsRunning)
                _model.CancelCurrentTurn();
            else
                _model.SendCurrentInput();
        }

        private void OnInputKeyDown(object? sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                SendOrStop();
                e.SuppressKeyPress = true;
                return;
            }

            if (e.KeyCode == Keys.Up && _inputBox.SelectionStart == 0 && _inputBox.TextLength == 0)
            {
                if (_model.RecallLastUserMessage())
                    e.SuppressKeyPress = true;
            }
        }

        // ─── Sidebar state + layout ─────────────────────────────────────

        private void ApplySidebarState()
        {
            _sidebar.Width = _sidebarCollapsed ? SidebarCollapsedWidth : SidebarExpandedWidth;
            _sidebarTitle.Visible = !_sidebarCollapsed;
            _searchBoxHost.Visible = !_sidebarCollapsed;
            _newChatButton.Visible = !_sidebarCollapsed;
            _collapseButton.Image = _sidebarCollapsed
                ? WinIcons.SidebarRight(13, NordColors.SecondaryText)
                : WinIcons.SidebarLeft(13, NordColors.SecondaryText);

            // In collapsed mode, hide the sidebar's own collapse button — the
            // header bar toggle is the canonical control. Keep the title hidden.
            _collapseButton.Visible = !_sidebarCollapsed;

            LayoutSidebarHeader();
            RenderSidebarSessions();
        }

        private void LayoutSidebarHeader()
        {
            if (_sidebarCollapsed)
            {
                _sidebarHeader.Height = 0;
                return;
            }

            _sidebarHeader.Height = 52;
            _sidebarTitle.SetBounds(14, 14, Math.Max(0, _sidebarHeader.Width - 76), 24);
            _newChatButton.SetBounds(_sidebarHeader.Width - 64, 12, 28, 28);
            _collapseButton.SetBounds(_sidebarHeader.Width - 34, 12, 28, 28);
        }

        // ─── Header layout ──────────────────────────────────────────────

        private void LayoutHeader()
        {
            int y = (_header.Height - 30) / 2;
            _headerSidebarToggle.SetBounds(14, y, 30, 30);

            int rightX = _header.Width - 18;
            if (_stopPill.Visible)
            {
                _stopPill.SetBounds(rightX - _stopPill.Width, y + 2, _stopPill.Width, _stopPill.Height);
                rightX = _stopPill.Left - 8;
            }
            if (_runningPill.Visible)
            {
                _runningPill.SetBounds(rightX - _runningPill.Width, y + 2, _runningPill.Width, _runningPill.Height);
                rightX = _runningPill.Left - 8;
            }

            int titleLeft = _headerSidebarToggle.Right + 12;
            int titleWidth = Math.Max(60, rightX - titleLeft - 8);
            _titleLabel.SetBounds(titleLeft, y - 1, titleWidth, 32);
        }

        // ─── Composer layout ────────────────────────────────────────────

        private void LayoutComposer()
        {
            int outerW = _composerOuter.ClientSize.Width;
            int outerH = _composerOuter.ClientSize.Height;
            int width = Math.Min(ComposerMaxWidth, Math.Max(360, outerW - _composerOuter.Padding.Horizontal));
            int x = (outerW - width) / 2;
            int h = outerH - _composerOuter.Padding.Vertical;
            _composerCard.SetBounds(x, _composerOuter.Padding.Top, width, h);
            LayoutComposerCard();
        }

        private void LayoutComposerCard()
        {
            int w = _composerCard.Width;
            int h = _composerCard.Height;
            int footerH = 44;
            int dividerY = h - footerH - 1;

            _inputBox.SetBounds(14, 10, w - 28, dividerY - 10);
            _composerDivider.SetBounds(0, dividerY, w, 1);
            _composerFooter.SetBounds(0, dividerY + 1, w, footerH);

            // Footer items: pill on left, send circle on right, indicator inside.
            int footerY = (footerH - 26) / 2;
            _templatePill.SetBounds(12, footerY, Math.Min(220, w - 100), 26);

            int sendY = (footerH - 30) / 2;
            _sendButton.SetBounds(w - 42, sendY, 30, 30);
            _contextIndicator.SetBounds(_sendButton.Left - 24, sendY + 6, 18, 18);
        }

        // ─── Landing layout ─────────────────────────────────────────────

        private void LayoutLanding()
        {
            if (_landingPanel.Controls.Count == 0) return;

            int cw = _landingPanel.ClientSize.Width;
            int ch = _landingPanel.ClientSize.Height;
            int centerX = cw / 2;

            Control sparkle = _landingPanel.Controls["sparkle"]!;
            Control title = _landingPanel.Controls["title"]!;
            Control task = _landingPanel.Controls["task"]!;
            Control mcp = _landingPanel.Controls["mcp"]!;
            Control jobs = _landingPanel.Controls["jobs"]!;

            int tileWidth = 220;
            int tileHeight = 84;
            int tileGap = 12;
            int tilesPerRow = cw < (tileWidth * 3 + tileGap * 2 + 88) ? 2 : 3;
            int tilesRows = (3 + tilesPerRow - 1) / tilesPerRow;
            int tilesBlockHeight = tilesRows * tileHeight + (tilesRows - 1) * tileGap;
            int blockHeight = 40 + 36 + 24 + tilesBlockHeight;
            int top = Math.Max(48, (ch - blockHeight) / 2);

            sparkle.SetBounds(centerX - sparkle.Width / 2, top, 40, 40);
            title.SetBounds(Math.Max(12, centerX - 360), top + 50, Math.Min(720, cw - 24), 30);

            // Tiles row(s)
            Control[] tiles = { task, mcp, jobs };
            int tilesY = top + 50 + 30 + 24;
            for (int i = 0; i < tiles.Length; i++)
            {
                tiles[i].Width = tileWidth;
                tiles[i].Height = tileHeight;
            }

            for (int i = 0; i < tiles.Length; i++)
            {
                int row = i / tilesPerRow;
                int col = i % tilesPerRow;
                int countInRow = Math.Min(tilesPerRow, tiles.Length - row * tilesPerRow);
                int rowWidth = countInRow * tileWidth + (countInRow - 1) * tileGap;
                int rowStart = centerX - rowWidth / 2;
                int x = rowStart + col * (tileWidth + tileGap);
                int y = tilesY + row * (tileHeight + tileGap);
                tiles[i].Location = new Point(x, y);
            }
        }

        private void UpdateMessageFlowWidth()
        {
            int width = EffectiveConversationWidth();
            int x = Math.Max(0, (_messageScroll.ClientSize.Width - width) / 2);
            _messageFlow.Location = new Point(x, 0);
            _messageFlow.Width = width;
        }

        private int EffectiveConversationWidth()
        {
            int scrollAllowance = SystemInformation.VerticalScrollBarWidth + 32;
            return Math.Min(ConversationMaxWidth, Math.Max(320, _messageScroll.ClientSize.Width - scrollAllowance));
        }

        private void ScrollTranscriptToBottom()
        {
            if (!_messageScroll.Visible) return;
            BeginInvoke(new Action(() =>
            {
                if (_messageScroll.IsDisposed) return;
                _messageScroll.AutoScrollPosition = new Point(0, _messageScroll.VerticalScroll.Maximum);
            }));
        }

        // ─── Registry persistence ───────────────────────────────────────

        private static bool ReadSidebarCollapsed()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RegistrySubKey);
                return key?.GetValue(SidebarCollapsedValueName) is int value && value != 0;
            }
            catch
            {
                return false;
            }
        }

        private static void WriteSidebarCollapsed(bool collapsed)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RegistrySubKey);
                key.SetValue(SidebarCollapsedValueName, collapsed ? 1 : 0);
            }
            catch
            {
            }
        }

        public void SetInitialRequest(string text)
        {
            _model.InputText = text;
        }

        public void SetRunning(bool running) { }
        public void AppendAgentMessage(string text) { }
        public void AppendWebCall(string text) { }
        public void AppendMcpCall(string text) { }
        public void AppendTerminalOutput(string text) { }

        internal static Color BlendColor(Color foreground, Color background, float amount)
        {
            amount = Math.Max(0f, Math.Min(1f, amount));
            int r = (int)Math.Round(background.R + (foreground.R - background.R) * amount);
            int g = (int)Math.Round(background.G + (foreground.G - background.G) * amount);
            int b = (int)Math.Round(background.B + (foreground.B - background.B) * amount);
            return Color.FromArgb(r, g, b);
        }

        // ═══════════════════════════════════════════════════════════════
        // Helper controls
        // ═══════════════════════════════════════════════════════════════

        private sealed class RoundedPanel : Panel
        {
            public Color FillColor = NordColors.PanelBackground;
            public Color BorderColor = NordColors.Border;
            public int Radius = 8;

            public RoundedPanel()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint
                       | ControlStyles.OptimizedDoubleBuffer
                       | ControlStyles.UserPaint
                       | ControlStyles.ResizeRedraw
                       | ControlStyles.SupportsTransparentBackColor, true);
                BackColor = Color.Transparent;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.Clear(BackColor);

                using var fill = new SolidBrush(FillColor);
                using var pen = new Pen(BorderColor, 1);
                using var path = GfxHelpers.RoundedPath(
                    new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f),
                    Math.Min(Radius, Math.Min(Width, Height) / 2));
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(pen, path);
            }
        }

        private sealed class SeparatorLine : Control
        {
            public SeparatorLine()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Height = 1;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                using var pen = new Pen(NordColors.Border, 1);
                int y = Height / 2;
                e.Graphics.DrawLine(pen, 0, y, Width, y);
            }
        }

        private sealed class GhostButton : Control, IButtonControl
        {
            public Color HoverFill = NordColors.BadgeBackground;
            public int CornerRadius = 6;

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public Image? Image { get; set; }
            private bool _hovered;
            private bool _pressed;

            public GhostButton()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint
                       | ControlStyles.OptimizedDoubleBuffer
                       | ControlStyles.UserPaint
                       | ControlStyles.ResizeRedraw
                       | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(28, 28);
                Cursor = Cursors.Hand;
                BackColor = Color.Transparent;
            }

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public DialogResult DialogResult { get; set; }
            public void NotifyDefault(bool value) { }
            public void PerformClick() => OnClick(EventArgs.Empty);

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; _pressed = false; Invalidate(); base.OnMouseLeave(e); }
            protected override void OnMouseDown(MouseEventArgs e) { _pressed = true; Invalidate(); base.OnMouseDown(e); }
            protected override void OnMouseUp(MouseEventArgs e) { _pressed = false; Invalidate(); base.OnMouseUp(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                if (_hovered || _pressed)
                {
                    using var fill = new SolidBrush(HoverFill);
                    using var path = GfxHelpers.RoundedPath(new RectangleF(0, 0, Width, Height), CornerRadius);
                    e.Graphics.FillPath(fill, path);
                }
                if (Image != null)
                {
                    int x = (Width - Image.Width) / 2;
                    int y = (Height - Image.Height) / 2;
                    e.Graphics.DrawImage(Image, x, y);
                }
            }
        }

        private sealed class CircleButton : Control, IButtonControl
        {
            public Color FillColor = NordColors.Accent;

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public Image? Image { get; set; }
            private bool _hovered;

            public CircleButton()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint
                       | ControlStyles.OptimizedDoubleBuffer
                       | ControlStyles.UserPaint
                       | ControlStyles.ResizeRedraw
                       | ControlStyles.SupportsTransparentBackColor, true);
                Cursor = Cursors.Hand;
                BackColor = Color.Transparent;
            }

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public DialogResult DialogResult { get; set; }
            public void NotifyDefault(bool value) { }
            public void PerformClick() => OnClick(EventArgs.Empty);

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                var fill = _hovered && Enabled ? BlendColor(Color.White, FillColor, 0.10f) : FillColor;
                using var brush = new SolidBrush(fill);
                e.Graphics.FillEllipse(brush, 0, 0, Width - 1, Height - 1);
                if (Image != null)
                {
                    int x = (Width - Image.Width) / 2;
                    int y = (Height - Image.Height) / 2;
                    e.Graphics.DrawImage(Image, x, y);
                }
            }
        }

        private sealed class RunningPill : Control
        {
            private float _pulse;
            private bool _pulseDown = true;

            public RunningPill()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(96, 26);
                BackColor = Color.Transparent;
                Font = new Font("Segoe UI", 8, FontStyle.Bold);
            }

            public void Tick()
            {
                if (!Visible) return;
                _pulse += _pulseDown ? -0.06f : 0.06f;
                if (_pulse <= 0.4f) { _pulse = 0.4f; _pulseDown = false; }
                if (_pulse >= 1f) { _pulse = 1f; _pulseDown = true; }
                Invalidate();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var bg = new SolidBrush(NordColors.BadgeBackground);
                using var border = new Pen(NordColors.Border, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Height / 2f);
                e.Graphics.FillPath(bg, path);
                e.Graphics.DrawPath(border, path);

                int dotR = 4 + (int)(_pulse * 2);
                int dotX = 10;
                int dotY = (Height - dotR) / 2;
                Color dotColor = NordColors.AccentGreen;
                using var dotBrush = new SolidBrush(Color.FromArgb((int)(_pulse * 255), dotColor));
                e.Graphics.FillEllipse(dotBrush, dotX, dotY, dotR, dotR);
                using var ringPen = new Pen(dotColor, 1.4f);
                e.Graphics.DrawEllipse(ringPen, dotX, dotY, dotR, dotR);

                TextRenderer.DrawText(
                    e.Graphics,
                    "Running",
                    Font,
                    new Rectangle(dotX + dotR + 6, 0, Width - (dotX + dotR + 6) - 8, Height),
                    NordColors.AccentGreen,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
            }
        }

        private sealed class StopPill : Control, IButtonControl
        {
            private bool _hovered;

            public StopPill()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(74, 26);
                BackColor = Color.Transparent;
                Cursor = Cursors.Hand;
                Font = new Font("Segoe UI", 8, FontStyle.Bold);
            }

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public DialogResult DialogResult { get; set; }
            public void NotifyDefault(bool value) { }
            public void PerformClick() => OnClick(EventArgs.Empty);

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color fill = _hovered
                    ? BlendColor(NordColors.ErrorRed, NordColors.RedSectionFill, 0.18f)
                    : NordColors.RedSectionFill;
                using var bg = new SolidBrush(fill);
                using var border = new Pen(NordColors.RedSectionBorder, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Height / 2f);
                e.Graphics.FillPath(bg, path);
                e.Graphics.DrawPath(border, path);

                var icon = WinIcons.StopCircleFill(13, NordColors.ErrorRed);
                e.Graphics.DrawImage(icon, 10, (Height - 13) / 2);

                TextRenderer.DrawText(
                    e.Graphics,
                    "Stop",
                    Font,
                    new Rectangle(28, 0, Width - 32, Height),
                    NordColors.ErrorRed,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
            }
        }

        private sealed class TemplatePillButton : Control, IButtonControl
        {
            public string? Heading;
            public event EventHandler? Clicked;
            private bool _hovered;

            public TemplatePillButton()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(180, 26);
                BackColor = Color.Transparent;
                Cursor = Cursors.Hand;
                Font = new Font("Segoe UI", 8, FontStyle.Bold);
            }

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public DialogResult DialogResult { get; set; }
            public void NotifyDefault(bool value) { }
            public void PerformClick() => Clicked?.Invoke(this, EventArgs.Empty);

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }
            protected override void OnClick(EventArgs e) { Clicked?.Invoke(this, e); base.OnClick(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                bool active = !string.IsNullOrEmpty(Heading);
                Color fill = active
                    ? (NordColors.IsDarkMode
                        ? BlendColor(NordColors.Accent, NordColors.EditorBackground, 0.16f)
                        : BlendColor(NordColors.Accent, NordColors.EditorBackground, 0.09f))
                    : NordColors.BadgeBackground;
                if (_hovered) fill = BlendColor(NordColors.PrimaryText, fill, 0.05f);

                Color border = active
                    ? BlendColor(NordColors.Accent, NordColors.EditorBackground, 0.30f)
                    : NordColors.Border;
                Color textColor = active ? NordColors.Accent : NordColors.SecondaryText;

                using var bg = new SolidBrush(fill);
                using var pen = new Pen(border, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), Height / 2f);
                e.Graphics.FillPath(bg, path);
                e.Graphics.DrawPath(pen, path);

                var starIcon = WinIcons.TextBadgeStar(10, textColor);
                e.Graphics.DrawImage(starIcon, 10, (Height - 10) / 2);

                string label = Heading ?? "No instruction";
                var chevron = WinIcons.ChevronUpChevronDown(9, textColor);
                int chevX = Width - chevron.Width - 10;
                e.Graphics.DrawImage(chevron, chevX, (Height - chevron.Height) / 2);

                TextRenderer.DrawText(
                    e.Graphics,
                    label,
                    Font,
                    new Rectangle(24, 0, chevX - 28, Height),
                    textColor,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            }
        }

        private sealed class ContextWindowIndicator : Control
        {
            public int ContextBudget;
            public int RemainingTokens;

            public ContextWindowIndicator()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(18, 18);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                if (ContextBudget <= 0) return;

                float used = Math.Max(0, Math.Min(1, (ContextBudget - RemainingTokens) / (float)ContextBudget));
                var rect = new RectangleF(2, 2, Width - 4, Height - 4);
                using var border = new Pen(NordColors.Border, 1.6f);
                e.Graphics.DrawEllipse(border, rect);

                Color tint = used < 0.6f
                    ? NordColors.AccentGreen
                    : used < 0.85f ? NordColors.AccentAmber : NordColors.ErrorRed;
                using var arc = new Pen(tint, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
                e.Graphics.DrawArc(arc, rect, -90, 360 * used);
            }
        }

        private sealed class TypingDots : Control
        {
            private int _phase;
            private readonly Timer _timer;

            public TypingDots()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                BackColor = Color.Transparent;
                _timer = new Timer { Interval = 220 };
                _timer.Tick += (_, _) => { _phase = (_phase + 1) % 3; Invalidate(); };
            }

            protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); _timer.Start(); }
            protected override void OnHandleDestroyed(EventArgs e) { _timer.Stop(); _timer.Dispose(); base.OnHandleDestroyed(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                var sparkleIcon = WinIcons.Sparkles(13, NordColors.AccentPurple);
                e.Graphics.DrawImage(sparkleIcon, 0, (Height - 13) / 2);

                int startX = 22;
                int dotSize = 5;
                int gap = 5;
                for (int i = 0; i < 3; i++)
                {
                    float alpha = i == _phase ? 1f : 0.45f;
                    var color = Color.FromArgb((int)(alpha * 200), NordColors.SecondaryText);
                    using var brush = new SolidBrush(color);
                    int x = startX + i * (dotSize + gap);
                    int y = (Height - dotSize) / 2;
                    e.Graphics.FillEllipse(brush, x, y, dotSize, dotSize);
                }
            }
        }

        private sealed class ErrorBanner : Panel
        {
            public event EventHandler? Dismissed;
            private string _message = "";
            private readonly Label _label;
            private readonly GhostButton _dismiss;

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public string Message
            {
                get => _message;
                set { _message = value; _label.Text = value; }
            }

            public ErrorBanner()
            {
                Dock = DockStyle.Top;
                Height = 36;
                BackColor = NordColors.RedSectionFill;
                Visible = false;
                DoubleBuffered = true;

                var iconBox = new PictureBox
                {
                    Image = WinIcons.ExclamationmarkTriangleFill(13, NordColors.ErrorRed),
                    SizeMode = PictureBoxSizeMode.CenterImage,
                    Size = new Size(20, 36),
                    Location = new Point(18, 0),
                    BackColor = Color.Transparent,
                };
                _label = new Label
                {
                    Font = new Font("Segoe UI", 9),
                    ForeColor = NordColors.PrimaryText,
                    BackColor = Color.Transparent,
                    AutoSize = false,
                    TextAlign = ContentAlignment.MiddleLeft,
                };
                _dismiss = new GhostButton
                {
                    Image = WinIcons.Cross(11, NordColors.SecondaryText),
                    Size = new Size(24, 24),
                    HoverFill = BlendColor(NordColors.ErrorRed, NordColors.RedSectionFill, 0.15f),
                };
                _dismiss.Click += (_, _) => Dismissed?.Invoke(this, EventArgs.Empty);

                Controls.Add(_label);
                Controls.Add(iconBox);
                Controls.Add(_dismiss);

                SizeChanged += (_, _) => RelayoutChildren();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                using var pen = new Pen(NordColors.RedSectionBorder, 1);
                e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);
            }

            private void RelayoutChildren()
            {
                _label.SetBounds(44, 0, Math.Max(0, Width - 80), Height);
                _dismiss.SetBounds(Width - 32, 6, 24, 24);
            }
        }

        private sealed class SessionRow : Control
        {
            private readonly AgentSessionInfo _session;
            private readonly ChatModel _model;
            private bool _hovered;
            private readonly GhostButton _delete;

            public SessionRow(AgentSessionInfo session, ChatModel model, int width)
            {
                _session = session;
                _model = model;
                SetStyle(ControlStyles.AllPaintingInWmPaint
                       | ControlStyles.OptimizedDoubleBuffer
                       | ControlStyles.UserPaint
                       | ControlStyles.ResizeRedraw
                       | ControlStyles.SupportsTransparentBackColor, true);
                Width = width;
                Height = 32;
                Margin = new Padding(6, 1, 6, 1);
                Cursor = Cursors.Hand;
                BackColor = Color.Transparent;

                _delete = new GhostButton
                {
                    Image = WinIcons.Cross(10, NordColors.SecondaryText),
                    Size = new Size(20, 20),
                    Visible = false,
                    HoverFill = NordColors.BadgeBackground,
                    Cursor = Cursors.Hand,
                };
                _delete.Click += (_, _) =>
                {
                    if (MessageBox.Show("Delete this chat?", "Delete chat", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                        _model.DeleteSession(_session);
                };
                Controls.Add(_delete);
                SizeChanged += (_, _) => LayoutChildren();
                LayoutChildren();
            }

            private void LayoutChildren()
            {
                _delete.SetBounds(Width - 26, (Height - 20) / 2, 20, 20);
            }

            protected override void OnMouseEnter(EventArgs e)
            {
                _hovered = true;
                _delete.Visible = true;
                Invalidate();
                base.OnMouseEnter(e);
            }

            protected override void OnMouseLeave(EventArgs e)
            {
                if (!ClientRectangle.Contains(PointToClient(Cursor.Position)))
                {
                    _hovered = false;
                    _delete.Visible = false;
                    Invalidate();
                }
                base.OnMouseLeave(e);
            }

            protected override void OnClick(EventArgs e)
            {
                base.OnClick(e);
                // Avoid opening on delete-button click.
                var p = PointToClient(Cursor.Position);
                if (_delete.Visible && _delete.Bounds.Contains(p)) return;
                _model.OpenSession(_session);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                bool active = _session.Id == _model.ActiveSessionId;
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

                if (active || _hovered)
                {
                    Color fill = active
                        ? (NordColors.IsDarkMode
                            ? BlendColor(NordColors.Accent, NordColors.PanelBackground, 0.10f)
                            : BlendColor(NordColors.Accent, NordColors.PanelBackground, 0.07f))
                        : NordColors.BadgeBackground;
                    using var bg = new SolidBrush(fill);
                    using var path = GfxHelpers.RoundedPath(new RectangleF(0, 0, Width - 1, Height - 1), 6);
                    e.Graphics.FillPath(bg, path);
                }

                if (active)
                {
                    using var bar = new SolidBrush(NordColors.Accent);
                    e.Graphics.FillRectangle(bar, 6, 8, 3, Height - 16);
                }

                string title = string.IsNullOrWhiteSpace(_session.Title) ? "Untitled Chat" : _session.Title;
                Color textColor = active ? NordColors.PrimaryText : NordColors.SecondaryText;
                var font = new Font("Segoe UI", 9, active ? FontStyle.Bold : FontStyle.Regular);

                int rightReserved = _delete.Visible ? 30 : 10;
                TextRenderer.DrawText(
                    e.Graphics,
                    title,
                    font,
                    new Rectangle(16, 0, Width - 16 - rightReserved, Height),
                    textColor,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
                font.Dispose();
            }
        }

        private sealed class SessionDot : Control
        {
            private readonly AgentSessionInfo _session;
            private readonly ChatModel _model;
            private bool _hovered;

            public SessionDot(AgentSessionInfo session, ChatModel model)
            {
                _session = session;
                _model = model;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
                Size = new Size(34, 34);
                BackColor = Color.Transparent;
                Cursor = Cursors.Hand;

                var tip = new ToolTip();
                tip.SetToolTip(this, string.IsNullOrWhiteSpace(_session.Title) ? "Untitled Chat" : _session.Title);
            }

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }
            protected override void OnClick(EventArgs e) { base.OnClick(e); _model.OpenSession(_session); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                bool active = _session.Id == _model.ActiveSessionId;

                Color fill = active
                    ? BlendColor(NordColors.Accent, NordColors.PanelBackground, 0.18f)
                    : (_hovered ? NordColors.BadgeBackground : NordColors.PanelBackground);
                Color border = active
                    ? BlendColor(NordColors.Accent, NordColors.PanelBackground, 0.40f)
                    : NordColors.Border;
                Color textColor = active ? NordColors.Accent : NordColors.SecondaryText;

                using var b = new SolidBrush(fill);
                using var pen = new Pen(border, 1);
                var rect = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
                e.Graphics.FillEllipse(b, rect);
                e.Graphics.DrawEllipse(pen, rect);

                string letter = string.IsNullOrWhiteSpace(_session.Title)
                    ? "?"
                    : _session.Title.Substring(0, 1).ToUpper();
                TextRenderer.DrawText(
                    e.Graphics,
                    letter,
                    new Font("Segoe UI", 10, FontStyle.Bold),
                    new Rectangle(0, 0, Width, Height),
                    textColor,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }

        private sealed class FeatureTile : Control, IButtonControl
        {
            private readonly string _title;
            private readonly string _description;
            private readonly Image _icon;
            private bool _hovered;

            public FeatureTile(string title, string description, Image icon)
            {
                _title = title;
                _description = description;
                _icon = icon;
                SetStyle(ControlStyles.AllPaintingInWmPaint
                       | ControlStyles.OptimizedDoubleBuffer
                       | ControlStyles.UserPaint
                       | ControlStyles.ResizeRedraw
                       | ControlStyles.SupportsTransparentBackColor, true);
                BackColor = Color.Transparent;
                Cursor = Cursors.Hand;
                Size = new Size(220, 84);
            }

            [Browsable(false), DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)]
            public DialogResult DialogResult { get; set; }
            public void NotifyDefault(bool value) { }
            public void PerformClick() => OnClick(EventArgs.Empty);

            protected override void OnMouseEnter(EventArgs e) { _hovered = true; Invalidate(); base.OnMouseEnter(e); }
            protected override void OnMouseLeave(EventArgs e) { _hovered = false; Invalidate(); base.OnMouseLeave(e); }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color fill = _hovered ? NordColors.BadgeBackground : NordColors.PanelBackground;
                using var b = new SolidBrush(fill);
                using var pen = new Pen(NordColors.Border, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 10);
                e.Graphics.FillPath(b, path);
                e.Graphics.DrawPath(pen, path);

                e.Graphics.DrawImage(_icon, 13, 13);
                using var titleFont = new Font("Segoe UI", 10, FontStyle.Bold);
                using var descFont = new Font("Segoe UI", 9);
                TextRenderer.DrawText(
                    e.Graphics,
                    _title,
                    titleFont,
                    new Rectangle(38, 10, Width - 50, 22),
                    NordColors.PrimaryText,
                    TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
                TextRenderer.DrawText(
                    e.Graphics,
                    _description,
                    descFont,
                    new Rectangle(38, 32, Width - 50, Height - 38),
                    NordColors.SecondaryText,
                    TextFormatFlags.Left | TextFormatFlags.WordBreak);
            }
        }

        private sealed class ThinkingSection : FlowLayoutPanel
        {
            private readonly List<ChatBlock> _blocks;
            private readonly bool _isStreaming;
            private readonly Panel _headerRow;
            private readonly PictureBox _headerIcon;
            private readonly Label _headerText;
            private readonly PictureBox _chevron;
            private readonly FlowLayoutPanel _body;
            private bool _expanded;

            public ThinkingSection(List<ChatBlock> blocks, bool isStreaming, int width)
            {
                _blocks = blocks;
                _isStreaming = isStreaming;
                FlowDirection = FlowDirection.TopDown;
                WrapContents = false;
                AutoSize = true;
                AutoSizeMode = AutoSizeMode.GrowAndShrink;
                Width = width;
                BackColor = Color.Transparent;
                Margin = new Padding(0, 0, 0, 6);

                _headerRow = new Panel
                {
                    Width = width,
                    Height = 26,
                    Cursor = Cursors.Hand,
                    BackColor = Color.Transparent,
                    Margin = new Padding(0, 0, 0, 2),
                };
                _headerIcon = new PictureBox
                {
                    Size = new Size(13, 13),
                    Location = new Point(0, 7),
                    SizeMode = PictureBoxSizeMode.CenterImage,
                    BackColor = Color.Transparent,
                    Image = isStreaming
                        ? WinIcons.Sparkles(11, NordColors.AccentPurple)
                        : WinIcons.Brain(11, NordColors.SecondaryText),
                };
                _headerText = new Label
                {
                    Text = HeaderText(),
                    AutoSize = true,
                    Location = new Point(20, 5),
                    Font = new Font("Segoe UI", 8, FontStyle.Bold),
                    ForeColor = NordColors.SecondaryText,
                    BackColor = Color.Transparent,
                };
                _chevron = new PictureBox
                {
                    Size = new Size(11, 11),
                    Location = new Point(0, 8),
                    SizeMode = PictureBoxSizeMode.CenterImage,
                    BackColor = Color.Transparent,
                    Image = WinIcons.ChevronDown(9, NordColors.SecondaryText),
                };
                _headerRow.Controls.Add(_headerIcon);
                _headerRow.Controls.Add(_headerText);
                _headerRow.Controls.Add(_chevron);
                _headerRow.Layout += (_, _) => LayoutHeaderRow();

                _body = new FlowLayoutPanel
                {
                    FlowDirection = FlowDirection.TopDown,
                    WrapContents = false,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    Width = width,
                    BackColor = Color.Transparent,
                    Padding = new Padding(2, 4, 0, 4),
                    Visible = false,
                };
                BuildBody(width);

                Controls.Add(_headerRow);
                Controls.Add(_body);

                _headerRow.Click += (_, _) => Toggle();
                _headerIcon.Click += (_, _) => Toggle();
                _headerText.Click += (_, _) => Toggle();
                _chevron.Click += (_, _) => Toggle();
            }

            private string HeaderText()
            {
                if (_isStreaming) return "Thinking…";
                int steps = _blocks.Count;
                return $"Thought for {steps} step{(steps == 1 ? "" : "s")}";
            }

            private void LayoutHeaderRow()
            {
                _headerText.Location = new Point(20, (_headerRow.Height - _headerText.Height) / 2);
                _chevron.Location = new Point(_headerText.Right + 6, (_headerRow.Height - 11) / 2);
            }

            private void Toggle()
            {
                _expanded = !_expanded;
                _body.Visible = _expanded;
                _chevron.Image = _expanded
                    ? WinIcons.ChevronUp(9, NordColors.SecondaryText)
                    : WinIcons.ChevronDown(9, NordColors.SecondaryText);
            }

            private void BuildBody(int width)
            {
                for (int i = 0; i < _blocks.Count; i++)
                    _body.Controls.Add(new ThinkingTimelineRow(_blocks[i], i == _blocks.Count - 1, _isStreaming && i == _blocks.Count - 1, width));
            }
        }

        private sealed class ThinkingTimelineRow : Panel
        {
            private readonly ChatBlock _block;
            private readonly bool _isLast;
            private readonly bool _isActive;
            private readonly Color _accent;
            private readonly string _label;
            private readonly Image _icon;
            private readonly Label _labelControl;
            private readonly Label _summaryControl;
            private readonly PictureBox _chevron;
            private readonly Panel? _expandedContent;
            private bool _expanded;

            public ThinkingTimelineRow(ChatBlock block, bool isLast, bool isActive, int width)
            {
                _block = block;
                _isLast = isLast;
                _isActive = isActive;
                (_icon, _label, _accent) = MetaFor(block.Kind);
                BackColor = Color.Transparent;
                Width = width;
                AutoSize = true;
                Padding = new Padding(0, 0, 0, isLast ? 4 : 0);
                Margin = Padding.Empty;
                DoubleBuffered = true;

                _labelControl = new Label
                {
                    Text = _label,
                    AutoSize = true,
                    Font = new Font("Segoe UI", 9, FontStyle.Bold),
                    ForeColor = NordColors.PrimaryText,
                    BackColor = Color.Transparent,
                };
                _summaryControl = new Label
                {
                    Text = Summary(),
                    AutoSize = true,
                    Font = new Font("Segoe UI", 9),
                    ForeColor = BlendColor(NordColors.SecondaryText, NordColors.EditorBackground, 0.7f),
                    BackColor = Color.Transparent,
                };
                _chevron = new PictureBox
                {
                    Image = WinIcons.ChevronDown(9, NordColors.SecondaryText),
                    SizeMode = PictureBoxSizeMode.CenterImage,
                    Size = new Size(11, 11),
                    BackColor = Color.Transparent,
                    Cursor = Cursors.Hand,
                };

                _expandedContent = BuildExpanded(width - 28);
                _expandedContent.Visible = false;

                Controls.Add(_labelControl);
                Controls.Add(_summaryControl);
                Controls.Add(_chevron);
                Controls.Add(_expandedContent);

                Cursor = Cursors.Hand;
                Click += (_, _) => Toggle();
                _labelControl.Click += (_, _) => Toggle();
                _summaryControl.Click += (_, _) => Toggle();
                _chevron.Click += (_, _) => Toggle();
                SizeChanged += (_, _) => LayoutRow();
                LayoutRow();
            }

            private string Summary()
            {
                var raw = _block.Text?.Trim() ?? "";
                if (raw.Length == 0) return "";
                var first = raw.Split('\n').FirstOrDefault(l => !string.IsNullOrWhiteSpace(l)) ?? "";
                first = first.Trim();
                return first.Length > 120 ? first[..120] + "…" : first;
            }

            private void LayoutRow()
            {
                int rowHeight = 28;
                _labelControl.Location = new Point(28, 5);
                _summaryControl.MaximumSize = new Size(Math.Max(60, Width - _labelControl.Right - 50), 0);
                _summaryControl.Location = new Point(_labelControl.Right + 8, 6);
                _chevron.Location = new Point(Width - 20, (rowHeight - 11) / 2);

                if (_expandedContent != null)
                {
                    _expandedContent.Location = new Point(28, rowHeight + 2);
                    _expandedContent.Width = Width - 28;
                }
                Height = rowHeight + (_expanded && _expandedContent != null ? _expandedContent.Height + 8 : 0) + (_isLast ? 4 : 0);
            }

            private void Toggle()
            {
                if (_expandedContent == null) return;
                _expanded = !_expanded;
                _expandedContent.Visible = _expanded;
                _chevron.Image = _expanded
                    ? WinIcons.ChevronUp(9, NordColors.SecondaryText)
                    : WinIcons.ChevronDown(9, NordColors.SecondaryText);
                _summaryControl.Visible = !_expanded;
                LayoutRow();
                Parent?.PerformLayout();
            }

            private Panel BuildExpanded(int width)
            {
                if (_block.Kind == ChatBlockKind.ShellCommand || _block.Kind == ChatBlockKind.TerminalOutput)
                {
                    var box = new RoundedPanel
                    {
                        Width = width,
                        AutoSize = true,
                        AutoSizeMode = AutoSizeMode.GrowAndShrink,
                        Padding = new Padding(10, 8, 10, 8),
                        FillColor = NordColors.IsDarkMode
                            ? Color.FromArgb(16, 18, 26)
                            : Color.FromArgb(248, 249, 253),
                        BorderColor = NordColors.Border,
                        Radius = 6,
                        BackColor = Color.Transparent,
                    };
                    var text = new Label
                    {
                        Text = _block.Text?.Trim() ?? "",
                        AutoSize = true,
                        MaximumSize = new Size(width - 24, 0),
                        Font = new Font("Consolas", 9),
                        ForeColor = NordColors.PrimaryText,
                        BackColor = Color.Transparent,
                    };
                    box.Controls.Add(text);
                    return box;
                }

                var panel = new Panel
                {
                    Width = width,
                    AutoSize = true,
                    BackColor = Color.Transparent,
                    Padding = Padding.Empty,
                };
                var label = new Label
                {
                    Text = _block.Text?.Trim() ?? "",
                    AutoSize = true,
                    MaximumSize = new Size(width, 0),
                    Font = new Font("Segoe UI", 9),
                    ForeColor = BlendColor(NordColors.PrimaryText, NordColors.EditorBackground, 0.85f),
                    BackColor = Color.Transparent,
                };
                panel.Controls.Add(label);
                return panel;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

                // Dot
                int dotSize = _isActive ? 7 : 5;
                int dotX = 8 - dotSize / 2 + 2;
                int dotY = 14 - dotSize / 2;
                Color dotColor = _isActive ? _accent : BlendColor(NordColors.SecondaryText, NordColors.EditorBackground, 0.5f);
                using (var brush = new SolidBrush(dotColor))
                    e.Graphics.FillEllipse(brush, dotX, dotY, dotSize, dotSize);

                // Vertical connector
                if (!_isLast)
                {
                    using var pen = new Pen(NordColors.Border, 1);
                    e.Graphics.DrawLine(pen, 10, 22, 10, Height);
                }

                // Icon next to label
                e.Graphics.DrawImage(_icon, 28, 7);
            }

            private static (Image icon, string label, Color color) MetaFor(ChatBlockKind kind)
            {
                return kind switch
                {
                    ChatBlockKind.AgentReasoning => (WinIcons.Brain(11, NordColors.AccentPurple), "Reasoning", NordColors.AccentPurple),
                    ChatBlockKind.ShellCommand => (WinIcons.TerminalIcon(11, NordColors.Accent), "Command", NordColors.Accent),
                    ChatBlockKind.TerminalOutput => (WinIcons.TerminalIcon(11, NordColors.SecondaryText), "Output", NordColors.SecondaryText),
                    ChatBlockKind.WebCall => (WinIcons.Globe(11, NordColors.AccentBlue), "Web Search", NordColors.AccentBlue),
                    ChatBlockKind.McpCall => (WinIcons.ServerRack(11, NordColors.AccentAmber), "MCP Call", NordColors.AccentAmber),
                    ChatBlockKind.ImageRendering => (WinIcons.Photo(11, NordColors.AccentGreen), "Image", NordColors.AccentGreen),
                    _ => (WinIcons.CheckmarkCircleFill(11, NordColors.AccentGreen), "Answer", NordColors.AccentGreen),
                };
            }
        }

        private sealed class CodeBlockView : Panel
        {
            private readonly string _code;
            private readonly string _language;
            private bool _copied;

            public CodeBlockView(string code, string language, int width)
            {
                _code = code;
                _language = string.IsNullOrWhiteSpace(language) ? "code" : language;
                Width = width;
                AutoSize = true;
                BackColor = Color.Transparent;
                Padding = Padding.Empty;
                Margin = new Padding(0, 4, 0, 8);
                DoubleBuffered = true;

                int innerWidth = width - 2;

                var header = new Panel
                {
                    Width = innerWidth,
                    Height = 30,
                    BackColor = NordColors.BadgeBackground,
                    Location = new Point(1, 1),
                };

                var lang = new Label
                {
                    Text = _language,
                    AutoSize = true,
                    Font = new Font("Segoe UI", 8, FontStyle.Bold),
                    ForeColor = NordColors.SecondaryText,
                    BackColor = Color.Transparent,
                    Location = new Point(12, 8),
                };

                var copyBtn = new GhostButton
                {
                    Size = new Size(60, 22),
                    HoverFill = BlendColor(NordColors.PrimaryText, NordColors.BadgeBackground, 0.06f),
                };
                copyBtn.Location = new Point(innerWidth - copyBtn.Width - 8, 4);
                copyBtn.Paint += (_, e) =>
                {
                    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                    var icon = _copied
                        ? WinIcons.Checkmark(10, NordColors.AccentGreen)
                        : WinIcons.DocOnDoc(10, NordColors.SecondaryText);
                    e.Graphics.DrawImage(icon, 8, (copyBtn.Height - 10) / 2);
                    using var font = new Font("Segoe UI", 8, FontStyle.Bold);
                    TextRenderer.DrawText(
                        e.Graphics,
                        _copied ? "Copied" : "Copy",
                        font,
                        new Rectangle(22, 0, copyBtn.Width - 24, copyBtn.Height),
                        _copied ? NordColors.AccentGreen : NordColors.SecondaryText,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
                };
                copyBtn.Click += (_, _) =>
                {
                    try { Clipboard.SetText(_code); } catch { }
                    _copied = true;
                    copyBtn.Invalidate();
                    var t = new Timer { Interval = 1500 };
                    t.Tick += (_, _) => { _copied = false; copyBtn.Invalidate(); t.Stop(); t.Dispose(); };
                    t.Start();
                };

                header.Controls.Add(lang);
                header.Controls.Add(copyBtn);

                int lineCount = Math.Max(1, _code.Split('\n').Length);
                int textHeight = Math.Min(280, 12 + lineCount * 16) + 16;

                var codeText = new TextBox
                {
                    Text = _code,
                    Multiline = true,
                    ReadOnly = true,
                    BorderStyle = BorderStyle.None,
                    ScrollBars = ScrollBars.Both,
                    WordWrap = false,
                    BackColor = NordColors.IsDarkMode
                        ? Color.FromArgb(10, 12, 22)
                        : Color.FromArgb(246, 248, 252),
                    ForeColor = NordColors.PrimaryText,
                    Font = new Font("Consolas", 9),
                    Location = new Point(12, 38),
                    Size = new Size(innerWidth - 22, textHeight),
                    Margin = Padding.Empty,
                };

                Controls.Add(header);
                Controls.Add(codeText);

                Height = 30 + textHeight + 16;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color fill = NordColors.IsDarkMode
                    ? Color.FromArgb(10, 12, 22)
                    : Color.FromArgb(246, 248, 252);
                using var brush = new SolidBrush(fill);
                using var pen = new Pen(NordColors.Border, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 8);
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
                // Header band underline
                using var underlinePen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(underlinePen, 1, 31, Width - 2, 31);
            }
        }

        private sealed class DarkMenuColors : ProfessionalColorTable
        {
            public override Color MenuItemSelected => NordColors.BadgeBackground;
            public override Color MenuItemSelectedGradientBegin => NordColors.BadgeBackground;
            public override Color MenuItemSelectedGradientEnd => NordColors.BadgeBackground;
            public override Color MenuStripGradientBegin => NordColors.PanelBackground;
            public override Color MenuStripGradientEnd => NordColors.PanelBackground;
            public override Color ToolStripDropDownBackground => NordColors.PanelBackground;
            public override Color ImageMarginGradientBegin => NordColors.PanelBackground;
            public override Color ImageMarginGradientMiddle => NordColors.PanelBackground;
            public override Color ImageMarginGradientEnd => NordColors.PanelBackground;
            public override Color MenuBorder => NordColors.Border;
            public override Color MenuItemBorder => NordColors.Border;
            public override Color SeparatorDark => NordColors.Border;
            public override Color SeparatorLight => NordColors.Border;
        }
    }
}
