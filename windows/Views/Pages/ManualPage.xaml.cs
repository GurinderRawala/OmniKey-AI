using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class ManualPage : Page
    {
        public ManualPage()
        {
            InitializeComponent();
            DataContext = new ManualViewModel();
        }
    }
}
