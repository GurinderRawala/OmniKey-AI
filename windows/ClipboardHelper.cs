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
                // Capture sequence number and text BEFORE copying so we can detect change.
                // NOTE: Do NOT await anything before SendKeys — any delay here allows
                // queued Windows messages (e.g. from the balloon tip) to be processed
                // and potentially shift keyboard focus away from the user's window,
                // causing Ctrl+C to be sent to the wrong target.
                uint seqBefore = GetClipboardSequenceNumber();
                string? textBefore = Clipboard.ContainsText() ? Clipboard.GetText() : null;

                // Send Ctrl+C to copy current selection
                SendKeys.SendWait("^c");

                await Task.Delay(250);

                uint seqAfter = GetClipboardSequenceNumber();

                // Primary check: sequence number changed — avoids the false-negative
                // where the selected text is identical to what was already on the clipboard.
                // Fallback to text comparison if GetClipboardSequenceNumber is unavailable
                // (returns 0, e.g. restricted window-station access).
                if (seqBefore != 0 && seqAfter != 0)
                {
                    if (seqAfter == seqBefore)
                        return null;
                }
                else
                {
                    if (!Clipboard.ContainsText())
                        return null;
                    string textAfter = Clipboard.GetText();
                    if (string.IsNullOrWhiteSpace(textAfter) || string.Equals(textBefore, textAfter, StringComparison.Ordinal))
                        return null;
                }

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
