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
        private AgentThinkingForm? _agentThinkingForm;

        public HotkeyForm()
        {
            ShowInTaskbar   = false;
            FormBorderStyle = FormBorderStyle.None;
            Size            = new Size(0, 0);
            _notifyIcon = new NotifyIcon { Visible = false };
        }

        // UI removed; HotkeyForm is now message-only

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            RegisterHotkeys();
            // No UI, no auth/init logic here
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnregisterHotkeys();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            base.OnFormClosing(e);
        }

        // ─── Auth initialisation ──────────────────────────────────────

        // Auth/status UI removed

        // ─── Context menu ─────────────────────────────────────────────

        // Context menu removed

        // Navigation UI removed

        // ─── Update checking ──────────────────────────────────────────

        /// <summary>
        /// Runs silently at startup. Shows a balloon tip when an update is found.
        /// </summary>
        // Update checking UI removed

        /// <summary>
        /// Triggered by the "Check for Updates" tray menu item.
        /// Shows the update window when available, or a "you're up to date" balloon.
        /// </summary>
        // Update checking UI removed

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
            // Instead of opening a new AgentThinkingForm, show the Agent Session tab in MainForm
            var mainForm = Application.OpenForms["MainForm"] as MainForm;
            if (mainForm != null)
            {
                mainForm.ShowAgentSessionTab();
                // Optionally, set the request text in the embedded AgentThinkingForm
                // mainForm.AgentThinkingForm.SetInitialRequest(originalText);
            }
            // The rest of the agent workflow logic should be handled by MainForm/AgentThinkingForm
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
