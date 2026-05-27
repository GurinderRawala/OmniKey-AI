using System.Windows;
using Wpf.Ui.Appearance;
using Wpf.Ui.Controls;

namespace OmniKey.Windows
{
    public partial class App : Application
    {
        public App()
        {
            InitializeComponent();
        }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ApplicationThemeManager.Apply(ApplicationTheme.Dark, WindowBackdropType.Mica);
        }
    }
}
