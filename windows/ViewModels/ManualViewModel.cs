using System.Collections.Generic;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;

namespace OmniKey.Windows.ViewModels
{
    /// <summary>
    /// A single keyboard shortcut row shown in the Manual page.
    /// </summary>
    internal sealed class ShortcutItem
    {
        public string Keys { get; }
        public string Title { get; }
        public string Description { get; }
        public string Icon { get; }

        public ShortcutItem(string keys, string title, string description, string icon)
        {
            Keys = keys;
            Title = title;
            Description = description;
            Icon = icon;
        }
    }

    /// <summary>
    /// A documentation section with a heading, an icon glyph, and a body
    /// paragraph (newlines preserved for simple multi-line rendering).
    /// </summary>
    internal sealed class ManualSection
    {
        public string Title { get; }
        public string Body { get; }
        public string Icon { get; }

        public ManualSection(string title, string body, string icon)
        {
            Title = title;
            Body = body;
            Icon = icon;
        }
    }

    /// <summary>
    /// Backing model for the Manual page. Static, read-only content sourced
    /// from the original WinForms ManualForm — modernized for WPF-UI.
    /// </summary>
    internal partial class ManualViewModel : ObservableObject
    {
        public string Tagline { get; } =
            "Use OmniKey AI anywhere on your Windows PC. Select text and activate one of the shortcuts below. " +
            "OmniKey will process your selected text and paste the improved version back in place.";

        public IReadOnlyList<ShortcutItem> Shortcuts { get; } = new[]
        {
            new ShortcutItem(
                "Ctrl+E",
                "Enhance prompts",
                "Improves clarity, structure, and tone of your selected text so it works better as an AI prompt.",
                "Sparkle24"),
            new ShortcutItem(
                "Ctrl+G",
                "Fix grammar and clarity",
                "Focuses on grammar, spelling, and readability without changing the core meaning.",
                "TextGrammarCheckmark24"),
            new ShortcutItem(
                "Ctrl+T",
                "Run your custom task",
                "Applies your saved task instructions to the selected text. Configure these in \"Task Instructions\" from the tray menu.",
                "ClipboardTask24"),
        };

        public IReadOnlyList<ManualSection> Sections { get; } = new[]
        {
            new ManualSection(
                "How OmniKey works",
                "1. Select text in any app (editor, browser, email, etc.).\n" +
                "2. Press one of the OmniKey shortcuts (Ctrl+E, Ctrl+G, or Ctrl+T).\n" +
                "3. OmniKey sends the text securely to the OmniKey AI service.\n" +
                "4. The result is pasted back in place of your original selection.",
                "Lightbulb24"),

            new ManualSection(
                "Custom tasks with Task Instructions",
                "• Open the \"Task Instructions\" window from the OmniKey tray menu.\n" +
                "• Describe the role, style, and rules you want OmniKey to follow when you press Ctrl+T.\n" +
                "• OmniKey will apply those instructions every time you trigger the custom task shortcut.",
                "ClipboardTextEdit24"),

            new ManualSection(
                "Asking questions with @omnikeyai",
                "You can also ask OmniKey questions related to your current task.\n\n" +
                "• In your document or editor, write a question starting with \"@omnikeyai\".\n" +
                "    Example: \"@omnikeyai Can you explain step 3 in simpler terms?\"\n" +
                "• Select that question (or the whole block of text around it).\n" +
                "• Press one of the OmniKey shortcuts.\n\n" +
                "OmniKey will treat anything after \"@omnikeyai\" as a direct question and answer in the context of your current text or task.",
                "ChatHelp24"),

            new ManualSection(
                "Running tasks with @omniAgent",
                "OmniAgent is an AI agent that can perform multi-step tasks by combining your instructions with " +
                "real-time context gathered from your terminal and the web.\n\n" +
                "How to use it:\n" +
                "• Type \"@omniAgent\" followed by clear instructions for what you want done.\n" +
                "    Example: \"@omniAgent Set up a new README section describing the API routes.\"\n" +
                "• Select the text containing your @omniAgent instructions.\n" +
                "• Press Ctrl+T to trigger the agent.\n\n" +
                "What the agent can do:\n" +
                "• Run terminal commands to gather context (e.g. read files, check git status, run tests).\n" +
                "• Search the web for real-time information using your configured search provider.\n" +
                "• Combine results from both sources to produce a final answer, which is pasted back in place.\n\n" +
                "If you have Task Instructions configured, the agent combines those with your @omniAgent " +
                "instructions to tailor its behavior to your role and preferences.\n\n" +
                "Note: The agent runs with the same permissions as your Windows user account. It cannot " +
                "run commands that require elevation (\"Run as Administrator\").",
                "Bot24"),

            new ManualSection(
                "OmniAgent sessions",
                "Each @omniAgent run belongs to a session. Sessions let the agent remember prior " +
                "context across multiple runs — useful for long-running or iterative tasks.\n\n" +
                "Choosing a session when you run @omniAgent:\n" +
                "• If no default is set, a picker dialog appears before each run.\n" +
                "• Select \"Start a new session\" to begin fresh every time.\n" +
                "• Select \"Resume an existing session\" and pick one from the list to continue where you left off.\n" +
                "• Check \"Remember this as default and skip this picker next time\" to save your choice " +
                "so the dialog is skipped automatically on future runs.\n\n" +
                "Managing your default session:\n" +
                "• Use the History button (bottom-left of the OmniAgent window) at any time to open the " +
                "session settings and change your default.\n" +
                "• You can also open \"OmniAgent Session\" from the tray menu to do the same.\n" +
                "• Click \"Clear Default\" inside the session settings to go back to always being asked.\n\n" +
                "The session list shows each session's name, number of turns, and remaining context tokens, " +
                "so you can choose the right one for your task.",
                "History24"),

            new ManualSection(
                "Web search providers",
                "OmniAgent can search the web while working on your task. The provider is configured " +
                "via the OmniKey CLI during onboarding (run \"omnikey onboard\").\n\n" +
                "Supported providers: DuckDuckGo, Serper, Brave Search, Tavily, SearXNG.",
                "GlobeSearch24"),

            new ManualSection(
                "LLM providers",
                "OmniKey supports multiple AI backends. Select and configure your preferred provider " +
                "during setup by running \"omnikey onboard\" in the CLI.\n\n" +
                "Supported providers:\n" +
                "• OpenAI      — GPT-4 and later models.\n" +
                "• Anthropic   — Claude models.\n" +
                "• Google      — Gemini models.\n\n" +
                "You can switch providers at any time by re-running \"omnikey onboard\".",
                "BrainCircuit24"),
        };
    }
}
