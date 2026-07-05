using System;
using System.Drawing;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    /// <summary>
    /// First-launch modal that displays the Terms &amp; Conditions bundled
    /// with the app and forces the user to explicitly accept before the
    /// tray + hotkeys + subscription flow start. Visually mirrors
    /// <see cref="LicenseForm"/> (Nord palette, WinForms) so the two
    /// first-launch dialogs feel like the same product.
    ///
    /// Contract:
    ///   - <see cref="DialogResult.OK"/> means the user clicked "I Accept"
    ///     and <see cref="TermsAcceptance.RecordAcceptance"/> was called.
    ///   - Anything else (Cancel / close button / "Decline &amp; Quit")
    ///     means the caller should exit the process.
    /// </summary>
    internal sealed class TermsForm : Form
    {
        private readonly TextBox _termsBox;
        private readonly Button  _acceptButton;
        private readonly Button  _declineButton;

        public TermsForm()
        {
            Text            = "OmniKey AI — Terms & Conditions";
            Size            = new Size(720, 620);
            MinimumSize     = new Size(640, 520);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            StartPosition   = FormStartPosition.CenterScreen;
            BackColor       = NordColors.WindowBackground;
            Icon            = UIStyles.AppIcon;
            KeyPreview      = true;

            // ── Header ────────────────────────────────────────────────────
            var headerPanel = new Panel
            {
                BackColor = NordColors.SurfaceBackground,
                Location  = new Point(0, 0),
                Size      = new Size(720, 110),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };

            var titleLabel = new Label
            {
                Text      = "Terms & Conditions",
                Font      = new Font("Segoe UI", 15, FontStyle.Bold),
                ForeColor = NordColors.PrimaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 22),
                Size      = new Size(720, 34),
            };

            var descLabel = new Label
            {
                Text      = "Please review and accept the terms before using OmniKey AI.",
                Font      = new Font("Segoe UI", 9),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Location  = new Point(0, 62),
                Size      = new Size(720, 22),
            };

            headerPanel.Controls.Add(titleLabel);
            headerPanel.Controls.Add(descLabel);

            var headerBorder = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 109),
                Size      = new Size(720, 1),
                Anchor    = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };

            // ── Body: read-only, scrollable terms text ───────────────────
            _termsBox = new TextBox
            {
                Multiline   = true,
                ReadOnly    = true,
                ScrollBars  = ScrollBars.Vertical,
                WordWrap    = true,
                Font        = new Font("Segoe UI", 9.5f),
                BackColor   = NordColors.EditorBackground,
                ForeColor   = NordColors.PrimaryText,
                BorderStyle = BorderStyle.FixedSingle,
                Location    = new Point(20, 122),
                Size        = new Size(680, 380),
                Anchor      = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
                Text        = TermsContent.Text.Replace("\n", Environment.NewLine),
                TabStop     = false,
            };
            _termsBox.Select(0, 0);

            // ── Summary disclaimer under the scrollable body ──────────────
            var summaryLabel = new Label
            {
                Text      = "OmniKey AI is open-source software released under the MIT License. It is provided AS-IS, without warranty. OmniKey and its contributors are not liable for any damages, data loss, third-party charges, or issues arising from AI-generated content.",
                Font      = new Font("Segoe UI", 8.5f, FontStyle.Italic),
                ForeColor = NordColors.SecondaryText,
                AutoSize  = false,
                Location  = new Point(20, 512),
                Size      = new Size(680, 40),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            };

            var footerSep = new Panel
            {
                BackColor = NordColors.Border,
                Location  = new Point(0, 558),
                Size      = new Size(720, 1),
                Anchor    = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            };

            // ── Actions ──────────────────────────────────────────────────
            _declineButton = UIStyles.MakeSecondaryButton("Decline & Quit", new Size(140, 32));
            _declineButton.Location = new Point(20, 570);
            _declineButton.Anchor   = AnchorStyles.Bottom | AnchorStyles.Left;
            _declineButton.Click += (_, _) =>
            {
                DialogResult = DialogResult.Cancel;
                Close();
            };

            _acceptButton = UIStyles.MakePrimaryButton("I Accept", new Size(120, 32));
            _acceptButton.Location = new Point(580, 570);
            _acceptButton.Anchor   = AnchorStyles.Bottom | AnchorStyles.Right;
            _acceptButton.Click += (_, _) =>
            {
                TermsAcceptance.RecordAcceptance();
                DialogResult = DialogResult.OK;
                Close();
            };

            // Deliberately do NOT wire _acceptButton as AcceptButton — legal
            // consent must be an explicit click on "I Accept", not a stray
            // Enter keypress while focus happens to be on the scrollable
            // terms box or the Decline button. Esc still maps to CancelButton
            // (Decline & Quit), which is the safe default.
            CancelButton = _declineButton;

            Controls.AddRange(new Control[]
            {
                headerPanel, headerBorder,
                _termsBox, summaryLabel,
                footerSep,
                _declineButton, _acceptButton,
            });
        }

        /// <summary>
        /// If the user closes the window with the X button we treat it as
        /// "decline" — the caller inspects <see cref="Form.DialogResult"/>
        /// and terminates the process when it isn't OK.
        /// </summary>
        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (DialogResult == DialogResult.None)
                DialogResult = DialogResult.Cancel;
            base.OnFormClosing(e);
        }
    }
}
