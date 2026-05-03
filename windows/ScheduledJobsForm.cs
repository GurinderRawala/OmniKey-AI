using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class ScheduledJobsForm : Form
    {
        private readonly ApiClient _api = new();
        private List<ScheduledJobDto> _jobs = new();
        private string? _editingJobId;

        // ─── List panel controls ──────────────────────────────────────────────
        private readonly ListView  _jobList;
        private readonly Button    _addButton;
        private readonly Button    _editButton;
        private readonly Button    _runNowButton;
        private readonly Button    _refreshButton;
        private readonly Button    _moreButton;
        private readonly Button    _closeButton;
        private readonly Label     _statusLabel;
        private readonly ContextMenuStrip _moreMenu;
        private readonly ToolStripMenuItem _toggleActiveMenuItem;
        private readonly ToolStripMenuItem _lastRunMenuItem;
        private readonly ToolStripMenuItem _deleteMenuItem;

        // Running-status tracking
        private readonly HashSet<string> _runningJobIds = new();
        private readonly Dictionary<string, string?> _preRunLastRunAt = new();
        private readonly Timer _pollTimer;

        // ─── Edit panel controls ──────────────────────────────────────────────
        private readonly Panel        _editPanel;
        private readonly Label        _editTitleLabel;
        private readonly TextBox      _labelBox;
        private readonly RichTextBox  _promptBox;
        private readonly RadioButton  _recurringRadio;
        private readonly RadioButton  _oneTimeRadio;
        private readonly TextBox      _cronBox;
        private readonly DateTimePicker _runAtPicker;
        private readonly Label        _cronLabel;
        private readonly Label        _runAtLabel;
        private readonly Button       _saveButton;
        private readonly Button       _cancelEditButton;

        private static readonly (string Label, string Value)[] CronPresets =
        {
            ("Weekdays at 9 AM",   "0 9 * * 1-5"),
            ("Daily at midnight",  "0 0 * * *"),
            ("Every hour",         "0 * * * *"),
            ("Monday at 8 AM",     "0 8 * * 1"),
        };

        public ScheduledJobsForm()
        {
            Text          = "Scheduled Jobs – OmniKey AI";
            Size          = new Size(860, 600);
            MinimumSize   = new Size(700, 500);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor     = NordColors.WindowBackground;

            // ─── Title ────────────────────────────────────────────────────────
            Controls.Add(new Label
            {
                Text      = "🕐  Scheduled Jobs",
                Font      = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize  = true,
                Location  = new Point(16, 14),
            });

            Controls.Add(new Label
            {
                Text      = "Schedule prompts to run automatically. The system will wake your PC if needed.",
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

            // ─── Job list ─────────────────────────────────────────────────────
            _jobList = new ListView
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
            _jobList.Columns.Add("Label",    200);
            _jobList.Columns.Add("Schedule", 180);
            _jobList.Columns.Add("Next Run",  160);
            _jobList.Columns.Add("Status",    130);
            _jobList.SelectedIndexChanged += (_, _) => UpdateButtonStates();
            _jobList.DoubleClick += (_, _) => EditSelected();
            Controls.Add(_jobList);

            // ─── Bottom action bar ────────────────────────────────────────────
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

            _addButton    = MakeButton("Add Job",  new Point(12, 14), NordColors.Accent);
            _editButton   = MakeButton("Edit",     new Point(112, 14), NordColors.AccentBlue);
            _runNowButton = MakeButton("Run Now",  new Point(200, 14), NordColors.AccentGreen);
            _refreshButton = MakeButton("Refresh", new Point(300, 14), NordColors.AccentBlue);
            _moreButton = MakeButton("More ▾", new Point(400, 14), NordColors.BadgeBackground, NordColors.PrimaryText);
            _closeButton  = MakeButton("Close",    new Point(742, 14), NordColors.SecondaryText);
            _closeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;

            _moreMenu = new ContextMenuStrip
            {
                ShowImageMargin = false,
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
            };

            _toggleActiveMenuItem = new ToolStripMenuItem("Activate");
            _lastRunMenuItem = new ToolStripMenuItem("Last Run");
            _deleteMenuItem = new ToolStripMenuItem("Delete") { ForeColor = NordColors.ErrorRed };
            _moreMenu.Items.AddRange(new ToolStripItem[]
            {
                _toggleActiveMenuItem,
                _lastRunMenuItem,
                new ToolStripSeparator(),
                _deleteMenuItem,
            });

            _addButton.Click    += (_, _) => ShowEditPanel(null);
            _editButton.Click   += (_, _) => EditSelected();
            _runNowButton.Click += async (_, _) => await RunNowAsync();
            _toggleActiveMenuItem.Click += async (_, _) => await ToggleActiveAsync();
            _lastRunMenuItem.Click += async (_, _) => await ShowLastRunAsync();
            _refreshButton.Click += async (_, _) => await RefreshJobsAsync();
            _deleteMenuItem.Click += async (_, _) => await DeleteSelectedAsync();
            _moreButton.Click += (_, _) => _moreMenu.Show(_moreButton, new Point(0, _moreButton.Height));
            _closeButton.Click  += (_, _) => Close();

            bottomPanel.Controls.Add(_addButton);
            bottomPanel.Controls.Add(_editButton);
            bottomPanel.Controls.Add(_runNowButton);
            bottomPanel.Controls.Add(_refreshButton);
            bottomPanel.Controls.Add(_moreButton);
            bottomPanel.Controls.Add(_closeButton);

            _statusLabel = new Label
            {
                Location  = new Point(500, 18),
                Size      = new Size(232, 20),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                Font      = new Font("Segoe UI", 9),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right,
                TextAlign = ContentAlignment.MiddleRight,
            };
            bottomPanel.Controls.Add(_statusLabel);
            Controls.Add(bottomPanel);

            // ─── Edit panel (hidden by default) ───────────────────────────────
            _editPanel = new Panel
            {
                Location  = new Point(16, 84),
                Size      = new Size(820, 420),
                BackColor = NordColors.PanelBackground,
                Visible   = false,
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            };

            _editTitleLabel = MakePanelLabel("Add New Job", new Point(12, 10), 16, FontStyle.Bold);

            var labelLbl = MakePanelLabel("Label", new Point(12, 44), 9);
            _labelBox = new TextBox
            {
                Location  = new Point(12, 62),
                Size      = new Size(780, 24),
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font      = new Font("Segoe UI", 10),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };

            var promptLbl = MakePanelLabel("Prompt", new Point(12, 96), 9);
            _promptBox = new RichTextBox
            {
                Location  = new Point(12, 114),
                Size      = new Size(780, 100),
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font      = new Font("Segoe UI", 10),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };

            var schedLbl = MakePanelLabel("Schedule type", new Point(12, 224), 9);
            _recurringRadio = new RadioButton
            {
                Text      = "Recurring (cron expression)",
                Location  = new Point(12, 242),
                Size      = new Size(240, 20),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                Checked   = true,
                Font      = new Font("Segoe UI", 9),
            };
            _oneTimeRadio = new RadioButton
            {
                Text      = "One-time",
                Location  = new Point(260, 242),
                Size      = new Size(120, 20),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.PanelBackground,
                Font      = new Font("Segoe UI", 9),
            };
            _recurringRadio.CheckedChanged += (_, _) => UpdateScheduleVisibility();
            _oneTimeRadio.CheckedChanged   += (_, _) => UpdateScheduleVisibility();

            _cronLabel = MakePanelLabel("Cron expression", new Point(12, 272), 9);
            _cronBox = new TextBox
            {
                Location  = new Point(12, 290),
                Size      = new Size(300, 24),
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                Font      = new Font("Courier New", 10),
                Text      = "0 9 * * 1-5",
            };

            // Cron preset buttons
            int presetX = 320;
            foreach (var (label, value) in CronPresets)
            {
                var preset = label;
                var val    = value;
                var btn = new Button
                {
                    Text      = preset,
                    Location  = new Point(presetX, 290),
                    Size      = new Size(120, 24),
                    BackColor = NordColors.BadgeBackground,
                    ForeColor = NordColors.PrimaryText,
                    FlatStyle = FlatStyle.Flat,
                    Font      = new Font("Segoe UI", 8),
                };
                btn.FlatAppearance.BorderColor = NordColors.Border;
                btn.Click += (_, _) => _cronBox.Text = val;
                _editPanel.Controls.Add(btn);
                presetX += 128;
            }

            _runAtLabel = MakePanelLabel("Date & Time", new Point(12, 272), 9);
            _runAtPicker = new DateTimePicker
            {
                Location = new Point(12, 290),
                Size     = new Size(300, 24),
                Format   = DateTimePickerFormat.Custom,
                CustomFormat = "yyyy-MM-dd  HH:mm",
                Value    = DateTime.Now.AddHours(1),
                Visible  = false,
            };

            _saveButton = MakeButton("Save Job", new Point(12, 370), NordColors.Accent);
            _saveButton.Size = new Size(100, 30);
            _saveButton.Click += async (_, _) => await SaveJobAsync();

            _cancelEditButton = MakeButton("Cancel", new Point(120, 370), NordColors.BadgeBackground, NordColors.PrimaryText);
            _cancelEditButton.Size = new Size(88, 30);
            _cancelEditButton.Click += (_, _) => HideEditPanel();

            _editPanel.Controls.AddRange(new Control[]
            {
                _editTitleLabel, labelLbl, _labelBox,
                promptLbl, _promptBox,
                schedLbl, _recurringRadio, _oneTimeRadio,
                _cronLabel, _cronBox, _runAtLabel, _runAtPicker,
                _saveButton, _cancelEditButton,
            });
            Controls.Add(_editPanel);

            _pollTimer = new Timer { Interval = 3000 };
            _pollTimer.Tick += async (_, _) => await PollForCompletionAsync();
            FormClosed += (_, _) => StopPolling();

            UpdateButtonStates();
            _ = LoadJobsAsync();
        }

        // ─── Helpers ──────────────────────────────────────────────────────────

        private static Button MakeButton(string text, Point location, Color backColor, Color? foreColor = null)
        {
            var btn = new Button
            {
                Text      = text,
                Location  = location,
                Size      = new Size(88, 28),
                BackColor = backColor,
                ForeColor = foreColor ?? Color.White,
                FlatStyle = FlatStyle.Flat,
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
            };
            btn.FlatAppearance.BorderSize = 0;
            if (backColor == NordColors.BadgeBackground)
                btn.FlatAppearance.BorderColor = NordColors.Border;
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

        private void UpdateButtonStates()
        {
            bool hasSelection = _jobList.SelectedItems.Count > 0;
            _editButton.Enabled   = hasSelection;
            _runNowButton.Enabled = hasSelection;
            _refreshButton.Enabled = !IsDisposed;
            _moreButton.Enabled = hasSelection;

            var selected = GetSelectedJob();
            _toggleActiveMenuItem.Enabled = selected != null;
            _toggleActiveMenuItem.Text = selected?.IsActive == true ? "Deactivate" : "Activate";
            _lastRunMenuItem.Enabled = selected != null &&
                (!string.IsNullOrWhiteSpace(selected.LastRunAt) ||
                 !string.IsNullOrWhiteSpace(selected.LastRunSessionId));
            _deleteMenuItem.Enabled = hasSelection;
        }

        private void UpdateScheduleVisibility()
        {
            bool isRecurring = _recurringRadio.Checked;
            _cronLabel.Visible   = isRecurring;
            _cronBox.Visible     = isRecurring;
            _runAtLabel.Visible  = !isRecurring;
            _runAtPicker.Visible = !isRecurring;
        }

        private void SetStatus(string msg) => _statusLabel.Text = msg;

        // ─── Data loading ─────────────────────────────────────────────────────

        private async Task LoadJobsAsync()
        {
            try
            {
                SetStatus("Loading jobs...");
                _jobs = await _api.FetchScheduledJobsAsync();
                _jobList.Items.Clear();
                foreach (var job in _jobs)
                {
                    var item = new ListViewItem(job.Label);
                    item.SubItems.Add(FormatSchedule(job));
                    item.SubItems.Add(string.IsNullOrWhiteSpace(job.NextRunAt) ? "—" : FormatDateTime(job.NextRunAt!));

                    string status = _runningJobIds.Contains(job.Id)
                        ? "Running..."
                        : (job.IsActive ? "Active" : "Inactive");
                    item.SubItems.Add(status);
                    item.Tag = job.Id;
                    item.ForeColor = job.IsActive ? NordColors.PrimaryText : NordColors.SecondaryText;
                    _jobList.Items.Add(item);
                }

                SetStatus("");
            }
            catch (Exception ex)
            {
                SetStatus("Error loading jobs: " + ex.Message);
            }
            UpdateButtonStates();
        }

        private static string FormatSchedule(ScheduledJobDto job)
        {
            if (!string.IsNullOrWhiteSpace(job.CronExpression))
                return job.CronExpression!;

            if (!string.IsNullOrWhiteSpace(job.RunAt))
                return "One-time: " + FormatDateTime(job.RunAt!);

            return "—";
        }

        private static string FormatDateTime(string raw)
        {
            if (DateTimeOffset.TryParse(raw, out var dto))
                return dto.ToLocalTime().ToString("MMM d, yyyy h:mm tt");

            if (DateTime.TryParse(raw, out var dt))
                return dt.ToLocalTime().ToString("MMM d, yyyy h:mm tt");

            return raw;
        }

        // ─── Edit panel ───────────────────────────────────────────────────────

        private void ShowEditPanel(ScheduledJobDto? job)
        {
            _editingJobId = job?.Id;
            _editTitleLabel.Text = job == null ? "Add New Job" : "Edit Job";
            _labelBox.Text       = job?.Label ?? "";
            _promptBox.Text      = job?.Prompt ?? "";

            if (job?.CronExpression is { Length: > 0 } cron)
            {
                _recurringRadio.Checked = true;
                _cronBox.Text           = cron;
            }
            else
            {
                _recurringRadio.Checked = true;
                _cronBox.Text           = "0 9 * * 1-5";
            }

            UpdateScheduleVisibility();
            _jobList.Visible  = false;
            _editPanel.Visible = true;
        }

        private void HideEditPanel()
        {
            _editPanel.Visible = false;
            _jobList.Visible   = true;
        }

        private void EditSelected()
        {
            if (_jobList.SelectedItems.Count == 0) return;
            var id  = _jobList.SelectedItems[0].Tag as string;
            var job = _jobs.FirstOrDefault(j => j.Id == id);
            if (job != null) ShowEditPanel(job);
        }

        private ScheduledJobDto? GetSelectedJob()
        {
            if (_jobList.SelectedItems.Count == 0) return null;
            var id = _jobList.SelectedItems[0].Tag as string;
            if (string.IsNullOrWhiteSpace(id)) return null;
            return _jobs.FirstOrDefault(j => j.Id == id);
        }

        private async Task RefreshJobsAsync()
        {
            await LoadJobsAsync();
        }

        // ─── Save / Delete / Run ──────────────────────────────────────────────

        private async Task SaveJobAsync()
        {
            var label  = _labelBox.Text.Trim();
            var prompt = _promptBox.Text.Trim();
            if (string.IsNullOrEmpty(label) || string.IsNullOrEmpty(prompt))
            {
                SetStatus("Label and Prompt are required.");
                return;
            }

            string? cronExpression = _recurringRadio.Checked ? _cronBox.Text.Trim() : null;
            DateTime? runAt = _oneTimeRadio.Checked ? _runAtPicker.Value.ToUniversalTime() : (DateTime?)null;

            try
            {
                _saveButton.Enabled = false;
                SetStatus("Saving…");

                if (_editingJobId != null)
                {
                    await _api.UpdateScheduledJobAsync(_editingJobId, label, prompt, cronExpression, runAt);
                }
                else
                {
                    var created = await _api.CreateScheduledJobAsync(label, prompt, cronExpression, runAt);
                    if (runAt.HasValue)
                        RegisterWakeTask(created.Id, label, runAt.Value);
                }

                HideEditPanel();
                SetStatus("Saved.");
                await LoadJobsAsync();
            }
            catch (Exception ex)
            {
                SetStatus("Error: " + ex.Message);
            }
            finally
            {
                _saveButton.Enabled = true;
            }
        }

        private async Task DeleteSelectedAsync()
        {
            if (_jobList.SelectedItems.Count == 0) return;
            var id = _jobList.SelectedItems[0].Tag as string;
            if (string.IsNullOrEmpty(id)) return;

            var confirm = MessageBox.Show("Delete this scheduled job?", "Confirm", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (confirm != DialogResult.Yes) return;

            try
            {
                await _api.DeleteScheduledJobAsync(id);
                SetStatus("Deleted.");
                await LoadJobsAsync();
            }
            catch (Exception ex)
            {
                SetStatus("Error: " + ex.Message);
            }
        }

        private async Task RunNowAsync()
        {
            var selected = GetSelectedJob();
            if (selected == null) return;

            try
            {
                _runNowButton.Enabled = false;
                SetStatus("Triggering job…");
                await _api.RunScheduledJobNowAsync(selected.Id);
                _runningJobIds.Add(selected.Id);
                _preRunLastRunAt[selected.Id] = selected.LastRunAt;
                SetStatus($"\"{selected.Label}\" triggered.");
                StartPolling();
                await LoadJobsAsync();
            }
            catch (Exception ex)
            {
                SetStatus("Error: " + ex.Message);
            }
            finally
            {
                _runNowButton.Enabled = true;
            }
        }

        private async Task ToggleActiveAsync()
        {
            var selected = GetSelectedJob();
            if (selected == null) return;

            try
            {
                SetStatus(selected.IsActive ? "Deactivating job..." : "Activating job...");
                await _api.UpdateScheduledJobAsync(
                    selected.Id,
                    selected.Label,
                    selected.Prompt,
                    selected.CronExpression,
                    ParseNullableUtcDate(selected.RunAt),
                    !selected.IsActive
                );
                await LoadJobsAsync();
            }
            catch (Exception ex)
            {
                SetStatus("Error: " + ex.Message);
            }
        }

        private async Task ShowLastRunAsync()
        {
            var selected = GetSelectedJob();
            if (selected == null) return;

            SetStatus("Preparing session history...");

            bool authenticated = await EnsureAuthenticatedAsync();
            if (!authenticated)
            {
                SetStatus("Could not authenticate to load run history.");
                return;
            }

            string? sessionId = selected.LastRunSessionId;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                try
                {
                    var fetched = await _api.FetchScheduledJobsAsync();
                    _jobs = fetched;
                    var refreshed = fetched.FirstOrDefault(j => j.Id == selected.Id);
                    sessionId = refreshed?.LastRunSessionId;
                    await LoadJobsAsync();
                }
                catch (Exception ex)
                {
                    SetStatus("Error: " + ex.Message);
                    return;
                }
            }

            if (string.IsNullOrWhiteSpace(sessionId))
            {
                SetStatus("Session history is not ready yet. Please try again in a moment.");
                return;
            }

            SetStatus("");
            using var historyForm = new JobRunHistoryForm(_api, selected.Label, sessionId!);
            historyForm.ShowDialog(this);
        }

        private static DateTime? ParseNullableUtcDate(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            if (DateTime.TryParse(raw, out var dt)) return dt.ToUniversalTime();
            return null;
        }

        private async Task<bool> EnsureAuthenticatedAsync()
        {
            if (!string.IsNullOrWhiteSpace(SubscriptionManager.Instance.JwtToken))
                return true;

            return await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
        }

        private void StartPolling()
        {
            if (!_pollTimer.Enabled)
                _pollTimer.Start();
        }

        private void StopPolling()
        {
            if (_pollTimer.Enabled)
                _pollTimer.Stop();
        }

        private async Task PollForCompletionAsync()
        {
            try
            {
                var fetched = await _api.FetchScheduledJobsAsync();
                _jobs = fetched;

                var stillRunning = new HashSet<string>();
                foreach (var id in _runningJobIds)
                {
                    _preRunLastRunAt.TryGetValue(id, out var snapshot);
                    var current = fetched.FirstOrDefault(j => j.Id == id)?.LastRunAt;
                    if (string.Equals(current, snapshot, StringComparison.Ordinal))
                        stillRunning.Add(id);
                }

                _runningJobIds.Clear();
                foreach (var id in stillRunning)
                    _runningJobIds.Add(id);

                var keysToRemove = _preRunLastRunAt.Keys.Where(k => !stillRunning.Contains(k)).ToList();
                foreach (var k in keysToRemove)
                    _preRunLastRunAt.Remove(k);

                if (_runningJobIds.Count == 0)
                    StopPolling();

                _jobList.Items.Clear();
                foreach (var job in _jobs)
                {
                    var item = new ListViewItem(job.Label);
                    item.SubItems.Add(FormatSchedule(job));
                    item.SubItems.Add(string.IsNullOrWhiteSpace(job.NextRunAt) ? "—" : FormatDateTime(job.NextRunAt!));
                    item.SubItems.Add(_runningJobIds.Contains(job.Id) ? "Running..." : (job.IsActive ? "Active" : "Inactive"));
                    item.Tag = job.Id;
                    item.ForeColor = job.IsActive ? NordColors.PrimaryText : NordColors.SecondaryText;
                    _jobList.Items.Add(item);
                }

                UpdateButtonStates();
            }
            catch
            {
                // Best-effort polling; ignore transient errors.
            }
        }

        // ─── Windows Task Scheduler wake integration ──────────────────────────

        private static void RegisterWakeTask(string jobId, string label, DateTime runAt)
        {
            try
            {
                string taskName = $"OmniKeyJob_{jobId}";
                string xml      = BuildTaskXml(label, runAt, jobId);
                string tmpPath  = System.IO.Path.GetTempFileName() + ".xml";
                System.IO.File.WriteAllText(tmpPath, xml);

                var psi = new ProcessStartInfo("schtasks.exe",
                    $"/create /xml \"{tmpPath}\" /tn \"{taskName}\" /f")
                {
                    CreateNoWindow        = true,
                    UseShellExecute       = false,
                    RedirectStandardError = true,
                };

                using var proc = Process.Start(psi);
                proc?.WaitForExit(5_000);
            }
            catch
            {
                // Non-fatal; the backend polling loop will still catch up on wake.
            }
        }

        private static string BuildTaskXml(string label, DateTime runAtUtc, string jobId)
        {
            string startBoundary = runAtUtc.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ss");
            string omnikeyPath   = Environment.ProcessPath ?? "omnikey";

            return $"""
                <?xml version="1.0" encoding="UTF-16"?>
                <Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
                  <Triggers>
                    <TimeTrigger>
                      <StartBoundary>{startBoundary}</StartBoundary>
                      <Enabled>true</Enabled>
                    </TimeTrigger>
                  </Triggers>
                  <Settings>
                    <WakeToRun>true</WakeToRun>
                    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
                    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                  </Settings>
                  <Actions Context="Author">
                    <Exec>
                      <Command>{omnikeyPath}</Command>
                      <Arguments>schedule run-now {jobId}</Arguments>
                    </Exec>
                  </Actions>
                  <RegistrationInfo>
                    <Description>OmniKey AI scheduled job: {label}</Description>
                  </RegistrationInfo>
                </Task>
                """;
        }
    }
}
