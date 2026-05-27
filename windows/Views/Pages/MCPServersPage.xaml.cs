using System.Windows.Controls;
using OmniKey.Windows.ViewModels;

namespace OmniKey.Windows.Views.Pages
{
    public partial class MCPServersPage : Page
    {
        public MCPServersPage()
        {
            InitializeComponent();
            var vm = new MCPServersViewModel();
            DataContext = vm;
            Loaded += async (_, _) => await vm.LoadCommand.ExecuteAsync(null);
        }
    }
}
