$ErrorActionPreference = 'Stop'
. ./scripts/windows-dependencies.ps1
Add-Type -Path ./scripts/audio-endpoints.cs
$name = Get-PocketMicrophoneName
function Assert-True { param([bool]$Value, [string]$Message); if (!$Value) { throw $Message } }
function New-TestEndpoint {
    param([string]$Description = 'CABLE Output', [string]$Adapter = 'VB-Audio Virtual Cable', [string]$Id = '{0.0.1.00000000}.{test}')
    $endpoint = New-Object PocketLink.WindowsAudio.Endpoint
    $endpoint.Id = $Id; $endpoint.Description = $Description; $endpoint.Adapter = $Adapter
    return $endpoint
}
Assert-True ([PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint))) 'Base capture device must be recognized.'
Assert-True ([PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint -Description $name))) 'Windows-renamed device must be recognized.'
Assert-True (![PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint -Id '{0.0.0.00000000}.{test}'))) 'Playback device must never be renamed.'
Assert-True (![PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint -Adapter 'VB-Audio Cable A'))) 'CABLE A must not be renamed.'
Assert-True (![PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint -Description 'CABLE Out 16ch'))) 'Other pins must not be renamed.'
Assert-True (![PocketLink.WindowsAudio.CaptureEndpoints]::IsBaseCable((New-TestEndpoint -Adapter 'USB Microphone'))) 'Hardware microphone must not be renamed.'

# All OS mutation boundaries below are mocked. No real rename/UAC/uninstall.
$script:endpoints = @([PSCustomObject]@{ Id = 'capture-test'; Name = 'CABLE Output (VB-Audio Virtual Cable)' })
$script:renameCalls = 0; $script:failWrite = $false; $script:denyWrite = $false
function Get-PocketCableCaptureEndpoints { return $script:endpoints }
function Set-PocketCableEndpointName {
    param([string]$Id, [string]$Name)
    Assert-True ($Id -eq 'capture-test') 'Wrong rename target.'
    $script:renameCalls++
    if ($script:denyWrite) { throw 'Windows audio policy rejected the microphone label (HRESULT 0x80070005).' }
    if (!$script:failWrite) { $script:endpoints[0].Name = $Name }
}
# Unexpected UAC or installer launches during naming must fail the test.
function Start-Process { throw 'Naming must not launch an elevated helper.' }
Assert-True (Initialize-PocketCableName) 'Rename should succeed.'
Assert-True ($script:renameCalls -eq 1) 'One rename expected.'
Assert-True (Initialize-PocketCableName) 'Already-renamed device should succeed.'
Assert-True ($script:renameCalls -eq 1) 'Already-renamed device must not be written again.'
$script:endpoints[0].Name = "$name (VB-Audio Virtual Cable)"
Assert-True (Initialize-PocketCableName) 'Windows adapter suffix must be accepted.'
Assert-True ($script:renameCalls -eq 1) 'Adapter suffix must not trigger UAC or another rename.'
$script:endpoints[0].Name = 'CABLE Output'
$script:denyWrite = $true; $caught = $false
try { $null = Initialize-PocketCableName } catch {
    $caught = $true
    Assert-True ($_.Exception.Message -match '0x80070005' -and $_.Exception.Message -match 'No driver reinstall') 'Preserve the actual HRESULT and provide recovery guidance.'
}
Assert-True $caught 'Policy errors must not be hidden behind an exit code.'
$script:denyWrite = $false; $script:failWrite = $true; $script:endpoints[0].Name = 'CABLE Output'
$caught = $false
try { $null = Initialize-PocketCableName } catch { $caught = $true }
Assert-True $caught 'An unpersisted rename must not report success.'
$script:endpoints = @()
Assert-True (!(Initialize-PocketCableName)) 'A missing endpoint needs restart guidance.'

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('pocketlink-driver-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Assert-True (Test-PocketCableAutoInstall -ProjectRoot $scratch) 'Default should permit installation.'
    Set-PocketCableAutoInstall -ProjectRoot $scratch -Enabled $false
    Assert-True (!(Test-PocketCableAutoInstall -ProjectRoot $scratch)) 'Uninstall preference must persist.'
    Set-PocketCableAutoInstall -ProjectRoot $scratch -Enabled $true
    Assert-True (Test-PocketCableAutoInstall -ProjectRoot $scratch) 'Explicit setup should restore installation.'
    $script:cableState = 'installed'; $script:uninstalls = 0; $script:downloads = 0; $script:verificationFails = $false
    function Get-PocketWindowsDependencies { return [PSCustomObject]@{ Apple = 'installed'; Cable = $script:cableState } }
    function Get-PocketCableInstaller {
        param([string]$ProjectRoot)
        $script:downloads++
        if ($script:verificationFails) { throw 'Signature verification failed' }
        return 'verified-installer.exe'
    }
    function Invoke-PocketCableInstaller {
        param([string]$Installer, [string]$Action)
        Assert-True ($Installer -eq 'verified-installer.exe' -and $Action -eq 'Uninstall') 'Use official uninstall action only.'
        Assert-True (!(Test-PocketCableAutoInstall -ProjectRoot $scratch)) 'Persist opt-out before driver removal.'
        $script:uninstalls++
    }
    # Simulate cancel or reboot pending: never claim the driver is gone.
    $warnings = @()
    Uninstall-PocketCable -ProjectRoot $scratch -WarningVariable warnings
    Assert-True ($script:uninstalls -eq 1) 'Installed cable opens official removal UI.'
    Assert-True (($warnings -join ' ') -match 'not confirmed') 'Cancellation must not claim successful removal.'
    $script:cableState = 'missing'
    Uninstall-PocketCable -ProjectRoot $scratch
    Assert-True ($script:uninstalls -eq 1 -and $script:downloads -eq 1) 'Missing cable must not open/download an installer.'
    # Reproduce the user's state: uninstall marker exists and the driver is missing.
    $script:installs = 0
    function Install-PocketCable { param([string]$ProjectRoot); $script:installs++ }
    Initialize-PocketWindowsDependencies -ProjectRoot $scratch
    Assert-True ($script:installs -eq 1) 'Normal startup must attempt installation without a repair flag.'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $scratch '.runtime\cable-auto-install-disabled'))) 'Normal startup must clear the real legacy marker.'

    $script:cableState = 'unknown'; $caught = $false
    try { Uninstall-PocketCable -ProjectRoot $scratch } catch { $caught = $true }
    Assert-True ($caught -and $script:uninstalls -eq 1) 'Unknown driver identity must not trigger uninstall.'
    $script:cableState = 'installed'; $script:verificationFails = $true; $caught = $false
    Set-PocketCableAutoInstall -ProjectRoot $scratch -Enabled $true
    try { Uninstall-PocketCable -ProjectRoot $scratch } catch { $caught = $true }
    Assert-True ($caught -and $script:uninstalls -eq 1) 'Verification failure must prevent installer execution.'
    Assert-True (Test-PocketCableAutoInstall -ProjectRoot $scratch) 'Verification failure must preserve preferences.'
} finally {
    # Delete only this test's resolved temporary directory with native PowerShell.
    $resolved = [IO.Path]::GetFullPath($scratch)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^pocketlink-driver-test-[0-9a-f]{32}$') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output 'PASS driver naming, target isolation, no elevation, error details, verification, uninstall cancellation and persistent opt-out'
