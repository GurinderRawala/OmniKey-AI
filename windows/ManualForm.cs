using System.Drawing;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class ManualForm : Form
    {
        public ManualForm()
        {
            Text          = "OmniKey \u2013 Manual";
            ClientSize    = new Size(900, 620);
            MinimumSize   = new Size(880, 580);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor     = NordColors.WindowBackground;

            // ── Header ────────────────────────────────────────────────────
            var titleLabel = new Label
            {
                Text      = "OmniKey Manual",
                Font      = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(24, 20),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left
            };
            Controls.Add(titleLabel);

            var subtitleLabel = new Label
            {
                Text      = "Use OmniKey AI anywhere on your Windows PC. Select text and activate one of the shortcuts below. " +
                            "OmniKey will process your selected text and paste the improved version back in place.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                Location  = new Point(24, 52),
                Size      = new Size(852, 34),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            Controls.Add(subtitleLabel);

            // Thin separator at y=88
            var separator = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 88),
                Size      = new Size(900, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            Controls.Add(separator);

            // ── Content panel ─────────────────────────────────────────────
            var wrapper = new Panel
            {
                Location  = new Point(16, 94),
                Size      = new Size(868, 466),
                BackColor = NordColors.PanelBackground,
                Padding   = new Padding(20, 14, 20, 14),
                Anchor    = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
            };
            Controls.Add(wrapper);

            var rtb = new RichTextBox
            {
                ReadOnly    = true,
                BorderStyle = BorderStyle.None,
                BackColor   = NordColors.PanelBackground,
                ForeColor   = NordColors.PrimaryText,
                ScrollBars  = RichTextBoxScrollBars.Vertical,
                WordWrap    = true,
                Dock        = DockStyle.Fill,
                Font        = new Font("Segoe UI", 10),
                DetectUrls  = false
            };
            wrapper.Controls.Add(rtb);

            // ── Content ───────────────────────────────────────────────────
            AppendTitle(rtb, "Keyboard shortcuts");

            AppendShortcutLine(rtb,
                "Ctrl+E",
                "Enhance prompts",
                "Improves clarity, structure, and tone of your selected text so it works better as an AI prompt.");

            AppendShortcutLine(rtb,
                "Ctrl+G",
                "Fix grammar and clarity",
                "Focuses on grammar, spelling, and readability without changing the core meaning.");

            AppendShortcutLine(rtb,
                "Ctrl+T",
                "Run your custom task",
                "Applies your saved task instructions to the selected text. Configure these in \"Task Instructions\" from the tray menu.");

            AppendDivider(rtb);
            AppendTitle(rtb, "How OmniKey works");
            AppendBody(rtb,
                "1. Select text in any app (editor, browser, email, etc.).\n" +
                "2. Press one of the OmniKey shortcuts (Ctrl+E, Ctrl+G, or Ctrl+T).\n" +
                "3. OmniKey sends the text securely to the OmniKey AI service.\n" +
                "4. The result is pasted back in place of your original selection.");

            AppendDivider(rtb);
            AppendTitle(rtb, "Custom tasks with Task Instructions");
            AppendBody(rtb,
                "- Open the \"Task Instructions\" window from the OmniKey tray menu.\n" +
                "- Describe the role, style, and rules you want OmniKey to follow when you press Ctrl+T.\n" +
                "- OmniKey will apply those instructions every time you trigger the custom task shortcut.");

            AppendDivider(rtb);
            AppendTitle(rtb, "Asking questions with @omnikeyai");
            AppendBody(rtb,
                "You can also ask OmniKey questions related to your current task.\n\n" +
                "- In your document or editor, write a question starting with \"@omnikeyai\".\n" +
                "    Example: \"@omnikeyai Can you explain step 3 in simpler terms?\"\n" +
                "- Select that question (or the whole block of text around it).\n" +
                "- Press one of the OmniKey shortcuts.\n\n" +
                "OmniKey will treat anything after \"@omnikeyai\" as a direct question and answer in the context of your current text or task.");

            AppendDivider(rtb);
            AppendTitle(rtb, "Running tasks with @omniAgent");
            AppendBody(rtb,
                "You can ask the Omni agent to perform tasks for you using the @omniAgent command.\n\n" +
                "- Type \"@omniAgent\" followed by clear instructions for what you want done.\n" +
                "    Example: \"@omniAgent Set up a new README section describing the API routes.\"\n" +
                "- Select the text containing your @omniAgent instructions.\n" +
                "- Press Ctrl+T to run your custom task.\n\n" +
                "If you have Task Instructions configured, the agent will combine those with the instructions you provided using \"@omniAgent\" and then execute the task.\n\n" +
                "The agent can access your terminal and perform actions through it, but it runs with restricted permissions. " +
                "It cannot run commands with \"sudo\" or install additional software needed to complete tasks.");

            // Scroll back to top after populating
            rtb.SelectionStart = 0;
            rtb.ScrollToCaret();

            // ── Close button ──────────────────────────────────────────────
            var closeButton = new Button
            {
                Text      = "Close",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.SurfaceBackground,
                FlatStyle = FlatStyle.Flat,
                Size      = new Size(80, 28),
                Location  = new Point(804, 580),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Right
            };
            closeButton.FlatAppearance.BorderColor        = NordColors.Border;
            closeButton.FlatAppearance.MouseOverBackColor = NordColors.PanelBackground;
            closeButton.Click += (_, _) => Close();
            Controls.Add(closeButton);
        }

        // ── Helpers ───────────────────────────────────────────────────────

        private static void AppendTitle(RichTextBox rtb, string text)
        {
            // Accent bar prefix in AccentCyan
            rtb.SelectionFont  = new Font("Segoe UI", 11, FontStyle.Bold);
            rtb.SelectionColor = NordColors.AccentCyan;
            rtb.AppendText("\u258c ");

            // Title text in AccentBlue
            rtb.SelectionColor = NordColors.AccentBlue;
            rtb.AppendText(text + "\n\n");
        }

        private static void AppendBody(RichTextBox rtb, string text)
        {
            rtb.SelectionFont  = new Font("Segoe UI", 10);
            rtb.SelectionColor = NordColors.PrimaryText;
            rtb.AppendText(text + "\n\n");
        }

        private static void AppendDivider(RichTextBox rtb)
        {
            // Empty spacer instead of a line of ─ chars
            rtb.SelectionFont  = new Font("Segoe UI", 6);
            rtb.SelectionColor = NordColors.Border;
            rtb.AppendText("\n");
        }

        private static void AppendShortcutLine(RichTextBox rtb, string keys, string label, string desc)
        {
            // Key combo in AccentAmber bold monospace
            rtb.SelectionFont  = new Font("Consolas", 10, FontStyle.Bold);
            rtb.SelectionColor = NordColors.AccentAmber;
            rtb.AppendText(keys + "  ");

            // Label in PrimaryText bold
            rtb.SelectionFont  = new Font("Segoe UI", 10, FontStyle.Bold);
            rtb.SelectionColor = NordColors.PrimaryText;
            rtb.AppendText(label + "\n");

            // Description in SecondaryText
            rtb.SelectionFont  = new Font("Segoe UI", 9);
            rtb.SelectionColor = NordColors.SecondaryText;
            rtb.AppendText("    " + desc + "\n\n");
        }
    }
}
