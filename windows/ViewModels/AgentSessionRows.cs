using System.Windows;
using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Wpf.Ui.Controls;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// Kind of agent action represented by a single timeline row. Drives
    /// the row's label, icon, and accent colour. Mirrors the categories
    /// the legacy <c>AgentThinkingForm</c> rendered as separate section
    /// cards (Web, MCP, Reasoning, Terminal).
    /// </summary>
    internal enum TimelineKind
    {
        Reasoning,
        Web,
        Mcp,
        Terminal,
    }

    /// <summary>
    /// Single collapsible step in the OmniAgent session timeline. Each
    /// row shows a one-line <see cref="Summary"/> when collapsed and the
    /// full <see cref="Text"/> when expanded — matching the ChatPage
    /// "Thought for N steps" timeline pattern. This replaces the legacy
    /// section-card layout that dumped the entire reasoning + terminal
    /// output inline.
    /// </summary>
    internal sealed partial class AgentTimelineRow : ObservableObject
    {
        public TimelineKind Kind { get; }
        public string Label { get; }
        public SymbolRegular IconSymbol { get; }
        public Brush AccentBrush { get; }

        [ObservableProperty] private string text = "";
        [ObservableProperty] private bool isExpanded;

        /// <summary>
        /// First non-empty line of <see cref="Text"/>, trimmed to ~80
        /// characters. Shown next to the label when the row is
        /// collapsed so the user can scan the timeline without
        /// expanding every step.
        /// </summary>
        public string Summary => BuildSummary(Text);

        public AgentTimelineRow(TimelineKind kind, string text)
        {
            Kind = kind;
            Text = text ?? "";
            (Label, IconSymbol, AccentBrush) = kind switch
            {
                TimelineKind.Reasoning => ("Agent reasoning", SymbolRegular.BrainCircuit24,  ResolveBrush("Nord.AccentPurpleBrush", Brushes.MediumPurple)),
                TimelineKind.Web       => ("Web search",      SymbolRegular.Globe24,         ResolveBrush("Nord.AccentBrush",       Brushes.SteelBlue)),
                TimelineKind.Mcp       => ("MCP tool call",   SymbolRegular.Server24,        ResolveBrush("Nord.AccentGreenBrush",  Brushes.MediumSeaGreen)),
                TimelineKind.Terminal  => ("Terminal output", SymbolRegular.WindowConsole20, ResolveBrush("Nord.AccentAmberBrush",  Brushes.Goldenrod)),
                _                      => ("Step",            SymbolRegular.Circle24,        Brushes.Gray),
            };
        }

        [RelayCommand]
        private void Toggle() => IsExpanded = !IsExpanded;

        partial void OnTextChanged(string value) => OnPropertyChanged(nameof(Summary));

        private static Brush ResolveBrush(string key, Brush fallback)
        {
            if (Application.Current?.Resources[key] is Brush b) return b;
            return fallback;
        }

        private static string BuildSummary(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "";
            // Skip leading blank lines, take the first content line.
            foreach (var raw in text.Split('\n'))
            {
                var trimmed = raw.Trim();
                if (trimmed.Length == 0) continue;
                return trimmed.Length > 80 ? trimmed[..80] + "…" : trimmed;
            }
            return "";
        }
    }

    /// <summary>
    /// Single turn shown in the "Previous Conversation" history card
    /// when the user resumed an existing session.
    /// </summary>
    internal sealed class HistoryTurnRow
    {
        public string Role { get; }
        public string RoleDisplay { get; }
        public string Text { get; }
        public bool IsAssistant { get; }

        public HistoryTurnRow(string role, string text)
        {
            Role = role;
            Text = text;
            IsAssistant = string.Equals(role, "assistant", System.StringComparison.OrdinalIgnoreCase);
            RoleDisplay = IsAssistant ? "Agent" : "You";
        }
    }
}
