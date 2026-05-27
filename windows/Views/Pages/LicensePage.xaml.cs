using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class LicensePage : Page
    {
        public LicensePage()
        {
            InitializeComponent();
            DataContext = new LicenseViewModel();
        }
    }
}
