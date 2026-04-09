# ============================================================
# StudyTwin - Master Automation Script (Deploy & Server)
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  StudyTwin - Master Automation Pipeline"      -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Environment Setup ─────────────────────────────────────
Write-Host "[1/5] Checking Environments..." -ForegroundColor Yellow

# Python Venv Check
$VenvFolder = "venv_blink"
if (-Not (Test-Path -Path $VenvFolder)) {
    Write-Host "  -> Virtual environment not found. Creating..." -ForegroundColor Gray
    python -m venv $VenvFolder
    Write-Host "  -> Installing requirements_blink.txt..." -ForegroundColor Gray
    & ".\$VenvFolder\Scripts\pip.exe" install -r requirements_blink.txt
} else {
    Write-Host "  -> Python virtual environment ('$VenvFolder') present." -ForegroundColor Gray
}

# Node Modules Check
if (-Not (Test-Path -Path "node_modules")) {
    Write-Host "  -> node_modules not found. Running npm install..." -ForegroundColor Gray
    npm install
} else {
    Write-Host "  -> node_modules present." -ForegroundColor Gray
}
Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 2. Firebase Config Check ─────────────────────────────────
Write-Host "[2/5] Validating Firebase Config..." -ForegroundColor Yellow
$firebaseJsonPath = "firebase.json"
if (Test-Path $firebaseJsonPath) {
    $fbConfig = Get-Content $firebaseJsonPath | ConvertFrom-Json
    if ($fbConfig.hosting.public -ne "dist") {
        Write-Host "  WARNING: firebase.json 'public' is not 'dist'. Fixing automatically..." -ForegroundColor Red
        $fbConfig.hosting.public = "dist"
        $fbConfig | ConvertTo-Json -Depth 10 | Set-Content $firebaseJsonPath
    }
} else {
    Write-Host "  ERROR: firebase.json missing! Deployment aborted." -ForegroundColor Red
    exit 1
}
Write-Host "  -> firebase.json settings validated." -ForegroundColor Gray
Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 3. Start Python Backend (Background) ────────────────────
Write-Host "[3/5] Starting Python Backend..." -ForegroundColor Yellow
Write-Host "  -> Launching blink_server.py in a background process..." -ForegroundColor Gray

# Quietly terminate any existing python processes running blink_server to prevent port conflicts
Get-Process -Name "python*" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "blink_server" } |
    Stop-Process -Force -ErrorAction SilentlyContinue

# Start blink_server.py in a separate minimized window
$backendProcess = Start-Process -FilePath ".\$VenvFolder\Scripts\python.exe" -ArgumentList "blink_server.py" -WindowStyle Minimized -PassThru
Write-Host "  -> Backend running (Process ID: $($backendProcess.Id))." -ForegroundColor Gray
Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 4. Build & Firebase Deploy ──────────────────────────────
Write-Host "[4/5] Building & Deploying Frontend..." -ForegroundColor Yellow

Write-Host "  -> Cleaning old dist folder..." -ForegroundColor Gray
if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }

Write-Host "  -> Running 'npm run build'..." -ForegroundColor Gray
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "  -> Auditing build directory for forbidden executables (.exe, .bin, .sh)..." -ForegroundColor Gray
$exeFiles = Get-ChildItem -Path "dist" -Recurse -Include *.exe,*.bin,*.sh -File
if ($exeFiles.Count -gt 0) {
    $exeFiles | ForEach-Object { Write-Host "    - $($_.FullName)" -ForegroundColor Red }
    Write-Host "  -> Removing forbidden files from dist..." -ForegroundColor Yellow
    $exeFiles | Remove-Item -Force
} else {
    Write-Host "  -> No executables found. Build is clean." -ForegroundColor Gray
}

Write-Host "  -> Deploying to Firebase Hosting..." -ForegroundColor Gray
firebase deploy --only hosting
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Firebase deployment failed." -ForegroundColor Red
    Write-Host "  Try checking the Firebase logs above for forbidden file detections." -ForegroundColor Red
    exit 1
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── 5. Completion ───────────────────────────────────────────
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Success! Fully Deployed and Running."        -ForegroundColor Green
Write-Host "  Backend  : Active in background"             -ForegroundColor Green
Write-Host "  Frontend : https://studytwin-rvce.web.app"   -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
