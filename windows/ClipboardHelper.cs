using System;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal static class ClipboardHelper
    {
        // Capture currently selected text by sending Ctrl+C to the active window.
        // NOTE: This must run on the UI (STA) thread; do not wrap in Task.Run.
        public static async Task<string?> CaptureSelectionAsync()
        {
            try
            {
                string? before = null;
                if (Clipboard.ContainsText())
                {
                    before = Clipboard.GetText();
                }

                // Send Ctrl+C to copy current selection
                SendKeys.SendWait("^c");

                await Task.Delay(200);

                string? after = null;
                if (Clipboard.ContainsText())
                {
                    after = Clipboard.GetText();
                }

                if (string.IsNullOrWhiteSpace(after) || string.Equals(before, after, StringComparison.Ordinal))
                {
                    return null;
                }

                return after;
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
