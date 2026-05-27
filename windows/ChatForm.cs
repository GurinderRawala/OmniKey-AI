using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OmniKey.Windows
{
    internal sealed class ChatForm : Form, IAgentSession
    {
        private const int SidebarExpandedWidth = 240;
        private const int SidebarCollapsedWidth = 52;
        private const int ConversationMaxWidth = 820;
        private const int ComposerMaxWidth = 980;
        private const string RegistrySubKey = @"SOFTWARE\OmniKeyAI";
        private const string SidebarCollapsedValueName = "ChatSidebarCollapsed";

        private readonly ChatModel _model = ChatModel.Shared;
        private Panel _sidebar = null!;
        private Panel _sidebarHeader = null!;
        private Label _sidebarTitle = null!;
        private TextBox _searchBox = null!;
        private FlowLayoutPanel _sessionList = null!;
        private Button _newChatButton = null!;
        private Button _collapseButton = null!;

        private Panel _header = null!;
        private Label _titleLabel = null!;
        private Label _statusLabel = null!;
        private Button _stopButton = null!;

        private Panel _contentHost = null!;
        private Panel _messageScroll = null!;
        private FlowLayoutPanel _messageFlow = null!;
        private Panel _landingPanel = null!;
        private Label _errorLabel = null!;

        private Panel _composerOuter = null!;
        private RoundedPanel _composerCard = null!;
        private TextBox _inputBox = null!;
        private ComboBox _templateBox = null!;
        private ContextWindowIndicator _contextIndicator = null!;
        private Button _sendButton = null!;

        private readonly Timer _pulseTimer;
        private bool _sidebarCollapsed;
        private bool _syncingInput;
        private bool _syncingTemplate;
        private float _pulseAlpha = 1f;
        private bool _pulseDown = true;

        public ChatForm()
        {
            Text = "OmniAgent Chat - OmniKey AI";
            Size = new Size(1080, 740);
            MinimumSize = new Size(820, 560);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = NordColors.WindowBackground;

            _model.BindToCurrentThread();
            _model.StateChanged += OnModelStateChanged;

            _sidebarCollapsed = ReadSidebarCollapsed();

            _sidebar = BuildSidebar();
            Controls.Add(_sidebar);

            var body = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.WindowBackground,
            };
            Controls.Add(body);

            _header = BuildHeader();
            body.Controls.Add(_header);

            _composerOuter = BuildComposer();
            body.Controls.Add(_composerOuter);

            _contentHost = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.WindowBackground,
            };
            body.Controls.Add(_contentHost);

            _messageFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                BackColor = NordColors.WindowBackground,
                Padding = new Padding(0, 18, 0, 24),
            };

            _messageScroll = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.WindowBackground,
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

            _errorLabel = new Label
            {
                Dock = DockStyle.Top,
                Height = 30,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(14, 0, 14, 0),
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.ErrorRed,
                BackColor = NordColors.RedSectionFill,
                Visible = false,
            };
            body.Controls.Add(_errorLabel);
            _errorLabel.BringToFront();

            _pulseTimer = new Timer { Interval = 50 };
            _pulseTimer.Tick += (_, _) => PulseRunningStatus();
            _pulseTimer.Start();

            ApplySidebarState();
            Layout += (_, _) =>
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

        private Panel BuildSidebar()
        {
            var sidebar = new Panel
            {
                Dock = DockStyle.Left,
                Width = _sidebarCollapsed ? SidebarCollapsedWidth : SidebarExpandedWidth,
                BackColor = NordColors.PanelBackground,
                Padding = new Padding(10, 10, 10, 10),
            };
            sidebar.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
            };

            _sidebarHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 38,
                BackColor = NordColors.PanelBackground,
            };

            _sidebarTitle = new Label
            {
                Text = "OmniAgent",
                AutoSize = false,
                Font = new Font("Segoe UI", 11, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                TextAlign = ContentAlignment.MiddleLeft,
            };

            _newChatButton = UIStyles.MakeIconButton(WinIcons.SquareAndPencil, 14, toolTip: "New chat");
            _newChatButton.Click += (_, _) => _model.StartNewChat();

            _collapseButton = UIStyles.MakeIconButton(WinIcons.SidebarLeft, 14, toolTip: "Collapse sidebar");
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
            sidebar.Controls.Add(_sidebarHeader);

            _searchBox = new TextBox
            {
                Dock = DockStyle.Top,
                Height = 30,
                PlaceholderText = "Search chats",
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Segoe UI", 9),
                Margin = new Padding(0, 8, 0, 8),
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
            sidebar.Controls.Add(_searchBox);

            _sessionList = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                BackColor = NordColors.PanelBackground,
                Padding = new Padding(0, 8, 0, 0),
            };
            sidebar.Controls.Add(_sessionList);
            _sessionList.BringToFront();

            return sidebar;
        }

        private Panel BuildHeader()
        {
            var header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 58,
                BackColor = NordColors.WindowBackground,
            };
            header.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
            };

            _titleLabel = new Label
            {
                AutoSize = false,
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                TextAlign = ContentAlignment.MiddleLeft,
            };

            _statusLabel = new Label
            {
                AutoSize = false,
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.Accent,
                BackColor = NordColors.WindowBackground,
                TextAlign = ContentAlignment.MiddleRight,
            };

            _stopButton = UIStyles.MakeDangerButton("Stop", new Size(84, 30), WinIcons.StopFill(12, NordColors.ErrorRed));
            _stopButton.Click += (_, _) => _model.CancelCurrentTurn();

            header.Controls.Add(_titleLabel);
            header.Controls.Add(_statusLabel);
            header.Controls.Add(_stopButton);
            header.SizeChanged += (_, _) => LayoutHeader();
            return header;
        }

        private Panel BuildComposer()
        {
            var outer = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 138,
                BackColor = NordColors.WindowBackground,
            };
            outer.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, 0, outer.Width, 0);
            };

            _composerCard = new RoundedPanel
            {
                FillColor = NordColors.EditorBackground,
                BorderColor = NordColors.Border,
                Radius = 14,
                BackColor = NordColors.WindowBackground,
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
                PlaceholderText = "Message OmniAgent",
            };
            _inputBox.TextChanged += (_, _) =>
            {
                if (_syncingInput) return;
                _model.InputText = _inputBox.Text;
            };
            _inputBox.KeyDown += OnInputKeyDown;
            _composerCard.Controls.Add(_inputBox);

            _templateBox = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Segoe UI", 8),
            };
            _templateBox.SelectedIndexChanged += (_, _) =>
            {
                if (_syncingTemplate) return;
                if (_templateBox.SelectedItem is TemplateChoice choice)
                    _model.SetDefaultTaskTemplate(choice.Id);
            };
            _composerCard.Controls.Add(_templateBox);

            _contextIndicator = new ContextWindowIndicator
            {
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.SecondaryText,
            };
            _composerCard.Controls.Add(_contextIndicator);

            _sendButton = UIStyles.MakeIconButton(WinIcons.ArrowUp, 14, new Size(30, 30), NordColors.WindowBackground, toolTip: "Send");
            _sendButton.BackColor = NordColors.Accent;
            _sendButton.FlatAppearance.BorderSize = 0;
            _sendButton.FlatAppearance.MouseOverBackColor = NordColors.AccentBlue;
            _sendButton.Click += (_, _) => SendOrStop();
            _composerCard.Controls.Add(_sendButton);

            outer.SizeChanged += (_, _) => LayoutComposer();
            _composerCard.SizeChanged += (_, _) => LayoutComposerCard();
            return outer;
        }

        private Panel BuildLandingPanel()
        {
            var landing = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = NordColors.WindowBackground,
            };

            var sparkle = new PictureBox
            {
                Image = WinIcons.Sparkles(34, NordColors.AccentPurple),
                SizeMode = PictureBoxSizeMode.CenterImage,
                Size = new Size(44, 44),
            };
            sparkle.Name = "sparkle";

            var title = new Label
            {
                Name = "title",
                Text = "OmniAgent Chat",
                AutoSize = false,
                Font = new Font("Segoe UI", 22, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                TextAlign = ContentAlignment.MiddleCenter,
            };

            var subtitle = new Label
            {
                Name = "subtitle",
                Text = "Start a focused agent session, continue a previous chat, or open your tools.",
                AutoSize = false,
                Font = new Font("Segoe UI", 10),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                TextAlign = ContentAlignment.MiddleCenter,
            };

            var taskButton = UIStyles.MakeSecondaryButton(
                "Task Instructions",
                new Size(178, 34),
                WinIcons.TextBadgeStar(14, NordColors.AccentPurple));
            taskButton.Name = "task";
            taskButton.Click += (_, _) => new TaskInstructionsForm().Show(this);

            var mcpButton = UIStyles.MakeSecondaryButton(
                "MCP Servers",
                new Size(138, 34),
                WinIcons.ServerRack(14, NordColors.AccentGreen));
            mcpButton.Name = "mcp";
            mcpButton.Click += (_, _) => new MCPServersForm().Show(this);

            var jobsButton = UIStyles.MakeSecondaryButton(
                "Scheduled Jobs",
                new Size(158, 34),
                WinIcons.CalendarBadgeClock(14, NordColors.AccentAmber));
            jobsButton.Name = "jobs";
            jobsButton.Click += (_, _) => new ScheduledJobsForm().Show(this);

            landing.Controls.Add(sparkle);
            landing.Controls.Add(title);
            landing.Controls.Add(subtitle);
            landing.Controls.Add(taskButton);
            landing.Controls.Add(mcpButton);
            landing.Controls.Add(jobsButton);
            landing.SizeChanged += (_, _) => LayoutLanding();
            return landing;
        }

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
            _statusLabel.Text = _model.IsRunning ? "Running..." : "";
            _stopButton.Visible = _model.IsRunning;

            _errorLabel.Text = _model.LastErrorMessage ?? "";
            _errorLabel.Visible = !string.IsNullOrWhiteSpace(_model.LastErrorMessage);

            if (_searchBox.Text != _model.SessionSearchQuery)
                _searchBox.Text = _model.SessionSearchQuery;

            _syncingInput = true;
            if (_inputBox.Text != _model.InputText)
                _inputBox.Text = _model.InputText;
            _syncingInput = false;

            RenderTemplatePicker();
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
                _sessionList.ResumeLayout();
                return;
            }

            var sessions = _model.FilteredSessions;
            int rowWidth = Math.Max(100, _sessionList.ClientSize.Width - 8);

            if (sessions.Count == 0)
            {
                _sessionList.Controls.Add(new Label
                {
                    Text = _model.IsSessionSearchActive ? "No matches" : "No chats yet",
                    AutoSize = false,
                    Size = new Size(rowWidth, 28),
                    ForeColor = NordColors.SecondaryText,
                    BackColor = NordColors.PanelBackground,
                    TextAlign = ContentAlignment.MiddleCenter,
                    Font = new Font("Segoe UI", 9),
                    Margin = new Padding(0, 8, 0, 0),
                });
                _sessionList.ResumeLayout();
                return;
            }

            foreach (var session in sessions)
            {
                _sessionList.Controls.Add(CreateSessionRow(session, rowWidth));
            }

            _sessionList.ResumeLayout();
        }

        private Control CreateSessionRow(AgentSessionInfo session, int width)
        {
            bool active = session.Id == _model.ActiveSessionId;
            var row = new RoundedPanel
            {
                Width = width,
                Height = 54,
                FillColor = active ? NordColors.BlueSectionFill : NordColors.PanelBackground,
                BorderColor = active ? NordColors.BlueSectionBorder : NordColors.PanelBackground,
                Radius = 8,
                Margin = new Padding(0, 0, 0, 6),
                Cursor = Cursors.Hand,
            };

            var title = new Label
            {
                Text = string.IsNullOrWhiteSpace(session.Title) ? "Untitled Chat" : session.Title,
                AutoEllipsis = true,
                AutoSize = false,
                Location = new Point(10, 8),
                Size = new Size(width - 42, 19),
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = Color.Transparent,
            };

            var meta = new Label
            {
                Text = session.Turns > 0 ? $"{session.Turns} turns" : "New chat",
                AutoEllipsis = true,
                AutoSize = false,
                Location = new Point(10, 28),
                Size = new Size(width - 42, 18),
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                BackColor = Color.Transparent,
            };

            var delete = UIStyles.MakeIconButton(WinIcons.XmarkCircleFill, 12, new Size(24, 24), NordColors.SecondaryText, toolTip: "Delete chat");
            delete.Location = new Point(width - 30, 15);
            delete.Visible = false;
            delete.Click += (_, _) =>
            {
                _model.DeleteSession(session);
            };

            void Open() => _model.OpenSession(session);
            row.Click += (_, _) => Open();
            title.Click += (_, _) => Open();
            meta.Click += (_, _) => Open();

            void ShowDelete(object? _, EventArgs __) => delete.Visible = true;
            void HideDelete(object? _, EventArgs __)
            {
                if (!delete.ClientRectangle.Contains(delete.PointToClient(Cursor.Position)))
                    delete.Visible = false;
            }

            row.MouseEnter += ShowDelete;
            title.MouseEnter += ShowDelete;
            meta.MouseEnter += ShowDelete;
            delete.MouseEnter += ShowDelete;
            row.MouseLeave += HideDelete;
            title.MouseLeave += HideDelete;
            meta.MouseLeave += HideDelete;
            delete.MouseLeave += HideDelete;

            row.Controls.Add(title);
            row.Controls.Add(meta);
            row.Controls.Add(delete);
            return row;
        }

        private void RenderMessages()
        {
            bool landing = !_model.IsLoadingSessionHistory && _model.Messages.Count == 0;
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

            if (_model.IsLoadingSessionHistory)
            {
                _messageFlow.Controls.Add(CreateNotice("Loading chat history..."));
            }
            else if (_model.TrimmedOlderMessageCount > 0)
            {
                _messageFlow.Controls.Add(CreateNotice($"Showing latest {ChatModel.MaxVisibleMessages} messages. {_model.TrimmedOlderMessageCount} older messages are still stored in history."));
            }

            if (!_model.IsLoadingSessionHistory && _model.Messages.Count == 0)
            {
                _messageFlow.Controls.Add(CreateNotice("No messages in this chat yet."));
            }

            foreach (var message in _model.Messages)
            {
                Control row = message.Role switch
                {
                    ChatMessageRole.User => CreateUserMessageRow(message, width),
                    ChatMessageRole.Assistant => CreateAssistantMessageRow(message, width),
                    _ => CreateNotice(message.Text),
                };
                _messageFlow.Controls.Add(row);
            }

            _messageFlow.ResumeLayout();
            ScrollTranscriptToBottom();
        }

        private Control CreateNotice(string text)
        {
            int width = EffectiveConversationWidth();
            var label = new Label
            {
                Text = text,
                AutoSize = false,
                Size = new Size(width, 30),
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                Margin = new Padding(0, 0, 0, 8),
            };
            return label;
        }

        private Control CreateUserMessageRow(ChatMessage message, int width)
        {
            var row = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.RightToLeft,
                WrapContents = false,
                AutoSize = true,
                Width = width,
                BackColor = NordColors.WindowBackground,
                Margin = new Padding(0, 8, 0, 14),
            };

            int bubbleMax = Math.Max(180, (int)(width * 0.72));
            var label = CreateWrappedLabel(message.Text, new Font("Segoe UI", 10), NordColors.WindowBackground, bubbleMax);
            label.BackColor = Color.Transparent;
            label.Margin = Padding.Empty;

            var bubble = new RoundedPanel
            {
                AutoSize = true,
                Padding = new Padding(14, 10, 14, 10),
                FillColor = NordColors.Accent,
                BorderColor = NordColors.Accent,
                Radius = 14,
                Margin = Padding.Empty,
            };
            bubble.Controls.Add(label);
            row.Controls.Add(bubble);
            return row;
        }

        private Control CreateAssistantMessageRow(ChatMessage message, int width)
        {
            var row = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                Width = width,
                BackColor = NordColors.WindowBackground,
                Margin = new Padding(0, 6, 0, 16),
            };

            var thinking = message.Blocks.Where(b => b.Kind != ChatBlockKind.FinalAnswer).ToList();
            var finals = message.Blocks.Where(b => b.Kind == ChatBlockKind.FinalAnswer).ToList();

            if (thinking.Count > 0)
                row.Controls.Add(CreateThinkingSection(thinking, width));

            foreach (var block in finals)
                row.Controls.Add(CreateFinalAnswerView(block.Text, width));

            if (message.Blocks.Count == 0 && _model.IsRunning)
                row.Controls.Add(CreateNotice("Thinking..."));

            return row;
        }

        private Control CreateThinkingSection(List<ChatBlock> blocks, int width)
        {
            var section = new RoundedPanel
            {
                Width = width,
                AutoSize = true,
                Padding = new Padding(12),
                FillColor = NordColors.SurfaceBackground,
                BorderColor = NordColors.Border,
                Radius = 8,
                Margin = new Padding(0, 0, 0, 10),
            };

            var header = UIStyles.MakeSecondaryButton(
                "Thinking",
                new Size(Math.Min(width - 24, 132), 28),
                WinIcons.Brain(12, NordColors.AccentPurple));
            header.Location = new Point(12, 10);
            section.Controls.Add(header);

            var content = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                Width = width - 24,
                Location = new Point(12, 46),
                BackColor = Color.Transparent,
            };

            foreach (var block in blocks)
                content.Controls.Add(CreateThinkingBlock(block, width - 36));

            header.Click += (_, _) =>
            {
                content.Visible = !content.Visible;
                header.Image = content.Visible
                    ? WinIcons.ChevronUp(12, NordColors.SecondaryText)
                    : WinIcons.ChevronDown(12, NordColors.SecondaryText);
            };

            section.Controls.Add(content);
            return section;
        }

        private Control CreateThinkingBlock(ChatBlock block, int width)
        {
            var panel = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                Width = width,
                BackColor = Color.Transparent,
                Margin = new Padding(0, 0, 0, 10),
            };

            var title = new Label
            {
                Text = BlockTitle(block.Kind),
                AutoSize = false,
                Size = new Size(width, 20),
                Font = new Font("Segoe UI", 8, FontStyle.Bold),
                ForeColor = BlockColor(block.Kind),
                BackColor = Color.Transparent,
            };
            panel.Controls.Add(title);

            if (block.Kind == ChatBlockKind.ShellCommand || block.Kind == ChatBlockKind.TerminalOutput)
                panel.Controls.Add(CreateCodeBlock(block.Text, width, block.Kind == ChatBlockKind.ShellCommand ? "powershell" : "output"));
            else
                panel.Controls.Add(CreateWrappedLabel(block.Text, new Font("Segoe UI", 9), NordColors.SecondaryText, width));

            return panel;
        }

        private Control CreateFinalAnswerView(string markdown, int width)
        {
            var paper = new RoundedPanel
            {
                Width = width,
                AutoSize = true,
                Padding = new Padding(16),
                FillColor = NordColors.PanelBackground,
                BorderColor = NordColors.Border,
                Radius = 8,
                Margin = new Padding(0, 0, 0, 4),
            };

            var markdownPanel = CreateMarkdownPanel(markdown, width - 32);
            markdownPanel.Location = new Point(16, 16);
            paper.Controls.Add(markdownPanel);
            return paper;
        }

        private FlowLayoutPanel CreateMarkdownPanel(string markdown, int width)
        {
            var panel = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoSize = true,
                Width = width,
                BackColor = Color.Transparent,
            };

            var lines = markdown.Replace("\r\n", "\n").Split('\n');
            bool inCode = false;
            string codeLang = "";
            var codeLines = new List<string>();

            foreach (string raw in lines)
            {
                string line = raw.TrimEnd();
                if (line.StartsWith("```", StringComparison.Ordinal))
                {
                    if (inCode)
                    {
                        panel.Controls.Add(CreateCodeBlock(string.Join(Environment.NewLine, codeLines), width, codeLang));
                        codeLines.Clear();
                        inCode = false;
                    }
                    else
                    {
                        inCode = true;
                        codeLang = line.Length > 3 ? line[3..].Trim() : "code";
                    }
                    continue;
                }

                if (inCode)
                {
                    codeLines.Add(line);
                    continue;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    panel.Controls.Add(new Panel { Width = width, Height = 6, BackColor = Color.Transparent });
                    continue;
                }

                if (Regex.IsMatch(line.Trim(), @"^-{3,}$"))
                {
                    panel.Controls.Add(new SeparatorLine { Width = width, Height = 12 });
                    continue;
                }

                if (line.StartsWith("#", StringComparison.Ordinal))
                {
                    int level = line.TakeWhile(c => c == '#').Count();
                    string text = line[level..].Trim();
                    float size = level == 1 ? 14f : level == 2 ? 12f : 10.5f;
                    panel.Controls.Add(CreateWrappedLabel(text, new Font("Segoe UI", size, FontStyle.Bold), NordColors.PrimaryText, width));
                    continue;
                }

                if (line.StartsWith("> ", StringComparison.Ordinal))
                {
                    var quote = new RoundedPanel
                    {
                        Width = width,
                        AutoSize = true,
                        Padding = new Padding(12, 8, 12, 8),
                        FillColor = NordColors.BadgeBackground,
                        BorderColor = NordColors.Border,
                        Radius = 6,
                        Margin = new Padding(0, 2, 0, 6),
                    };
                    quote.Controls.Add(CreateWrappedLabel(line[2..].Trim(), new Font("Segoe UI", 9, FontStyle.Italic), NordColors.SecondaryText, width - 24));
                    panel.Controls.Add(quote);
                    continue;
                }

                if (Regex.IsMatch(line, @"^(\-|\*|\d+\.)\s+"))
                {
                    string text = Regex.Replace(line, @"^(\-|\*|\d+\.)\s+", "");
                    panel.Controls.Add(CreateWrappedLabel("• " + text, new Font("Segoe UI", 10), NordColors.PrimaryText, width));
                    continue;
                }

                Font font = line.Contains('|')
                    ? new Font("Consolas", 9)
                    : new Font("Segoe UI", 10);
                panel.Controls.Add(CreateWrappedLabel(line, font, NordColors.PrimaryText, width));
            }

            if (codeLines.Count > 0)
                panel.Controls.Add(CreateCodeBlock(string.Join(Environment.NewLine, codeLines), width, codeLang));

            return panel;
        }

        private Control CreateCodeBlock(string code, int width, string language)
        {
            var box = new RoundedPanel
            {
                Width = width,
                AutoSize = true,
                Padding = new Padding(0),
                FillColor = NordColors.EditorBackground,
                BorderColor = NordColors.Border,
                Radius = 8,
                Margin = new Padding(0, 4, 0, 8),
            };

            var header = new Panel
            {
                Width = width,
                Height = 28,
                BackColor = NordColors.SurfaceBackground,
            };

            var lang = new Label
            {
                Text = string.IsNullOrWhiteSpace(language) ? "code" : language,
                AutoSize = false,
                Location = new Point(10, 5),
                Size = new Size(width - 74, 18),
                Font = new Font("Segoe UI", 8, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.SurfaceBackground,
            };
            var copy = UIStyles.MakeIconButton(WinIcons.DocOnDoc, 12, new Size(24, 24), NordColors.SecondaryText, toolTip: "Copy");
            copy.Location = new Point(width - 30, 2);
            copy.Click += (_, _) => Clipboard.SetText(code);
            header.Controls.Add(lang);
            header.Controls.Add(copy);

            int lineCount = Math.Max(1, code.Split('\n').Length);
            var text = new TextBox
            {
                Text = code,
                Multiline = true,
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                ScrollBars = ScrollBars.Vertical,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Consolas", 9),
                Location = new Point(10, 36),
                Size = new Size(width - 20, Math.Min(240, 20 + lineCount * 17)),
            };

            box.Controls.Add(header);
            box.Controls.Add(text);
            box.Height = header.Height + text.Height + 18;
            return box;
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
                Margin = new Padding(0, 0, 0, 6),
            };
        }

        private void RenderTemplatePicker()
        {
            _syncingTemplate = true;
            string? selectedId = _model.DefaultTaskTemplate?.Id;
            _templateBox.Items.Clear();
            _templateBox.Items.Add(new TemplateChoice(null, "No task instruction"));
            foreach (var template in _model.AvailableTaskTemplates)
                _templateBox.Items.Add(new TemplateChoice(template.Id, template.Heading));

            int selectedIndex = 0;
            for (int i = 0; i < _templateBox.Items.Count; i++)
            {
                if (_templateBox.Items[i] is TemplateChoice choice && choice.Id == selectedId)
                {
                    selectedIndex = i;
                    break;
                }
            }

            _templateBox.SelectedIndex = selectedIndex;
            _templateBox.Enabled = !_model.IsUpdatingDefaultTaskTemplate;
            _syncingTemplate = false;
        }

        private void UpdateSendButton()
        {
            bool running = _model.IsRunning;
            _sendButton.Image = running
                ? WinIcons.StopFill(14, NordColors.WindowBackground)
                : WinIcons.ArrowUp(14, NordColors.WindowBackground);
            _sendButton.BackColor = running ? NordColors.ErrorRed : NordColors.Accent;
            _sendButton.FlatAppearance.MouseOverBackColor = running ? NordColors.ErrorRed : NordColors.AccentBlue;
        }

        private void UpdateContextIndicator()
        {
            var session = _model.ActiveSession;
            _contextIndicator.ContextBudget = session?.ContextBudget ?? 0;
            _contextIndicator.RemainingTokens = session?.RemainingContextTokens ?? 0;
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

        private void ApplySidebarState()
        {
            _sidebar.Width = _sidebarCollapsed ? SidebarCollapsedWidth : SidebarExpandedWidth;
            _sidebarTitle.Visible = !_sidebarCollapsed;
            _searchBox.Visible = !_sidebarCollapsed;
            _sessionList.Visible = !_sidebarCollapsed;
            _collapseButton.Image = WinIcons.SidebarLeft(14, NordColors.PrimaryText);
            LayoutSidebarHeader();
            RenderSidebarSessions();
        }

        private void LayoutSidebarHeader()
        {
            _sidebarTitle.SetBounds(2, 4, Math.Max(0, _sidebarHeader.Width - 76), 28);
            _newChatButton.SetBounds(_sidebarHeader.Width - 62, 4, 28, 28);
            _collapseButton.SetBounds(_sidebarHeader.Width - 30, 4, 28, 28);

            if (_sidebarCollapsed)
            {
                _newChatButton.SetBounds(2, 2, 28, 28);
                _collapseButton.SetBounds(2, 32, 28, 28);
                _sidebarHeader.Height = 64;
            }
            else
            {
                _sidebarHeader.Height = 38;
            }
        }

        private void LayoutHeader()
        {
            int stopWidth = _stopButton.Visible ? _stopButton.Width + 12 : 0;
            _titleLabel.SetBounds(18, 13, Math.Max(120, _header.Width - 260 - stopWidth), 28);
            _statusLabel.SetBounds(Math.Max(0, _header.Width - 230 - stopWidth), 18, 140, 22);
            _stopButton.Location = new Point(_header.Width - _stopButton.Width - 18, 14);
        }

        private void LayoutComposer()
        {
            int width = Math.Min(ComposerMaxWidth, Math.Max(360, _composerOuter.ClientSize.Width - 56));
            int x = Math.Max(18, (_composerOuter.ClientSize.Width - width) / 2);
            _composerCard.SetBounds(x, 16, width, 94);
            LayoutComposerCard();
        }

        private void LayoutComposerCard()
        {
            int pad = 14;
            _sendButton.SetBounds(_composerCard.Width - 44, _composerCard.Height - 44, 30, 30);
            _templateBox.SetBounds(pad, _composerCard.Height - 38, Math.Min(230, _composerCard.Width - 180), 26);
            _contextIndicator.SetBounds(_sendButton.Left - 112, _composerCard.Height - 38, 100, 26);
            _inputBox.SetBounds(pad, 12, _composerCard.Width - pad * 3 - _sendButton.Width, _composerCard.Height - 54);
        }

        private void LayoutLanding()
        {
            if (_landingPanel.Controls.Count == 0) return;

            int centerX = _landingPanel.ClientSize.Width / 2;
            int top = Math.Max(36, _landingPanel.ClientSize.Height / 2 - 150);
            Control sparkle = _landingPanel.Controls["sparkle"]!;
            Control title = _landingPanel.Controls["title"]!;
            Control subtitle = _landingPanel.Controls["subtitle"]!;
            Control task = _landingPanel.Controls["task"]!;
            Control mcp = _landingPanel.Controls["mcp"]!;
            Control jobs = _landingPanel.Controls["jobs"]!;

            sparkle.Location = new Point(centerX - sparkle.Width / 2, top);
            title.SetBounds(Math.Max(12, centerX - 260), top + 50, Math.Min(520, _landingPanel.ClientSize.Width - 24), 42);
            subtitle.SetBounds(Math.Max(12, centerX - 320), top + 96, Math.Min(640, _landingPanel.ClientSize.Width - 24), 26);

            int total = task.Width + mcp.Width + jobs.Width + 18 * 2;
            int x = centerX - total / 2;
            int y = top + 144;
            task.Location = new Point(x, y);
            mcp.Location = new Point(task.Right + 18, y);
            jobs.Location = new Point(mcp.Right + 18, y);
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
            int scrollAllowance = SystemInformation.VerticalScrollBarWidth + 36;
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

        private void PulseRunningStatus()
        {
            if (!_model.IsRunning)
                return;

            _pulseAlpha += _pulseDown ? -0.06f : 0.06f;
            if (_pulseAlpha <= 0.35f) { _pulseAlpha = 0.35f; _pulseDown = false; }
            if (_pulseAlpha >= 1f) { _pulseAlpha = 1f; _pulseDown = true; }

            _statusLabel.ForeColor = _pulseAlpha > 0.65f ? NordColors.Accent : NordColors.SecondaryText;
        }

        private static string BlockTitle(ChatBlockKind kind) =>
            kind switch
            {
                ChatBlockKind.AgentReasoning => "Reasoning",
                ChatBlockKind.ShellCommand => "Shell command",
                ChatBlockKind.TerminalOutput => "Terminal output",
                ChatBlockKind.WebCall => "Web",
                ChatBlockKind.McpCall => "MCP tool",
                ChatBlockKind.ImageRendering => "Image rendering",
                _ => "Final answer"
            };

        private static Color BlockColor(ChatBlockKind kind) =>
            kind switch
            {
                ChatBlockKind.AgentReasoning => NordColors.AccentPurple,
                ChatBlockKind.ShellCommand => NordColors.AccentAmber,
                ChatBlockKind.TerminalOutput => NordColors.AccentAmber,
                ChatBlockKind.WebCall => NordColors.Accent,
                ChatBlockKind.McpCall => NordColors.AccentGreen,
                ChatBlockKind.ImageRendering => NordColors.AccentCyan,
                _ => NordColors.PrimaryText
            };

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

        public void SetRunning(bool running)
        {
        }

        public void AppendAgentMessage(string text)
        {
        }

        public void AppendWebCall(string text)
        {
        }

        public void AppendMcpCall(string text)
        {
        }

        public void AppendTerminalOutput(string text)
        {
        }

        private sealed class TemplateChoice
        {
            public string? Id { get; }
            private string Label { get; }

            public TemplateChoice(string? id, string label)
            {
                Id = id;
                Label = label;
            }

            public override string ToString() => Label;
        }

        private sealed class RoundedPanel : Panel
        {
            public Color FillColor = NordColors.PanelBackground;
            public Color BorderColor = NordColors.Border;
            public int Radius = 8;

            public RoundedPanel()
            {
                DoubleBuffered = true;
                BackColor = Color.Transparent;
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var fill = new SolidBrush(FillColor);
                using var pen = new Pen(BorderColor, 1);
                using var path = GfxHelpers.RoundedPath(new RectangleF(0, 0, Width - 1, Height - 1), Radius);
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(pen, path);
            }
        }

        private sealed class SeparatorLine : Control
        {
            public SeparatorLine()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                using var pen = new Pen(NordColors.Border, 1);
                int y = Height / 2;
                e.Graphics.DrawLine(pen, 0, y, Width, y);
            }
        }

        private sealed class ContextWindowIndicator : Control
        {
            public int ContextBudget;
            public int RemainingTokens;

            public ContextWindowIndicator()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
                Font = new Font("Segoe UI", 8);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                float ratio = ContextBudget <= 0 ? 0f : Math.Max(0f, Math.Min(1f, RemainingTokens / (float)ContextBudget));
                var rect = new RectangleF(4, 5, 16, 16);
                using var border = new Pen(NordColors.Border, 2);
                using var arc = new Pen(ratio > 0.20f ? NordColors.AccentGreen : NordColors.AccentAmber, 2);
                e.Graphics.DrawEllipse(border, rect);
                if (ContextBudget > 0)
                    e.Graphics.DrawArc(arc, rect, -90, 360 * ratio);

                string text = ContextBudget > 0 ? $"{RemainingTokens:N0}" : "Context";
                TextRenderer.DrawText(
                    e.Graphics,
                    text,
                    Font,
                    new Rectangle(24, 2, Width - 24, Height - 4),
                    NordColors.SecondaryText,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
            }
        }
    }
}
