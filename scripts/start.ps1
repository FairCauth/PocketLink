param([switch]$Check, [switch]$NoBrowser, [switch]$Stop, [int]$Port = 8787, [int]$SetupPort = 8788)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$OutputEncoding = [Console]::OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    if ($nodePath) {
        $major = & $nodePath -p "process.versions.node.split('.')[0]"
        if ([int]$major -lt 22) { $nodePath = $null }
    }
    if (!$nodePath) {
        $portable = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools') -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($portable) { $nodePath = $portable.FullName }
    }
    if (!$nodePath) {
        if ($Check -or $Stop) { throw 'Node.js 22+ was not found. Run Start-PocketLink.cmd first.' }
        Write-Host 'Downloading portable Node.js 22 LTS from nodejs.org...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $toolsDir = Join-Path $projectRoot '.tools'
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $manifest = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
        $entry = $manifest -split "`n" | Where-Object { $_ -match "  node-v[0-9.]+-win-$architecture\.zip\s*$" } | Select-Object -First 1
        if (!$entry) { throw 'Could not find a verified Windows Node.js download.' }
        $parts = $entry.Trim() -split '\s+'
        $zipPath = Join-Path $toolsDir $parts[1]
        Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/latest-v22.x/' + $parts[1]) -OutFile $zipPath
        if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $parts[0]) { throw 'Node.js download checksum mismatch.' }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsDir -Force
        $nodePath = Join-Path (Join-Path $toolsDir ([IO.Path]::GetFileNameWithoutExtension($zipPath))) 'node.exe'
    }
    $env:PATH = (Split-Path -Parent $nodePath) + ';' + $env:PATH
    if (!$Stop) {
        & $nodePath -e "try { require('ws'); require('qrcode'); } catch { process.exit(1); }"
        if ($LASTEXITCODE -ne 0) {
            if ($Check) { throw 'Dependencies are missing. Run Start-PocketLink.cmd first.' }
            Write-Host 'Installing PocketLink dependencies...'
            $npmPath = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
            & $npmPath ci --cache (Join-Path $projectRoot '.npm-cache')
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your Internet connection and retry.' }
        }
    }
    $launchArgs = @((Join-Path $PSScriptRoot 'launcher.mjs'), '--port', "$Port", '--setup-port', "$SetupPort")
    if ($Check) { $launchArgs += '--check' }
    if ($NoBrowser) { $launchArgs += '--no-browser' }
    if ($Stop) { $launchArgs += '--stop' }
    & $nodePath @launchArgs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
