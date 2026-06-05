<p align="center">
   <img src="macOS/Assets.xcassets/AppIcon.appiconset/Icon-iOS-Default-1024x1024@1x.png" alt="OmniKey AI Icon" width="128" height="128" />
</p>

# OmniKey AI

OmniKey AI is a productivity tool that enhances your workflow with AI-powered prompt enhancements, grammar correction, and custom tasks — triggered by a keyboard shortcut on whatever text you have selected.

> Available on **macOS** (menu bar app) and **Windows** (system tray app).

> 🌐 **Full documentation, downloads, and product details live at [omnikeyai.ca](https://omnikeyai.ca).** This README only covers the essentials.

## Getting Started

1. **Install the CLI:**

   ```sh
   # macOS (recommended)
   brew tap GurinderRawala/omnikey-ai https://github.com/GurinderRawala/OmniKey-AI.git
   brew install omnikey-cli

   # or via npm (cross-platform)
   npm install -g omnikey-cli
   ```

2. **Onboard and configure a provider** — pick OpenAI, Anthropic, Google Gemini, or Nemotron, and optionally a web search provider:

   ```sh
   omnikey onboard
   ```

3. **Start the persistent daemon:**

   ```sh
   omnikey daemon
   ```

4. **Download the desktop app** — [macOS](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/macos/download) · [Windows](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/windows/download).

## Features

A quick reference of the core capabilities and the commands or shortcuts that drive them. Full details live on the [website](https://omnikeyai.ca).

- **Prompt Enhancement** — `⌘E` / `Ctrl+E` rewrites the selected text into a stronger prompt.
- **Grammar & Clarity Fix** — `⌘G` / `Ctrl+G` cleans up grammar without changing meaning.
- **Custom Tasks** — `⌘T` / `Ctrl+T` applies your saved task instructions to the selected text.
- **Multiple LLM providers** — switch between OpenAI, Anthropic, Google Gemini, and Nemotron during onboarding or via `omnikey set`.
- **Web Search** — opt in during onboarding. Supports DuckDuckGo, Serper, Brave Search, Tavily, and SearXNG.
- **Authenticated Browser Sessions** — `omnikey grant-browser-access` sets up a dedicated debug profile so the agent can read logged-in pages (Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium, and Safari on macOS).
- **MCP Servers** — extend the agent with Model Context Protocol tools:

  ```sh
  omnikey mcp add
  omnikey mcp list
  omnikey mcp toggle <id>
  ```

- **Telegram Integration** — run tasks and get notifications from any device:

  ```sh
  omnikey telegram start
  omnikey telegram status
  omnikey telegram logs
  omnikey telegram stop
  ```

- **Scheduled Jobs** — automate recurring or one-time prompt runs from the desktop app or the CLI (`omnikey schedule add` / `list` / `remove`).

## The @omniAgent

Select text starting with `@omniAgent` and press `⌘T` / `Ctrl+T` to hand off the task to the autonomous agent. It can:

- **Run shell commands** on your machine to inspect files, processes, environment, or run builds.
- **Read your live browser tabs** (including authenticated ones) for context from internal dashboards, private docs, and paid tools — no copy-paste required.
- **Search the web** via your configured provider (falls back to DuckDuckGo).
- **Use any MCP server** you have registered (databases, APIs, custom tools).
- **Combine your saved task instructions** automatically when relevant.

Use `@omnikeyai` (without the agent prefix) for plain Q&A in the context of your selected text. For the full agent design and tool list, see [omnikeyai.ca](https://omnikeyai.ca).

---

## Developers

OmniKey AI is a Yarn monorepo with three TypeScript workspaces (`api`, `cli`, `telegram`) plus native desktop clients in Swift (macOS) and C# (Windows). For setup, build/test workflows, and a tour of the main commands, see **[DEVELOPMENT.md](./DEVELOPMENT.md)**.
