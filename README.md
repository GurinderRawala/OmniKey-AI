<p align="center">
   <img src="macOS/Assets.xcassets/AppIcon.appiconset/Icon-iOS-Default-1024x1024@1x.png" alt="OmniKey AI Icon" width="128" height="128" />
</p>

# OmniKey AI

OmniKey AI is a productivity tool that enhances your workflow with AI-powered prompt enhancements, grammar correction, and custom tasks. Simply select a text and execute the command using a specific key combination from your keyboard.

> **Available on macOS and Windows.** On macOS, OmniKey runs as a menu bar app. On Windows, it runs as a system tray app.

## Getting Started

Follow these steps to set up OmniKey:

1. **Install OmniKey CLI:**

   **Via Homebrew (macOS recommended):**
   ```sh
   brew tap GurinderRawala/omnikey-ai https://github.com/GurinderRawala/OmniKey-AI.git
   brew install omnikey-cli
   ```

   **Via npm:**
   ```sh
   npm install -g omnikey-cli
   ```

2. **Onboard and configure your LLM provider:**

   ```sh
   omnikey onboard
   ```

   OmniKey supports **OpenAI**, **Anthropic**, and **Google Gemini** as LLM providers. You will be prompted to select a provider and enter your API key. You can also optionally configure a **web search provider** (Serper, Brave Search, Tavily, or SearXNG) — if none is configured, OmniKey falls back to **DuckDuckGo** by default, so web search works out of the box with no key required.

3. **Start the OmniKey daemon:**
   This command will set up a persistence agent and keep the OmniKey backend running across system restarts. On macOS it registers a launchd agent; on Windows it registers a Task Scheduler task.

   ```sh
   omnikey daemon
   ```

   For more information about CLI commands, see the [CLI documentation](./cli/README.md).

4. **Download the app for your platform:**
   - [Download OmniKey for macOS](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/macos/download)
   - [Download OmniKey for Windows](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/windows/download)

## Features

- **Authenticated Browser Session Reading** *(macOS only — New!)*: OmniKey can now read content from your live browser tab — including pages that require login — so the `@omniAgent` can work with authenticated resources like internal dashboards, private docs, and paid tools without you having to copy-paste anything. Works with **Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium, and Safari** on macOS.

  > **One-time setup required (macOS only):** You need to enable **Allow JavaScript from Apple Events** in your browser before OmniKey can read your active tab. The steps differ slightly by browser:
  >
  > **Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium** (Chromium-based):
  > Go to **View → Developer → Allow JavaScript from Apple Events** and make sure it is checked.
  >
  > **Safari:**
  > First enable the Develop menu: **Safari → Settings → Advanced → check "Show features for web developers"**.
  > Then go to **Develop → Allow JavaScript from Apple Events** and make sure it is checked.
  >
  > This is a one-time setting per browser. Once enabled, OmniKey can read the content of your active tab via Apple Events.

- **Multiple LLM Providers**: Choose between OpenAI, Anthropic, or Google Gemini as your AI backend. Configure your preferred provider during onboarding or at any time via the CLI.
- **Web Search**: Configure a web search provider during onboarding to allow `@omniAgent` to gather real-time context from the web alongside your terminal. Supported providers:
  - **DuckDuckGo** — default fallback, no key required
  - **Serper** (serper.dev) — Google Search API, 2,500 free requests/mo
  - **Brave Search** (brave.com/search/api) — 2,000 free requests/mo
  - **Tavily** (tavily.com) — optimized for AI, 1,000 free requests/mo
  - **SearXNG** — self-hosted, no key needed (provide your instance URL)
- **Prompt Enhancement (`⌘E` / `Ctrl+E`)**: Improves clarity, structure, and tone of your selected text to make it a better AI prompt.
- **Grammar & Clarity Fix (`⌘G` / `Ctrl+G`)**: Focuses on grammar, spelling, and readability without changing the core meaning of your text.
- **Custom Tasks (`⌘T` / `Ctrl+T`)**: Applies your saved task instructions to the selected text. Configure these in the “Task Instructions” window from the menu bar.
- **@omnikeyai Questions**: Select a question starting with “@omnikeyai” and use a shortcut to get answers in the context of your current text or task.
- **@omniAgent Tasks**: Select instructions starting with “@omniAgent” and press `⌘T` / `Ctrl+T` to have the agent perform tasks for you, combining your task instructions if configured. OmniKey gathers context from both your **terminal** (by running commands) and the **web** (using your configured search provider, falling back to DuckDuckGo if none is set).

#### How OmniKey Works

1. Select text in any app (editor, browser, email, etc.).
2. Press one of the OmniKey shortcuts (`⌘E`, `⌘G`, or `⌘T` on macOS — `Ctrl+E`, `Ctrl+G`, or `Ctrl+T` on Windows).
3. OmniKey sends the text securely to the OmniKey AI service.
4. The result is pasted back in place of your original selection.

You can add or edit your custom task instructions in the **Task Instructions** tab in the menu bar / system tray app.

To learn more about how to use OmniKey, see the **Manual View** in the app.
