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

        private readonly ComboBox    _templatePicker;
        private readonly ComboBox    _examplePicker;
        private readonly Label       _exampleLabel;
        private readonly Label       _instructionsLabel;
        private readonly TextBox     _headingBox;
        private readonly RichTextBox _instructionsBox;
        private readonly Label       _statusLabel;
        private readonly Button      _saveButton;
        private readonly Button      _defaultButton;
        private readonly Button      _deleteButton;

        // Top of the instructions area — shifts up when example section is hidden
        private int _instructionsTop = 212;

        private static readonly (string Name, string Content)[] Examples =
        {
            (
                "Editor \u2013 polish my writing",
                "<role>\n" +
                "You are an expert writing editor who improves clarity, tone, and correctness.\n" +
                "</role>\n" +
                "<task>\n" +
                "Rewrite the selected text to be clearer, more concise, and professional while preserving the original meaning and intent.\n" +
                "</task>\n" +
                "<style_guidelines>\n" +
                "- Fix grammar, spelling, and punctuation.\n" +
                "- Prefer clear, direct, and natural phrasing.\n" +
                "- Use a confident, professional, and friendly tone.\n" +
                "- Remove redundancy, filler, and unnecessary verbosity.\n" +
                "- Improve flow and readability (sentence structure, transitions, and word choice).\n" +
                "- Prefer active voice over passive voice when it does not change the meaning.\n" +
                "- Maintain any technical accuracy, domain-specific terminology, and constraints.\n" +
                "- Preserve placeholders, variables, code, URLs, and formatting markers exactly as given.\n" +
                "- Respect the original form: if the text is a list, heading, or bullet points, keep that structure.\n" +
                "</style_guidelines>\n\n" +
                "<output_constraints>\n" +
                "- Output only the revised version of the selected text.\n" +
                "- Do NOT include explanations, commentary, or justification.\n" +
                "- Do NOT add new ideas or information that is not implied by the original text.\n" +
                "- If the original text is incomplete or ambiguous, make the best good-faith edit while keeping intent as close as possible.\n" +
                "</output_constraints>"
            ),
            (
                "Write SQL queries Template",
                "<role>\n" +
                "You are an expert SQL query writer and optimizer.\n" +
                "</role>\n" +
                "<schema>\n" +
                "You are given a database schema. Queries must operate only on the tables, columns, and relationships defined in that schema.\n" +
                "Always reference tables and columns exactly as they appear in the schema.\n" +
                "// copy past your schema here...\n" +
                "</schema>\n" +
                "<task>\n" +
                "- Read only the parts of the user's instructions that mention @omnikeyai and treat them as the single source of truth for the task.\n" +
                "- Generate one or more SQL statements that correctly implement those instructions, based strictly on the provided schema.\n" +
                "- Optimize the SQL for performance, clarity, and maintainability (e.g., appropriate joins, predicates, indexing hints when relevant, and avoiding unnecessary subqueries).\n" +
                "- If anything in the instructions or schema is ambiguous or missing, express your questions, assumptions, or notes **only** as SQL comments using `-- ...` or `/* ... */` within the SQL.\n" +
                "</task>\n" +
                "<output_constraints>\n" +
                "- Your entire response MUST be valid SQL syntax.\n" +
                "- Do NOT return markdown, natural-language explanations, or any text that is not valid SQL.\n" +
                "- Do NOT wrap SQL in code fences or any other formatting; output only raw SQL.\n" +
                "- All non-SQL remarks must appear as inline SQL comments beside or above the relevant SQL.\n" +
                "</output_constraints>"
            )
        };

        public TaskInstructionsForm()
        {
            Text          = "Task Instructions \u2013 OmniKey AI";
            Size          = new Size(820, 540);
            MinimumSize   = new Size(700, 480);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor     = NordColors.WindowBackground;

            // ── Title ─────────────────────────────────────────────────────
            Controls.Add(new Label
            {
                Text      = "\u2261  Task templates for Ctrl+T",
                Font      = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 14)
            });

            Controls.Add(new Label
            {
                Text      = "Save up to 5 task instruction templates. One can be set as default for Ctrl+T.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 46)
            });

            // Separator line after subtitle
            Controls.Add(new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 68),
                Size      = new Size(820, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            });

            // ── Row: Heading + Template picker ────────────────────────────
            Controls.Add(new Label
            {
                Text      = "Heading:",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 80)
            });

            _headingBox = new TextBox
            {
                Font            = new Font("Segoe UI", 10),
                Location        = new Point(16, 100),
                Size            = new Size(370, 24),
                BackColor       = NordColors.EditorBackground,
                ForeColor       = NordColors.PrimaryText,
                BorderStyle     = BorderStyle.FixedSingle,
                PlaceholderText = "Template heading"
            };
            _headingBox.TextChanged += (_, _) => UpdateButtons();
            Controls.Add(_headingBox);

            Controls.Add(new Label
            {
                Text      = "Template:",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(406, 80)
            });

            _templatePicker = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                DrawMode      = DrawMode.OwnerDrawFixed,
                Font          = new Font("Segoe UI", 9),
                Location      = new Point(406, 100),
                Size          = new Size(250, 24),
                BackColor     = NordColors.PanelBackground,
                ForeColor     = NordColors.PrimaryText
            };
            _templatePicker.DrawItem              += DrawDarkComboItem;
            _templatePicker.SelectedIndexChanged  += OnTemplatePickerChanged;
            Controls.Add(_templatePicker);

            // ── Example picker row ────────────────────────────────────────
            _exampleLabel = new Label
            {
                Text      = "Load example:",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 136)
            };
            Controls.Add(_exampleLabel);

            _examplePicker = new ComboBox
            {
                DropDownStyle = ComboBoxStyle.DropDownList,
                DrawMode      = DrawMode.OwnerDrawFixed,
                Font          = new Font("Segoe UI", 9),
                Location      = new Point(16, 156),
                Size          = new Size(240, 24),
                BackColor     = NordColors.PanelBackground,
                ForeColor     = NordColors.PrimaryText
            };
            _examplePicker.DrawItem             += DrawDarkComboItem;
            _examplePicker.Items.Add("None");
            foreach (var (name, _) in Examples) _examplePicker.Items.Add(name);
            _examplePicker.SelectedIndex         = 0;
            _examplePicker.SelectedIndexChanged  += OnExamplePickerChanged;
            Controls.Add(_examplePicker);

            // ── Instructions label ────────────────────────────────────────
            _instructionsLabel = new Label
            {
                Text      = "Instructions:",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 192)
            };
            Controls.Add(_instructionsLabel);

            _instructionsBox = new RichTextBox
            {
                Font        = new Font("Consolas", 10),
                Location    = new Point(16, 212),
                Anchor      = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                ScrollBars  = RichTextBoxScrollBars.Vertical
            };
            Controls.Add(_instructionsBox);

            // ── Bottom panel ──────────────────────────────────────────────
            var bottomPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 46,
                BackColor = NordColors.WindowBackground
            };

            // 1px top border on bottom panel
            bottomPanel.Paint += (_, e) =>
            {
                using var pen = new Pen(NordColors.Border, 1);
                e.Graphics.DrawLine(pen, 0, 0, bottomPanel.Width, 0);
            };

            _deleteButton          = MakeButton("Delete Template", ButtonRole.Danger);
            _deleteButton.Location = new Point(8, 9);
            _deleteButton.Click   += async (_, _) => await DeleteAsync();

            _statusLabel = new Label
            {
                Text      = "",
                Font      = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(148, 16)
            };

            var closeButton = MakeButton("Close", ButtonRole.Default);
            closeButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            closeButton.Click += (_, _) => Close();

            _defaultButton        = MakeButton("Use for Ctrl+T", ButtonRole.Default);
            _defaultButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            _defaultButton.Click += async (_, _) => await SetDefaultAsync();

            _saveButton        = MakeButton("Save Template", ButtonRole.Primary);
            _saveButton.Anchor = AnchorStyles.Right | AnchorStyles.Top;
            _saveButton.Click += async (_, _) => await SaveAsync();

            bottomPanel.Controls.AddRange(new Control[]
            {
                _deleteButton, _statusLabel, closeButton, _defaultButton, _saveButton
            });
            bottomPanel.SizeChanged += (_, _) => LayoutBottomButtons(bottomPanel, closeButton);
            Controls.Add(bottomPanel);

            SizeChanged += (_, _) => ResizeInstructions();
            Load        += async (_, _) => await FetchTemplatesAsync();
            Shown       += (_, _) => ResizeInstructions();
        }

        // ── Layout helpers ────────────────────────────────────────────────

        private enum ButtonRole { Primary, Danger, Default }

        private static Button MakeButton(string text, ButtonRole role)
        {
            var b = new Button
            {
                Text      = text,
                Size      = new Size(text.Length > 10 ? 120 : 80, 28),
                FlatStyle = FlatStyle.Flat
            };

            switch (role)
            {
                case ButtonRole.Primary:
                    b.BackColor = NordColors.AccentBlue;
                    b.ForeColor = Color.White;
                    b.FlatAppearance.BorderColor = NordColors.AccentBlue;
                    break;
                case ButtonRole.Danger:
                    b.BackColor = NordColors.RedSectionFill;
                    b.ForeColor = NordColors.ErrorRed;
                    b.FlatAppearance.BorderColor = NordColors.RedSectionBorder;
                    break;
                default:
                    b.BackColor = NordColors.SurfaceBackground;
                    b.ForeColor = NordColors.PrimaryText;
                    b.FlatAppearance.BorderColor = NordColors.Border;
                    break;
            }

            return b;
        }

        private static void DrawDarkComboItem(object? sender, DrawItemEventArgs e)
        {
            if (e.Index < 0 || sender is not ComboBox combo) return;

            bool  selected  = (e.State & DrawItemState.Selected) != 0;
            Color backColor = selected ? NordColors.AccentBlue : NordColors.PanelBackground;
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
            int right           = panel.ClientSize.Width - 8;
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
            string? item     = _templatePicker.SelectedItem as string;
            bool    isNewSlot = item == "New template" || item == "No templates yet";

            if (isNewSlot)
            {
                _selectedId = null;
                _headingBox.Text      = "";
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
                    _selectedId           = tpl.Id;
                    _headingBox.Text      = tpl.Heading;
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
            _selectedId           = tpl.Id;
            _headingBox.Text      = tpl.Heading;
            _instructionsBox.Text = tpl.Instructions;
            SetExampleSectionVisible(false);

            string display = (tpl.IsDefault ? "\u2605 " : "") + tpl.Heading;
            int    idx     = _templatePicker.Items.IndexOf(display);
            if (idx >= 0)
            {
                _templatePicker.SelectedIndexChanged -= OnTemplatePickerChanged;
                _templatePicker.SelectedIndex         = idx;
                _templatePicker.SelectedIndexChanged += OnTemplatePickerChanged;
            }

            UpdateButtons();
        }

        private void UpdateButtons()
        {
            bool has          = _selectedId != null;
            _deleteButton.Enabled  = has;
            _defaultButton.Enabled = has;
            bool headingFilled = !string.IsNullOrWhiteSpace(_headingBox.Text);
            bool atLimit       = _selectedId == null && _templates.Count >= 5;
            _saveButton.Enabled    = headingFilled && !atLimit;
        }

        private async Task SaveAsync()
        {
            string heading = _headingBox.Text.Trim();
            if (string.IsNullOrWhiteSpace(heading)) return;

            string instructions  = _instructionsBox.Text;
            _saveButton.Enabled  = false;
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
            string id             = _selectedId;
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
                    _headingBox.Text      = "";
                    _instructionsBox.Text = "";
                    _examplePicker.SelectedIndex = 0;
                    SetExampleSectionVisible(true);
                    if (_templatePicker.Items.Count > 0)
                    {
                        _templatePicker.SelectedIndexChanged -= OnTemplatePickerChanged;
                        _templatePicker.SelectedIndex         = 0;
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
            void Update()
            {
                _statusLabel.Text = msg;
                string lower = msg.ToLowerInvariant();
                _statusLabel.ForeColor =
                    lower.Contains("success") || lower.Contains("created") ||
                    lower.Contains("updated") || lower.Contains("loaded") || lower.Contains("set")
                        ? NordColors.AccentGreen :
                    lower.Contains("failed") || lower.Contains("error")
                        ? NordColors.ErrorRed :
                    NordColors.SecondaryText;
            }

            if (InvokeRequired) Invoke(Update);
            else Update();
        }
    }
}
