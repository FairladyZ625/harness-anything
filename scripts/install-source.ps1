#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$repoUrl = if ($env:HARNESS_REPO_URL) { $env:HARNESS_REPO_URL } else { 'https://github.com/FairladyZ625/harness-anything.git' }
$installRoot = if ($env:HARNESS_INSTALL_ROOT) { $env:HARNESS_INSTALL_ROOT } else { Join-Path $HOME '.local\share\harness-anything' }
$npmPrefix = if ($env:HARNESS_NPM_PREFIX) { $env:HARNESS_NPM_PREFIX } else { Join-Path $HOME '.local\share\harness-anything-npm' }
$pullMode = 'pull'
$expectedRef = ''

function Show-Usage {
  @'
Usage: install-source.ps1 [--offline|--no-pull|-Offline|-NoPull] [--ref <commit>|-Ref <commit>]

  --offline, --no-pull  Build the existing checkout without contacting the remote.
                        Fails when the checkout does not exist yet.
  --ref <commit>        Install exactly this commit. With network access, fetch it
                        and detach HEAD if needed and the checkout is clean.
  -h, --help, -Help     Show this help.
'@ | Write-Output
}

for ($i = 0; $i -lt $args.Count; $i++) {
  $arg = [string]$args[$i]
  switch -Regex ($arg) {
    '^(--offline|--no-pull|-Offline|-NoPull)$' { $pullMode = 'off' }
    '^(--ref|-Ref)$' {
      if ($i + 1 -ge $args.Count) {
        [Console]::Error.WriteLine('--ref requires a commit')
        exit 2
      }
      $i++
      $expectedRef = [string]$args[$i]
    }
    '^--ref=(.*)$' { $expectedRef = $Matches[1] }
    '^(-h|--help|-Help)$' {
      Show-Usage
      exit 0
    }
    default {
      Show-Usage | Out-String | ForEach-Object { [Console]::Error.Write($_) }
      [Console]::Error.WriteLine("Unknown argument: $arg")
      exit 2
    }
  }
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
  }
}

function Invoke-DownloadWithRetry {
  param([string]$Label, [scriptblock]$Action)
  $delay = 1
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    & $Action $attempt | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($attempt -lt 4) {
      [Console]::Error.WriteLine("$Label failed. Retrying in $delay seconds (retry $attempt/3).")
      Start-Sleep -Seconds $delay
      $delay *= 2
    }
  }
  return $false
}

function Invoke-GitDownload {
  param([string]$Label, [string[]]$Arguments)
  Invoke-DownloadWithRetry $Label {
    param($attempt)
    $config = if ($attempt -gt 1) { @('-c', 'http.version=HTTP/1.1') }
    & $gitCmd.Source @config @Arguments
  }
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $gitCmd -or -not $nodeCmd -or -not $npmCmd) {
  [Console]::Error.WriteLine('Harness Anything requires git, Node.js 24+, and npm.')
  exit 1
}

$nodeVersionText = ((& $nodeCmd.Source --version) | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(\d+)\.') {
  [Console]::Error.WriteLine('Harness Anything requires Node.js 24 or newer.')
  exit 1
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 24) {
  [Console]::Error.WriteLine('Harness Anything requires Node.js 24 or newer.')
  exit 1
}

