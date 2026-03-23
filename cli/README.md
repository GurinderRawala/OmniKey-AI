# Omnikey CLI

A command-line tool for onboarding users to the Omnikey open-source app, configuring your LLM provider (OpenAI, Anthropic, or Gemini), and setting up the web search tool.

## About OmnikeyAI

OmnikeyAI is a productivity tool that helps you quickly rewrite selected text using your preferred LLM provider. The CLI allows you to configure and run the backend daemon on your local machine, manage your API keys, choose your LLM provider (OpenAI, Anthropic, or Gemini), and optionally configure the web search tool.

- Website: [omnikeyai.ca](https://omnikeyai.ca)
- For more details about the app and its features, see the [main README](https://github.com/GurinderRawala/OmniKey-AI).
- Download the latest macOS app here: [Download OmniKeyAI for macOS](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/macos/download)
- Download the latest Windows app here: [Download OmniKeyAI for Windows](https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/windows/download)

## Features

- `omnikey onboard`: Interactive onboarding to configure your LLM provider and API key.
- Supports **OpenAI**, **Anthropic**, and **Google Gemini** as LLM providers.
- Optional **web search tool** integration for enhanced responses.
- Accepts CLI flags for non-interactive setup.
- Configure and run the backend daemon — persisted across reboots on both macOS and Windows.

## Usage

```sh
# Install CLI globally (from this directory)
npm install -g omnikey-cli

# Onboard interactively (will prompt for LLM key and web search tool)
omnikey onboard

# Start the daemon (auto-restarts on reboot)
omnikey daemon --port 7071

# Kill the daemon
omnikey kill-daemon

# Restart the daemon (kill + start in one step)
omnikey restart-daemon --port 7071

# Show current configuration (API keys are masked)
omnikey config

# Set a single configuration value
omnikey set OMNIKEY_PORT 8080

# Remove the config directory (keeps SQLite database)
omnikey remove-config

# Remove config and also the SQLite database
omnikey remove-config --db

# Check daemon status
omnikey status

# Check daemon logs
omnikey logs --lines 100

# Check daemon error logs only
omnikey logs --errors
```

### Command reference

| Command | Description |
|---|---|
| `omnikey onboard` | Interactive setup for LLM provider and web search |
| `omnikey daemon [--port]` | Start the backend daemon (default port: 7071) |
| `omnikey kill-daemon` | Stop the running daemon |
| `omnikey restart-daemon [--port]` | Kill and restart the daemon |
| `omnikey config` | Display current config with masked API keys |
| `omnikey set <key> <value>` | Update a single config value |
| `omnikey remove-config [--db]` | Remove config files; add `--db` to also delete the database |
| `omnikey status` | Show what process is using the daemon port |
| `omnikey logs [--lines N] [--errors]` | Tail daemon logs |

## Platform notes

### macOS

The daemon is registered as a **launchd agent** (`~/Library/LaunchAgents/com.omnikey.daemon.plist`) so it auto-restarts after login and on crashes.

### Windows

The daemon is registered as a **Windows Task Scheduler** task (`OmnikeyDaemon`) that runs at every logon. A wrapper script (`~/.omnikey/start-daemon.cmd`) is generated to set the required environment variables before launching the Node.js backend.

> **Note:** `schtasks` is a built-in Windows command — no third-party tools or administrator rights are required for user-level scheduled tasks.

Commands that query process state use `netstat` (instead of `lsof`) on Windows, and process termination uses `taskkill` (instead of `SIGTERM`).

## Development

- Built with Node.js and TypeScript.
- Uses `commander` for CLI parsing and `inquirer` for prompts.
- Utilizes Yarn as the package manager.

## License

MIT
