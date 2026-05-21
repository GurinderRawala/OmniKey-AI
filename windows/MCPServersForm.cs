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

        // ─── List panel ────────────────────────────────────────────────
        private readonly ListView _listView;
        private readonly Button   _addButton;
        private readonly Button   _editButton;
        private readonly Button   _toggleButton;
        private readonly Button   _deleteButton;
        private readonly Button   _refreshButton;
        private readonly Button   _closeButton;
        private readonly Label    _statusLabel;

        // ─── Edit panel ────────────────────────────────────────────────
        private readonly Panel        _editPanel;
        private readonly Label        _editTitleLabel;
        private readonly TextBox      _nameBox;
        private readonly TextBox      _descriptionBox;
        private readonly ComboBox     _transportCombo;
        private readonly TextBox      _commandBox;
        private readonly TextBox      _argsBox;
        private readonly DataGridView _envGrid;
        private readonly TextBox      _urlBox;
        private readonly DataGridView _headersGrid;
        private readonly CheckBox     _enabledCheck;
        private readonly Label        _commandLabel;
        private readonly Label        _argsLabel;
        private readonly Label        _envLabel;
        private readonly Label        _urlLabel;
        private readonly Label        _headersLabel;
        private readonly Button       _saveButton;
        private readonly Button       _cancelEditButton;
        private bool                  _isSaving = false;

        public MCPServersForm()
        {
            Text          = "MCP Servers – OmniKey AI";
            Size          = new Size(900, 640);
            MinimumSize   = new Size(760, 540);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor     = NordColors.WindowBackground;

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
                Text      = "Manage Model Context Protocol servers that extend the global agent's capabilities.",
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
                Size      = new Size(900, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            });

            // ─── List ─────────────────────────────────────────────────
            _listView = new ListView
            {
                Location      = new Point(16, 84),
                Size          = new Size(858, 440),
                View          = View.Details,
                FullRowSelect = true,
                GridLines     = false,
                HideSelection = false,
                BackColor     = NordColors.PanelBackground,
                ForeColor     = NordColors.PrimaryText,
                Font          = new Font("Segoe UI", 9),
                Anchor        = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            };
            _listView.Columns.Add("Name",      180);
            _listView.Columns.Add("Transport", 100);
            _listView.Columns.Add("Endpoint",  340);
            _listView.Columns.Add("Enabled",   80);
            _listView.Columns.Add("Description", 200);
            _listView.SelectedIndexChanged += (_, _) => UpdateButtonStates();
            _listView.DoubleClick += (_, _) => EditSelected();
            Controls.Add(_listView);

            // ─── Bottom action bar ────────────────────────────────────
            var bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 60,
                BackColor = NordColors.WindowBackground,
            };
            bottomPanel.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, 0, bottomPanel.Width, 0);
            };

            _addButton    = MakeButton("Install",   new Point(12, 14),  NordColors.Accent);
            _editButton   = MakeButton("Edit",      new Point(108, 14), NordColors.AccentBlue);
            _toggleButton = MakeButton("Toggle",    new Point(196, 14), NordColors.AccentGreen);
            _deleteButton = MakeButton("Delete",    new Point(288, 14), NordColors.ErrorRed);
            _refreshButton = MakeButton("Refresh",  new Point(380, 14), NordColors.AccentBlue);
            _closeButton  = MakeButton("Close",     new Point(778, 14), NordColors.SecondaryText);

            _addButton.Click     += async (_, _) => { StartAdding(); await Task.CompletedTask; };
            _editButton.Click    += (_, _) => EditSelected();
            _toggleButton.Click  += async (_, _) => await ToggleSelectedAsync();
            _deleteButton.Click  += async (_, _) => await DeleteSelectedAsync();
            _refreshButton.Click += async (_, _) => await LoadAsync();
            _closeButton.Click   += (_, _) => Close();

            bottomPanel.Controls.AddRange(new Control[]
            {
                _addButton, _editButton, _toggleButton, _deleteButton, _refreshButton, _closeButton,
            });

            _statusLabel = new Label
            {
                AutoSize  = false,
                Size      = new Size(360, 20),
                Location  = new Point(412, 22),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                Font      = new Font("Segoe UI", 8),
                TextAlign = ContentAlignment.MiddleLeft,
            };
            bottomPanel.Controls.Add(_statusLabel);
            Controls.Add(bottomPanel);

            // ─── Edit panel ───────────────────────────────────────────
            _editPanel = new Panel
            {
                Location  = new Point(16, 84),
                Size      = new Size(858, 440),
                BackColor = NordColors.PanelBackground,
                Visible   = false,
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
                AutoScroll = true,
            };

            _editTitleLabel = new Label
            {
                Text      = "Install MCP Server",
                Font      = new Font("Segoe UI", 11, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                AutoSize  = true,
                Location  = new Point(16, 12),
            };
            _editPanel.Controls.Add(_editTitleLabel);

            _editPanel.Controls.Add(MakeFieldLabel("Name",         new Point(16, 44)));
            _nameBox = MakeTextBox(new Point(16, 64), 380);
            _editPanel.Controls.Add(_nameBox);

            _editPanel.Controls.Add(MakeFieldLabel("Transport",    new Point(420, 44)));
            _transportCombo = new ComboBox
            {
                Location      = new Point(420, 64),
                Size          = new Size(180, 24),
                DropDownStyle = ComboBoxStyle.DropDownList,
                BackColor     = NordColors.EditorBackground,
                ForeColor     = NordColors.PrimaryText,
                Font          = new Font("Segoe UI", 9),
            };
            _transportCombo.Items.AddRange(new object[] { "stdio", "http", "sse" });
            _transportCombo.SelectedIndex = 0;
            _transportCombo.SelectedIndexChanged += (_, _) => UpdateTransportFieldsVisibility();
            _editPanel.Controls.Add(_transportCombo);

            _enabledCheck = new CheckBox
            {
                Text      = "Enabled",
                Checked   = true,
                Location  = new Point(620, 64),
                AutoSize  = true,
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                Font      = new Font("Segoe UI", 9),
            };
            _editPanel.Controls.Add(_enabledCheck);

            _editPanel.Controls.Add(MakeFieldLabel("Description",  new Point(16, 96)));
            _descriptionBox = MakeTextBox(new Point(16, 116), 784);
            _editPanel.Controls.Add(_descriptionBox);

            // stdio fields
            _commandLabel = MakeFieldLabel("Command", new Point(16, 148));
            _editPanel.Controls.Add(_commandLabel);
            _commandBox = MakeTextBox(new Point(16, 168), 784);
            _editPanel.Controls.Add(_commandBox);

            _argsLabel = MakeFieldLabel("Args (one per line)", new Point(16, 200));
            _editPanel.Controls.Add(_argsLabel);
            _argsBox = new TextBox
            {
                Location   = new Point(16, 220),
                Size       = new Size(784, 60),
                Multiline  = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor  = NordColors.EditorBackground,
                ForeColor  = NordColors.PrimaryText,
                Font       = new Font("Consolas", 9),
                BorderStyle = BorderStyle.FixedSingle,
            };
            _editPanel.Controls.Add(_argsBox);

            _envLabel = MakeFieldLabel("Environment (KEY / VALUE)", new Point(16, 290));
            _editPanel.Controls.Add(_envLabel);
            _envGrid = MakeKVGrid(new Point(16, 310), new Size(784, 80));
            _editPanel.Controls.Add(_envGrid);

            // remote fields
            _urlLabel = MakeFieldLabel("URL", new Point(16, 148));
            _urlLabel.Visible = false;
            _editPanel.Controls.Add(_urlLabel);
            _urlBox = MakeTextBox(new Point(16, 168), 784);
            _urlBox.Visible = false;
            _editPanel.Controls.Add(_urlBox);

            _headersLabel = MakeFieldLabel("Headers (KEY / VALUE)", new Point(16, 200));
            _headersLabel.Visible = false;
            _editPanel.Controls.Add(_headersLabel);
            _headersGrid = MakeKVGrid(new Point(16, 220), new Size(784, 100));
            _headersGrid.Visible = false;
            _editPanel.Controls.Add(_headersGrid);

            _saveButton = MakeButton("Save", new Point(16, 400), NordColors.Accent);
            _cancelEditButton = MakeButton("Cancel", new Point(112, 400), NordColors.SecondaryText);
            _saveButton.Click += async (_, _) => await SaveAsync();
            _cancelEditButton.Click += (_, _) => CancelEditing();
            _editPanel.Controls.Add(_saveButton);
            _editPanel.Controls.Add(_cancelEditButton);

            Controls.Add(_editPanel);

            UpdateButtonStates();
            UpdateTransportFieldsVisibility();

            Shown += async (_, _) => await LoadAsync();
        }

        // ─── Helpers ──────────────────────────────────────────────────

        private static Button MakeButton(string text, Point location, Color back, Color? fore = null)
        {
            return new Button
            {
                Text      = text,
                Location  = location,
                Size      = new Size(88, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = back,
                ForeColor = fore ?? Color.White,
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                FlatAppearance = { BorderSize = 0 },
                Cursor    = Cursors.Hand,
            };
        }

        private static Label MakeFieldLabel(string text, Point location)
        {
            return new Label
            {
                Text      = text,
                Location  = location,
                AutoSize  = true,
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.PanelBackground,
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
                Font        = new Font("Segoe UI", 9),
                BorderStyle = BorderStyle.FixedSingle,
            };
        }

        private static DataGridView MakeKVGrid(Point location, Size size)
        {
            var grid = new DataGridView
            {
                Location               = location,
                Size                   = size,
                BackgroundColor        = NordColors.EditorBackground,
                ForeColor              = NordColors.PrimaryText,
                GridColor              = NordColors.Border,
                BorderStyle            = BorderStyle.FixedSingle,
                ColumnHeadersDefaultCellStyle = { BackColor = NordColors.PanelBackground, ForeColor = NordColors.PrimaryText },
                EnableHeadersVisualStyles = false,
                RowHeadersVisible      = false,
                AllowUserToResizeRows  = false,
                AllowUserToAddRows     = true,
                AutoSizeColumnsMode    = DataGridViewAutoSizeColumnsMode.Fill,
            };
            grid.Columns.Add("key", "Key");
            grid.Columns.Add("value", "Value");
            return grid;
        }

        private void UpdateTransportFieldsVisibility()
        {
            string transport = (_transportCombo.SelectedItem as string) ?? "stdio";
            bool isStdio = transport == "stdio";

            _commandLabel.Visible = isStdio;
            _commandBox.Visible   = isStdio;
            _argsLabel.Visible    = isStdio;
            _argsBox.Visible      = isStdio;
            _envLabel.Visible     = isStdio;
            _envGrid.Visible      = isStdio;

            _urlLabel.Visible     = !isStdio;
            _urlBox.Visible       = !isStdio;
            _headersLabel.Visible = !isStdio;
            _headersGrid.Visible  = !isStdio;
        }

        private void UpdateButtonStates()
        {
            bool hasSelection = _listView.SelectedItems.Count > 0;
            _editButton.Enabled   = hasSelection;
            _toggleButton.Enabled = hasSelection;
            _deleteButton.Enabled = hasSelection;
        }

        private MCPServerDto? SelectedServer()
        {
            if (_listView.SelectedItems.Count == 0) return null;
            if (_listView.SelectedItems[0].Tag is MCPServerDto dto) return dto;
            return null;
        }

        // ─── Data flow ────────────────────────────────────────────────

        private async Task LoadAsync()
        {
            try
            {
                _statusLabel.Text = "Loading…";
                _servers = await _api.FetchMCPServersAsync();
                RefreshListView();
                _statusLabel.Text = $"{_servers.Count} MCP server(s).";
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
        }

        private void RefreshListView()
        {
            _listView.BeginUpdate();
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
                _listView.Items.Add(item);
            }
            _listView.EndUpdate();
            UpdateButtonStates();
        }

        private void StartAdding()
        {
            _editingId = null;
            _editTitleLabel.Text = "Install MCP Server";
            _nameBox.Text = "";
            _descriptionBox.Text = "";
            _transportCombo.SelectedItem = "stdio";
            _commandBox.Text = "";
            _argsBox.Text = "";
            _urlBox.Text = "";
            _envGrid.Rows.Clear();
            _headersGrid.Rows.Clear();
            _enabledCheck.Checked = true;
            ShowEditPanel(true);
        }

        private void EditSelected()
        {
            var dto = SelectedServer();
            if (dto == null) return;

            _editingId = dto.Id;
            _editTitleLabel.Text = "Edit MCP Server";
            _nameBox.Text = dto.Name;
            _descriptionBox.Text = dto.Description ?? "";
            _transportCombo.SelectedItem = dto.Transport;
            _commandBox.Text = dto.Command ?? "";
            _argsBox.Text = string.Join(Environment.NewLine, dto.Args);
            _urlBox.Text = dto.Url ?? "";
            _enabledCheck.Checked = dto.IsEnabled;

            _envGrid.Rows.Clear();
            foreach (var kv in dto.Env)
                _envGrid.Rows.Add(kv.Key, kv.Value);

            _headersGrid.Rows.Clear();
            foreach (var kv in dto.Headers)
                _headersGrid.Rows.Add(kv.Key, kv.Value);

            ShowEditPanel(true);
        }

        private void CancelEditing()
        {
            ShowEditPanel(false);
            _statusLabel.Text = "";
        }

        private void ShowEditPanel(bool visible)
        {
            _editPanel.Visible  = visible;
            _listView.Visible   = !visible;
            _addButton.Enabled     = !visible;
            _refreshButton.Enabled = !visible;
            if (visible)
            {
                _editButton.Enabled   = false;
                _toggleButton.Enabled = false;
                _deleteButton.Enabled = false;
            }
            else
            {
                UpdateButtonStates();
            }
        }

        private async Task SaveAsync()
        {
            if (_isSaving) return;

            string transport = (_transportCombo.SelectedItem as string) ?? "stdio";
            string name = _nameBox.Text.Trim();
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
                Env         = transport == "stdio" ? GridToDict(_envGrid) : new Dictionary<string, string>(),
                Url         = transport != "stdio" ? _urlBox.Text.Trim() : null,
                Headers     = transport != "stdio" ? GridToDict(_headersGrid) : new Dictionary<string, string>(),
                IsEnabled   = _enabledCheck.Checked,
            };

            _isSaving = true;
            _saveButton.Enabled = false;
            _statusLabel.Text = "Saving…";
            try
            {
                if (_editingId == null)
                    await _api.CreateMCPServerAsync(dto);
                else
                    await _api.UpdateMCPServerAsync(_editingId, dto);

                ShowEditPanel(false);
                await LoadAsync();
                _statusLabel.Text = "Saved.";
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
            finally
            {
                _isSaving = false;
                _saveButton.Enabled = true;
            }
        }

        private static Dictionary<string, string> GridToDict(DataGridView grid)
        {
            var dict = new Dictionary<string, string>();
            foreach (DataGridViewRow row in grid.Rows)
            {
                if (row.IsNewRow) continue;
                string key = (row.Cells[0].Value as string ?? "").Trim();
                if (string.IsNullOrEmpty(key)) continue;
                string value = (row.Cells[1].Value as string ?? "");
                dict[key] = value;
            }
            return dict;
        }

        private async Task ToggleSelectedAsync()
        {
            var dto = SelectedServer();
            if (dto == null) return;
            try
            {
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
            var confirm = MessageBox.Show(
                this,
                $"Delete MCP server \"{dto.Name}\"?",
                "Confirm",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (confirm != DialogResult.Yes) return;

            try
            {
                await _api.DeleteMCPServerAsync(dto.Id);
                await LoadAsync();
                _statusLabel.Text = "Deleted.";
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
        }
    }
}
