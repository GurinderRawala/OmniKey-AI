using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using OmniKey.Windows.ViewModels;
using OmniKey.Windows.Views.Pages;

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
            using var brush = new SolidBrush(active ? NordColors.AccentGreen : NordColors.ErrorRed);
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

            // All tray entries navigate the WPF MainWindow shell — including
            // OmniAgent Session, which used to open a separate WinForms
            // window. The session UI now lives as a page inside MainWindow.

            var agentChatItem = new ToolStripMenuItem("Agent Chat");
            agentChatItem.Click += (_, _) => Program.ShowMainWindow<ChatPage>();
            menu.Items.Add(agentChatItem);

            var agentSessionItem = new ToolStripMenuItem("OmniAgent Session");
            agentSessionItem.Click += (_, _) => Program.ShowMainWindow<AgentSessionPage>();
            menu.Items.Add(agentSessionItem);

            var taskInstructionsItem = new ToolStripMenuItem("Task Instructions");
            taskInstructionsItem.Click += (_, _) => Program.ShowMainWindow<TaskInstructionsPage>();
            menu.Items.Add(taskInstructionsItem);

            var mcpServersItem = new ToolStripMenuItem("MCP Servers");
            mcpServersItem.Click += (_, _) => Program.ShowMainWindow<MCPServersPage>();
            menu.Items.Add(mcpServersItem);

            var scheduledJobsItem = new ToolStripMenuItem("Scheduled Jobs");
            scheduledJobsItem.Click += (_, _) => Program.ShowMainWindow<ScheduledJobsPage>();
            menu.Items.Add(scheduledJobsItem);

            menu.Items.Add(new ToolStripSeparator());

            var exitItem = new ToolStripMenuItem("Exit");
            exitItem.Click += (_, _) =>
            {
                // Shut down the WPF dispatcher loop; Program.Main's app.Run()
                // returns, then the tray icon + hotkeys are torn down.
                System.Windows.Application.Current?.Shutdown();
            };
            menu.Items.Add(exitItem);

            return menu;
        }

        // ─── Update checking ──────────────────────────────────────────

        /// <summary>
        /// Runs silently at startup. Shows a balloon tip when an update is found.
        /// </summary>
        private async Task CheckForUpdatesBackgroundAsync()
        {
            var info = await UpdateChecker.CheckAsync();
            if (info == null) return;

            ShowBalloon("OmniKey AI", $"Update {info.Version} is available! Open Settings \u2192 Updates to install.");
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

        /// <summary>
        /// Ctrl+T \u2192 @omniAgent path. Navigates the WPF MainWindow to the
        /// AgentSessionPage and hands the request to
        /// <see cref="AgentSessionViewModel.Shared"/>. The VM either kicks
        /// off the run immediately (when a default session is configured)
        /// or parks the request as <c>PendingRequestText</c> and lets the
        /// user pick from the on-page dropdown.
        /// </summary>
        private Task RunAgentWorkflowAsync(string originalText, IntPtr originalWindow)
        {
            string? storedDefault = AgentSessionPreferences.ReadDefaultSessionId();
            bool hasDefault = !string.IsNullOrWhiteSpace(storedDefault);

            Program.ShowMainWindow<AgentSessionPage>();

            if (hasDefault)
            {
                AgentSessionViewModel.Shared.StartRunWithDefault(originalText);
                ShowBalloon("OmniKey AI", "OmniAgent session started\u2026");
            }
            else
            {
                AgentSessionViewModel.Shared.PreparePendingRun(originalText);
                ShowBalloon("OmniKey AI", "Pick a session in the OmniAgent window to start.");
            }

            // The run is now owned by AgentSessionViewModel; HotkeyForm is
            // done. The unused originalWindow handle is fine \u2014 the user
            // copies the final answer themselves from the page.
            _ = originalWindow;
            return Task.CompletedTask;
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

