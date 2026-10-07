# Loaded by start.ps1. Merely dot-sourcing this file never installs anything.
. (Join-Path $PSScriptRoot 'cable-management.ps1')
function Get-PocketWindowsDependencies {
    $apple = 'unknown'
    $cable = 'unknown'
    try {
        $appleService = Get-Service -Name 'Apple Mobile Device Service' -ErrorAction SilentlyContinue
        $appleApp = Get-AppxPackage -Name 'AppleInc.AppleDevices' -ErrorAction Stop
        $apple = if ($appleService -or $appleApp) { 'installed' } else { 'missing' }
    } catch {
        if ($appleService) { $apple = 'installed' }
    }
    try {
        # The MEDIA hardware device keeps its identity even when endpoints are renamed.
        $devices = @(Get-PnpDevice -Class Media -PresentOnly -ErrorAction Stop | Where-Object {
            $_.FriendlyName -eq 'VB-Audio Virtual Cable'
        })
        $cable = if ($devices.Count) { 'installed' } else { 'missing' }
    } catch {}
    return [PSCustomObject]@{ Apple = $apple; Cable = $cable }
}

function Install-PocketAppleDevices {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host 'Installing Apple Devices from Microsoft Store...'
        & $winget.Source install --id 9NP83LWLPZ9K --exact --source msstore --accept-source-agreements --accept-package-agreements --disable-interactivity
        if ($LASTEXITCODE -eq 0) { return }
        Write-Warning 'Automatic Store installation did not finish. Complete installation in Microsoft Store.'
    } else {
        Write-Warning 'winget is unavailable. Install Apple Devices from the Store page that opens.'
    }
    # The user needs to interact with the Store if automatic installation fails.
    Start-Process 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K'
}

function Get-PocketCableInstaller {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot)
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') {
        throw 'Automatic VB-CABLE setup supports x64 Windows only. Get the correct driver from https://vb-audio.com/Cable/ .'
    }
    $folder = Join-Path $ProjectRoot '.tools\vb-cable-pack45'
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $archive = Join-Path $folder 'driver.zip'
    $installer = Join-Path $folder 'VBCABLE_Setup_x64.exe'
    $expectedHash = 'b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb'
    if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        Write-Host 'Downloading VB-CABLE from vb-audio.com...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip' -OutFile ($archive + '.download') -TimeoutSec 180
        if ((Get-FileHash -LiteralPath ($archive + '.download') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
            throw 'VB-CABLE download checksum mismatch. Get the current package from https://vb-audio.com/Cable/ manually.'
        }
        Move-Item -LiteralPath ($archive + '.download') -Destination $archive -Force
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $folder -Force
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'VB-Audio|Vincent Burel|Burel Vincent') {
        throw 'VB-CABLE installer signature could not be verified. Install from https://vb-audio.com/Cable/ manually.'
    }
    return $installer
}

function Invoke-PocketCableInstaller {
    param([Parameter(Mandatory=$true)][string]$Installer, [ValidateSet('Install', 'Uninstall')][string]$Action)
    $folder = Split-Path -Parent $Installer
    if ($Action -eq 'Uninstall') { Write-Host 'In the official VB-CABLE installer, click Remove Driver. Accept Windows authorization if prompted.' }
    else { Write-Host 'In the official VB-CABLE installer, click Install Driver. Accept Windows authorization if prompted.' }
    # This official installer is interactive; no undocumented silent driver switches.
    $process = Start-Process -FilePath $Installer -WorkingDirectory $folder -Verb RunAs -WindowStyle Normal -Wait -PassThru
    Write-Host "VB-CABLE installer closed (exit $($process.ExitCode)). Follow its restart instructions; PocketLink never restarts Windows automatically."
}

function Install-PocketCable {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot)
    $installer = Get-PocketCableInstaller -ProjectRoot $ProjectRoot
    Invoke-PocketCableInstaller -Installer $installer -Action Install
}

function Initialize-PocketWindowsDependencies {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot, [switch]$Wireless)
    # A normal launch prepares missing components, including after an earlier uninstall.
    # Clear the legacy opt-out so old project state cannot block one-click startup.
    Set-PocketCableAutoInstall -ProjectRoot $ProjectRoot -Enabled $true
    $state = Get-PocketWindowsDependencies
    Write-Host "Windows components: Apple USB support=$($state.Apple); VB-CABLE=$($state.Cable)"
    if (!$Wireless -and $state.Apple -eq 'missing') {
        try { Install-PocketAppleDevices } catch { Write-Warning "Apple Devices: $($_.Exception.Message)" }
    } elseif (!$Wireless -and $state.Apple -eq 'unknown') {
        Write-Warning 'Cannot inspect Apple USB support. Install Apple Devices if USB connection is unavailable.'
    }
    if ($state.Cable -eq 'missing') {
        try { Install-PocketCable -ProjectRoot $ProjectRoot } catch { Write-Warning "VB-CABLE: $($_.Exception.Message)" }
    } elseif ($state.Cable -eq 'unknown') {
        Write-Warning 'Cannot inspect audio drivers. Check Windows Sound settings for CABLE Input / CABLE Output.'
    }
    $after = Get-PocketWindowsDependencies
    Write-Host "Windows components after setup: Apple USB support=$($after.Apple); VB-CABLE=$($after.Cable)"
    if ($after.Cable -ne 'installed') {
        Write-Warning 'System microphone is not confirmed ready. You can still connect and listen in the browser; finish VB-CABLE installation for other apps.'
    }
    if ($after.Cable -eq 'installed') {
        try { $null = Initialize-PocketCableName } catch { Write-Warning "Microphone name: $($_.Exception.Message)" }
    }
}
