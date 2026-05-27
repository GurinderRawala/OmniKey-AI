using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class JobRunHistoryPage : Page
    {
        public JobRunHistoryPage()
        {
            InitializeComponent();
            var vm = new JobRunHistoryViewModel();
            DataContext = vm;
            Loaded += async (_, _) => await vm.LoadCommand.ExecuteAsync(null);
        }
    }
}
