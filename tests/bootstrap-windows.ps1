$ErrorActionPreference = 'Stop'
foreach ($file in @('scripts/start.ps1', 'scripts/windows-dependencies.ps1', 'scripts/cable-management.ps1', 'scripts/manage-cable.ps1')) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) $file), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
. ./scripts/windows-dependencies.ps1
$script:appleCalls = 0
$script:cableCalls = 0
$script:apple = 'installed'
$script:cable = 'installed'
$script:renameCalls = 0
$script:autoInstall = $true
$script:installSucceeds = $false
# Substitute only the external installer boundary; never install software in tests.
function Get-PocketWindowsDependencies { return [PSCustomObject]@{ Apple = $script:apple; Cable = $script:cable } }
function Install-PocketAppleDevices { $script:appleCalls++ }
function Install-PocketCable {
    param([string]$ProjectRoot)
    $script:cableCalls++
    if ($script:installSucceeds) { $script:cable = 'installed' }
}
function Initialize-PocketCableName { $script:renameCalls++; return $true }
function Test-PocketCableAutoInstall { param([string]$ProjectRoot); return $script:autoInstall }
function Set-PocketCableAutoInstall { param([string]$ProjectRoot, [bool]$Enabled); $script:autoInstall = $Enabled }
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path
if ($script:appleCalls -or $script:cableCalls) { throw 'Installed drivers must not be reinstalled.' }
if ($script:renameCalls -ne 1) { throw 'Existing VB-CABLE must be checked for automatic microphone naming.' }
$script:apple = 'missing'
$script:cable = 'missing'
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path
if ($script:appleCalls -ne 1 -or $script:cableCalls -ne 1) { throw 'Missing components must run setup.' }
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path -Wireless
if ($script:appleCalls -ne 1 -or $script:cableCalls -ne 2) { throw 'Wireless mode must skip Apple setup.' }
$script:apple = 'unknown'
$script:cable = 'unknown'
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path
if ($script:appleCalls -ne 1 -or $script:cableCalls -ne 2) { throw 'Unknown detection must not trigger duplicate installs.' }
$script:cable = 'missing'
$script:autoInstall = $false
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path -Wireless
if ($script:cableCalls -ne 3 -or !$script:autoInstall) { throw 'Normal startup must clear the legacy opt-out and install a missing driver.' }
$script:autoInstall = $true
$script:installSucceeds = $true
Initialize-PocketWindowsDependencies -ProjectRoot (Get-Location).Path -Wireless
if ($script:cableCalls -ne 4 -or $script:renameCalls -ne 2) { throw 'A newly installed driver must be renamed during the same initialization.' }
Write-Output 'PASS Windows preparation orchestration'
