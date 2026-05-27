using CommunityToolkit.Mvvm.ComponentModel;

namespace OmniKey.Windows.ViewModels
{
    public partial class MainWindowViewModel : ObservableObject
    {
        [ObservableProperty]
        private string applicationTitle = "OmniKey";
    }
}
