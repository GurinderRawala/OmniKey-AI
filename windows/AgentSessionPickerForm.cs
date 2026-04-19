using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AgentSessionPickerForm : Form
    {
        private readonly List<AgentSessionInfo> _sessions;
        private readonly bool _settingsMode;
        private readonly RadioButton _newSessionRadio;
        private readonly RadioButton _resumeRadio;
        private readonly ListView _sessionList;
        private readonly CheckBox _rememberDefaultCheck;
        private readonly Label _defaultHintLabel;
        private readonly Button _okButton;

        public AgentSessionSelection Selection { get; private set; } = new();

        /// <param name="settingsMode">
        /// When true the form is used from the History button to configure the default
        /// session for future runs. The "remember" checkbox is hidden (always saved) and
        /// the current stored default is pre-selected.
        /// </param>
        public AgentSessionPickerForm(List<AgentSessionInfo> sessions, string? currentDefaultSessionId, bool settingsMode = false)
        {
            _sessions = sessions;
            _settingsMode = settingsMode;

            Text = settingsMode ? "OmniAgent Default Session" : "Choose OmniAgent Session";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(560, 454);
            BackColor = NordColors.WindowBackground;

            var titleLabel = new Label
            {
                Text = settingsMode
                    ? "Configure default session behavior"
                    : "Resume previous session or start fresh",
                Font = new Font("Segoe UI", 11, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(16, 16)
            };

            var subtitleLabel = new Label
            {
                Text = settingsMode
                    ? "OmniAgent will use this automatically on the next run."
                    : "Pick where OmniAgent should continue for this run.",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize = true,
                Location = new Point(16, 42)
            };

            _newSessionRadio = new RadioButton
            {
                Text = "Start a new session",
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(18, 78),
                Checked = true
            };

            _resumeRadio = new RadioButton
            {
                Text = "Resume an existing session",
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(18, 104)
            };

            _sessionList = new ListView
            {
                View = View.Details,
                FullRowSelect = true,
                MultiSelect = false,
                Location = new Point(18, 132),
                Size = new Size(524, 220),
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                HeaderStyle = ColumnHeaderStyle.Nonclickable,
                HideSelection = false
            };
            _sessionList.Columns.Add("Session", 290);
            _sessionList.Columns.Add("Turns", 80, HorizontalAlignment.Right);
            _sessionList.Columns.Add("Tokens Left", 130, HorizontalAlignment.Right);

            foreach (var session in _sessions)
            {
                var item = new ListViewItem(session.Title);
                item.SubItems.Add(session.Turns.ToString());
                item.SubItems.Add(session.RemainingContextTokens.ToString("N0"));
                item.Tag = session;
                _sessionList.Items.Add(item);
            }

            // In settings mode the checkbox is always true and hidden; the act of
            // clicking OK always persists the selection as the stored default.
            _rememberDefaultCheck = new CheckBox
            {
                Text = "Remember this as default and skip this picker next time",
                ForeColor = NordColors.PrimaryText,
                AutoSize = true,
                Location = new Point(18, 364),
                Checked = settingsMode,
                Visible = !settingsMode
            };

            _defaultHintLabel = new Label
            {
                Text = BuildHintText(currentDefaultSessionId),
                Font = new Font("Segoe UI", 8),
                ForeColor = NordColors.SecondaryText,
                AutoSize = true,
                // In settings mode the checkbox is hidden so the hint sits higher.
                Location = new Point(18, settingsMode ? 370 : 388)
            };

            var clearDefaultButton = new Button
            {
                Text = "Clear Default",
                Size = new Size(100, 28),
                Location = new Point(18, 412),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.PrimaryText,
            };
            clearDefaultButton.FlatAppearance.BorderColor = NordColors.Border;
            clearDefaultButton.Click += (_, _) =>
            {
                AgentSessionPreferences.ClearDefaultSessionId();
                _defaultHintLabel.Text = "No default session is currently set.";
            };

            _okButton = new Button
            {
                Text = settingsMode ? "Save Default" : "Continue",
                Size = new Size(96, 30),
                Location = new Point(446, 412),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.Accent,
                ForeColor = Color.White,
                DialogResult = DialogResult.OK
            };
            _okButton.FlatAppearance.BorderSize = 0;
            _okButton.Click += OnContinueClicked;

            var cancelButton = new Button
            {
                Text = "Cancel",
                Size = new Size(96, 30),
                Location = new Point(344, 412),
                FlatStyle = FlatStyle.Flat,
                BackColor = NordColors.SurfaceBackground,
                ForeColor = NordColors.PrimaryText,
                DialogResult = DialogResult.Cancel
            };
            cancelButton.FlatAppearance.BorderColor = NordColors.Border;

            _newSessionRadio.CheckedChanged += (_, _) => UpdateUiState();
            _resumeRadio.CheckedChanged += (_, _) => UpdateUiState();
            _sessionList.SelectedIndexChanged += (_, _) => UpdateUiState();
            _sessionList.DoubleClick += (_, _) =>
            {
                if (_resumeRadio.Checked && _sessionList.SelectedItems.Count > 0)
                    OnContinueClicked(this, EventArgs.Empty);
            };

            Controls.Add(titleLabel);
            Controls.Add(subtitleLabel);
            Controls.Add(_newSessionRadio);
            Controls.Add(_resumeRadio);
            Controls.Add(_sessionList);
            Controls.Add(_rememberDefaultCheck);
            Controls.Add(_defaultHintLabel);
            Controls.Add(clearDefaultButton);
            Controls.Add(cancelButton);
            Controls.Add(_okButton);

            AcceptButton = _okButton;
            CancelButton = cancelButton;

            if (_sessions.Count > 0)
                _sessionList.Items[0].Selected = true;
            else
                _resumeRadio.Enabled = false;

            // In settings mode pre-select the currently stored default so the user
            // can see what is active and change it if they want.
            if (settingsMode && !string.IsNullOrWhiteSpace(currentDefaultSessionId))
            {
                if (currentDefaultSessionId == AgentSessionPreferences.NewSessionSentinel)
                {
                    _newSessionRadio.Checked = true;
                }
                else
                {
                    foreach (ListViewItem item in _sessionList.Items)
                    {
                        if (item.Tag is AgentSessionInfo info && info.Id == currentDefaultSessionId)
                        {
                            _resumeRadio.Checked = true;
                            item.Selected = true;
                            item.EnsureVisible();
                            break;
                        }
                    }
                }
            }

            UpdateUiState();
        }

        private void UpdateUiState()
        {
            _sessionList.Enabled = _resumeRadio.Checked;
            _okButton.Enabled = _newSessionRadio.Checked || _sessionList.SelectedItems.Count > 0;
        }

        private void OnContinueClicked(object? sender, EventArgs e)
        {
            if (_newSessionRadio.Checked)
            {
                Selection = new AgentSessionSelection
                {
                    SessionId = null,
                    SessionTitle = "New Session"
                };

                if (_settingsMode || _rememberDefaultCheck.Checked)
                {
                    AgentSessionPreferences.WriteDefaultSessionId(AgentSessionPreferences.NewSessionSentinel);
                    _defaultHintLabel.Text = "Default set: always start a new session.";
                }

                DialogResult = DialogResult.OK;
                Close();
                return;
            }

            if (_sessionList.SelectedItems.Count == 0)
            {
                MessageBox.Show(this, "Select a session to continue.", "OmniKey AI", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var picked = (AgentSessionInfo?)_sessionList.SelectedItems[0].Tag;
            if (picked == null)
                return;

            Selection = new AgentSessionSelection
            {
                SessionId = picked.Id,
                SessionTitle = string.IsNullOrWhiteSpace(picked.Title) ? "Session" : picked.Title
            };

            if (_settingsMode || _rememberDefaultCheck.Checked)
            {
                AgentSessionPreferences.WriteDefaultSessionId(picked.Id);
                _defaultHintLabel.Text = $"Default set: {Selection.SessionTitle}";
            }

            DialogResult = DialogResult.OK;
            Close();
        }

        private static string BuildHintText(string? defaultId)
        {
            if (string.IsNullOrWhiteSpace(defaultId))
                return "No default session is currently set.";
            if (defaultId == AgentSessionPreferences.NewSessionSentinel)
                return "Default set: always start a new session.";
            return "A default session is currently set.";
        }
    }
}
