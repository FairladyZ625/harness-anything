#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
  --ref <commit>        Require HEAD to be <commit>. A failed pull is tolerated only
                        when the checkout already points at that commit.
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
  Invoke-Checked $gitCmd.Source @('clone', $repoUrl, $installRoot)
} elseif ($pullMode -eq 'pull') {
  & $gitCmd.Source -C $installRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    $localHead = (& $gitCmd.Source -C $installRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) { $localHead = '' }
    $requestedSha = ''
    if ($expectedRef) {
      $requestedSha = (& $gitCmd.Source -C $installRoot rev-parse --verify --quiet "$expectedRef^{commit}" 2>$null | Select-Object -First 1)
      if ($LASTEXITCODE -ne 0) { $requestedSha = '' }
    }
    if ($expectedRef -and $requestedSha -and ($localHead -eq $requestedSha)) {
      [Console]::Error.WriteLine("")
      [Console]::Error.WriteLine("Pull failed, but $installRoot is already at $expectedRef; continuing with the local source.")
    } else {
      [Console]::Error.WriteLine("")
      [Console]::Error.WriteLine("Cannot update $installRoot from $repoUrl.")
      if ($expectedRef) {
        $reqDisplay = if ($requestedSha) { $requestedSha } else { '<not present>' }
        $headDisplay = if ($localHead) { $localHead } else { '<unknown>' }
        [Console]::Error.WriteLine("Requested --ref $expectedRef resolves to $reqDisplay; local HEAD is $headDisplay.")
      }
      [Console]::Error.WriteLine('The checkout is not at the requested commit, so the installer stopped before building unexpected code.')
      [Console]::Error.WriteLine('If the source was synced another way, rerun with --offline (or --ref <commit> when HEAD already is that commit).')
      exit 1
    }
  }
}

Push-Location $installRoot
try {
  if ($expectedRef) {
    $expectedSha = (& $gitCmd.Source rev-parse --verify --quiet "$expectedRef^{commit}" | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $expectedSha) {
      [Console]::Error.WriteLine("Requested --ref $expectedRef is not present in $installRoot; fetch or merge it first.")
      exit 1
    }
    $actualSha = (& $gitCmd.Source rev-parse HEAD | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or ($actualSha -ne $expectedSha)) {
      [Console]::Error.WriteLine("Install root HEAD is $actualSha, but --ref requires $expectedRef ($expectedSha).")
      exit 1
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
    Invoke-Checked $npmCmd.Source @('ci', '--no-audit', '--no-fund')
    Set-Content -Path $depsStamp -Value "$depsDigest`n" -NoNewline -Encoding ASCII
  }

  Invoke-Checked $nodeCmd.Source @('node_modules/electron/install.js')
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