$parentDir = Split-Path -Parent $installRoot
if ($parentDir -and -not (Test-Path $parentDir)) {
  New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

if (-not (Test-Path (Join-Path $installRoot '.git'))) {
  if ($pullMode -eq 'off') {
    [Console]::Error.WriteLine("Cannot install offline: $installRoot is not a git checkout.")
    [Console]::Error.WriteLine('Run the installer once with network access, or copy an existing checkout to that path first.')
    exit 1
  }
  if (-not (Invoke-GitDownload 'Git clone' @('clone', '--', $repoUrl, $installRoot))) { exit 1 }
} elseif (($pullMode -eq 'pull') -and -not $expectedRef) {
  if (-not (Invoke-GitDownload 'Git pull' @('-C', $installRoot, 'pull', '--ff-only'))) {
    [Console]::Error.WriteLine("Cannot update $installRoot. If the source was synced another way, rerun with --offline.")
    exit 1
  }
}

Push-Location $installRoot
try {
  if ($expectedRef) {
    $expectedSha = (& $gitCmd.Source rev-parse --verify --quiet --end-of-options "$expectedRef^{commit}" | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) { $expectedSha = '' }
    $actualSha = (& $gitCmd.Source rev-parse HEAD | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the source checkout HEAD.' }
    if ($actualSha -ne $expectedSha) {
      if ($pullMode -eq 'off') {
        [Console]::Error.WriteLine("Offline install requires HEAD at $expectedRef. Current HEAD is $actualSha.")
        exit 1
      }
      $checkoutStatus = & $gitCmd.Source status --porcelain
      if ($LASTEXITCODE -ne 0) { throw 'Could not read the source checkout status.' }
      if ($checkoutStatus) {
        [Console]::Error.WriteLine("Cannot switch to ${expectedRef}: $installRoot has local changes. Commit or remove them, then retry.")
        exit 1
      }
      $fetchRef = if ($expectedSha) { $expectedSha } else { $expectedRef }
      if (Invoke-GitDownload 'Git fetch' @('fetch', '--no-tags', '--', 'origin', $fetchRef)) {
        $expectedSha = (& $gitCmd.Source rev-parse --verify 'FETCH_HEAD^{commit}' | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the fetched commit.' }
      } elseif (-not $expectedSha) {
        exit 1
      } else {
        [Console]::Error.WriteLine("Using the local commit $expectedSha after fetch failed.")
      }
      Invoke-Checked $gitCmd.Source @('checkout', '--detach', $expectedSha)
    }
  }

  $manifestInputs = @('package-lock.json', 'package.json')
  $workspacePkgDir = Join-Path $installRoot 'packages'
  if (Test-Path $workspacePkgDir) {
    Get-ChildItem -Path $workspacePkgDir -Directory | ForEach-Object {
      $pkgJson = Join-Path $_.FullName 'package.json'
      if (Test-Path $pkgJson) {
        $manifestInputs += ("packages/{0}/package.json" -f $_.Name)
      }
    }
  }

  $digestScript = @'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const hash = createHash("sha256");
for (const file of process.argv.slice(2).sort()) {
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
'@
  $depsDigest = ($digestScript | & $nodeCmd.Source --input-type=module - @manifestInputs) | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Failed to compute dependency digest.' }
  $depsDigest = $depsDigest.Trim()
  $depsStamp = Join-Path $installRoot 'node_modules\.harness-install-deps.sha256'

  if ((Test-Path (Join-Path $installRoot 'node_modules')) -and (Test-Path $depsStamp) -and ((Get-Content $depsStamp -Raw).Trim() -eq $depsDigest)) {
    Write-Output ("Dependencies unchanged ({0}); skipping npm ci." -f $depsDigest.Substring(0, [Math]::Min(12, $depsDigest.Length)))
  } else {
    Write-Output 'Installing dependencies. The Electron runtime downloads separately and a first run can take several minutes; later runs reuse the caches.'
    $previousSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
    try {
      $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
      Invoke-Checked $npmCmd.Source @('ci', '--no-audit', '--no-fund')
    } finally {
      $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $previousSkip
    }
    Set-Content -Path $depsStamp -Value "$depsDigest`n" -NoNewline -Encoding ASCII
  }

  $electronInstall = { & $nodeCmd.Source 'node_modules/electron/install.js' }
  if (-not (Invoke-DownloadWithRetry 'Electron download' $electronInstall)) {
    if ($env:ELECTRON_MIRROR -or $env:npm_config_electron_mirror -or $env:npm_package_config_electron_mirror) {
      throw 'Electron download failed with the configured mirror.'
    }
    [Console]::Error.WriteLine('Electron default download failed. Retrying with https://npmmirror.com/mirrors/electron/.')
    $previousMirror = $env:ELECTRON_MIRROR
    try {
      $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
      if (-not (Invoke-DownloadWithRetry 'Electron mirror download' $electronInstall)) {
        throw 'Electron download failed with the fallback mirror.'
      }
    } finally {
      $env:ELECTRON_MIRROR = $previousMirror
    }
  }
  # Upgrade step: daemon, CLI and GUI are built together. A running Electron window keeps the
  # bundle it started with, so `ha gui` must be restarted after this block; rebuilding only the
  # CLI leaves the old GUI contract to reject new daemon fields.
  Invoke-Checked $npmCmd.Source @('run', 'build', '-w', '@harness-anything/daemon')
  Invoke-Checked $npmCmd.Source @('run', 'build', '-w', '@harness-anything/cli')
  Invoke-Checked $npmCmd.Source @('run', 'build', '-w', '@harness-anything/gui')
  Write-Output 'Rebuilt daemon, CLI and GUI; quit any running GUI window and rerun `ha gui` to load the new bundle.'

  $verifyElectronScript = @'
const fs = require("node:fs");
const path = require("node:path");
const root = path.dirname(require.resolve("electron/package.json"));
const rel = fs.readFileSync(path.join(root, "path.txt"), "utf8").trim();
const bin = path.join(root, "dist", rel);
fs.accessSync(bin, fs.constants.X_OK);
console.log("Electron runtime: " + bin);
'@
  $verifyElectronScript | & $nodeCmd.Source -
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): electron runtime check"
  }

  $previousPrefix = $env:npm_config_prefix
  try {
    $env:npm_config_prefix = $npmPrefix
    Push-Location (Join-Path $installRoot 'packages\cli')
    try {
      Invoke-Checked $npmCmd.Source @('link')
    } finally {
      Pop-Location
    }
  } finally {
    if ($null -eq $previousPrefix) {
      Remove-Item Env:npm_config_prefix -ErrorAction SilentlyContinue
    } else {
      $env:npm_config_prefix = $previousPrefix
    }
  }

  $cliCmd = Join-Path $npmPrefix 'ha.cmd'
  $cliPs1 = Join-Path $npmPrefix 'ha.ps1'
  $cliBin = Join-Path $npmPrefix 'bin\ha'
  $cliEntry = if (Test-Path $cliCmd) {
    $cliCmd
  } elseif (Test-Path $cliPs1) {
    $cliPs1
  } elseif (Test-Path $cliBin) {
    $cliBin
  } else {
    $null
  }

  if (-not $cliEntry) {
    [Console]::Error.WriteLine("npm link did not create a CLI entry under $npmPrefix.")
    [Console]::Error.WriteLine('The build succeeded, but the printed instructions would not run; fix the npm prefix and rerun.')
    exit 1
  }

  $binDir = Split-Path -Parent $cliEntry
  Write-Output ""
  Write-Output "Installed source CLI at $installRoot"
  Write-Output "CLI entry: $cliEntry"
  Write-Output "Next: & `"$cliEntry`" --version"
  Write-Output "Run: & `"$cliEntry`" edge join <invite-link>"
  Write-Output "GUI: & `"$cliEntry`" gui"
  Write-Output "GUI headless check: cd `"$installRoot`"; npm run smoke:gui:headless"
  Write-Output '# To use `ha` in new PowerShell terminals, add this line to your $PROFILE:'
  Write-Output "`$env:PATH = `"$binDir;`$env:PATH`""
} finally {
  Pop-Location
}
