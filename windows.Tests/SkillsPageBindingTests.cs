using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Xml.Linq;
using Xunit;

namespace OmniKey.Windows.Tests
{
    /// <summary>
    /// SkillsPage.xaml needs WPF and is not compiled here, so this checks the
    /// markup itself: every draft input is disabled (not just read-only)
    /// while a save is in flight. A disabled control also disables the
    /// WPF-UI clear button inside its template, which read-only does not
    /// guarantee.
    /// </summary>
    public class SkillsPageBindingTests
    {
        private static readonly XNamespace X = "http://schemas.microsoft.com/winfx/2006/xaml";

        private static XDocument LoadPage([CallerFilePath] string here = "") =>
            XDocument.Load(Path.Combine(
                Path.GetDirectoryName(here)!, "..", "windows", "Views", "Pages", "SkillsPage.xaml"));

        [Theory]
        [InlineData("NameBox")]
        [InlineData("KeywordBox")]
        [InlineData("InstructionsBox")]
        public void DraftTextBoxIsDisabledWhileSaving(string name)
        {
            var box = LoadPage().Descendants().Single(e => (string?)e.Attribute(X + "Name") == name);

            Assert.Equal("TextBox", box.Name.LocalName);
            Assert.Equal("{Binding IsDraftEditable}", (string?)box.Attribute("IsEnabled"));
            Assert.Null(box.Attribute("IsReadOnly"));
        }

        [Fact]
        public void EnabledToggleIsDisabledWhileSaving()
        {
            var toggle = LoadPage().Descendants()
                .Single(e => e.Name.LocalName == "ToggleSwitch"
                    && (string?)e.Attribute("AutomationProperties.Name") == "Enabled");

            Assert.Equal("{Binding IsDraftEditable}", (string?)toggle.Attribute("IsEnabled"));
        }
    }
}
