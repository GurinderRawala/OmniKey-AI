using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class TaskInstructionsForm : Form
    {
        private readonly ApiClient _api = new();
        private List<TaskTemplateDto> _templates = new();
        private string? _selectedId;

        private readonly ComboBox _templatePicker;
        private readonly ComboBox _examplePicker;
        private readonly Label _exampleLabel;
        private readonly Label _instructionsLabel;
        private readonly TextBox _headingBox;
        private readonly RichTextBox _instructionsBox;
        private readonly Label _statusLabel;
        private readonly Button _saveButton;
        private readonly Button _defaultButton;
        private readonly Button _deleteButton;

        // Top of the instructions area — shifts up when example section is hidden
        private int _instructionsTop = 212;

        private static readonly (string Name, string Content)[] Examples =
        {
            (
                "Editor \u2013 polish my writing",
                "You are an expert editor. Polish the provided text for clarity, grammar, and flow while preserving the author's voice and intent. Return only the improved text without commentary."
            ),
            (
                "SQL assistant",
                "You are an expert SQL assistant. Write, optimize, or fix SQL queries based on the provided description or existing query. Return only the SQL unless asked for explanation."
            )
        };

        public TaskInstructionsForm()
        {
            Text = "Task Instructions \u2013 OmniKey AI";
            Size = new Size(820, 540);
            MinimumSize = new Size(700, 480);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = NordColors.WindowBackground;

            // ── Title ────────────────────────────────────────────────────
            Controls.Add(new Label
            {
                Text = "Task templates for Ctrl+T",
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 14)
            });

            Controls.Add(new Label
            {
                Text = "Save up to 5 task instruction templates. One can be set as default for Ctrl+T.",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 46)
            });

            // ── Row: Heading + Template picker ───────────────────────────
            Controls.Add(new Label
            {
                Text = "Heading:",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 80)
            });

            _headingBox = new TextBox
            {
                Font = new Font("Segoe UI", 10),
                Location = new Point(16, 100),
                Size = new Size(370, 24),
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                PlaceholderText = "Template heading"
            };
            _headingBox.TextChanged += (_, _) => UpdateButtons();
            Controls.Add(_headingBox);

            Controls.Add(new Label
            {
                Text = "Template:",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(406, 80)
            });

            _templatePicker = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                DrawMode = DrawMode.OwnerDrawFixed,
                Font = new Font("Segoe UI", 9),
                Location = new Point(406, 100),
                Size = new Size(250, 24),
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            _templatePicker.DrawItem += DrawDarkComboItem;
            _templatePicker.SelectedIndexChanged += OnTemplatePickerChanged;
            Controls.Add(_templatePicker);

            // ── Example picker row ────────────────────────────────────────
            _exampleLabel = new Label
            {
                Text = "Load example:",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 136)
            };
            Controls.Add(_exampleLabel);

            _examplePicker = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                DrawMode = DrawMode.OwnerDrawFixed,
                Font = new Font("Segoe UI", 9),
                Location = new Point(16, 156),
                Size = new Size(240, 24),
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            _examplePicker.DrawItem += DrawDarkComboItem;
            _examplePicker.Items.Add("None");
            foreach (var (name, _) in Examples) _examplePicker.Items.Add(name);
            _examplePicker.SelectedIndex = 0;
            _examplePicker.SelectedIndexChanged += OnExamplePickerChanged;
            Controls.Add(_examplePicker);

            // ── Instructions label ────────────────────────────────────────
            _instructionsLabel = new Label
            {
                Text = "Instructions:",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 192)
            };
            Controls.Add(_instructionsLabel);

            _instructionsBox = new RichTextBox
            {
                Font = new Font("Consolas", 10),
                Location = new Point(16, 212),
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                ScrollBars = RichTextBoxScrollBars.Vertical
            };
            Controls.Add(_instructionsBox);

            // ── Bottom panel ──────────────────────────────────────────────
            var bottomPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 46,
                BackColor = NordColors.WindowBackground
            };

            _deleteButton = MakeButton("Delete Template", NordColors.PanelBackground);
            _deleteButton.Location = new Point(8, 9);
            _deleteButton.Click += async (_, _) => await DeleteAsync();

            _statusLabel = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(148, 16)
            };

            var closeButton = MakeButton("Close", NordColors.PanelBackground);
            closeButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            closeButton.Click += (_, _) => Close();

            _defaultButton = MakeButton("Use for Ctrl+T", NordColors.PanelBackground);
            _defaultButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            _defaultButton.Click += async (_, _) => await SetDefaultAsync();

            _saveButton = MakeButton("Save Template", NordColors.Accent);
            _saveButton.ForeColor = Color.White;
            _saveButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            _saveButton.Click += async (_, _) => await SaveAsync();

            bottomPanel.Controls.AddRange(new Control[]
            {
                _deleteButton, _statusLabel, closeButton, _defaultButton, _saveButton
            });
            bottomPanel.SizeChanged += (_, _) => LayoutBottomButtons(bottomPanel, closeButton);
            Controls.Add(bottomPanel);

            SizeChanged += (_, _) => ResizeInstructions();
            Load  += async (_, _) => await FetchTemplatesAsync();
            Shown += (_, _) => ResizeInstructions();
        }

        // ── Layout helpers ────────────────────────────────────────────────

        private static Button MakeButton(string text, Color back)
        {
            var b = new Button
            {
                Text = text,
                Size = new Size(text.Length > 10 ? 120 : 80, 28),
                FlatStyle = FlatStyle.Flat,
                BackColor = back,
                ForeColor = NordColors.PrimaryText
            };
            b.FlatAppearance.BorderColor = NordColors.Border;
            return b;
        }

        private static void DrawDarkComboItem(object? sender, DrawItemEventArgs e)
        {
            if (e.Index < 0 || sender is not ComboBox combo) return;

            bool selected = (e.State & DrawItemState.Selected) != 0;
            Color backColor = selected ? NordColors.Accent : NordColors.PanelBackground;
            Color foreColor = NordColors.PrimaryText;

            e.Graphics.FillRectangle(new SolidBrush(backColor), e.Bounds);
            string? text = combo.Items[e.Index]?.ToString();
            if (text != null)
                TextRenderer.DrawText(e.Graphics, text, e.Font ?? combo.Font,
                    e.Bounds, foreColor,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        }

        private void LayoutBottomButtons(Panel panel, Button close)
        {
            int right = panel.ClientSize.Width - 8;
            _saveButton.Location    = new Point(right - _saveButton.Width, 9);
            _defaultButton.Location = new Point(_saveButton.Left - _defaultButton.Width - 4, 9);
            close.Location          = new Point(_defaultButton.Left - close.Width - 4, 9);
        }

        private void SetExampleSectionVisible(bool visible)
        {
            _exampleLabel.Visible  = visible;
            _examplePicker.Visible = visible;

            _instructionsTop = visible ? 212 : 156;
            _instructionsLabel.Location = new Point(16, _instructionsTop - 20);
            _instructionsBox.Location   = new Point(16, _instructionsTop);
            ResizeInstructions();
        }

        private void ResizeInstructions()
        {
            var bottomH = Controls.OfType<Panel>()
                .FirstOrDefault(p => p.Dock == DockStyle.Bottom)?.Height ?? 46;
            _instructionsBox.Size = new Size(
                ClientSize.Width - 32,
                Math.Max(ClientSize.Height - _instructionsTop - bottomH - 8, 80));
        }

        // ── Picker event handlers ─────────────────────────────────────────

        private void OnTemplatePickerChanged(object? sender, EventArgs e)
        {
            if (_templatePicker.SelectedIndex < 0) return;
            string? item = _templatePicker.SelectedItem as string;
            bool isNewSlot = item == "New template" || item == "No templates yet";

            if (isNewSlot)
            {
                _selectedId = null;
                _headingBox.Text = "";
                _instructionsBox.Text = "";
                _examplePicker.SelectedIndex = 0;
                SetExampleSectionVisible(true);
            }
            else
            {
                string heading = (item ?? "").TrimStart('\u2605', ' ');
                var tpl = _templates.FirstOrDefault(t => t.Heading == heading);
                if (tpl != null)
                {
                    _selectedId = tpl.Id;
                    _headingBox.Text = tpl.Heading;
                    _instructionsBox.Text = tpl.Instructions;
                    _examplePicker.SelectedIndex = 0;
                    SetExampleSectionVisible(false);
                }
            }

            UpdateButtons();
        }

        private void OnExamplePickerChanged(object? sender, EventArgs e)
        {
            int idx = _examplePicker.SelectedIndex;
            if (idx <= 0 || _selectedId != null) return;

            int exIdx = idx - 1;
            if (exIdx < Examples.Length)
            {
                if (string.IsNullOrWhiteSpace(_headingBox.Text))
                    _headingBox.Text = Examples[exIdx].Name;
                _instructionsBox.Text = Examples[exIdx].Content;
                SetStatus($"Loaded example \"{Examples[exIdx].Name}\".");
            }
        }

        // ── Networking ────────────────────────────────────────────────────

        private async Task FetchTemplatesAsync()
        {
            SetStatus("Loading templates...");
            try
            {
                _templates = await _api.FetchTaskTemplatesAsync();
                RebuildPicker();

                if (_templates.Count == 0)
                {
                    SetStatus("No saved templates yet.");
                    SetExampleSectionVisible(true);
                }
                else
                {
                    var def = _templates.FirstOrDefault(t => t.IsDefault) ?? _templates[0];
                    SelectTemplate(def);
                    SetStatus("Templates loaded.");
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to load templates: " + ex.Message);
            }
        }

        private void RebuildPicker()
        {
            _templatePicker.SelectedIndexChanged -= OnTemplatePickerChanged;
            _templatePicker.Items.Clear();

            foreach (var t in _templates)
                _templatePicker.Items.Add((t.IsDefault ? "\u2605 " : "") + t.Heading);

            if (_templates.Count < 5)
                _templatePicker.Items.Add(_templates.Count == 0 ? "No templates yet" : "New template");

            _templatePicker.SelectedIndexChanged += OnTemplatePickerChanged;
        }

        private void SelectTemplate(TaskTemplateDto tpl)
        {
            _selectedId = tpl.Id;
            _headingBox.Text = tpl.Heading;
            _instructionsBox.Text = tpl.Instructions;
            SetExampleSectionVisible(false);

            string display = (tpl.IsDefault ? "\u2605 " : "") + tpl.Heading;
            int idx = _templatePicker.Items.IndexOf(display);
            if (idx >= 0)
            {
                _templatePicker.SelectedIndexChanged -= OnTemplatePickerChanged;
                _templatePicker.SelectedIndex = idx;
                _templatePicker.SelectedIndexChanged += OnTemplatePickerChanged;
            }

            UpdateButtons();
        }

        private void UpdateButtons()
        {
            bool has = _selectedId != null;
            _deleteButton.Enabled  = has;
            _defaultButton.Enabled = has;
            bool headingFilled = !string.IsNullOrWhiteSpace(_headingBox.Text);
            bool atLimit       = _selectedId == null && _templates.Count >= 5;
            _saveButton.Enabled = headingFilled && !atLimit;
        }

        private async Task SaveAsync()
        {
            string heading = _headingBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(heading)) return;

            string instructions = _instructionsBox.Text;
            _saveButton.Enabled = false;
            SetStatus("Saving...");

            try
            {
                if (_selectedId != null)
                {
                    var updated = await _api.UpdateTaskTemplateAsync(_selectedId, heading, instructions);
                    int i = _templates.FindIndex(t => t.Id == updated.Id);
                    if (i >= 0) _templates[i] = updated;
                    RebuildPicker();
                    SelectTemplate(updated);
                    SetStatus("Template updated.");
                }
                else
                {
                    if (_templates.Count >= 5) { SetStatus("Maximum of 5 templates reached."); return; }
                    var created = await _api.CreateTaskTemplateAsync(heading, instructions);
                    _templates.Add(created);
                    RebuildPicker();
                    SelectTemplate(created);
                    SetStatus("Template created.");
                }
            }
            catch (Exception ex)
            {
                SetStatus("Failed to save: " + ex.Message);
            }
            finally
            {
                UpdateButtons();
            }
        }

        private async Task DeleteAsync()
        {
            if (_selectedId == null) return;
            string id = _selectedId;
            _deleteButton.Enabled = false;
            SetStatus("Deleting...");

            try
            {
                await _api.DeleteTaskTemplateAsync(id);
                _templates.RemoveAll(t => t.Id == id);
                _selectedId = null;
                RebuildPicker();

                if (_templates.Count > 0)
                {
                    SelectTemplate(_templates[0]);
                }
                else
                {
                    _headingBox.Text = "";
                    _instructionsBox.Text = "";
                    _examplePicker.SelectedIndex = 0;
                    SetExampleSectionVisible(true);
                    if (_templatePicker.Items.Count > 0)
                    {
                        _templatePicker.SelectedIndexChanged -= OnTemplatePickerChanged;
                        _templatePicker.SelectedIndex = 0;
                        _templatePicker.SelectedIndexChanged += OnTemplatePickerChanged;
                    }
                }

                SetStatus("Template deleted.");
            }
            catch (Exception ex)
            {
                SetStatus("Failed to delete: " + ex.Message);
                _deleteButton.Enabled = _selectedId != null;
            }
        }

        private async Task SetDefaultAsync()
        {
            if (_selectedId == null) return;
            SetStatus("Setting default...");

            try
            {
                var updated = await _api.SetDefaultTaskTemplateAsync(_selectedId);
                _templates = _templates.Select(t => new TaskTemplateDto
                {
                    Id           = t.Id,
                    Heading      = t.Heading,
                    Instructions = t.Instructions,
                    IsDefault    = t.Id == updated.Id
                }).ToList();
                RebuildPicker();
                SelectTemplate(updated);
                SetStatus("Default template set for Ctrl+T.");
            }
            catch (Exception ex)
            {
                SetStatus("Failed to set default: " + ex.Message);
            }
        }

        private void SetStatus(string msg)
        {
            if (InvokeRequired) Invoke(() => _statusLabel.Text = msg);
            else _statusLabel.Text = msg;
        }
    }
}
