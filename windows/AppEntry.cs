using System;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal sealed class AppEntry : ApplicationContext
    {
        private readonly MainForm _mainForm;
        private readonly HotkeyForm _hotkeyForm;

        public AppEntry()
        {
            _mainForm = new MainForm();
            _mainForm.FormClosed += (s, e) => ExitThread();
            _hotkeyForm = new HotkeyForm();
            _hotkeyForm.Show(); // Hidden, message-only
            _mainForm.Show();
        }
    }
}
