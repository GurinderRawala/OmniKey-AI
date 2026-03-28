using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class ManualForm : Form
    {
        public ManualForm()
        {
            Text            = "OmniKey - Manual";
            ClientSize      = new Size(900, 640);
            MinimumSize     = new Size(640, 480);
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            DoubleBuffered  = true;

            // ── Footer panel (docked bottom) ──────────────────────────────
            var footerPanel = new Panel
            {
                Dock      = DockStyle.Bottom,
                Height    = 52,
                BackColor = NordColors.WindowBackground,
            };
            var footerSep = new Panel
            {
                Dock      = DockStyle.Top,
                Height    = 1,
                BackColor = NordColors.Border,
            };
            var closeButton = new Button
            {
                Text      = "Close",
                Font      = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                BackColor = NordColors.SurfaceBackground,
                FlatStyle = FlatStyle.Flat,
                Size      = new Size(88, 32),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right,
            };
            closeButton.Location = new Point(ClientSize.Width - closeButton.Width - 16, 10);
            closeButton.FlatAppearance.BorderColor        = NordColors.Border;
            closeButton.FlatAppearance.MouseOverBackColor = NordColors.PanelBackground;
            closeButton.Click += (_, _) => Close();
            footerPanel.Controls.Add(closeButton);
            footerPanel.Controls.Add(footerSep);

            // ── Header panel (docked top) ─────────────────────────────────
            var headerPanel = new Panel
            {
                Dock      = DockStyle.Top,
                Height    = 88,
                BackColor = NordColors.WindowBackground,
            };
            var titleLabel = new Label
            {
                Text      = "OmniKey Manual",
                Font      = new Font("Segoe UI", 16, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Location  = new Point(24, 18),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left,
            };
            var subtitleLabel = new Label
            {
                Text      = "Use OmniKey AI anywhere on your Windows PC. Select text and activate one of the shortcuts below. " +
                            "OmniKey will process your selected text and paste the improved version back in place.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(24, 52),
                Size      = new Size(ClientSize.Width - 48, 32),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };
            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(subtitleLabel);

            // ── Header separator ──────────────────────────────────────────
            var separator = new Panel
            {
                Dock      = DockStyle.Top,
                Height    = 1,
                BackColor = NordColors.Border,
            };

            // ── Scrollable content area (fill) ────────────────────────────
            var scrollWrapper = new Panel
            {
                Dock       = DockStyle.Fill,
                BackColor  = NordColors.PanelBackground,
                AutoScroll = true,
            };

            var contentFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                WrapContents  = false,
                AutoSize      = true,
                AutoSizeMode  = AutoSizeMode.GrowAndShrink,
                BackColor     = NordColors.PanelBackground,
                Padding       = new Padding(16, 16, 24, 16),
            };
            scrollWrapper.Controls.Add(contentFlow);

            // Compute content width from current client size
            int contentW = ClientSize.Width
                           - contentFlow.Padding.Left
                           - contentFlow.Padding.Right
                           - SystemInformation.VerticalScrollBarWidth;

            // ── Section: Keyboard Shortcuts ───────────────────────────────
            contentFlow.Controls.Add(MakeSectionHeader("Keyboard Shortcuts", NordColors.AccentBlue, contentW));

            contentFlow.Controls.Add(MakeShortcutRow(
                "Ctrl+E",
                "Enhance Prompts",
                "Improves clarity, structure, and tone of your selected text so it works better as an AI prompt.",
                contentW));

            contentFlow.Controls.Add(MakeShortcutRow(
                "Ctrl+G",
                "Fix Grammar & Clarity",
                "Focuses on grammar, spelling, and readability without changing the core meaning.",
                contentW));

            contentFlow.Controls.Add(MakeShortcutRow(
                "Ctrl+T",
                "Run Custom Task",
                "Applies your saved task instructions to the selected text. Configure these in \"Task Instructions\" from the tray menu.",
                contentW));

            contentFlow.Controls.Add(MakeDivider(contentW));

            // ── Section: How OmniKey Works ────────────────────────────────
            contentFlow.Controls.Add(MakeSectionHeader("How OmniKey Works", NordColors.AccentCyan, contentW));
            contentFlow.Controls.Add(MakeBodyBlock(
                "1.  Select text in any app (editor, browser, email, etc.).\n" +
                "2.  Press one of the OmniKey shortcuts (Ctrl+E, Ctrl+G, or Ctrl+T).\n" +
                "3.  OmniKey sends the text securely to the OmniKey AI service.\n" +
                "4.  The result is pasted back in place of your original selection.",
                contentW));

            contentFlow.Controls.Add(MakeDivider(contentW));

            // ── Section: Custom Tasks ─────────────────────────────────────
            contentFlow.Controls.Add(MakeSectionHeader("Custom Tasks with Task Instructions", NordColors.AccentPurple, contentW));
            contentFlow.Controls.Add(MakeBodyBlock(
                "Open the \"Task Instructions\" window from the OmniKey tray menu.\n" +
                "Describe the role, style, and rules you want OmniKey to follow when you press Ctrl+T.\n" +
                "OmniKey will apply those instructions every time you trigger the custom task shortcut.",
                contentW));

            contentFlow.Controls.Add(MakeDivider(contentW));

            // ── Section: @omnikeyai ───────────────────────────────────────
            contentFlow.Controls.Add(MakeSectionHeader("Asking Questions with @omnikeyai", NordColors.AccentGreen, contentW));
            contentFlow.Controls.Add(MakeBodyBlock(
                "You can ask OmniKey questions related to your current task.\n\n" +
                "In your document or editor, write a question starting with \"@omnikeyai\".\n" +
                "    Example:  \"@omnikeyai Can you explain step 3 in simpler terms?\"\n\n" +
                "Select that question (or the whole block of text around it), then press one of the OmniKey shortcuts.\n" +
                "OmniKey will treat anything after \"@omnikeyai\" as a direct question and answer in the context of your current text or task.",
                contentW));

            contentFlow.Controls.Add(MakeDivider(contentW));

            // ── Section: @omniAgent ───────────────────────────────────────
            contentFlow.Controls.Add(MakeSectionHeader("Running Tasks with @omniAgent", NordColors.AccentAmber, contentW));
            contentFlow.Controls.Add(MakeBodyBlock(
                "Ask the Omni agent to perform tasks for you using the @omniAgent command.\n\n" +
                "Type \"@omniAgent\" followed by clear instructions for what you want done.\n" +
                "    Example:  \"@omniAgent Set up a new README section describing the API routes.\"\n\n" +
                "Select the text containing your @omniAgent instructions, then press Ctrl+T to run your custom task.\n\n" +
                "If you have Task Instructions configured, the agent will combine those with your @omniAgent instructions and execute the task.\n\n" +
                "The agent can access your terminal but runs with restricted permissions. " +
                "It cannot run commands with \"sudo\" or install additional software.",
                contentW));

            // ── Keep scroll position at top ───────────────────────────────
            scrollWrapper.AutoScrollPosition = new Point(0, 0);

            // ── Resize: keep content width in sync with scroll area ───────
            scrollWrapper.SizeChanged += (_, _) =>
            {
                int w = scrollWrapper.ClientSize.Width
                        - contentFlow.Padding.Left
                        - contentFlow.Padding.Right
                        - SystemInformation.VerticalScrollBarWidth;
                if (w < 100) return;
                foreach (Control c in contentFlow.Controls)
                    c.Width = w;
            };

            // ── Add panels to form (order matters for docking) ────────────
            Controls.Add(footerPanel);
            Controls.Add(headerPanel);
            Controls.Add(separator);
            Controls.Add(scrollWrapper);
        }

        // ── Section header: colored left bar + circle icon + bold title ────

        private static Panel MakeSectionHeader(string title, Color accent, int width)
        {
            var panel = new Panel
            {
                Width     = width,
                Height    = 44,
                BackColor = NordColors.PanelBackground,
                Margin    = new Padding(0, 8, 0, 8),
            };
            panel.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

                // Left accent bar
                using var barBrush = new SolidBrush(accent);
                using var barPath  = GfxHelpers.RoundedPath(new RectangleF(0, 8, 4, 28), 2f);
                e.Graphics.FillPath(barBrush, barPath);

                // Icon circle background
                using var iconBg = new SolidBrush(Color.FromArgb(30, accent));
                e.Graphics.FillEllipse(iconBg, 12, 10, 24, 24);

                // Icon dots (simple list-like indicator)
                using var dotBrush = new SolidBrush(accent);
                float cx = 24, cy = 22;
                float dr = 2.5f;
                e.Graphics.FillEllipse(dotBrush, cx - dr, cy - 6f,  dr * 2, dr * 2);
                e.Graphics.FillEllipse(dotBrush, cx - dr, cy - 1f,  dr * 2, dr * 2);
                e.Graphics.FillEllipse(dotBrush, cx - dr, cy + 4f,  dr * 2, dr * 2);

                // Title text
                TextRenderer.DrawText(e.Graphics, title,
                    new Font("Segoe UI", 11, FontStyle.Bold),
                    new Rectangle(42, 0, panel.Width - 46, panel.Height),
                    accent, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            };
            return panel;
        }

        // ── Shortcut row: key pill badges + name + description ─────────────

        private static Panel MakeShortcutRow(string keys, string label, string desc, int width)
        {
            const int padH   = 16;
            const int padV   = 14;
            const int badgeH = 26;
            const int gap    = 10;

            int innerW   = width - padH * 2;
            var descFont = new Font("Segoe UI", 9f);
            var descSize = TextRenderer.MeasureText(desc, descFont, new Size(innerW, int.MaxValue),
                TextFormatFlags.WordBreak);
            int rowH = padV + badgeH + gap + descSize.Height + padV;

            var row = new Panel
            {
                Width     = width,
                Height    = rowH,
                BackColor = NordColors.SurfaceBackground,
                Margin    = new Padding(0, 0, 0, 10),
            };
            row.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var pen = new Pen(NordColors.Border, 1);
                GfxHelpers.DrawRoundedRect(e.Graphics, pen,
                    new RectangleF(0, 0, row.Width - 1, row.Height - 1), 8);
            };

            // Key badges flow (left side of top row)
            var badgesFlow = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents  = false,
                AutoSize      = true,
                Location      = new Point(padH, padV),
                BackColor     = Color.Transparent,
            };

            // Parse key combo like "Ctrl+E" -> ["Ctrl", "E"]
            var keyParts = keys.Split('+');
            for (int i = 0; i < keyParts.Length; i++)
            {
                badgesFlow.Controls.Add(MakeKeyBadge(keyParts[i].Trim()));
                if (i < keyParts.Length - 1)
                {
                    badgesFlow.Controls.Add(new Label
                    {
                        Text      = "+",
                        Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                        ForeColor = NordColors.SecondaryText,
                        AutoSize  = true,
                        Margin    = new Padding(3, 5, 3, 0),
                        BackColor = Color.Transparent,
                    });
                }
            }

            // Shortcut label (bold, right of badges)
            var nameLabel = new Label
            {
                Text      = "  " + label,
                Font      = new Font("Segoe UI", 10, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = true,
                Margin    = new Padding(10, 3, 0, 0),
                BackColor = Color.Transparent,
            };
            badgesFlow.Controls.Add(nameLabel);

            // Description
            var descLabel = new Label
            {
                Text      = desc,
                Font      = descFont,
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(padH, padV + badgeH + gap),
                Size      = new Size(innerW, descSize.Height),
                BackColor = Color.Transparent,
            };

            row.Controls.Add(badgesFlow);
            row.Controls.Add(descLabel);
            return row;
        }

        // ── Key badge: pill-shaped keyboard key ────────────────────────────

        private static Panel MakeKeyBadge(string keyText)
        {
            var lbl = new Label
            {
                Text      = keyText,
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Bold),
                ForeColor = NordColors.AccentAmber,
                AutoSize  = true,
                BackColor = Color.Transparent,
                Location  = new Point(9, 5),
                Margin    = Padding.Empty,
            };

            int w = lbl.PreferredWidth + 20;
            int h = lbl.PreferredHeight + 10;

            var badge = new Panel
            {
                Size      = new Size(w, h),
                BackColor = Color.Transparent,
                Margin    = new Padding(0, 0, 4, 0),
            };
            badge.Paint += (_, e) =>
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using var bgBrush = new SolidBrush(NordColors.AmberSectionFill);
                using var border  = new Pen(NordColors.AmberSectionBorder, 1);
                GfxHelpers.FillRoundedRect(e.Graphics, bgBrush,
                    new RectangleF(0, 0, badge.Width - 1, badge.Height - 1), 6);
                GfxHelpers.DrawRoundedRect(e.Graphics, border,
                    new RectangleF(0, 0, badge.Width - 1, badge.Height - 1), 6);
            };
            badge.Controls.Add(lbl);
            return badge;
        }

        // ── Body text block ────────────────────────────────────────────────

        private static Panel MakeBodyBlock(string text, int width)
        {
            var bodyFont = new Font("Segoe UI", 9.5f);
            var measured = TextRenderer.MeasureText(text, bodyFont, new Size(width - 24, int.MaxValue),
                TextFormatFlags.WordBreak);
            var lbl = new Label
            {
                Text      = text,
                Font      = bodyFont,
                ForeColor = NordColors.PrimaryText,
                AutoSize  = false,
                Size      = new Size(width - 8, measured.Height + 8),
                BackColor = NordColors.PanelBackground,
                Padding   = new Padding(4, 0, 0, 0),
            };
            return new Panel
            {
                Width     = width,
                Height    = lbl.Height,
                BackColor = NordColors.PanelBackground,
                Margin    = new Padding(0, 2, 0, 8),
                Controls  = { lbl },
            };
        }

        // ── Thin horizontal divider ────────────────────────────────────────

        private static Panel MakeDivider(int width)
        {
            return new Panel
            {
                Width     = width,
                Height    = 1,
                BackColor = NordColors.Border,
                Margin    = new Padding(0, 12, 0, 16),
            };
        }
    }
}
