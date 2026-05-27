using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class UpdatesPage : Page
    {
        public UpdatesPage()
        {
            InitializeComponent();
            var vm = new UpdatesViewModel();
            DataContext = vm;
            Loaded += async (_, _) =>
            {
                if (vm.CheckForUpdatesCommand.CanExecute(null))
                    await vm.CheckForUpdatesCommand.ExecuteAsync(null);
            };
        }
    }
}
