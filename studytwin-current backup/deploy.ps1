# ============================================================
# StudyTwin - Clean Build & Firebase Deploy Script
# ============================================================
# This script ensures a fresh production build is created
# and only finalized web assets are deployed to Firebase.
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  StudyTwin - Build & Deploy Pipeline"       -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Clean previous artifacts ──────────────────────────
Write-Host "[1/5] Cleaning previous build artifacts..." -ForegroundColor Yellow

if (Test-Path -Path "dist") {
    Remove-Item -Recurse -Force "dist"
    Write-Host "  -> Removed old 'dist' directory." -ForegroundColor Gray
}

if (Test-Path -Path ".firebase") {
    Remove-Item -Recurse -Force ".firebase"
    Write-Host "  -> Cleared Firebase local cache." -ForegroundColor Gray
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── Step 2: Verify node_modules ───────────────────────────────
Write-Host "[2/5] Verifying dependencies..." -ForegroundColor Yellow

if (-not (Test-Path -Path "node_modules")) {
    Write-Host "  -> node_modules not found. Running npm install..." -ForegroundColor Gray
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed. Aborting." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  -> node_modules present." -ForegroundColor Gray
}

# Verify vite is accessible
$viteCheck = npx vite --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  -> Vite not found. Reinstalling dependencies..." -ForegroundColor Gray
    Remove-Item -Recurse -Force "node_modules"
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: npm install failed. Aborting." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "  -> Vite verified: $viteCheck" -ForegroundColor Gray
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── Step 3: Production build ─────────────────────────────────
Write-Host "[3/5] Building production bundle (npm run build)..." -ForegroundColor Yellow

npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: Build failed! Check the errors above." -ForegroundColor Red
    Write-Host "  Deployment aborted." -ForegroundColor Red
    exit 1
}

Write-Host "  Build successful." -ForegroundColor Green
Write-Host ""

# ── Step 4: Verify dist contents ─────────────────────────────
Write-Host "[4/5] Verifying dist folder..." -ForegroundColor Yellow

if (-not (Test-Path -Path "dist")) {
    Write-Host "  ERROR: 'dist' folder was not created. Build may have misconfigured output." -ForegroundColor Red
    exit 1
}

$fileCount = (Get-ChildItem -Path "dist" -Recurse -File).Count
Write-Host "  -> dist contains $fileCount files." -ForegroundColor Gray

# Check for forbidden executables sneaking into dist
$exeFiles = Get-ChildItem -Path "dist" -Recurse -Include *.exe,*.bin,*.sh -File
if ($exeFiles.Count -gt 0) {
    Write-Host "  WARNING: Found $($exeFiles.Count) executable files in dist!" -ForegroundColor Red
    $exeFiles | ForEach-Object { Write-Host "    - $($_.FullName)" -ForegroundColor Red }
    Write-Host "  These will be rejected by the Spark plan. Removing them..." -ForegroundColor Yellow
    $exeFiles | Remove-Item -Force
}

Write-Host "  Done." -ForegroundColor Green
Write-Host ""

# ── Step 5: Deploy to Firebase ────────────────────────────────
Write-Host "[5/5] Deploying to Firebase Hosting..." -ForegroundColor Yellow
Write-Host ""

firebase deploy --only hosting

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: Firebase deployment failed." -ForegroundColor Red
    Write-Host "  Try: firebase login --reauth" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Deployment Complete!"                       -ForegroundColor Green
Write-Host "  Project: studytwin-rvce"                    -ForegroundColor Green
Write-Host "  https://studytwin-rvce.web.app"             -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
