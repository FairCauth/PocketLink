param([switch]$Check, [switch]$NoBrowser, [switch]$Stop, [switch]$RepairDrivers, [switch]$SkipDrivers, [int]$Port = 8787, [int]$SetupPort = 8788)
# RepairDrivers is accepted for compatibility; normal startup already repairs missing drivers.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$OutputEncoding = [Console]::OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$preparationLock = $null
$transcribing = $false
function Test-PocketNode {
    param([string]$Path)
    if (!$Path -or !(Test-Path -LiteralPath $Path)) { return $false }
    try {
        $major = & $Path -p "process.versions.node.split('.')[0]"
        return $LASTEXITCODE -eq 0 -and [int]$major -ge 22
    } catch { return $false }
}
try {
    if (!$Check -and !$Stop) {
        $runtimeDir = Join-Path $projectRoot '.runtime'
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        try {
            $preparationLock = [IO.File]::Open((Join-Path $runtimeDir 'preparing.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch { throw 'PocketLink is already preparing dependencies. Wait for the other startup window.' }
        try {
            Start-Transcript -LiteralPath (Join-Path $runtimeDir 'startup.log') -Force | Out-Null
            $transcribing = $true
        } catch {}
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host '[1/4] Checking Node.js...'
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    if (!(Test-PocketNode $nodePath)) { $nodePath = $null }
    if (!$nodePath) {
        $portable = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Where-Object { Test-PocketNode $_.FullName } | Select-Object -First 1
        if ($portable) { $nodePath = $portable.FullName }
    }
    if (!$nodePath) {
        if ($Check -or $Stop) { throw 'Node.js 22+ was not found. Run Start-PocketLink.cmd first.' }
        Write-Host 'Downloading portable Node.js 22 LTS from nodejs.org...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $toolsDir = Join-Path $projectRoot '.tools'
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $architecture = if ($machine -eq 'ARM64') { 'arm64' } elseif ($machine -eq 'AMD64') { 'x64' } else { throw 'PocketLink requires 64-bit Windows.' }
        $manifest = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -TimeoutSec 60).Content
        $entry = $manifest -split "`n" | Where-Object { $_ -match "  node-v[0-9.]+-win-$architecture\.zip\s*$" } | Select-Object -First 1
        if (!$entry) { throw 'Could not find a verified Windows Node.js download.' }
        $parts = $entry.Trim() -split '\s+'
        $zipPath = Join-Path $toolsDir $parts[1]
        Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/latest-v22.x/' + $parts[1]) -OutFile ($zipPath + '.download') -TimeoutSec 180
        if ((Get-FileHash -LiteralPath ($zipPath + '.download') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $parts[0]) { throw 'Node.js download checksum mismatch.' }
        Move-Item -LiteralPath ($zipPath + '.download') -Destination $zipPath -Force
        Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsDir -Force
        $nodePath = Join-Path (Join-Path $toolsDir ([IO.Path]::GetFileNameWithoutExtension($zipPath))) 'node.exe'
        if (!(Test-PocketNode $nodePath)) { throw 'Downloaded Node.js cannot run on this computer.' }
    }
    $env:PATH = (Split-Path -Parent $nodePath) + ';' + $env:PATH
    if (!$Stop) {
        Write-Host '[2/4] Checking project dependencies...'
        & $nodePath (Join-Path $PSScriptRoot 'runtime-dependencies.mjs')
        if ($LASTEXITCODE -ne 0) {
            if ($Check) { throw 'Dependencies are missing. Run Start-PocketLink.cmd first.' }
            Write-Host 'Installing PocketLink dependencies...'
            $npmPath = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
            if (!(Test-Path -LiteralPath $npmPath)) { throw 'npm.cmd is missing from the Node.js installation. Repair Node.js and retry.' }
            & $npmPath ci --ignore-scripts --no-audit --no-fund --cache (Join-Path $projectRoot '.npm-cache')
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your Internet connection and retry.' }
            & $nodePath (Join-Path $PSScriptRoot 'runtime-dependencies.mjs') --record
            if ($LASTEXITCODE -ne 0) { throw 'Dependency verification failed.' }
        }
        . (Join-Path $PSScriptRoot 'windows-dependencies.ps1')
        if ($Check) {
            Get-PocketWindowsDependencies | Format-List
        } else {
            & $nodePath (Join-Path $PSScriptRoot 'prepare-static.mjs')
            if ($LASTEXITCODE -ne 0) { throw 'Could not prepare web assets.' }
            Write-Host '[3/4] Checking Windows drivers...'
            if (!$SkipDrivers) {
                Initialize-PocketWindowsDependencies -ProjectRoot $projectRoot
            }
            Write-Host '[4/4] Starting PocketLink audio studio (USB and wireless included)...'
        }
    }
    $launchArgs = @((Join-Path $PSScriptRoot 'launcher.mjs'), '--port', "$Port", '--setup-port', "$SetupPort")
    if ($Check) { $launchArgs += '--check' }
    if ($NoBrowser) { $launchArgs += '--no-browser' }
    if ($Stop) { $launchArgs += '--stop' }
    if ($preparationLock) { $preparationLock.Dispose(); $preparationLock = $null }
    & $nodePath @launchArgs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($preparationLock) { $preparationLock.Dispose() }
    if ($transcribing) { Stop-Transcript | Out-Null }
}
