using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class MainForm : Form
    {
        private readonly TabControl _tabControl;
        private readonly TabPage _taskInstructionsTab;
        private readonly TabPage _manualTab;
        private readonly TabPage _checkUpdatesTab;
        private readonly TabPage _licenseTab;
        private readonly TabPage _agentSessionTab;

        private readonly TaskInstructionsForm _taskInstructionsForm;
        private readonly ManualForm _manualForm;
        private readonly UpdateForm? _updateForm; // Will be instantiated as needed
        private readonly LicenseForm _licenseForm;
        private readonly AgentThinkingForm _agentThinkingForm;
        public AgentThinkingForm AgentThinkingForm => _agentThinkingForm;

        private readonly NotifyIcon _notifyIcon;
        private readonly ApiClient _apiClient = new();
        private bool _isProcessing;

        public MainForm()
        {
            this.Name = "MainForm";
            Text = "OmniKey AI";
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(700, 500);
            BackColor = NordColors.WindowBackground;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            ClientSize = new Size(900, 640);

            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            using var iconStream = assembly.GetManifestResourceStream("OmniKey.Windows.app.ico");
            var appIcon = iconStream != null ? new Icon(iconStream) : SystemIcons.Information;
            Icon = appIcon;

            _notifyIcon = new NotifyIcon
            {
                Text = "OmniKey AI",
                Icon = appIcon,
                Visible = true
            };

            _tabControl = new TabControl
            {
                Dock = DockStyle.Fill,
                Appearance = TabAppearance.Normal,
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
                Font = new Font("Segoe UI", 10f),
                DrawMode = TabDrawMode.OwnerDrawFixed,
                ItemSize = new Size(120, 36)
            };
            _tabControl.DrawItem += (s, e) =>
            {
                var g = e.Graphics;
                var tab = _tabControl.TabPages[e.Index];
                var rect = e.Bounds;
                bool selected = (e.State & DrawItemState.Selected) != 0;
                var bg = selected ? NordColors.PanelBackground : NordColors.SurfaceBackground;
                using (var b = new SolidBrush(bg)) g.FillRectangle(b, rect);
                var font = new Font(_tabControl.Font, selected ? FontStyle.Bold : FontStyle.Regular);
                var textColor = selected ? NordColors.PrimaryText : NordColors.SecondaryText;
                TextRenderer.DrawText(g, tab.Text, font, rect, textColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                if (selected)
                {
                    using var accent = new SolidBrush(NordColors.AccentBlue);
                    g.FillRectangle(accent, rect.Left + 12, rect.Bottom - 4, rect.Width - 24, 3);
                }
            };
            var tabBorder = new Panel
            {
                Dock = DockStyle.Top,
                Height = 1,
                BackColor = NordColors.Border
            };
            Controls.Add(tabBorder);

            // Task Instructions Tab
            _taskInstructionsForm = new TaskInstructionsForm { TopLevel = false, FormBorderStyle = FormBorderStyle.None, Dock = DockStyle.Fill, Visible = true };
            _taskInstructionsTab = new TabPage("Task Instructions")
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            _taskInstructionsTab.Controls.Add(_taskInstructionsForm);
            _taskInstructionsForm.Show();

            // Manual Tab
            _manualForm = new ManualForm { TopLevel = false, FormBorderStyle = FormBorderStyle.None, Dock = DockStyle.Fill, Visible = true };
            _manualTab = new TabPage("Manual")
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            _manualTab.Controls.Add(_manualForm);
            _manualForm.Show();

            // Check Updates Tab
            _updateForm = null; // Will be created on demand
            _checkUpdatesTab = new TabPage("Check Updates")
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            // We'll add the UpdateForm dynamically when needed

            // License Tab
            _licenseForm = new LicenseForm { TopLevel = false, FormBorderStyle = FormBorderStyle.None, Dock = DockStyle.Fill, Visible = true };
            _licenseTab = new TabPage("License Form")
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText
            };
            _licenseTab.Controls.Add(_licenseForm);
            _licenseForm.Show();

            // Agent Session Tab
            _agentThinkingForm = new AgentThinkingForm { TopLevel = false, FormBorderStyle = FormBorderStyle.None, Dock = DockStyle.Fill, Visible = true };
            _agentThinkingForm.SizeChanged += (s, e) => _agentThinkingForm.Invalidate();
            _agentSessionTab = new TabPage("Agent Session")
            {
                BackColor = NordColors.PanelBackground,
                ForeColor = NordColors.PrimaryText,
                Visible = true
            };
            _agentSessionTab.Controls.Add(_agentThinkingForm);
            _agentThinkingForm.Show();

            _tabControl.TabPages.Add(_taskInstructionsTab);
            _tabControl.TabPages.Add(_manualTab);
            _tabControl.TabPages.Add(_checkUpdatesTab);
            if (!ApiClient.IsSelfHosted)
                _tabControl.TabPages.Add(_licenseTab);
            _tabControl.TabPages.Add(_agentSessionTab);

            Controls.Add(_tabControl);
        }

        public void ShowAgentSessionTab()
        {
            _tabControl.SelectedTab = _agentSessionTab;
            this.Show();
            this.Activate();
            this.BringToFront();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            _ = InitializeAuthAsync();
            _ = CheckForUpdatesBackgroundAsync();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            base.OnFormClosing(e);
        }

        private async Task InitializeAuthAsync()
        {
            // Mirror HotkeyForm logic
            if (ApiClient.IsSelfHosted)
            {
                await SubscriptionManager.Instance.ActivateStoredKeyAsync();
                return;
            }
            if (SubscriptionManager.Instance.HasStoredKey)
            {
                await SubscriptionManager.Instance.ActivateStoredKeyAsync();
                return;
            }
            // No key, or activation failed – show the license form
            _tabControl.SelectedTab = _licenseTab;
        }

        private async Task CheckForUpdatesBackgroundAsync()
        {
            var info = await UpdateChecker.CheckAsync();
            if (info == null) return;
            _notifyIcon.BalloonTipTitle = "OmniKey AI";
            _notifyIcon.BalloonTipText = $"Update {info.Version} is available! Check the 'Check Updates' tab.";
            _notifyIcon.ShowBalloonTip(3000);
        }
    }
}
