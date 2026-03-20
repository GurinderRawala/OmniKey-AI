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

        public HotkeyForm()
        {
            ShowInTaskbar  = false;
            WindowState    = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity        = 0;

            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            using var iconStream = assembly.GetManifestResourceStream("OmniKey.Windows.app.ico");
            var appIcon = iconStream != null ? new Icon(iconStream) : SystemIcons.Information;

            _notifyIcon = new NotifyIcon
            {
                Text             = "OmniKey AI",
                Icon             = appIcon,
                Visible          = true,
                ContextMenuStrip = BuildContextMenu(),
            };
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            RegisterHotkeys();
            _ = InitializeAuthAsync();
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
            if (_statusMenuItem != null)
                _statusMenuItem.Text = "Status: " + status;
        }

        // ─── Context menu ─────────────────────────────────────────────

        private ContextMenuStrip BuildContextMenu()
        {
            var menu = new ContextMenuStrip();

            _statusMenuItem = new ToolStripMenuItem("Status: Checking\u2026") { Enabled = false };
            menu.Items.Add(_statusMenuItem);
            menu.Items.Add(new ToolStripSeparator());

            var taskInstructionsItem = new ToolStripMenuItem("Task Instructions\u2026");
            taskInstructionsItem.Click += (_, _) => ShowTaskInstructions();
            menu.Items.Add(taskInstructionsItem);

            var manualItem = new ToolStripMenuItem("Manual\u2026");
            manualItem.Click += (_, _) => ShowManual();
            menu.Items.Add(manualItem);

            var licenseItem = new ToolStripMenuItem("Subscription / Activate\u2026");
            licenseItem.Click += (_, _) => ShowLicenseForm();
            if (ApiClient.IsSelfHosted) licenseItem.Visible = false;
            menu.Items.Add(licenseItem);

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

        private void ShowManual()
        {
            var form = new ManualForm();
            form.Show(this);
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

                ShowBalloon("OmniKey AI", actionName + "\u2026");

                string? selected = await ClipboardHelper.CaptureSelectionAsync();
                if (string.IsNullOrWhiteSpace(selected))
                {
                    ShowBalloon("OmniKey AI", "No text selected. Please select text and try again.");
                    return;
                }

                string normalized = ClipboardHelper.NormalizeOriginalText(selected);

                // Agent workflow for Ctrl+T when @omniAgent directive is present
                if (command == EnhanceCommand.Task && AgentRunner.ContainsAgentDirective(normalized))
                {
                    await RunAgentWorkflowAsync(normalized, originalWindow);
                    return;
                }

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
            // Close any existing agent window
            _agentThinkingForm?.Close();
            _agentThinkingForm = new AgentThinkingForm();

            _agentThinkingForm.SetInitialRequest(originalText);
            _agentThinkingForm.SetRunning(true);
            _agentThinkingForm.Show(this);

            var ct = _agentThinkingForm.CancellationSource.Token;

            ShowBalloon("OmniKey AI", "OmniAgent session started\u2026");

            string result;
            try
            {
                result = await AgentRunner.RunAgentSessionAsync(originalText, _agentThinkingForm, ct);
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
