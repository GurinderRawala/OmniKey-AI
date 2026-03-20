#!/usr/bin/env pwsh
# build_release_zip.ps1 – Windows counterpart of macOS/build_release_dmg.sh
#
# Builds a self-contained, single-file Windows x64 release of OmniKey AI and
# packages it as a ZIP archive ready for distribution.
#
# Usage:
#   .\build_release_zip.ps1
#   OMNIKEY_BACKEND_URL="https://my-backend" .\build_release_zip.ps1
#
# The published executable reads the backend URL at runtime using the same
# three-level precedence as ApiClient.cs:
#   1. ~/.omnikey/config.json  (OMNIKEY_PORT key)
#   2. OMNIKEY_BACKEND_URL environment variable
#   3. Fallback: http://localhost:7172
#
# Requirements:
#   - .NET SDK 10 (net10.0-windows)  – https://dotnet.microsoft.com/download
#   - PowerShell 7+ (pwsh)           – https://github.com/PowerShell/PowerShell

param(
    [string]$BackendBaseUrl = ($env:OMNIKEY_BACKEND_URL ?? "http://localhost:7172"),
    [string]$Runtime        = "win-x64"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Configuration ────────────────────────────────────────────────────────────
$APP_NAME    = "OmniKeyAI"
$SCRIPT_DIR  = $PSScriptRoot
$PROJ_FILE   = Join-Path $SCRIPT_DIR "OmniKey.Windows.csproj"

# Read version from .csproj so the ZIP name stays in sync automatically.
[xml]$csproj  = Get-Content $PROJ_FILE
$APP_VERSION  = $csproj.Project.PropertyGroup.Version
if (-not $APP_VERSION) { $APP_VERSION = "0.0.0" }

$PUBLISH_DIR  = Join-Path $SCRIPT_DIR ".publish"
$ZIP_NAME     = "${APP_NAME}-windows-${Runtime}.zip"
$ZIP_PATH     = Join-Path $SCRIPT_DIR $ZIP_NAME

# ── Helpers ──────────────────────────────────────────────────────────────────
function Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Cyan  }
function Err   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red   }

# ── 1. Clean previous publish output ─────────────────────────────────────────
Info "Cleaning previous publish output..."
if (Test-Path $PUBLISH_DIR) { Remove-Item $PUBLISH_DIR -Recurse -Force }

# ── 2. Build & publish ────────────────────────────────────────────────────────
Info "Publishing $APP_NAME $APP_VERSION ($Runtime) – self-contained single-file..."

dotnet publish $PROJ_FILE `
    --configuration Release `
    --runtime       $Runtime `
    --self-contained true `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:EnableCompressionInSingleFile=true `
    --output        $PUBLISH_DIR

if ($LASTEXITCODE -ne 0) {
    Err "dotnet publish failed (exit $LASTEXITCODE)."
    exit 1
}

# Verify the expected executable exists
$EXE_PATH = Join-Path $PUBLISH_DIR "OmniKey.Windows.exe"
if (-not (Test-Path $EXE_PATH)) {
    Err "Expected executable not found: $EXE_PATH"
    exit 1
}

# ── 3. Rename exe to branded name ─────────────────────────────────────────────
$BRANDED_EXE = Join-Path $PUBLISH_DIR "${APP_NAME}.exe"
Rename-Item $EXE_PATH $BRANDED_EXE

# ── 4. Write a minimal README into the package ────────────────────────────────
$README = @"
OmniKey AI $APP_VERSION – Windows ($Runtime)
=============================================

Installation
------------
1. Extract this ZIP to any folder (e.g. C:\Program Files\OmniKeyAI\).
2. (Optional) Create a shortcut to OmniKeyAI.exe in your Start Menu or Startup folder
   (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup) to launch on login.
3. Run OmniKeyAI.exe.  A tray icon will appear in the system notification area.

Backend URL
-----------
By default the app connects to: $BackendBaseUrl

To point it at a different backend set the environment variable before launching:
    set OMNIKEY_BACKEND_URL=https://your-backend-url
or create %USERPROFILE%\.omnikey\config.json:
    { "OMNIKEY_PORT": "7172" }

Hotkeys
-------
  Ctrl+E  Enhance selected text
  Ctrl+G  Fix grammar of selected text
  Ctrl+T  Run custom task on selected text

Auto-update
-----------
OmniKey AI checks for updates automatically at startup and via the tray menu
"Check for Updates" item.  When a new version is available it will notify you
and open the download page in your browser.

Uninstallation
--------------
Delete the folder you extracted the ZIP into.
Registry key: HKCU\SOFTWARE\OmniKeyAI (subscription key cache) can be removed
with: reg delete HKCU\SOFTWARE\OmniKeyAI /f
"@

$README | Set-Content (Join-Path $PUBLISH_DIR "README.txt") -Encoding UTF8

# ── 5. Create the distribution ZIP ───────────────────────────────────────────
Info "Creating distribution ZIP..."
if (Test-Path $ZIP_PATH) { Remove-Item $ZIP_PATH -Force }

Compress-Archive -Path "$PUBLISH_DIR\*" -DestinationPath $ZIP_PATH

Info "Done.  ZIP created at: $ZIP_PATH"
Info "  App version : $APP_VERSION"
Info "  Runtime     : $Runtime"
Info "  Backend URL : $BackendBaseUrl  (runtime-configurable)"
