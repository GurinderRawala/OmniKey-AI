<p align="center">
   <img src="macOS/Assets.xcassets/AppIcon.appiconset/Icon-iOS-Default-1024x1024@1x.png" alt="OmniKey AI Icon" width="128" height="128" />
</p>

# OmniKey AI

OmniKey AI is a productivity tool that enhances your workflow with AI-powered prompt enhancements, grammar correction, and custom tasks. Simply select a text and execute the command using a specific key combination from your keyboard.

> **Available on macOS and Windows.** On macOS, OmniKey runs as a menu bar app. On Windows, it runs as a system tray app.

## Getting Started

Follow these steps to set up OmniKey:

1. **Install OmniKey CLI via npm:**

   ```sh
   npm install -g omnikey-cli
   ```

2. **Onboard and add your OpenAI API key:**

   ```sh
   omnikey onboard
   ```

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

- **Prompt Enhancement (`⌘E` / `Ctrl+E`)**: Improves clarity, structure, and tone of your selected text to make it a better AI prompt.
- **Grammar & Clarity Fix (`⌘G` / `Ctrl+G`)**: Focuses on grammar, spelling, and readability without changing the core meaning of your text.
- **Custom Tasks (`⌘T` / `Ctrl+T`)**: Applies your saved task instructions to the selected text. Configure these in the “Task Instructions” window from the menu bar.
- **@omnikeyai Questions**: Select a question starting with “@omnikeyai” and use a shortcut to get answers in the context of your current text or task.
- **@omniAgent Tasks**: Select instructions starting with “@omniAgent” and press `⌘T` / `Ctrl+T` to have the agent perform tasks for you, combining your task instructions if configured. OmniKey will use your terminal to gather context by running commands.

#### How OmniKey Works

1. Select text in any app (editor, browser, email, etc.).
2. Press one of the OmniKey shortcuts (`⌘E`, `⌘G`, or `⌘T` on macOS — `Ctrl+E`, `Ctrl+G`, or `Ctrl+T` on Windows).
3. OmniKey sends the text securely to the OmniKey AI service.
4. The result is pasted back in place of your original selection.

You can add or edit your custom task instructions in the **Task Instructions** tab in the menu bar / system tray app.

To learn more about how to use OmniKey, see the **Manual View** in the app.
