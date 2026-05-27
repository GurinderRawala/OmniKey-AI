using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class MCPServersForm : Form
    {
        private readonly ApiClient _api = new();
        private List<MCPServerDto> _servers = new();
        private string? _editingId;

        // ─── List panel controls ───────────────────────────────────────
        private readonly ListView  _listView;
        private readonly Button    _addButton;
        private readonly Button    _editButton;
        private readonly Button    _toggleButton;
        private readonly Button    _refreshButton;
        private readonly Button    _moreButton;
        private readonly Button    _closeButton;
        private readonly Label     _statusLabel;
        private readonly ContextMenuStrip  _moreMenu;
        private readonly ToolStripMenuItem _deleteMenuItem;

        // ─── Edit panel controls ───────────────────────────────────────
        private readonly Panel    _editPanel;
        private readonly Label    _editTitleLabel;
        private readonly TextBox  _nameBox;
        private readonly TextBox  _descriptionBox;
        private readonly ComboBox _transportCombo;
        private readonly TextBox  _commandBox;
        private readonly TextBox  _argsBox;
        private readonly TextBox  _urlBox;
        private readonly CheckBox _enabledCheck;
        private readonly Label    _commandLabel;
        private readonly Label    _argsLabel;
        private readonly Label    _envLabel;
        private readonly Label    _urlLabel;
        private readonly Label    _headersLabel;
        private readonly Button   _envAddButton;
        private readonly Button   _headersAddButton;
        private readonly Panel    _envPanel;
        private readonly Panel    _headersPanel;
        private readonly Button   _saveButton;
        private readonly Button   _cancelEditButton;
        private bool              _isSaving;

        public MCPServersForm()
        {
            Text          = "MCP Servers – OmniKey AI";
            Size          = new Size(860, 600);
            MinimumSize   = new Size(700, 500);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor     = NordColors.WindowBackground;
            Icon          = UIStyles.AppIcon;

            // ─── Title ────────────────────────────────────────────────
            Controls.Add(new Label
            {
                Text      = "🧩  MCP Servers",
                Font      = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 14),
            });
            Controls.Add(new Label
            {
                Text      = "Manage Model Context Protocol servers that extend the agent's capabilities.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 46),
            });
            Controls.Add(new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 68),
                Size      = new Size(860, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            });

            // ─── Server list ──────────────────────────────────────────
            _listView = new ListView
            {
                Location      = new Point(16, 84),
                Size          = new Size(820, 420),
                View          = View.Details,
                FullRowSelect = true,
                GridLines     = false,
                HideSelection = false,
                BackColor     = NordColors.PanelBackground,
                ForeColor     = NordColors.PrimaryText,
                Font          = new Font("Segoe UI", 9),
                Anchor        = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            };
            _listView.Columns.Add("Name",        180);
            _listView.Columns.Add("Transport",    90);
            _listView.Columns.Add("Endpoint",    290);
            _listView.Columns.Add("Enabled",      70);
            _listView.Columns.Add("Description", 180);
            _listView.SelectedIndexChanged += (_, _) => UpdateButtonStates();
            _listView.DoubleClick          += (_, _) => EditSelected();
            Controls.Add(_listView);

            // ─── Bottom action bar ─────────────────────────────────────
            var bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 56,
                BackColor = NordColors.WindowBackground,
            };
            bottomPanel.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, 0, bottomPanel.Width, 0);
            };

            _addButton     = MakeButton("Add Server", new Point(12, 14),  NordColors.Accent);
            _editButton    = MakeButton("Edit",       new Point(112, 14), NordColors.AccentBlue);
            _toggleButton  = MakeButton("Toggle",     new Point(200, 14), NordColors.AccentGreen);
            _refreshButton = MakeButton("Refresh",    new Point(300, 14), NordColors.AccentBlue);
            _moreButton    = MakeButton("More ▾",     new Point(400, 14), NordColors.BadgeBackground, NordColors.PrimaryText);
            _closeButton   = MakeButton("Close",      new Point(742, 14), NordColors.SecondaryText);
            _closeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;

            _moreMenu = new ContextMenuStrip
            {
                ShowImageMargin = false,
                BackColor       = NordColors.PanelBackground,
                ForeColor       = NordColors.PrimaryText,
            };
            _deleteMenuItem = new ToolStripMenuItem("Delete") { ForeColor = NordColors.ErrorRed };
            _moreMenu.Items.Add(_deleteMenuItem);

            _addButton.Click      += (_, _) => StartAdding();
            _editButton.Click     += (_, _) => EditSelected();
            _toggleButton.Click   += async (_, _) => await ToggleSelectedAsync();
            _refreshButton.Click  += async (_, _) => await LoadAsync();
            _moreButton.Click     += (_, _) => _moreMenu.Show(_moreButton, new Point(0, _moreButton.Height));
            _deleteMenuItem.Click += async (_, _) => await DeleteSelectedAsync();
            _closeButton.Click    += (_, _) => Close();

            _statusLabel = new Label
            {
                Location  = new Point(490, 18),
                Size      = new Size(242, 20),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                Font      = new Font("Segoe UI", 9),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right,
                TextAlign = ContentAlignment.MiddleRight,
            };
            bottomPanel.Controls.AddRange(new Control[]
            {
                _addButton, _editButton, _toggleButton, _refreshButton,
                _moreButton, _closeButton, _statusLabel,
            });
            Controls.Add(bottomPanel);

            // ─── Edit panel ────────────────────────────────────────────
            _editPanel = new Panel
            {
                Location   = new Point(16, 84),
                Size       = new Size(820, 420),
                BackColor  = NordColors.PanelBackground,
                Visible    = false,
                Anchor     = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
                AutoScroll = true,
            };

            _editTitleLabel = MakePanelLabel("Add MCP Server", new Point(12, 10), 13, FontStyle.Bold);

            // Row 1: Name + Transport + Enabled
            var nameLbl      = MakePanelLabel("Name",      new Point(12,  44), 9);
            _nameBox         = MakeTextBox(new Point(12,  62), 300);
            var transportLbl = MakePanelLabel("Transport", new Point(328, 44), 9);
            _transportCombo  = new ComboBox
            {
                Location      = new Point(328, 62),
                Size          = new Size(120, 24),
                DropDownStyle = ComboBoxStyle.DropDownList,
                BackColor     = NordColors.EditorBackground,
                ForeColor     = NordColors.PrimaryText,
                Font          = new Font("Segoe UI", 9),
            };
            _transportCombo.Items.AddRange(new object[] { "stdio", "http", "sse" });
            _transportCombo.SelectedIndex = 0;
            _transportCombo.SelectedIndexChanged += (_, _) => UpdateTransportFieldsVisibility();
            _enabledCheck = new CheckBox
            {
                Text      = "Enabled",
                Checked   = true,
                Location  = new Point(464, 64),
                AutoSize  = true,
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                Font      = new Font("Segoe UI", 9),
            };

            // Row 2: Description
            var descLbl      = MakePanelLabel("Description", new Point(12, 96), 9);
            _descriptionBox  = MakeTextBox(new Point(12, 114), 780);

            // stdio fields
            _commandLabel = MakePanelLabel("Command",            new Point(12, 148), 9);
            _commandBox   = MakeTextBox(new Point(12, 166), 780);
            _argsLabel    = MakePanelLabel("Args (one per line)", new Point(12, 200), 9);
            _argsBox = new TextBox
            {
                Location    = new Point(12, 218),
                Size        = new Size(780, 48),
                Multiline   = true,
                ScrollBars  = ScrollBars.Vertical,
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                Font        = new Font("Consolas", 9),
                BorderStyle = BorderStyle.FixedSingle,
            };
            _envLabel      = MakePanelLabel("Environment Variables", new Point(12, 276), 9);
            _envAddButton  = MakeInlineAddButton(new Point(718, 273));
            _envPanel      = MakeKvContainer(new Point(12, 294), new Size(780, 84));
            _envAddButton.Click += (_, _) => AddKvRow(_envPanel);

            // remote fields (same y-positions as stdio, toggled)
            _urlLabel     = MakePanelLabel("URL",     new Point(12, 148), 9);
            _urlLabel.Visible = false;
            _urlBox       = MakeTextBox(new Point(12, 166), 780);
            _urlBox.Visible = false;
            _headersLabel = MakePanelLabel("Headers", new Point(12, 200), 9);
            _headersLabel.Visible = false;
            _headersAddButton = MakeInlineAddButton(new Point(718, 197));
            _headersAddButton.Visible = false;
            _headersPanel = MakeKvContainer(new Point(12, 218), new Size(780, 100));
            _headersPanel.Visible = false;
            _headersAddButton.Click += (_, _) => AddKvRow(_headersPanel);

            _saveButton = MakeButton("Save", new Point(12, 390), NordColors.Accent);
            _saveButton.Size = new Size(100, 30);
            _saveButton.Click += async (_, _) => await SaveAsync();
            _cancelEditButton = MakeButton("Cancel", new Point(120, 390), NordColors.BadgeBackground, NordColors.PrimaryText);
            _cancelEditButton.Size = new Size(88, 30);
            _cancelEditButton.Click += (_, _) => HideEditPanel();

            _editPanel.Controls.AddRange(new Control[]
            {
                _editTitleLabel,
                nameLbl, _nameBox, transportLbl, _transportCombo, _enabledCheck,
                descLbl, _descriptionBox,
                _commandLabel, _commandBox, _argsLabel, _argsBox,
                _envLabel, _envAddButton, _envPanel,
                _urlLabel, _urlBox,
                _headersLabel, _headersAddButton, _headersPanel,
                _saveButton, _cancelEditButton,
            });
            Controls.Add(_editPanel);

            UpdateButtonStates();
            UpdateTransportFieldsVisibility();

            Shown += async (_, _) => await LoadAsync();
        }

        // ─── KV panel helpers ─────────────────────────────────────────

        private static Panel MakeKvContainer(Point location, Size size)
        {
            return new Panel
            {
                Location    = location,
                Size        = size,
                BackColor   = NordColors.PanelBackground,
                AutoScroll  = true,
            };
        }

        private static Button MakeInlineAddButton(Point location)
        {
            var btn = UIStyles.MakeSecondaryButton("+ Add", new Size(60, 22));
            btn.Location = location;
            return btn;
        }

        private void AddKvRow(Panel container, string key = "", string value = "")
        {
            int y = container.Controls.Count * 30;

            var row = new Panel
            {
                Location  = new Point(0, y),
                Size      = new Size(container.Width - SystemInformation.VerticalScrollBarWidth, 28),
                BackColor = NordColors.PanelBackground,
                Tag       = "kvrow",
            };

            var keyBox = new TextBox
            {
                Location    = new Point(0, 2),
                Size        = new Size(355, 24),
                Text        = key,
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                Font        = new Font("Segoe UI", 9),
                BorderStyle = BorderStyle.FixedSingle,
            };
            var valBox = new TextBox
            {
                Location    = new Point(363, 2),
                Size        = new Size(355, 24),
                Text        = value,
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                Font        = new Font("Segoe UI", 9),
                BorderStyle = BorderStyle.FixedSingle,
            };
            var removeBtn = UIStyles.MakeIconButton(WinIcons.XmarkCircleFill, 12, new Size(24, 24), NordColors.SecondaryText, toolTip: "Remove");
            removeBtn.Location = new Point(726, 2);
            removeBtn.Click += (_, _) =>
            {
                container.Controls.Remove(row);
                RelayoutKvRows(container);
            };

            row.Controls.AddRange(new Control[] { keyBox, valBox, removeBtn });
            container.Controls.Add(row);
        }

        private static void RelayoutKvRows(Panel container)
        {
            int y = 0;
            foreach (Control c in container.Controls.Cast<Control>().OrderBy(c => c.Top))
            {
                c.Location = new Point(0, y);
                y += 30;
            }
        }

        private static void ClearKvPanel(Panel container)
        {
            container.Controls.Clear();
        }

        private static Dictionary<string, string> ReadKvPanel(Panel container)
        {
            var dict = new Dictionary<string, string>();
            foreach (Control c in container.Controls)
            {
                var boxes = c.Controls.OfType<TextBox>().OrderBy(t => t.Left).ToList();
                if (boxes.Count < 2) continue;
                string key = boxes[0].Text.Trim();
                if (string.IsNullOrEmpty(key)) continue;
                dict[key] = boxes[1].Text;
            }
            return dict;
        }

        // ─── Button / label factories ─────────────────────────────────

        private static Button MakeButton(string text, Point location, Color backColor, Color? foreColor = null)
        {
            Button btn;
            if (backColor == NordColors.Accent || backColor == NordColors.AccentBlue)
                btn = UIStyles.MakePrimaryButton(text, new Size(88, 28));
            else if (backColor == NordColors.AccentGreen)
                btn = UIStyles.MakePrimaryButton(text, new Size(88, 28), WinIcons.Checkmark(12, NordColors.WindowBackground));
            else
                btn = UIStyles.MakeSecondaryButton(text, new Size(88, 28));

            btn.Location = location;
            if (foreColor.HasValue)
                btn.ForeColor = foreColor.Value;
            return btn;
        }

        private Label MakePanelLabel(string text, Point location, float fontSize, FontStyle style = FontStyle.Regular)
        {
            return new Label
            {
                Text      = text,
                Location  = location,
                AutoSize  = true,
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.PanelBackground,
                Font      = new Font("Segoe UI", fontSize, style),
            };
        }

        private static TextBox MakeTextBox(Point location, int width)
        {
            return new TextBox
            {
                Location    = location,
                Size        = new Size(width, 24),
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                Font        = new Font("Segoe UI", 10),
                BorderStyle = BorderStyle.FixedSingle,
            };
        }

        // ─── State ────────────────────────────────────────────────────

        private void UpdateTransportFieldsVisibility()
        {
            bool isStdio = (_transportCombo.SelectedItem as string) == "stdio";
            _commandLabel.Visible     = isStdio;
            _commandBox.Visible       = isStdio;
            _argsLabel.Visible        = isStdio;
            _argsBox.Visible          = isStdio;
            _envLabel.Visible         = isStdio;
            _envAddButton.Visible     = isStdio;
            _envPanel.Visible         = isStdio;
            _urlLabel.Visible         = !isStdio;
            _urlBox.Visible           = !isStdio;
            _headersLabel.Visible     = !isStdio;
            _headersAddButton.Visible = !isStdio;
            _headersPanel.Visible     = !isStdio;
        }

        private void UpdateButtonStates()
        {
            bool sel = _listView.SelectedItems.Count > 0;
            _editButton.Enabled     = sel;
            _toggleButton.Enabled   = sel;
            _moreButton.Enabled     = sel;
            _deleteMenuItem.Enabled = sel;
        }

        private MCPServerDto? SelectedServer()
        {
            if (_listView.SelectedItems.Count == 0) return null;
            return _listView.SelectedItems[0].Tag as MCPServerDto;
        }

        private void HideEditPanel()
        {
            _editPanel.Visible = false;
            _listView.Visible  = true;
        }

        // ─── Data flow ────────────────────────────────────────────────

        private async Task LoadAsync()
        {
            try
            {
                _statusLabel.Text = "Loading…";
                _servers = await _api.FetchMCPServersAsync();
                _listView.Items.Clear();
                foreach (var s in _servers)
                {
                    string endpoint = s.Transport == "stdio"
                        ? (s.Command ?? "") + (s.Args.Count > 0 ? " " + string.Join(' ', s.Args) : "")
                        : s.Url ?? "";
                    var item = new ListViewItem(s.Name) { Tag = s };
                    item.SubItems.Add(s.Transport);
                    item.SubItems.Add(endpoint);
                    item.SubItems.Add(s.IsEnabled ? "Yes" : "No");
                    item.SubItems.Add(s.Description ?? "");
                    item.ForeColor = s.IsEnabled ? NordColors.PrimaryText : NordColors.SecondaryText;
                    _listView.Items.Add(item);
                }
                _statusLabel.Text = $"{_servers.Count} server(s)";
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
            UpdateButtonStates();
        }

        private void StartAdding()
        {
            _editingId            = null;
            _editTitleLabel.Text  = "Add MCP Server";
            _nameBox.Text         = "";
            _descriptionBox.Text  = "";
            _transportCombo.SelectedItem = "stdio";
            _commandBox.Text      = "";
            _argsBox.Text         = "";
            _urlBox.Text          = "";
            ClearKvPanel(_envPanel);
            ClearKvPanel(_headersPanel);
            _enabledCheck.Checked = true;
            UpdateTransportFieldsVisibility();
            _listView.Visible  = false;
            _editPanel.Visible = true;
        }

        private void EditSelected()
        {
            var dto = SelectedServer();
            if (dto == null) return;

            _editingId            = dto.Id;
            _editTitleLabel.Text  = "Edit MCP Server";
            _nameBox.Text         = dto.Name;
            _descriptionBox.Text  = dto.Description ?? "";
            _transportCombo.SelectedItem = dto.Transport;
            _commandBox.Text      = dto.Command ?? "";
            _argsBox.Text         = string.Join(Environment.NewLine, dto.Args);
            _urlBox.Text          = dto.Url ?? "";
            _enabledCheck.Checked = dto.IsEnabled;

            ClearKvPanel(_envPanel);
            foreach (var kv in dto.Env)
                AddKvRow(_envPanel, kv.Key, kv.Value);

            ClearKvPanel(_headersPanel);
            foreach (var kv in dto.Headers)
                AddKvRow(_headersPanel, kv.Key, kv.Value);

            UpdateTransportFieldsVisibility();
            _listView.Visible  = false;
            _editPanel.Visible = true;
        }

        private async Task SaveAsync()
        {
            if (_isSaving) return;

            string transport = (_transportCombo.SelectedItem as string) ?? "stdio";
            string name      = _nameBox.Text.Trim();

            if (string.IsNullOrEmpty(name))
            {
                _statusLabel.Text = "Name is required.";
                return;
            }
            if (transport == "stdio" && string.IsNullOrWhiteSpace(_commandBox.Text))
            {
                _statusLabel.Text = "Command is required for stdio transport.";
                return;
            }
            if (transport != "stdio" && string.IsNullOrWhiteSpace(_urlBox.Text))
            {
                _statusLabel.Text = "URL is required for http/sse transport.";
                return;
            }

            var dto = new MCPServerDto
            {
                Name        = name,
                Description = _descriptionBox.Text.Trim(),
                Transport   = transport,
                Command     = transport == "stdio" ? _commandBox.Text.Trim() : null,
                Args        = transport == "stdio"
                                ? _argsBox.Text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries)
                                    .Select(s => s.Trim()).Where(s => s.Length > 0).ToList()
                                : new List<string>(),
                Env         = transport == "stdio" ? ReadKvPanel(_envPanel)     : new Dictionary<string, string>(),
                Url         = transport != "stdio" ? _urlBox.Text.Trim()        : null,
                Headers     = transport != "stdio" ? ReadKvPanel(_headersPanel) : new Dictionary<string, string>(),
                IsEnabled   = _enabledCheck.Checked,
            };

            _isSaving           = true;
            _saveButton.Enabled = false;
            _statusLabel.Text   = "Saving…";
            try
            {
                if (_editingId == null)
                    await _api.CreateMCPServerAsync(dto);
                else
                    await _api.UpdateMCPServerAsync(_editingId, dto);

                HideEditPanel();
                await LoadAsync();
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
            finally
            {
                _isSaving           = false;
                _saveButton.Enabled = true;
            }
        }

        private async Task ToggleSelectedAsync()
        {
            var dto = SelectedServer();
            if (dto == null) return;
            try
            {
                _statusLabel.Text = dto.IsEnabled ? "Disabling…" : "Enabling…";
                await _api.ToggleMCPServerAsync(dto.Id, !dto.IsEnabled);
                await LoadAsync();
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
        }

        private async Task DeleteSelectedAsync()
        {
            var dto = SelectedServer();
            if (dto == null) return;
            if (MessageBox.Show(this,
                    $"Delete \"{dto.Name}\"?",
                    "Confirm Delete",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes) return;
            try
            {
                await _api.DeleteMCPServerAsync(dto.Id);
                _statusLabel.Text = "Deleted.";
                await LoadAsync();
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
        }
    }
}
