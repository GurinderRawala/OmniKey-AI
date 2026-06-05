# OmniKey AI - One-line installer for Windows (PowerShell)
#
# Usage:
#   iwr -useb https://omnikeyai.ca/install.ps1 | iex
#
# This script will:
#   1. Verify Node.js (>= 18) is installed (offers a winget install if missing).
#   2. Install the `omnikey-cli` npm package globally.
#   3. Run `omnikey onboard` interactively to configure credentials.
#   4. Start the OmniKey AI daemon in the background (logs to ~/.omnikey/logs).
#   5. Download the Windows desktop app ZIP from https://omnikeyai.ca/windows/download
#      and open it so the user can run the installer.
#
$ErrorActionPreference = 'Stop'

# ---------- Configuration ----------
$NpmPackage     = 'omnikey-cli'
$WindowsAppUrl  = if ($env:OMNIKEY_WINDOWS_URL) { $env:OMNIKEY_WINDOWS_URL } else { 'https://omnikeyai.ca/windows/download' }
$OmniKeyDir     = Join-Path $env:USERPROFILE '.omnikey'
$LogDir         = Join-Path $OmniKeyDir 'logs'
$DaemonLog      = Join-Path $LogDir 'daemon.log'
$DaemonErrLog   = Join-Path $LogDir 'daemon.err.log'
$DaemonPidFile  = Join-Path $OmniKeyDir 'daemon.pid'
$DownloadDir    = Join-Path $env:USERPROFILE 'Downloads'
$DownloadPath   = Join-Path $DownloadDir 'OmniKeyAI-windows.zip'

New-Item -ItemType Directory -Force -Path $LogDir       | Out-Null
New-Item -ItemType Directory -Force -Path $DownloadDir  | Out-Null

# ---------- Pretty output ----------
function Write-Info  ($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err   ($msg) { Write-Host "[X]  $msg" -ForegroundColor Red }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "+==========================================+" -ForegroundColor Cyan
Write-Host "|          OmniKey AI Installer            |" -ForegroundColor Cyan
Write-Host "+==========================================+" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. Node.js / npm check (winget fallback) ----------
Write-Info "Checking Node.js installation..."
if (-not (Test-Command 'node') -or -not (Test-Command 'npm')) {
    if (Test-Command 'winget') {
        Write-Warn2 "Node.js not found. Installing via winget (OpenJS.NodeJS.LTS)..."
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Err "winget failed to install Node.js. Install it manually from https://nodejs.org/ and re-run."
            exit 1
        }
        # Refresh PATH in the current session so the new node/npm are visible.
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
    } else {
        Write-Err "Node.js / npm is not installed and winget is unavailable."
        Write-Err "Install Node.js >= 18 from https://nodejs.org/ and re-run this installer."
        exit 1
    }
}

$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Err "Node.js >= 18 is required (found v$nodeVersion)."
    exit 1
}
Write-Ok "Node.js v$nodeVersion detected."

# ---------- 2. Install omnikey-cli ----------
if (Test-Command 'omnikey') {
    Write-Ok "omnikey-cli already installed."
} else {
    Write-Info "Installing $NpmPackage globally via npm..."
    & npm install -g $NpmPackage
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install -g $NpmPackage failed (exit $LASTEXITCODE)."
        Write-Err "If this is a permission issue, run PowerShell as Administrator and try again."
        exit 1
    }
    if (-not (Test-Command 'omnikey')) {
        Write-Err "'omnikey' is not on PATH after install. Open a new PowerShell window or check your npm global bin."
        exit 1
    }
    Write-Ok "omnikey-cli installed: $((Get-Command omnikey).Source)"
}

# ---------- 3. Onboarding ----------
Write-Info "Starting interactive onboarding - you'll be prompted for your provider key."
& omnikey onboard
if ($LASTEXITCODE -ne 0) {
    Write-Err "Onboarding failed (exit $LASTEXITCODE)."
    exit 1
}
Write-Ok "Onboarding complete."

# ---------- 4. Start daemon in background ----------
Write-Info "Starting OmniKey daemon in the background (logs: $DaemonLog)..."

# Stop any previous daemon we started.
if (Test-Path $DaemonPidFile) {
    $oldPid = Get-Content $DaemonPidFile -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Warn2 "Stopping previous daemon (pid $oldPid)..."
        # The pid is the cmd.exe wrapper; /T kills the node daemon child too.
        & taskkill /PID $oldPid /T /F 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }
}

# `omnikey` is an npm shim (.cmd/.ps1), not a native .exe. Start-Process with
# output redirection is forced onto CreateProcess, which can only launch real
# Win32 executables (otherwise: "%1 is not a valid Win32 application"). Run the
# shim through the command processor instead.
$daemonProc = Start-Process -FilePath $env:ComSpec -ArgumentList '/c','omnikey','daemon' `
    -RedirectStandardOutput $DaemonLog -RedirectStandardError $DaemonErrLog `
    -WindowStyle Hidden -PassThru

if (-not $daemonProc) {
    Write-Err "Failed to start the OmniKey daemon."
    exit 1
}
Set-Content -Path $DaemonPidFile -Value $daemonProc.Id

Start-Sleep -Seconds 2
if ($daemonProc.HasExited) {
    Write-Err "Daemon exited immediately. See $DaemonLog / $DaemonErrLog"
    exit 1
}
Write-Ok "Daemon running (pid $($daemonProc.Id)). Logs: $DaemonLog"

# ---------- 5. Download Windows desktop app ----------
Write-Info "Downloading the Windows desktop app from: $WindowsAppUrl"
try {
    Invoke-WebRequest -Uri $WindowsAppUrl -OutFile $DownloadPath -UseBasicParsing
} catch {
    Write-Err "Failed to download from $WindowsAppUrl"
    Write-Err $_.Exception.Message
    exit 1
}
Write-Ok "Downloaded to: $DownloadPath"

Write-Info "Opening the downloaded archive..."
try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$DownloadPath`""
} catch {
    Write-Warn2 "Could not auto-open the download. Open it manually: $DownloadPath"
}

# ---------- Done ----------
Write-Host ""
Write-Ok "All done!"
Write-Host "   * CLI:    $((Get-Command omnikey).Source)"
Write-Host "   * Daemon: running (pid $($daemonProc.Id), log: $DaemonLog)"
Write-Host "   * App:    $DownloadPath"
Write-Host ""
