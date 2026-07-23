param(
  [Parameter(Mandatory=$true)][string]$CanonicalRoot,
  [string]$HaBin = "ha",
  [string]$ServiceName = "HarnessAnythingDaemon"
)

$ErrorActionPreference = "Stop"

$command = "`"$HaBin`" --root `"$CanonicalRoot`" daemon start --foreground"
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe config $ServiceName binPath= $command | Out-Null
} else {
  New-Service -Name $ServiceName -BinaryPathName $command -DisplayName "Harness Anything Daemon" -StartupType Automatic | Out-Null
}

New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName" -Name Environment -PropertyType MultiString -Value @("HARNESS_DAEMON_SUPERVISOR=windows-service:$ServiceName") -Force | Out-Null

Write-Host "Service registered: $ServiceName"
Write-Host "Start with: Start-Service $ServiceName"
Write-Host "Verify with: ha --root `"$CanonicalRoot`" daemon status --json"
