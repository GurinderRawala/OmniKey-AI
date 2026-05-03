using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class HotkeyForm : Form
    {
        private const int WM_HOTKEY = 0x0312;
        private const uint MOD_CONTROL = 0x0002;

        private const int HOTKEY_ID_ENHANCE = 1;
        private const int HOTKEY_ID_GRAMMAR = 2;
        private const int HOTKEY_ID_TASK    = 3;

        private readonly NotifyIcon _notifyIcon;
        private readonly ApiClient _apiClient = new();
        private bool _isProcessing;
        private ToolStripMenuItem? _statusMenuItem;
        private AgentThinkingForm? _agentThinkingForm;
        private ToolStripMenuItem? _checkUpdatesMenuItem;

        public HotkeyForm()
        {
            ShowInTaskbar  = false;
            WindowState    = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity        = 0;

            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            using var trayIconStream = assembly.GetManifestResourceStream("OmniKey.Windows.tray.ico");
            using var appIconStream = assembly.GetManifestResourceStream("OmniKey.Windows.app.ico");
            var appIcon = trayIconStream != null
                ? new Icon(trayIconStream)
                : (appIconStream != null ? new Icon(appIconStream) : SystemIcons.Information);

            var contextMenu = BuildContextMenu();
            _notifyIcon = new NotifyIcon
            {
                Text             = "OmniKey AI",
                Icon             = appIcon,
                Visible          = true,
                ContextMenuStrip = contextMenu,
            };
            _notifyIcon.MouseClick += (_, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    SetForegroundWindow(Handle);
                    var workArea = Screen.GetWorkingArea(Cursor.Position);
                    contextMenu.Show(Cursor.Position.X, workArea.Bottom);
                }
            };
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            RegisterHotkeys();
            _ = InitializeAuthAsync();
            _ = CheckForUpdatesBackgroundAsync();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnregisterHotkeys();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            base.OnFormClosing(e);
        }

        // ─── Auth initialisation ──────────────────────────────────────

        private async Task InitializeAuthAsync()
        {
            if (ApiClient.IsSelfHosted)
            {
                // Self-hosted backend issues a JWT without a subscription key.
                // We still need to call /activate so the agent WebSocket has a
                // valid token; skip this check if it fails (server may not be
                // ready yet — the agent will retry on first use).
                UpdateStatus("Activating\u2026 (self-hosted)");
                bool ok = await SubscriptionManager.Instance.ActivateStoredKeyAsync();
                UpdateStatus(ok ? "Active (self-hosted)" : "Active (self-hosted)");
                return;
            }

            if (SubscriptionManager.Instance.HasStoredKey)
            {
                UpdateStatus("Activating\u2026");
                bool ok = await SubscriptionManager.Instance.ActivateStoredKeyAsync();
                if (ok)
                {
                    UpdateStatus("Active");
                    return;
                }
            }

            // No key, or activation failed – show the license form
            ShowLicenseForm();
        }

        private void ShowLicenseForm()
        {
            using var form = new LicenseForm();
            var result = form.ShowDialog(this);

            if (result == DialogResult.OK)
                UpdateStatus("Active");
            else
                Application.Exit();
        }

        private void UpdateStatus(string status)
        {
            if (_statusMenuItem == null) return;
            _statusMenuItem.Text  = "Status: " + status;
            _statusMenuItem.Image = CreateDotIcon(status.StartsWith("Active"));
        }

        private static Bitmap CreateDotIcon(bool active)
        {
            var bmp = new Bitmap(16, 16);
            using var g = Graphics.FromImage(bmp);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var brush = new SolidBrush(active ? Color.FromArgb(34, 197, 94) : Color.FromArgb(239, 68, 68));
            g.FillEllipse(brush, 2, 2, 12, 12);
            return bmp;
        }

        // ─── Context menu ─────────────────────────────────────────────

        private ContextMenuStrip BuildContextMenu()
        {
            var menu = new ContextMenuStrip();

            _statusMenuItem = new ToolStripMenuItem("Status: Checking\u2026") { Enabled = false };
            menu.Items.Add(_statusMenuItem);
            menu.Items.Add(new ToolStripSeparator());

            var taskInstructionsItem = new ToolStripMenuItem("Task Instructions");
            taskInstructionsItem.Click += (_, _) => ShowTaskInstructions();
            menu.Items.Add(taskInstructionsItem);

            var agentSessionItem = new ToolStripMenuItem("OmniAgent Session");
            agentSessionItem.Click += async (_, _) => await ShowAgentSessionPickerFromMenuAsync();
            menu.Items.Add(agentSessionItem);

            var scheduledJobsItem = new ToolStripMenuItem("Scheduled Jobs");
            scheduledJobsItem.Click += (_, _) => ShowScheduledJobs();
            menu.Items.Add(scheduledJobsItem);

            var manualItem = new ToolStripMenuItem("Manual");
            manualItem.Click += (_, _) => ShowManual();
            menu.Items.Add(manualItem);

            var licenseItem = new ToolStripMenuItem("Subscription / Activate");
            licenseItem.Click += (_, _) => ShowLicenseForm();
            if (ApiClient.IsSelfHosted) licenseItem.Visible = false;
            menu.Items.Add(licenseItem);

            _checkUpdatesMenuItem = new ToolStripMenuItem("Check for Updates");
            _checkUpdatesMenuItem.Click += async (_, _) => await CheckForUpdatesFromMenuAsync();
            menu.Items.Add(_checkUpdatesMenuItem);

            menu.Items.Add(new ToolStripSeparator());

            var exitItem = new ToolStripMenuItem("Exit");
            exitItem.Click += (_, _) => Application.Exit();
            menu.Items.Add(exitItem);

            return menu;
        }

        private void ShowTaskInstructions()
        {
            var form = new TaskInstructionsForm();
            form.Show(this);
        }

        private void ShowScheduledJobs()
        {
            var form = new ScheduledJobsForm();
            form.Show(this);
        }

        private void ShowManual()
        {
            var form = new ManualForm();
            form.Show(this);
        }

        private async Task ShowAgentSessionPickerFromMenuAsync()
        {
            try
            {
                await AgentSessionService.ShowSessionSettingsAsync(this);
            }
            catch (Exception ex)
            {
                ShowBalloon("OmniKey AI", "Session settings error: " + ex.Message);
            }
        }

        // ─── Update checking ──────────────────────────────────────────

        /// <summary>
        /// Runs silently at startup. Shows a balloon tip when an update is found.
        /// </summary>
        private async Task CheckForUpdatesBackgroundAsync()
        {
            var info = await UpdateChecker.CheckAsync();
            if (info == null) return;

            ShowBalloon("OmniKey AI", $"Update {info.Version} is available! Click \u2018Check for Updates\u2019 to install.");
        }

        /// <summary>
        /// Triggered by the "Check for Updates" tray menu item.
        /// Shows the update window when available, or a "you're up to date" balloon.
        /// </summary>
        private async Task CheckForUpdatesFromMenuAsync()
        {
            if (_checkUpdatesMenuItem != null)
            {
                _checkUpdatesMenuItem.Enabled = false;
                _checkUpdatesMenuItem.Text    = "Checking\u2026";
            }

            try
            {
                var info = await UpdateChecker.CheckAsync();

                if (info == null)
                {
                    ShowBalloon("OmniKey AI", "You\u2019re up to date! No new version available.");
                    return;
                }

                var form = new UpdateForm(info);
                form.Show(this);
            }
            finally
            {
                if (_checkUpdatesMenuItem != null)
                {
                    _checkUpdatesMenuItem.Enabled = true;
                    _checkUpdatesMenuItem.Text    = "Check for Updates";
                }
            }
        }

        // ─── Hotkey handling ──────────────────────────────────────────

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                _ = HandleHotkeyAsync(id);
            }

            base.WndProc(ref m);
        }

        private async Task HandleHotkeyAsync(int id)
        {
            if (_isProcessing)
            {
                ShowBalloon("OmniKey AI", "Already processing a selection. Please wait\u2026");
                return;
            }

            _isProcessing = true;

            // Capture the focused window before any UI changes (balloons, forms) can shift focus.
            IntPtr originalWindow = GetForegroundWindow();

            try
            {
                var command = id switch
                {
                    HOTKEY_ID_ENHANCE => EnhanceCommand.Enhance,
                    HOTKEY_ID_GRAMMAR => EnhanceCommand.Grammar,
                    HOTKEY_ID_TASK    => EnhanceCommand.Task,
                    _                 => EnhanceCommand.Enhance,
                };

                string actionName = command switch
                {
                    EnhanceCommand.Enhance => "Enhancing Prompt",
                    EnhanceCommand.Grammar => "Fixing Grammar",
                    EnhanceCommand.Task    => "Performing Custom Task",
                    _                      => "Processing",
                };

                // Capture the selection BEFORE showing any balloon so that the
                // balloon tip (which on Windows 10/11 becomes a toast notification)
                // cannot steal keyboard focus before Ctrl+C is sent to the user's
                // window, which would cause the clipboard capture to fail.
                string? selected = await ClipboardHelper.CaptureSelectionAsync();
                if (string.IsNullOrWhiteSpace(selected))
                {
                    ShowBalloon("OmniKey AI", "No text selected. Please select text and try again.");
                    return;
                }

                ShowBalloon("OmniKey AI", actionName + "\u2026");

                // Check directive on raw text before any normalization so the
                // @omniAgent token is never accidentally stripped or transformed.
                if (command == EnhanceCommand.Task && AgentRunner.ContainsAgentDirective(selected))
                {
                    string normalizedForAgent = ClipboardHelper.NormalizeOriginalText(selected);
                    try
                    {
                        await RunAgentWorkflowAsync(normalizedForAgent, originalWindow);
                    }
                    catch (Exception ex)
                    {
                        ShowBalloon("OmniKey AI", "Agent error: " + ex.Message);
                    }
                    return;
                }

                string normalized = ClipboardHelper.NormalizeOriginalText(selected);

                string result;
                try
                {
                    result = await _apiClient.SendAsync(normalized, command);
                }
                catch (Exception ex)
                {
                    ShowBalloon("OmniKey AI", "Error contacting backend: " + ex.Message);
                    return;
                }

                if (string.IsNullOrWhiteSpace(result))
                {
                    ShowBalloon("OmniKey AI", "Backend returned empty response; keeping original text.");
                    return;
                }

                await RestoreFocusAndPasteAsync(originalWindow, result);
                ShowBalloon("OmniKey AI", "Text updated.");
            }
            finally
            {
                _isProcessing = false;
            }
        }

        private async Task RunAgentWorkflowAsync(string originalText, IntPtr originalWindow)
        {
            AgentSessionSelection? sessionSelection;
            try
            {
                sessionSelection = await AgentSessionService.ResolveSelectionAsync(this);
            }
            catch (Exception ex)
            {
                ShowBalloon("OmniKey AI", "Session picker error: " + ex.Message);
                return;
            }

            if (sessionSelection == null)
            {
                ShowBalloon("OmniKey AI", "Agent session cancelled.");
                return;
            }

            // Close any existing agent window
            _agentThinkingForm?.Close();
            _agentThinkingForm = new AgentThinkingForm();
            _agentThinkingForm.Text = $"OmniAgent Session - {sessionSelection.SessionTitle} - OmniKey AI";

            _agentThinkingForm.Show(this);
            _agentThinkingForm.SetInitialRequest(originalText);
            _agentThinkingForm.SetRunning(true);

            var ct = _agentThinkingForm.CancellationSource.Token;

            ShowBalloon("OmniKey AI", "OmniAgent session started\u2026");

            string result;
            try
            {
                result = await AgentRunner.RunAgentSessionAsync(
                    originalText,
                    _agentThinkingForm,
                    ct,
                    sessionSelection.SessionId);
            }
            catch (OperationCanceledException)
            {
                _agentThinkingForm?.SetRunning(false);
                ShowBalloon("OmniKey AI", "Agent session cancelled.");
                return;
            }
            catch (Exception ex)
            {
                _agentThinkingForm?.SetRunning(false);
                ShowBalloon("OmniKey AI", "Agent error: " + ex.Message);
                return;
            }

            _agentThinkingForm?.SetRunning(false);

            if (string.IsNullOrWhiteSpace(result))
            {
                ShowBalloon("OmniKey AI", "Agent returned empty response.");
                return;
            }

            await RestoreFocusAndPasteAsync(originalWindow, result);
            ShowBalloon("OmniKey AI", "Agent finished. Text updated.");
        }

        // Brings the original window back to the foreground (mirroring macOS behavior),
        // waits for it to activate, then pastes the result via Ctrl+V.
        private async Task RestoreFocusAndPasteAsync(IntPtr windowHandle, string text)
        {
            if (windowHandle != IntPtr.Zero)
            {
                SetForegroundWindow(windowHandle);
                await Task.Delay(250);
            }
            await ClipboardHelper.ReplaceSelectionAsync(text);
        }

        // ─── Win32 hotkey registration ────────────────────────────────

        private void RegisterHotkeys()
        {
            RegisterHotKey(Handle, HOTKEY_ID_ENHANCE, MOD_CONTROL, (uint)Keys.E);
            RegisterHotKey(Handle, HOTKEY_ID_GRAMMAR, MOD_CONTROL, (uint)Keys.G);
            RegisterHotKey(Handle, HOTKEY_ID_TASK,    MOD_CONTROL, (uint)Keys.T);
        }

        private void UnregisterHotkeys()
        {
            UnregisterHotKey(Handle, HOTKEY_ID_ENHANCE);
            UnregisterHotKey(Handle, HOTKEY_ID_GRAMMAR);
            UnregisterHotKey(Handle, HOTKEY_ID_TASK);
        }

        private void ShowBalloon(string title, string text)
        {
            _notifyIcon.BalloonTipTitle = title;
            _notifyIcon.BalloonTipText  = text;
            _notifyIcon.ShowBalloonTip(3000);
        }

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
