param([ValidateSet('Rename', 'Install', 'Uninstall', 'Check')][string]$Action = 'Check')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$OutputEncoding = [Console]::OutputEncoding
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'windows-dependencies.ps1')
$driverLock = $null
try {
    if ($Action -in @('Install', 'Uninstall')) {
        $runtime = Join-Path $projectRoot '.runtime'
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        try {
            $driverLock = [IO.File]::Open((Join-Path $runtime 'preparing.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch { throw 'PocketLink is already preparing or managing drivers. Wait for the other setup window.' }
    }
    switch ($Action) {
        'Check' {
            Get-PocketWindowsDependencies | Format-List
            Get-PocketCableCaptureEndpoints | Select-Object Name, Description, Adapter, State | Format-List
            Write-Host "Automatic installation enabled: $(Test-PocketCableAutoInstall -ProjectRoot $projectRoot)"
        }
        'Rename' {
            if (!(Initialize-PocketCableName)) { exit 1 }
        }
        'Install' {
            $state = Get-PocketWindowsDependencies
            if ($state.Cable -eq 'unknown') { throw 'Cannot inspect VB-CABLE. No installation was attempted.' }
            if ($state.Cable -eq 'missing') { Install-PocketCable -ProjectRoot $projectRoot }
            if ((Get-PocketWindowsDependencies).Cable -ne 'installed') { throw 'VB-CABLE installation is not confirmed. Follow the installer restart instructions and retry.' }
            Set-PocketCableAutoInstall -ProjectRoot $projectRoot -Enabled $true
            if (!(Initialize-PocketCableName)) { exit 1 }
        }
        'Uninstall' { Uninstall-PocketCable -ProjectRoot $projectRoot }
    }
} catch {
    Write-Host $_.Exception.GetBaseException().Message -ForegroundColor Red
    exit 1
} finally {
    if ($driverLock) { $driverLock.Dispose() }
}
