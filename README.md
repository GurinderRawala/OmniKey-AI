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

- **Authenticated Browser Session Reading** *(macOS & Windows — New!)*: OmniKey can read content from your live browser tab — including pages that require login — so the `@omniAgent` can work with authenticated resources like internal dashboards, private docs, and paid tools without you having to copy-paste anything.

  Works with:
  - **Windows**: Chrome, Brave, Edge
  - **macOS**: Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium, and Safari

  > **Recommended setup (macOS & Windows):** Run the following command and let the CLI do everything for you:
  > ```sh
  > omnikey grant-browser-access
  > ```
  > The CLI detects your installed browsers, creates a dedicated OmniKey debug profile stored at `~/.omnikey/browser-debug-profiles/`, finds a free debug port, registers a permanent login startup entry, and verifies the connection — all in one guided flow. Because a fresh profile is used, you sign in to your accounts once inside it. Your main browser profile is never touched, and the debug profile persists between sessions.
  >
  > After setup, reopen the browser with its OmniKey debug profile at any time using:
  > ```sh
  > omnikey browser open
  > ```

  ---

  ### Manual Setup

  #### Windows — Remote Debugging Port (CDP)

  Modern Chrome no longer allows `--remote-debugging-port` with your existing user profile. You must point `--user-data-dir` at a dedicated, separate directory.

  1. Create a folder for the OmniKey debug profile — e.g., paste into PowerShell:
     ```powershell
     mkdir "$env:USERPROFILE\.omnikey\browser-debug-profiles\chrome-default"
     ```
  2. Close all Chrome windows completely (check Task Manager → Details for any remaining `chrome.exe` processes).
  3. Launch Chrome pointing at the new profile — paste into PowerShell:
     ```powershell
     & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
       '--remote-debugging-port=9222' `
       "--user-data-dir=$env:USERPROFILE\.omnikey\browser-debug-profiles\chrome-default" `
       '--no-first-run' '--no-default-browser-check'
     ```
  4. A fresh Chrome window opens. Sign in to your accounts — this profile persists, so you only do this once.
  5. Confirm the port is active: `http://127.0.0.1:9222/json`
  6. To auto-start on login, add this command as a Registry Run value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

  > **Edge:** replace `chrome.exe` with `msedge.exe`. **Brave:** use `brave.exe`.

  ---

  #### macOS — Remote Debugging Port (CDP) (Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium)

  Modern Chrome requires a separate `--user-data-dir` for remote debugging — using your existing profile is no longer supported.

  1. Create a folder for the OmniKey debug profile:
     ```sh
     mkdir -p ~/.omnikey/browser-debug-profiles/chrome-default
     ```
  2. Quit the browser fully (`⌘Q`).
  3. Launch it from Terminal pointing at the new profile:
     ```sh
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
       --remote-debugging-port=9222 \
       --user-data-dir="$HOME/.omnikey/browser-debug-profiles/chrome-default" \
       --no-first-run --no-default-browser-check
     ```
  4. A fresh browser window opens. Sign in to your accounts — this profile persists between sessions.
  5. Confirm the port is active: `http://127.0.0.1:9222/json`
  6. To auto-start on login, create a launchd plist at `~/Library/LaunchAgents/com.omnikey.browser-debug.plist` with `RunAtLoad = true` pointing to the same command.

  > Replace the app path for Brave (`Brave Browser.app`), Edge (`Microsoft Edge.app`), etc. Use a different folder name per browser.

  ---

  #### macOS — AppleScript (Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium)

  Go to **View → Developer → Allow JavaScript from Apple Events** and make sure it is checked, then restart the browser.

  #### macOS — AppleScript (Safari)

  First enable the Develop menu: **Safari → Settings → Advanced → check "Show features for web developers"**.
  Then go to **Develop → Allow JavaScript from Apple Events** and make sure it is checked.

  No separate profile or port needed — OmniKey reads your existing open tabs directly. This is a one-time setting per browser.

- **Multiple LLM Providers**: Choose between OpenAI, Anthropic, or Google Gemini as your AI backend. Configure your preferred provider during onboarding or at any time via the CLI.
- **Web Search**: Configure a web search provider during onboarding to allow `@omniAgent` to gather real-time context from the web alongside your terminal. Supported providers:
  - **DuckDuckGo** — default fallback, no key required
  - **Serper** (serper.dev) — Google Search API, 2,500 free requests/mo
  - **Brave Search** (brave.com/search/api) — 2,000 free requests/mo
  - **Tavily** (tavily.com) — optimized for AI, 1,000 free requests/mo
  - **SearXNG** — self-hosted, no key needed (provide your instance URL)
- **Prompt Enhancement (`⌘E` / `Ctrl+E`)**: Improves clarity, structure, and tone of your selected text to make it a better AI prompt.
- **Grammar & Clarity Fix (`⌘G` / `Ctrl+G`)**: Focuses on grammar, spelling, and readability without changing the core meaning of your text.
- **Custom Tasks (`⌘T` / `Ctrl+T`)**: Applies your saved task instructions to the selected text. Configure these in the "Task Instructions" window from the menu bar.
- **@omnikeyai Questions**: Select a question starting with "@omnikeyai" and use a shortcut to get answers in the context of your current text or task.
- **@omniAgent Tasks**: Select instructions starting with "@omniAgent" and press `⌘T` / `Ctrl+T` to have the agent perform tasks for you, combining your task instructions if configured. OmniKey gathers context from both your **terminal** (by running commands) and the **web** (using your configured search provider, falling back to DuckDuckGo if none is set).

#### How OmniKey Works

1. Select text in any app (editor, browser, email, etc.).
2. Press one of the OmniKey shortcuts (`⌘E`, `⌘G`, or `⌘T` on macOS — `Ctrl+E`, `Ctrl+G`, or `Ctrl+T` on Windows).
3. OmniKey sends the text securely to the OmniKey AI service.
4. The result is pasted back in place of your original selection.

You can add or edit your custom task instructions in the **Task Instructions** tab in the menu bar / system tray app.

To learn more about how to use OmniKey, see the **Manual View** in the app.