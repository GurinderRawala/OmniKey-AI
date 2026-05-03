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
- `omnikey grant-browser-access`: One-time setup to give Omnikey access to authenticated browser tabs for web fetch.
- Scheduled Jobs commands to create, list, delete, and trigger jobs from the CLI.

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

# Grant Omnikey access to authenticated browser tabs
omnikey grant-browser-access

# Reopen the browser with its saved Omnikey debug profile at any time
omnikey browser open

# Add a scheduled job (interactive)
omnikey schedule add

# List scheduled jobs
omnikey schedule list

# Remove a scheduled job (interactive select)
omnikey schedule remove

# Trigger a scheduled job immediately by ID
omnikey schedule run-now <job-id>
```

### Command reference

| Command                               | Description                                                               |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `omnikey onboard`                     | Interactive setup for LLM provider and web search                         |
| `omnikey daemon [--port]`             | Start the backend daemon (default port: 7071)                             |
| `omnikey kill-daemon`                 | Stop the running daemon                                                   |
| `omnikey restart-daemon [--port]`     | Kill and restart the daemon                                               |
| `omnikey config`                      | Display current config with masked API keys                               |
| `omnikey set <key> <value>`           | Update a single config value                                              |
| `omnikey remove-config [--db]`        | Remove config files; add `--db` to also delete the database               |
| `omnikey status`                      | Show what process is using the daemon port                                |
| `omnikey logs [--lines N] [--errors]` | Tail daemon logs                                                          |
| `omnikey grant-browser-access`        | Set up authenticated browser tab access for web fetch                     |
| `omnikey browser open`                | Reopen the browser with the saved Omnikey debug profile                   |
| `omnikey schedule add`                | Create a scheduled job with interactive prompt, schedule type, and timing |
| `omnikey schedule list`               | List all scheduled jobs with status and next run                          |
| `omnikey schedule remove`             | Remove an existing scheduled job via interactive selection                |
| `omnikey schedule run-now <id>`       | Trigger a scheduled job immediately                                       |

## Scheduled Jobs

The CLI includes a full `schedule` command group to manage recurring and one-time jobs.

### `omnikey schedule add`

Creates a new job interactively:

- Prompts for a job label
- Lets you enter a multiline prompt directly in terminal (type `END` on its own line when finished)
- Supports:
  - Recurring schedule with cron presets or custom cron
  - One-time schedule by date/time

### `omnikey schedule list`

Displays all jobs in a table with:

- ID
- Label
- Schedule
- Next run
- Status

### `omnikey schedule remove`

Lets you choose a job from a list and confirms deletion.

### `omnikey schedule run-now <id>`

Runs a job immediately using its job ID.

## Browser access (`grant-browser-access` / `browser open`)

Omnikey can read content from your authenticated browser tabs when fetching web pages that require a login. `omnikey grant-browser-access` performs a guided, one-time setup to enable this.

After setup, run `omnikey browser open` at any time to relaunch the browser with its saved Omnikey debug profile (kills any running instance first, cleans up stale lock files, then re-launches and confirms the debug port is active).

### Windows

On Windows the only supported method is **Remote Debugging Port (CDP)**:

1. Detects installed browsers (Chrome, Edge, Brave).
2. Prompts you to select a browser and profile.
3. Finds an available port starting at 9222.
4. Saves `BROWSER_DEBUG_PORT` to `~/.omnikey/config.json`.
5. Registers a **Windows Registry Run key** (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OmnikeyBrowserDebug`) so the browser launches automatically with `--remote-debugging-port=<port>` on every login.
6. Force-kills any running browser processes, waits until they are fully gone, then launches the browser immediately.
7. Verifies the debug port is reachable at `http://127.0.0.1:<port>/json` and reports success or a diagnostic error.

Re-running the command when a startup entry already exists lets you **Update** (change browser/profile/port) or **Remove** (disable the startup entry).

### macOS

On macOS you choose between two methods:

#### Remote Debugging Port (CDP) — recommended

Same flow as Windows, but the startup entry is written as a **launchd agent** (`~/Library/LaunchAgents/com.omnikey.browser-debug.plist`) loaded immediately with `launchctl`.

Supported browsers: Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium.

#### AppleScript

No port or browser restart needed. Omnikey reads the live tab content directly via Apple Events.

The CLI automatically enables **"Allow JavaScript from Apple Events"** for every selected browser:

- **Chrome / Brave / Edge / Arc / Vivaldi / Opera** — patches the `devtools.allow_javascript_apple_events` key in each profile's `Preferences` JSON file. The browser must be closed before patching (the CLI will warn you if it is still running).
- **Safari** — runs `defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool YES`.

Both changes are permanent and survive reboots. Restart each browser once after setup for the change to take effect.

## Platform notes

### macOS

The daemon is registered as a **launchd agent** (`~/Library/LaunchAgents/com.omnikey.daemon.plist`) so it auto-restarts after login and on crashes.

### Windows

The daemon runs as a **Windows Service** managed by [NSSM (Non-Sucking Service Manager)](https://nssm.cc/). This gives it production-grade persistence:

| Behaviour              | Detail                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Starts on boot         | Runs as `SERVICE_AUTO_START` — no login required                                              |
| Auto-restarts on crash | Restarts after a 3-second delay on any unexpected exit                                        |
| Runs in the background | No console window, no logged-in user needed                                                   |
| Log rotation           | stdout/stderr written to `~/.omnikey/daemon.log` and `daemon-error.log` with rotation enabled |

#### Prerequisites

NSSM must be installed and the command must be run from an **elevated (Administrator) terminal**.

If NSSM is not found, `omnikey daemon` will prompt you:

```
? NSSM is required but not found. Install it now via winget? (Y/n)
```

Answering **Y** runs `winget install nssm` automatically and continues setup. Alternatively install it manually:

```sh
winget install nssm          # Windows Package Manager (built-in on Win 10/11)
scoop install nssm           # Scoop
choco install nssm           # Chocolatey
```

#### Service management

```sh
# View service status in Services console
services.msc

# Or via the command line
sc query OmnikeyDaemon

# Stop / start manually
nssm stop OmnikeyDaemon
nssm start OmnikeyDaemon

# Uninstall (also done automatically by omnikey kill-daemon / remove-config)
nssm remove OmnikeyDaemon confirm
```

Commands that query process state use `netstat` (instead of `lsof`) on Windows, and process termination uses `taskkill` (instead of `SIGTERM`).

## Development

- Built with Node.js and TypeScript.
- Uses `commander` for CLI parsing and `inquirer` for prompts.
- Utilizes Yarn as the package manager.

## License

MIT
