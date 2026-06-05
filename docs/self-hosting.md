# Self-Hosting OmniKey AI

## Prerequisites

Before starting the self-hosting process, ensure that you have the following installed on your machine:

1. **Node.js** (v18.0.0 or higher).
2. **GCP CLI** to download installers from GCP buckets (only needed for maintainer release builds — not required for installing).
3. **GCP Authentication**: Make sure you've authenticated using `gcloud auth login` and selected the appropriate project. You may also need to set the project context for `gsutil` with:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   ```

## Quick install (recommended)

OmniKey AI ships a one-line installer that installs the CLI, runs onboarding,
starts the daemon, and downloads and opens the desktop installer for your
platform.

### macOS / Linux

```bash
curl -fsSL https://omnikeyai.ca/install.sh | bash
```

### Windows (PowerShell)

```powershell
iwr -useb https://omnikeyai.ca/install.ps1 | iex
```

The installer requires Node.js 18+ to already be installed. If you don't
have Node.js, grab it from [nodejs.org](https://nodejs.org/) (or via `nvm`
/ `brew` / `winget`) and re-run the command.

> Note: on Linux the desktop app step is skipped — OmniKey AI currently
> only ships a desktop installer for macOS and Windows. The CLI and daemon
> work on Linux.

The install scripts themselves live at
[`scripts/install.sh`](../scripts/install.sh) and
[`scripts/install.ps1`](../scripts/install.ps1), and are served behind the
short `omnikeyai.ca` URL by the container in
[`scripts/installer-host/`](../scripts/installer-host/) (Cloud Run +
custom domain).

## Manual steps for Self-Hosting

If you'd rather perform each step yourself, you can follow the manual
process below.

### Steps to Install OmniKey AI Locally

#### 1. Install OmniKey AI CLI

Install the OmniKey AI CLI globally using npm:

```bash
npm install -g omnikey-ai
```

#### 2. Configure OmniKey AI by Onboarding

Run the onboarding command to configure your environment, such as API keys and database connections:

```bash
omnikey onboard
```

#### 3. Start the OmniKey AI Daemon

After completing the onboarding process, start the OmniKey AI daemon to run the API server:

```bash
omnikey start
```

#### 4. Start the Desktop App

You can download desktop app from below link
- **Mac**: https://storage.googleapis.com/omnikey-releases/OmniKey-AI-0.4.0-arm64.dmg
- **Windows**: https://storage.googleapis.com/omnikey-releases/OmniKey-AI-0.4.0-Setup.exe
