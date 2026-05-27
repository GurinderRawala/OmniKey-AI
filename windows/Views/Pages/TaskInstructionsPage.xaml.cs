using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class TaskInstructionsPage : Page
    {
        public TaskInstructionsPage()
        {
            InitializeComponent();
            var vm = new TaskInstructionsViewModel();
            DataContext = vm;
            Loaded += async (_, _) => await vm.LoadCommand.ExecuteAsync(null);
        }
    }
}
