#!/usr/bin/env bash
#
# OmniKey AI - Installation Script
#
# Installs the omnikey-cli (Homebrew preferred, npm fallback), runs the
# interactive onboarding flow, starts the daemon in the background, then
# downloads the macOS desktop app and opens the .dmg so the user can
# drag it into /Applications.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/GurinderRawala/OmniKey-AI/main/scripts/install.sh | bash
#
set -euo pipefail

# ---------- Configuration ----------
# macOS download URL is taken from README.md (Getting Started → step 4).
MACOS_DOWNLOAD_URL="${OMNIKEY_MACOS_URL:-https://omnikeyai-saas-fmytqc3dra-uc.a.run.app/macos/download}"
BREW_TAP="GurinderRawala/omnikey-ai"
BREW_TAP_URL="https://github.com/GurinderRawala/OmniKey-AI.git"
BREW_FORMULA="omnikey-cli"
NPM_PACKAGE="omnikey-cli"

DOWNLOAD_DIR="${HOME}/Downloads"
DMG_PATH="${DOWNLOAD_DIR}/OmniKey-AI.dmg"
LOG_DIR="${HOME}/.omnikey/logs"
DAEMON_LOG="${LOG_DIR}/daemon.log"

# ---------- Pretty output ----------
if [[ -t 1 ]]; then
  BOLD=$(tput bold); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1); CYAN=$(tput setaf 6); RESET=$(tput sgr0)
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
info() { echo "${CYAN}${BOLD}==>${RESET} ${BOLD}$*${RESET}"; }
ok()   { echo "${GREEN}✔${RESET} $*"; }
warn() { echo "${YELLOW}⚠${RESET} $*"; }
fail() { echo "${RED}✘ $*${RESET}" >&2; exit 1; }

trap 'fail "Installation failed on line $LINENO."' ERR

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. Install omnikey-cli ----------
install_cli() {
  if have omnikey; then
    ok "omnikey-cli already installed ($(omnikey --version 2>/dev/null || echo 'version unknown'))."
    return 0
  fi

  info "Installing ${BREW_FORMULA}..."

  if have brew; then
    info "Homebrew detected — installing via brew."
    if ! brew tap | grep -qi "^${BREW_TAP}$"; then
      brew tap "${BREW_TAP}" "${BREW_TAP_URL}" || fail "Failed to add brew tap ${BREW_TAP}."
    fi
    brew install "${BREW_FORMULA}" || fail "brew install ${BREW_FORMULA} failed."
  elif have npm; then
    info "Homebrew not found — installing via npm."
    if ! npm install -g "${NPM_PACKAGE}" >/dev/null 2>&1; then
      warn "Global npm install failed without sudo — retrying with sudo."
      sudo npm install -g "${NPM_PACKAGE}" || fail "npm install -g ${NPM_PACKAGE} failed."
    fi
  else
    fail "Neither 'brew' nor 'npm' is installed. Install one (Homebrew or Node.js 18+) and re-run."
  fi

  have omnikey || fail "Installed, but 'omnikey' is not on PATH. Open a new shell or check your PATH."
  ok "omnikey-cli installed: $(command -v omnikey)"
}

# ---------- 2. Onboarding ----------
run_onboard() {
  info "Starting onboarding — you'll be prompted for your provider key."
  # Ensure interactive prompts work when piped through curl | bash.
  if [[ -t 0 ]]; then
    omnikey onboard
  elif [[ -e /dev/tty ]]; then
    omnikey onboard < /dev/tty
  else
    fail "No interactive terminal available. Re-run this installer in an interactive shell."
  fi
  ok "Onboarding complete."
}

# ---------- 3. Daemon ----------
start_daemon() {
  info "Starting OmniKey daemon..."
  mkdir -p "$LOG_DIR"
  nohup omnikey daemon >"$DAEMON_LOG" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    ok "Daemon running (pid $pid). Logs: $DAEMON_LOG"
  else
    fail "Daemon failed to start. See $DAEMON_LOG"
  fi
}

# ---------- 4. macOS app download ----------
download_macos_app() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    warn "Not running on macOS — skipping .dmg download."
    return 0
  fi

  mkdir -p "$DOWNLOAD_DIR"
  info "Downloading the macOS app from: $MACOS_DOWNLOAD_URL"

  if have curl; then
    curl -fL --progress-bar -o "$DMG_PATH" "$MACOS_DOWNLOAD_URL" \
      || fail "Failed to download .dmg from $MACOS_DOWNLOAD_URL"
  elif have wget; then
    wget -O "$DMG_PATH" "$MACOS_DOWNLOAD_URL" \
      || fail "Failed to download .dmg from $MACOS_DOWNLOAD_URL"
  else
    fail "Neither curl nor wget is available to download the .dmg."
  fi
  ok "Downloaded to: $DMG_PATH"

  info "Opening the .dmg — drag OmniKey into your Applications folder."
  open "$DMG_PATH" || warn "Could not auto-open the .dmg. Open it manually: $DMG_PATH"
}

# ---------- Main ----------
main() {
  echo
  echo "${BOLD}╔══════════════════════════════════════════╗${RESET}"
  echo "${BOLD}║         OmniKey AI Installer             ║${RESET}"
  echo "${BOLD}╚══════════════════════════════════════════╝${RESET}"
  echo

  install_cli
  run_onboard
  start_daemon
  download_macos_app

  echo
  ok "${BOLD}All done!${RESET}"
  echo "  • CLI:    $(command -v omnikey)"
  echo "  • Daemon: running in background (log: $DAEMON_LOG)"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  • App:    $DMG_PATH (drag into /Applications)"
  fi
  echo
}

main "$@"
