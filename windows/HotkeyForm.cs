using System;
using System.Drawing;
using System.Runtime.InteropServices;
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
        private const int HOTKEY_ID_TASK = 3;

        private readonly NotifyIcon _notifyIcon;
        private readonly ApiClient _apiClient = new ApiClient();
        private bool _isProcessing;

        public HotkeyForm()
        {
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            Opacity = 0;

            _notifyIcon = new NotifyIcon
            {
                Text = "OmniKey AI",
                Icon = SystemIcons.Information,
                Visible = true,
                ContextMenuStrip = BuildContextMenu(),
            };
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            RegisterHotkeys();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnregisterHotkeys();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            base.OnFormClosing(e);
        }

        private ContextMenuStrip BuildContextMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Fix Prompt (Ctrl+E)...");
            menu.Items.Add("Fix Grammar (Ctrl+G)...");
            menu.Items.Add("Custom Task (Ctrl+T)...");
            menu.Items.Add(new ToolStripSeparator());

            var exitItem = new ToolStripMenuItem("Exit");
            exitItem.Click += (_, _) => Application.Exit();
            menu.Items.Add(exitItem);

            return menu;
        }

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
                ShowBalloon("OmniKey AI", "Already processing a selection. Please wait...");
                return;
            }

            _isProcessing = true;

            try
            {
                var command = id switch
                {
                    HOTKEY_ID_ENHANCE => EnhanceCommand.Enhance,
                    HOTKEY_ID_GRAMMAR => EnhanceCommand.Grammar,
                    HOTKEY_ID_TASK => EnhanceCommand.Task,
                    _ => EnhanceCommand.Enhance,
                };

                string actionName = command switch
                {
                    EnhanceCommand.Enhance => "Enhancing Prompt",
                    EnhanceCommand.Grammar => "Fixing Grammar",
                    EnhanceCommand.Task => "Performing Custom Task",
                    _ => "Processing",
                };

                ShowBalloon("OmniKey AI", actionName + "...");

                // Copy current selection via Ctrl+C and read clipboard
                string? selected = await ClipboardHelper.CaptureSelectionAsync();
                if (string.IsNullOrWhiteSpace(selected))
                {
                    ShowBalloon("OmniKey AI", "No text selected. Please select text and try again.");
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

                await ClipboardHelper.ReplaceSelectionAsync(result);
                ShowBalloon("OmniKey AI", "Text updated.");
            }
            finally
            {
                _isProcessing = false;
            }
        }

        private void RegisterHotkeys()
        {
            // Ctrl+E
            RegisterHotKey(Handle, HOTKEY_ID_ENHANCE, MOD_CONTROL, (uint)Keys.E);
            // Ctrl+G
            RegisterHotKey(Handle, HOTKEY_ID_GRAMMAR, MOD_CONTROL, (uint)Keys.G);
            // Ctrl+T
            RegisterHotKey(Handle, HOTKEY_ID_TASK, MOD_CONTROL, (uint)Keys.T);
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
            _notifyIcon.BalloonTipText = text;
            _notifyIcon.ShowBalloonTip(3000);
        }

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    }
}
