# OmniKey AI - One-line installer for Windows (PowerShell)
#
# Usage:
#   iwr -useb https://omnikeyai.ca/install.ps1 | iex
#
# This script will:
#   1. Verify Node.js (>= 18) is installed.
#   2. Install the `omnikey-ai` npm package globally.
#   3. Run `omnikey onboard` interactively to configure credentials.
#   4. Start the OmniKey AI daemon in the background.
#   5. Download the matching Windows desktop installer from the GCP releases bucket.
#   6. Launch the installer so the user can finish setting up the desktop app.

$ErrorActionPreference = 'Stop'

function Write-Info  ($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "[OK] $msg"  -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host "[!]  $msg"  -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "[X]  $msg"  -ForegroundColor Red }

$NpmPackage    = 'omnikey-ai'
$ReleaseBucket = 'https://storage.googleapis.com/omnikey-releases'
$OmniKeyDir    = Join-Path $env:USERPROFILE '.omnikey'
$LogDir        = Join-Path $OmniKeyDir 'logs'
$DaemonLog     = Join-Path $LogDir 'daemon.log'
$DaemonPidFile = Join-Path $OmniKeyDir 'daemon.pid'
$DownloadDir   = $env:TEMP

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host ""
Write-Host "  ___                  _ _  __        " -ForegroundColor Cyan
Write-Host " / _ \ _ __ ___  _ __ (_) |/ /___ _   _" -ForegroundColor Cyan
Write-Host "| | | | '_ `` _ \| '_ \| | ' // _ \ | | |" -ForegroundColor Cyan
Write-Host "| |_| | | | | | | | | | | . \  __/ |_| |" -ForegroundColor Cyan
Write-Host " \___/|_| |_| |_|_| |_|_|_|\_\___|\__, |" -ForegroundColor Cyan
Write-Host "                                  |___/ " -ForegroundColor Cyan
Write-Host "              OmniKey AI Installer       " -ForegroundColor Cyan
Write-Host ""

# ---------- 1. Node.js / npm check ----------
Write-Info "Checking Node.js installation..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $npmCmd) {
    Write-Err "Node.js / npm is not installed."
    Write-Err "Install Node.js >= 18 from https://nodejs.org/ and re-run this installer."
    exit 1
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Err "Node.js >= 18 is required (found v$nodeVersion)."
    exit 1
}
Write-Ok "Node.js v$nodeVersion detected."

# ---------- 2. install / upgrade omnikey-ai ----------
Write-Info "Installing the latest $NpmPackage CLI globally..."
& npm install -g $NpmPackage
if ($LASTEXITCODE -ne 0) {
    Write-Err "npm install -g $NpmPackage failed (exit $LASTEXITCODE)."
    Write-Err "If this is a permission issue, open PowerShell as Administrator and re-run."
    exit 1
}
Write-Ok "Installed $NpmPackage."

$omniKeyCmd = Get-Command omnikey -ErrorAction SilentlyContinue
if (-not $omniKeyCmd) {
    Write-Err "'omnikey' command not found after install. Check that your global npm bin is in PATH."
    exit 1
}
Write-Ok "omnikey CLI available: $($omniKeyCmd.Source)"

# ---------- 3. onboarding (interactive) ----------
Write-Info "Starting interactive onboarding - please provide your credentials when prompted."
& omnikey onboard
if ($LASTEXITCODE -ne 0) {
    Write-Err "Onboarding failed (exit $LASTEXITCODE)."
    exit 1
}
Write-Ok "Onboarding complete."

# ---------- 4. start daemon in background ----------
Write-Info "Starting OmniKey AI daemon in the background (logs: $DaemonLog)..."

# Stop any previous daemon we started.
if (Test-Path $DaemonPidFile) {
    $oldPid = Get-Content $DaemonPidFile -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Warn2 "Stopping previous daemon (pid $oldPid)..."
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

$daemonProc = Start-Process -FilePath 'omnikey' -ArgumentList 'start' `
    -RedirectStandardOutput $DaemonLog -RedirectStandardError $DaemonLog `
    -WindowStyle Hidden -PassThru
Set-Content -Path $DaemonPidFile -Value $daemonProc.Id
Start-Sleep -Seconds 2
if ($daemonProc.HasExited) {
    Write-Err "Daemon failed to start. See logs at: $DaemonLog"
    exit 1
}
Write-Ok "Daemon started (pid $($daemonProc.Id))."

# ---------- 5. download desktop installer ----------
Write-Info "Resolving latest desktop installer version..."
$latestVersion = (& npm view $NpmPackage version) 2>$null
if (-not $latestVersion) {
    Write-Err "Could not resolve the latest OmniKey AI version from npm. Skipping desktop install."
    exit 1
}
$latestVersion = $latestVersion.Trim()
Write-Ok "Latest version: $latestVersion"

$installerName = "OmniKey-AI-$latestVersion-Setup.exe"
$installerUrl  = "$ReleaseBucket/$installerName"
$installerPath = Join-Path $DownloadDir $installerName

Write-Info "Downloading desktop installer: $installerUrl"
try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
} catch {
    Write-Err "Failed to download $installerUrl."
    Write-Err "You can install the desktop app manually from:"
    Write-Err "  https://github.com/GurinderRawala/OmniKey-AI/releases"
    exit 1
}
Write-Ok "Downloaded to $installerPath"

# ---------- 6. launch installer ----------
Write-Info "Launching the desktop installer..."
try {
    Start-Process -FilePath $installerPath
} catch {
    Write-Warn2 "Could not auto-launch the installer. Run it manually: $installerPath"
}

Write-Host ""
Write-Host "OmniKey AI installation complete!" -ForegroundColor Green
Write-Host "  - CLI:        $($omniKeyCmd.Source)"
Write-Host "  - Daemon pid: $($daemonProc.Id) (log: $DaemonLog)"
Write-Host "  - Installer:  $installerPath"
Write-Host ""
Write-Host "Follow the installer window to finish setting up the desktop app."
