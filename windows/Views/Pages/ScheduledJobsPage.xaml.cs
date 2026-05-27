using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class ScheduledJobsPage : Page
    {
        public ScheduledJobsPage()
        {
            InitializeComponent();
            var vm = new ScheduledJobsViewModel();
            DataContext = vm;
            Loaded += async (_, _) => await vm.LoadCommand.ExecuteAsync(null);
        }
    }
}
