using System;
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
            };

            Controls.Add(titleLabel);
            Controls.Add(subtitleLabel);
            Controls.Add(_statusLabel);
            Controls.Add(_contentBox);

            Shown += async (_, _) => await LoadHistoryAsync();
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
                if (messages.Count == 0)
                {
                    _statusLabel.Text = "No messages found for this run.";
                    return;
                }

                var userMessages = messages
                    .Where(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))
                    .Select(m => m.Text)
                    .Where(t => !string.IsNullOrWhiteSpace(t))
                    .ToList();

                var agentMessages = messages
                    .Where(m => string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase))
                    .Select(m => m.Text)
                    .Where(t => !string.IsNullOrWhiteSpace(t))
                    .ToList();

                var sb = new StringBuilder();

                if (userMessages.Count > 0)
                {
                    sb.AppendLine("=== Job Prompt ===");
                    sb.AppendLine(userMessages[0]);
                    sb.AppendLine();
                }

                if (agentMessages.Count > 0)
                {
                    sb.AppendLine("=== Agent Reasoning ===");
                    for (int i = 0; i < agentMessages.Count; i++)
                    {
                        sb.AppendLine($"{i + 1}. {agentMessages[i]}");
                        sb.AppendLine();
                    }
                }

                if (userMessages.Count > 1)
                {
                    sb.AppendLine("=== Tool Outputs ===");
                    foreach (var output in userMessages.Skip(1))
                    {
                        sb.AppendLine(output);
                        sb.AppendLine();
                    }
                }

                _contentBox.Text = sb.ToString().Trim();
                _statusLabel.Text = "";
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
                    if (messages.Count == 0)
                    {
                        _statusLabel.Text = "No messages found for this run.";
                        return;
                    }
                    _contentBox.Text = string.Join(Environment.NewLine + Environment.NewLine, messages.Select(m => $"[{m.Role}]\n{m.Text}"));
                    _statusLabel.Text = "";
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
    }
}
