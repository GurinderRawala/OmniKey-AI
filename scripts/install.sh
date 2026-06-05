#!/usr/bin/env bash
#
# OmniKey AI - One-line installer for macOS and Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/GurinderRawala/OmniKey-AI/main/scripts/install.sh | bash
#
# This script will:
#   1. Verify Node.js (>= 18) is installed.
#   2. Install the `omnikey-ai` npm package globally.
#   3. Run `omnikey onboard` interactively to configure credentials.
#   4. Start the OmniKey AI daemon in the background.
#   5. Detect the platform (macOS arm64/x64) and download the matching
#      desktop installer from the public GCP releases bucket.
#   6. Open the installer so the user can finish installing the desktop app.
#
set -euo pipefail

# ---------- pretty output helpers ----------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi
info()  { printf "%s==>%s %s\n" "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*"; }
ok()    { printf "%s✓%s   %s\n" "${C_GREEN}${C_BOLD}" "${C_RESET}" "$*"; }
warn()  { printf "%s!%s   %s\n" "${C_YELLOW}${C_BOLD}" "${C_RESET}" "$*"; }
err()   { printf "%s✗%s   %s\n" "${C_RED}${C_BOLD}"   "${C_RESET}" "$*" >&2; }

# ---------- config ----------
NPM_PACKAGE="omnikey-ai"
RELEASES_BUCKET="https://storage.googleapis.com/omnikey-releases"
LOG_DIR="$HOME/.omnikey/logs"
DAEMON_LOG="$LOG_DIR/daemon.log"
DAEMON_PID_FILE="$HOME/.omnikey/daemon.pid"
DOWNLOAD_DIR="${TMPDIR:-/tmp}"

mkdir -p "$LOG_DIR"

# ---------- banner ----------
printf "\n%s" "${C_BLUE}${C_BOLD}"
cat <<'BANNER'
  ___                  _ _  __
 / _ \ _ __ ___  _ __ (_) |/ /___ _   _
| | | | '_ ` _ \| '_ \| | ' // _ \ | | |
| |_| | | | | | | | | | | . \  __/ |_| |
 \___/|_| |_| |_|_| |_|_|_|\_\___|\__, |
                                  |___/
              OmniKey AI Installer
BANNER
printf "%s\n\n" "${C_RESET}"

# ---------- 0. platform detection ----------
OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"
case "$OS_RAW" in
  Darwin) PLATFORM="mac" ;;
  Linux)
    PLATFORM="linux"
    warn "OmniKey AI does not ship a Linux desktop installer."
    warn "We'll still install the CLI and start the daemon — the desktop"
    warn "app step will be skipped."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    err "This script is for macOS/Linux. On Windows, run the PowerShell installer instead:"
    err "  iwr -useb https://raw.githubusercontent.com/GurinderRawala/OmniKey-AI/main/scripts/install.ps1 | iex"
    exit 1
    ;;
  *)
    err "Unsupported OS: $OS_RAW"
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *)
    warn "Unrecognized architecture '$ARCH_RAW' — defaulting to x64."
    ARCH="x64"
    ;;
esac

info "Detected platform: ${C_BOLD}${PLATFORM}-${ARCH}${C_RESET}"

# ---------- 1. Node.js / npm check ----------
info "Checking Node.js installation..."
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed."
  err "Install Node.js >= 18 from https://nodejs.org/ (or via nvm/brew) and re-run this installer."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed. Please install Node.js (which includes npm) and re-run."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  err "Node.js >= 18 is required (found $(node -v))."
  exit 1
fi
ok "Node.js $(node -v) detected."

# ---------- 2. install / upgrade omnikey-ai ----------
info "Installing the latest ${NPM_PACKAGE} CLI globally..."
if npm install -g "$NPM_PACKAGE" >/dev/null 2>&1; then
  ok "Installed $NPM_PACKAGE."
else
  warn "Global install without sudo failed — retrying with sudo (you may be prompted for your password)."
  sudo npm install -g "$NPM_PACKAGE"
  ok "Installed $NPM_PACKAGE (with sudo)."
fi

if ! command -v omnikey >/dev/null 2>&1; then
  err "'omnikey' command not found after install. Check that your global npm bin is in PATH:"
  err "  $(npm bin -g 2>/dev/null || echo '(unknown)')"
  exit 1
fi
ok "omnikey CLI available: $(command -v omnikey)"

# ---------- 3. onboarding (interactive) ----------
info "Starting interactive onboarding — please provide your credentials when prompted."
# Make sure stdin is a TTY for inquirer prompts. If piped via curl|bash, /dev/tty is needed.
if [ -t 0 ]; then
  omnikey onboard
else
  if [ -e /dev/tty ]; then
    omnikey onboard < /dev/tty
  else
    err "No interactive terminal available. Re-run this installer in an interactive shell."
    exit 1
  fi
fi
ok "Onboarding complete."

# ---------- 4. start daemon in background ----------
info "Starting OmniKey AI daemon in the background (logs: $DAEMON_LOG)..."
# Kill any previous daemon we started.
if [ -f "$DAEMON_PID_FILE" ]; then
  OLD_PID="$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Stopping previous daemon (pid $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi
nohup omnikey start >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
disown "$DAEMON_PID" 2>/dev/null || true
sleep 2
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  ok "Daemon started (pid $DAEMON_PID)."
else
  err "Daemon failed to start. See logs at: $DAEMON_LOG"
  exit 1
fi

# ---------- 5. download desktop installer ----------
if [ "$PLATFORM" != "mac" ]; then
  warn "Skipping desktop installer download (no installer available for $PLATFORM)."
  printf "\n%s\n" "${C_GREEN}${C_BOLD}🎉 OmniKey AI CLI is installed and running.${C_RESET}"
  printf "    Daemon log: %s\n" "$DAEMON_LOG"
  exit 0
fi

info "Resolving latest desktop installer version..."
# Look up the latest npm package version as the source of truth for the
# matching desktop installer (release-build.js uploads both with the same version).
LATEST_VERSION="$(npm view "$NPM_PACKAGE" version 2>/dev/null || true)"
if [ -z "$LATEST_VERSION" ]; then
  err "Could not resolve the latest OmniKey AI version from npm. Skipping desktop install."
  exit 1
fi
ok "Latest version: $LATEST_VERSION"

INSTALLER_NAME="OmniKey-AI-${LATEST_VERSION}-${ARCH}.dmg"
INSTALLER_URL="${RELEASES_BUCKET}/${INSTALLER_NAME}"
INSTALLER_PATH="${DOWNLOAD_DIR}/${INSTALLER_NAME}"

info "Downloading desktop installer: $INSTALLER_URL"
if ! curl -fL --progress-bar -o "$INSTALLER_PATH" "$INSTALLER_URL"; then
  err "Failed to download $INSTALLER_URL."
  err "You can install the desktop app manually from:"
  err "  https://github.com/GurinderRawala/OmniKey-AI/releases"
  exit 1
fi
ok "Downloaded to $INSTALLER_PATH"

# ---------- 6. open installer ----------
info "Opening the desktop installer..."
open "$INSTALLER_PATH" || warn "Could not auto-open the installer. Open it manually: $INSTALLER_PATH"

printf "\n%s\n" "${C_GREEN}${C_BOLD}🎉 OmniKey AI installation complete!${C_RESET}"
printf "    • CLI:        %s\n" "$(command -v omnikey)"
printf "    • Daemon pid: %s (log: %s)\n" "$DAEMON_PID" "$DAEMON_LOG"
printf "    • Installer:  %s\n" "$INSTALLER_PATH"
printf "\nFollow the installer window to finish setting up the desktop app.\n"
