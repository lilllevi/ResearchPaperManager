# Research Paper Manager — one-command launcher for Windows (PowerShell).
#
# Usage (from the project folder):
#     .\run.ps1
#
# It creates a local Python virtual environment on first run, installs the
# dependencies, then starts the app and opens it in your browser.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# 1. Find Python
$py = "python"
try { & $py --version | Out-Null } catch {
    Write-Host "Python was not found. Install Python 3.10+ from https://www.python.org/downloads/ (check 'Add to PATH')." -ForegroundColor Red
    exit 1
}

# 2. Create the virtual environment on first run
if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment (.venv)..." -ForegroundColor Cyan
    & $py -m venv .venv
}

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

# 3. Install / update dependencies
Write-Host "Installing dependencies (first run may take a minute)..." -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip | Out-Null
& $venvPy -m pip install -r requirements.txt

# 4. Make sure a .env exists
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host ""
    Write-Host "A .env file was created. Open it and paste your Gemini API key," -ForegroundColor Yellow
    Write-Host "then run .\run.ps1 again. (The app will still start without a key," -ForegroundColor Yellow
    Write-Host "but AI features stay disabled until you add one.)" -ForegroundColor Yellow
    Write-Host ""
}

# 5. Read host/port from .env if present (defaults otherwise)
$appHost = "127.0.0.1"
$port = "8000"
if (Test-Path ".env") {
    foreach ($line in Get-Content ".env") {
        if ($line -match "^\s*RPM_HOST\s*=\s*(.+)\s*$") { $appHost = $Matches[1].Trim() }
        if ($line -match "^\s*RPM_PORT\s*=\s*(.+)\s*$") { $port = $Matches[1].Trim() }
    }
}

$url = "http://$appHost`:$port"
Write-Host ""
Write-Host "Starting Research Paper Manager at $url" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor Green
Start-Process $url

# 6. Launch the server (uvicorn serves both the API and the web UI)
& $venvPy -m uvicorn backend.main:app --host $appHost --port $port
