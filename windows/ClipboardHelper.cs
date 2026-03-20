using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal static class ClipboardHelper
    {
        [DllImport("user32.dll")]
        private static extern uint GetClipboardSequenceNumber();

        // Capture currently selected text by sending Ctrl+C to the active window.
        // NOTE: This must run on the UI (STA) thread; do not wrap in Task.Run.
        public static async Task<string?> CaptureSelectionAsync()
        {
            try
            {
                // Small settle delay so modifier keys from the triggering hotkey
                // (e.g. Ctrl held during Ctrl+E) are physically released before we
                // inject a new Ctrl+C, preventing key-state interference.
                await Task.Delay(80);

                uint seqBefore = GetClipboardSequenceNumber();

                // Send Ctrl+C to copy current selection
                SendKeys.SendWait("^c");

                await Task.Delay(250);

                // Compare sequence numbers rather than clipboard text — avoids the
                // false-negative where the selected text is identical to what was
                // already on the clipboard (string equality check was the old bug).
                if (GetClipboardSequenceNumber() == seqBefore)
                    return null;

                if (!Clipboard.ContainsText())
                    return null;

                return Clipboard.GetText();
            }
            catch
            {
                return null;
            }
        }

        public static async Task ReplaceSelectionAsync(string newText)
        {
            try
            {
                Clipboard.SetText(newText);
                await Task.Delay(100);
                // Paste via Ctrl+V
                SendKeys.SendWait("^v");
            }
            catch
            {
                // Ignore
            }
        }

        public static string NormalizeOriginalText(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
                return string.Empty;

            var result = text.Trim();

            return result;
        }
    }
}
