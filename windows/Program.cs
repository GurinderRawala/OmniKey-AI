using System;
using System.Windows.Forms;

namespace OmniKey.Windows
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using var hotkeyForm = new HotkeyForm();
            Application.Run(hotkeyForm);
        }
    }
}
