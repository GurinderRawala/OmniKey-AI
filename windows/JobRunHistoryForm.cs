using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class JobRunHistoryForm : Form
    {
        private readonly ApiClient _api;
        private readonly string _jobLabel;
        private readonly string _sessionId;

        private readonly Label _statusLabel;
        private readonly RichTextBox _contentBox;
        private readonly Button _copyFinalAnswerButton;

        /// <summary>
        /// The extracted final answer for this run, or <c>null</c> when none is
        /// available. Surfaced so the "Copy Final Answer" button works without
        /// re-parsing the displayed text.
        /// </summary>
        private string? _finalAnswer;

        public JobRunHistoryForm(ApiClient api, string jobLabel, string sessionId)
        {
            _api = api;
            _jobLabel = jobLabel;
            _sessionId = sessionId;

            Text = $"Last Run Details - {jobLabel}";
            StartPosition = FormStartPosition.CenterParent;
            Size = new Size(920, 700);
            MinimumSize = new Size(760, 520);
            BackColor = NordColors.WindowBackground;
            Icon = UIStyles.AppIcon;

            var titleLabel = new Label
            {
                Text = "Last Run Details",
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 14),
            };

            var subtitleLabel = new Label
            {
                Text = $"Steps the agent took during the last scheduled run for \"{jobLabel}\".",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 42),
            };

            _statusLabel = new Label
            {
                Text = "Loading...",
                Font = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                BackColor = NordColors.WindowBackground,
                AutoSize = true,
                Location = new Point(16, 66),
            };

            _copyFinalAnswerButton = UIStyles.MakeSecondaryButton(
                "  Copy Final Answer",
                new Size(170, 28),
                WinIcons.ClipboardIcon(14, NordColors.AccentGreen));
            _copyFinalAnswerButton.ForeColor = NordColors.AccentGreen;
            _copyFinalAnswerButton.BackColor = NordColors.GreenSectionFill;
            _copyFinalAnswerButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _copyFinalAnswerButton.Visible = false;
            _copyFinalAnswerButton.FlatAppearance.BorderColor = NordColors.GreenSectionBorder;
            _copyFinalAnswerButton.FlatAppearance.MouseOverBackColor = NordColors.GreenSectionFill;
            _copyFinalAnswerButton.Click += OnCopyFinalAnswerClick;

            _contentBox = new RichTextBox
            {
                Location = new Point(16, 92),
                Size = new Size(870, 560),
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                BackColor = NordColors.EditorBackground,
                ForeColor = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Segoe UI", 10),
                ReadOnly = true,
                WordWrap = true,
                DetectUrls = false,
            };

            Controls.Add(titleLabel);
            Controls.Add(subtitleLabel);
            Controls.Add(_statusLabel);
            Controls.Add(_copyFinalAnswerButton);
            Controls.Add(_contentBox);

            // Anchor the copy button to the top-right of the form so it stays
            // visible when the window is resized.
            Layout += (_, _) => PositionCopyButton();
            PositionCopyButton();

            Shown += async (_, _) => await LoadHistoryAsync();
        }

        private void PositionCopyButton()
        {
            int rightPad = 30;
            _copyFinalAnswerButton.Location =
                new Point(ClientSize.Width - _copyFinalAnswerButton.Width - rightPad, 60);
        }

        private async Task LoadHistoryAsync()
        {
            try
            {
                if (string.IsNullOrWhiteSpace(SubscriptionManager.Instance.JwtToken))
                {
                    bool activated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                    if (!activated)
                    {
                        _statusLabel.Text = "Not authenticated.";
                        return;
                    }
                }

                var messages = await _api.FetchSessionMessagesAsync(_sessionId);
                RenderMessages(messages);
            }
            catch (ApiException ex) when (ex.StatusCode == 401 || ex.StatusCode == 403)
            {
                bool reactivated = await SubscriptionManager.Instance.ReactivateStoredKeyIfNeededAsync();
                if (!reactivated)
                {
                    _statusLabel.Text = "Not authenticated.";
                    return;
                }

                try
                {
                    var messages = await _api.FetchSessionMessagesAsync(_sessionId);
                    RenderMessages(messages);
                }
                catch (Exception retryEx)
                {
                    _statusLabel.Text = "Error: " + retryEx.Message;
                }
            }
            catch (Exception ex)
            {
                _statusLabel.Text = "Error: " + ex.Message;
            }
        }

        /// <summary>
        /// Renders the session transcript into the rich text box, surfacing the
        /// final answer as a highlighted top section with a dedicated copy
        /// button — mirroring how <see cref="AgentThinkingForm.SetFinalAnswer"/>
        /// presents the final response in the live agent view.
        /// </summary>
        private void RenderMessages(IList<SessionHistoryEntryDto> messages)
        {
            if (messages == null || messages.Count == 0)
            {
                _statusLabel.Text = "No messages found for this run.";
                _contentBox.Clear();
                _finalAnswer = null;
                _copyFinalAnswerButton.Visible = false;
                return;
            }

            var userMessages = messages
                .Where(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))
                .Select(m => m.Text)
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();

            var assistantMessages = messages
                .Where(m => string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase))
                .Select(m => m.Text)
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();

            // Find the final answer: prefer a <final_answer>…</final_answer>
            // block (newest first), fall back to the last assistant message.
            // Tracks the assistant-message index so we can exclude it from the
            // reasoning steps below.
            int finalAnswerIndex = -1;
            string? finalAnswer = null;
            for (int i = assistantMessages.Count - 1; i >= 0; i--)
            {
                var extracted = ExtractFinalAnswer(assistantMessages[i]);
                if (!string.IsNullOrWhiteSpace(extracted))
                {
                    finalAnswer = extracted!.Trim();
                    finalAnswerIndex = i;
                    break;
                }
            }
            if (finalAnswer == null && assistantMessages.Count > 0)
            {
                finalAnswer = assistantMessages[^1].Trim();
                finalAnswerIndex = assistantMessages.Count - 1;
            }

            _finalAnswer = string.IsNullOrWhiteSpace(finalAnswer) ? null : finalAnswer;
            _copyFinalAnswerButton.Visible = _finalAnswer != null;

            var reasoningMessages = new List<string>(assistantMessages.Count);
            for (int i = 0; i < assistantMessages.Count; i++)
            {
                if (i == finalAnswerIndex) continue;
                reasoningMessages.Add(StripFinalAnswerTags(assistantMessages[i]));
            }

            _contentBox.SuspendLayout();
            _contentBox.Clear();

            if (_finalAnswer != null)
            {
                AppendSectionHeader("=== Final Answer ===", NordColors.AccentGreen);
                AppendBody(_finalAnswer);
                AppendBlankLine();
            }

            if (userMessages.Count > 0)
            {
                AppendSectionHeader("=== Job Prompt ===", NordColors.AccentBlue);
                AppendBody(userMessages[0]);
                AppendBlankLine();
            }

            if (reasoningMessages.Count > 0)
            {
                AppendSectionHeader("=== Agent Reasoning ===", NordColors.AccentPurple);
                for (int i = 0; i < reasoningMessages.Count; i++)
                {
                    AppendBody($"{i + 1}. {reasoningMessages[i]}");
                    AppendBlankLine();
                }
            }

            if (userMessages.Count > 1)
            {
                AppendSectionHeader("=== Tool Outputs ===", NordColors.AccentAmber);
                foreach (var output in userMessages.Skip(1))
                {
                    AppendBody(output);
                    AppendBlankLine();
                }
            }

            // Reset caret + scroll back to the top so the final answer is the
            // first thing the user sees.
            _contentBox.SelectionStart = 0;
            _contentBox.SelectionLength = 0;
            _contentBox.ScrollToCaret();
            _contentBox.ResumeLayout();

            _statusLabel.Text = "";
        }

        private void OnCopyFinalAnswerClick(object? sender, EventArgs e)
        {
            if (string.IsNullOrEmpty(_finalAnswer)) return;
            try { Clipboard.SetText(_finalAnswer); } catch { /* ignore */ }

            _copyFinalAnswerButton.Text = "  Copied!";
            _copyFinalAnswerButton.Image = WinIcons.Checkmark(14, NordColors.AccentGreen);

            var timer = new System.Windows.Forms.Timer { Interval = 1500 };
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                timer.Dispose();
                if (IsDisposed || _copyFinalAnswerButton.IsDisposed) return;
                _copyFinalAnswerButton.Text = "  Copy Final Answer";
                _copyFinalAnswerButton.Image = WinIcons.ClipboardIcon(14, NordColors.AccentGreen);
            };
            timer.Start();
        }

        // ─── RichTextBox helpers ──────────────────────────────────────

        private void AppendSectionHeader(string text, Color color)
        {
            int start = _contentBox.TextLength;
            _contentBox.AppendText(text + Environment.NewLine);
            _contentBox.Select(start, text.Length);
            _contentBox.SelectionColor = color;
            _contentBox.SelectionFont = new Font("Segoe UI", 10, FontStyle.Bold);
            _contentBox.Select(_contentBox.TextLength, 0);
            _contentBox.SelectionColor = NordColors.PrimaryText;
            _contentBox.SelectionFont = _contentBox.Font;
        }

        private void AppendBody(string text)
        {
            _contentBox.SelectionColor = NordColors.PrimaryText;
            _contentBox.SelectionFont = _contentBox.Font;
            _contentBox.AppendText(text + Environment.NewLine);
        }

        private void AppendBlankLine()
        {
            _contentBox.AppendText(Environment.NewLine);
        }

        // ─── Text parsing helpers ─────────────────────────────────────

        /// <summary>
        /// Extracts the inner text of a <c>&lt;final_answer&gt;…&lt;/final_answer&gt;</c>
        /// block. Kept in sync with <c>AgentRunner.ExtractFinalAnswer</c> so the
        /// scheduled-job view surfaces the same final answer the live runner uses.
        /// </summary>
        private static string? ExtractFinalAnswer(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            int start = text.IndexOf("<final_answer>", StringComparison.Ordinal);
            if (start < 0) return null;
            start += "<final_answer>".Length;
            int end = text.IndexOf("</final_answer>", start, StringComparison.Ordinal);
            if (end < 0) return null;
            return text[start..end].Trim();
        }

        /// <summary>
        /// Removes any stray <c>&lt;final_answer&gt;</c> wrapper tags from a
        /// reasoning step so the displayed transcript stays clean.
        /// </summary>
        private static string StripFinalAnswerTags(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            return text
                .Replace("<final_answer>", string.Empty)
                .Replace("</final_answer>", string.Empty)
                .Trim();
        }
    }
}
