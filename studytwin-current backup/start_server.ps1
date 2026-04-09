param(
    [string]$VenvFolder = "venv_blink",
    [switch]$InstallRequirements,
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  StudyTwin Environment & Server Starter  " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Ensure Python Virtual Environment exists ─────────────────
Write-Host "[1/5] Checking Python virtual environment..." -ForegroundColor Yellow

if (-Not (Test-Path -Path $VenvFolder)) {
    Write-Host "  -> Virtual environment '$VenvFolder' not found. Creating..." -ForegroundColor Gray
    python -m venv $VenvFolder
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Failed to create virtual environment." -ForegroundColor Red
        exit 1
    }
    $InstallRequirements = $true
} else {
    Write-Host "  -> Virtual environment '$VenvFolder' already exists." -ForegroundColor Gray
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 2. Activate Virtual Environment ─────────────────────────────
Write-Host "[2/5] Activating virtual environment..." -ForegroundColor Yellow

$activateScript = ".\$VenvFolder\Scripts\Activate.ps1"

if (Test-Path -Path $activateScript) {
    . $activateScript
    Write-Host "  -> Activated." -ForegroundColor Gray
} else {
    Write-Host "  ERROR: Activation script not found at '$activateScript'." -ForegroundColor Red
    Write-Host "        Is this a Windows environment with Python installed?" -ForegroundColor Red
    exit 1
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 3. Install requirements if needed ───────────────────────────
Write-Host "[3/5] Checking Python dependencies..." -ForegroundColor Yellow

if ($InstallRequirements -and (Test-Path -Path "requirements_blink.txt")) {
    Write-Host "  -> Installing Python dependencies from requirements_blink.txt..." -ForegroundColor Gray
    pip install -r requirements_blink.txt
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: pip install had errors. Some packages may be missing." -ForegroundColor Red
    }
} else {
    Write-Host "  -> Skipping (no install flag or requirements file)." -ForegroundColor Gray
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 4. Start Python Blink Server (background) ──────────────────
Write-Host "[4/5] Starting Python Blink Detection Backend..." -ForegroundColor Yellow

if ($SkipBackend) {
    Write-Host "  -> Skipped (--SkipBackend flag set)." -ForegroundColor Gray
} else {
    # Kill any existing blink_server processes to prevent port conflicts
    $existingProcesses = Get-Process -Name "python*" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "blink_server" -or $_.MainWindowTitle -match "blink_server" }
    if ($existingProcesses) {
        Write-Host "  -> Terminating existing blink_server processes..." -ForegroundColor Gray
        $existingProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # Start blink_server.py in a minimized window
    $pythonExe = ".\$VenvFolder\Scripts\python.exe"
    if (Test-Path "blink_server.py") {
        $backendProcess = Start-Process -FilePath $pythonExe `
            -ArgumentList "blink_server.py" `
            -WindowStyle Minimized `
            -PassThru
        Write-Host "  -> Backend started (PID: $($backendProcess.Id)) on http://localhost:5001" -ForegroundColor Gray
    } else {
        Write-Host "  WARNING: blink_server.py not found, skipping backend." -ForegroundColor Red
    }
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 5. Start Vite Dev Server (frontend) ────────────────────────
Write-Host "[5/5] Starting Vite Dev Server (frontend)..." -ForegroundColor Yellow

# Check that node_modules exist
if (-Not (Test-Path -Path "node_modules")) {
    Write-Host "  -> node_modules not found. Running npm install..." -ForegroundColor Gray
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed. Aborting." -ForegroundColor Red
        exit 1
    }
}

Write-Host "  -> Starting dev server on http://localhost:3000" -ForegroundColor Gray
Write-Host "     Press Ctrl+C to stop both frontend and backend." -ForegroundColor DarkGray
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Backend  : http://localhost:5001         " -ForegroundColor Green
Write-Host "  Frontend : http://localhost:3000         " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

npm run dev
