using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class LicensePage : Page
    {
        public LicensePage()
        {
            InitializeComponent();
            var vm = new LicenseViewModel();
            DataContext = vm;
            Loaded += async (_, _) =>
            {
                if (vm.LoadCommand.CanExecute(null))
                    await vm.LoadCommand.ExecuteAsync(null);
            };
        }
    }
}
