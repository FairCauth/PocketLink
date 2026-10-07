# Loading this file has no installation, rename or uninstall side effects.
function Get-PocketCableCaptureEndpoints {
    if (!('PocketLink.WindowsAudio.CaptureEndpoints' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'audio-endpoints.cs') -ErrorAction Stop
    }
    return @([PocketLink.WindowsAudio.CaptureEndpoints]::List() | Where-Object {
        [PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable($_) -and ($_.State -band 11) -ne 0
    })
}

function Get-PocketMicrophoneName {
    # ASCII source stays readable by Windows PowerShell 5.1 on every system locale.
    return 'PocketLink ' + [char]0x9EA6 + [char]0x514B + [char]0x98CE
}

function Set-PocketCableEndpointName {
    param([string]$Id, [string]$Name)
    [PocketLink.WindowsAudio.CaptureEndpoints]::Rename($Id, $Name)
}

function Initialize-PocketCableName {
    $target = Get-PocketMicrophoneName
    $endpoints = @(Get-PocketCableCaptureEndpoints)
    if (!$endpoints.Count) {
        Write-Warning 'VB-CABLE recording endpoint is not ready. If the driver was just installed, restart Windows and run PocketLink again.'
        return $false
    }
    $pending = @($endpoints | Where-Object { $_.Name -ne $target -and $_.Name -ne "$target (VB-Audio Virtual Cable)" })
    if ($pending.Count) {
        Write-Host "Renaming CABLE Output to $target..."
        try {
            foreach ($endpoint in $pending) { Set-PocketCableEndpointName -Id $endpoint.Id -Name $target }
        } catch {
            throw ($_.Exception.GetBaseException().Message + ' Open Windows Sound > Input > CABLE Output > Rename if audio policy is unavailable. No driver reinstall is needed.')
        }
        $verified = @(Get-PocketCableCaptureEndpoints)
        if (!$verified.Count -or @($verified | Where-Object { $_.Name -ne $target -and $_.Name -ne "$target (VB-Audio Virtual Cable)" }).Count) {
            throw 'The microphone name could not be verified. Open Windows Sound > Input > CABLE Output and rename it manually.'
        }
    }
    Write-Host "System microphone: $target"
    return $true
}

function Test-PocketCableAutoInstall {
    param([string]$ProjectRoot)
    return !(Test-Path -LiteralPath (Join-Path $ProjectRoot '.runtime\cable-auto-install-disabled'))
}

function Set-PocketCableAutoInstall {
    param([string]$ProjectRoot, [bool]$Enabled)
    $marker = Join-Path $ProjectRoot '.runtime\cable-auto-install-disabled'
    if ($Enabled) {
        if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
        Set-Content -LiteralPath $marker -Value 'VB-CABLE was uninstalled. The next normal PocketLink startup restores automatic installation.' -Encoding UTF8
    }
}

function Uninstall-PocketCable {
    param([Parameter(Mandatory=$true)][string]$ProjectRoot)
    $before = Get-PocketWindowsDependencies
    if ($before.Cable -eq 'unknown') { throw 'Cannot identify VB-CABLE. No driver removal was attempted.' }
    if ($before.Cable -eq 'missing') {
        Set-PocketCableAutoInstall -ProjectRoot $ProjectRoot -Enabled $false
        Write-Host 'VB-CABLE is not installed. The next normal PocketLink startup will prepare it again.'
        return
    }
    Write-Host 'Close PocketLink receiver tabs and any apps using VB-CABLE before removing the driver.'
    Write-Host 'This removes the shared VB-CABLE virtual sound card (CABLE Input and the PocketLink microphone). Other apps using it will lose that audio route.'
    Write-Host 'Apple Devices and other audio drivers are not removed.'
    # Verify/download before persisting the preference or opening an installer.
    $installer = Get-PocketCableInstaller -ProjectRoot $ProjectRoot
    # Retain the marker for older launchers. The current launcher clears it on startup.
    Set-PocketCableAutoInstall -ProjectRoot $ProjectRoot -Enabled $false
    Write-Host 'The next normal PocketLink startup will install VB-CABLE if it is missing.'
    Invoke-PocketCableInstaller -Installer $installer -Action Uninstall
    $after = Get-PocketWindowsDependencies
    if ($after.Cable -eq 'missing') {
        Write-Host 'VB-CABLE is no longer detected. Follow the official installer restart instructions.'
    } else {
        Write-Warning 'VB-CABLE is still detected or cannot be verified. Removal may have been cancelled or may require a restart; uninstallation is not confirmed.'
    }
    Write-Host 'To use PocketLink again, run Start-PocketLink.cmd. Missing drivers are installed automatically.'
}
