# Run this script in an Elevated (Administrator) PowerShell
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Please run this script in an Administrator PowerShell."
    exit 1
}

$baseDir = "D:\software\easytier"
New-Item -ItemType Directory -Force -Path (Join-Path $baseDir "logs") | Out-Null

# Validate config before registering service
& (Join-Path $baseDir "easytier-core.exe") -c (Join-Path $baseDir "config.toml") --multi-thread true --bind-device true --check-config
if ($LASTEXITCODE -ne 0) {
    throw "EasyTier config check failed with exit code $LASTEXITCODE"
}

# Allow inbound/outbound for easytier-core.exe (essential for UDP P2P hole punching)
$ruleName = "EasyTier Core"
$coreExe = Join-Path $baseDir "easytier-core.exe"
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $ruleName
}
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Program $coreExe -Action Allow | Out-Null
Write-Output "Configured Windows Firewall rule: $ruleName -> $coreExe"

# Reinstall cleanly if already registered
$svcExe = Join-Path $baseDir "easytier-service.exe"
$svc = Get-Service -Name "EasyTierService" -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") {
        & $svcExe stop
    }
    & $svcExe uninstall
}

& $svcExe install
& $svcExe start

Start-Sleep -Seconds 5
Get-Service -Name "EasyTierService" | Format-Table Name, Status, StartType -AutoSize
& (Join-Path $baseDir "easytier-cli.exe") node
& (Join-Path $baseDir "easytier-cli.exe") peer
