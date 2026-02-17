# Setup on Windows

## Step 1
To download and run the app on Windows, open the PowerShell terminal and copy-paste this command:

```powershell
# OmniKey-AI Windows bootstrap script (HTTPS-only, fixed .env location)
# Run in Windows Terminal (PowerShell)

$ErrorActionPreference = "Stop"

function Ensure-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

function Write-Header($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

try {
  Write-Header "Setting PowerShell execution policy for current user"
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

  # Install Scoop if missing
  if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) {
    Write-Header "Installing Scoop"
    Invoke-RestMethod -Uri "https://get.scoop.sh" | Invoke-Expression
  } else {
    Write-Header "Scoop already installed"
  }

  Write-Header "Updating Scoop"
  scoop update

  Write-Header "Installing dependencies (git, nodejs, yarn, dotnet-sdk)"
  scoop install git nodejs yarn dotnet-sdk

  # Refresh PATH
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","User") + ";" +
              [System.Environment]::GetEnvironmentVariable("PATH","Machine")

  Ensure-Command git
  Ensure-Command node
  Ensure-Command yarn
  Ensure-Command dotnet

  Write-Header "Cloning public repo via HTTPS"
  $repoHttps = "https://github.com/GurinderRawala/OmniKey-AI.git"
  $targetDir = "OmniKey-AI"

  if (-not (Test-Path $targetDir)) {
    git clone $repoHttps
  } else {
    Write-Host "Repo folder '$targetDir' already exists. Skipping clone." -ForegroundColor Yellow
  }

  # Store absolute repo root path
  $repoRoot = (Resolve-Path $targetDir).Path

  Write-Header "Installing JS dependencies (yarn install)"
  Push-Location $repoRoot
  yarn install
  Pop-Location

  Write-Header "Prompting for OPENAI_API_KEY"
  $secureKey = Read-Host "Enter OPENAI_API_KEY" -AsSecureString
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  )

  if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "OPENAI_API_KEY cannot be empty."
  }

  Write-Header "Creating .env at repo root"
  $envPath = Join-Path $repoRoot ".env"
  "OPENAI_API_KEY=$plainKey" | Out-File -FilePath $envPath -Encoding utf8 -Force

  Write-Header "Building C# tray app (dotnet build)"
  $windowsDir = Join-Path $repoRoot "windows"

  if (-not (Test-Path $windowsDir)) {
    throw "Expected folder not found: $windowsDir"
  }

  Push-Location $windowsDir
  dotnet build
  Pop-Location

  Write-Host ""
  Write-Host "✅ Done. Repo set up and dotnet build completed." -ForegroundColor Green
  Write-Host "📄 .env created at: $envPath" -ForegroundColor Gray

} catch {
  Write-Host ""
  Write-Host "❌ Failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
```

## Step 2

Run the app using following command:

```powershell 

$env:DOTNET_ROOT="$HOME\scoop\apps\dotnet-sdk\current"; Set-Location OmniKey-AI; yarn dev:windows

```

To turn it off you can press `Ctrl + C`.
