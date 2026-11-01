#!/usr/bin/env bash
set -euo pipefail

repo_url=${HARNESS_REPO_URL:-https://github.com/FairladyZ625/harness-anything.git}
install_root=${HARNESS_INSTALL_ROOT:-"$HOME/.local/share/harness-anything"}
pull_mode=pull
expected_ref=

usage() {
  cat <<'EOF'
Usage: install-source.sh [--offline|--no-pull] [--ref <commit>]

  --offline, --no-pull  Build the existing checkout without contacting the remote.
                        Fails when the checkout does not exist yet.
  --ref <commit>        Require HEAD to be <commit>. A failed pull is tolerated only
                        when the checkout already points at that commit.
  -h, --help            Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline | --no-pull) pull_mode=off ;;
    --ref)
      if [ "$#" -lt 2 ]; then
        printf '%s\n' '--ref requires a commit' >&2
        exit 2
      fi
      expected_ref=$2
      shift
      ;;
    --ref=*) expected_ref=${1#--ref=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v git >/dev/null || ! command -v npm >/dev/null; then
  printf '%s\n' 'Harness Anything requires git, Node.js 24+, and npm.' >&2
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 24 ]; then
  printf '%s\n' 'Harness Anything requires Node.js 24 or newer.' >&2
  exit 1
fi

mkdir -p "$(dirname "$install_root")"
if [ ! -d "$install_root/.git" ]; then
  if [ "$pull_mode" = off ]; then
    printf 'Cannot install offline: %s is not a git checkout.\n' "$install_root" >&2
    printf '%s\n' 'Run the installer once with network access, or copy an existing checkout to that path first.' >&2
    exit 1
  fi
  git clone "$repo_url" "$install_root"
elif [ "$pull_mode" = pull ]; then
  if ! git -C "$install_root" pull --ff-only; then
    local_head=$(git -C "$install_root" rev-parse HEAD 2>/dev/null || true)
    requested_sha=
    if [ -n "$expected_ref" ]; then
      requested_sha=$(git -C "$install_root" rev-parse --verify --quiet "$expected_ref^{commit}" 2>/dev/null || true)
    fi
    if [ -n "$expected_ref" ] && [ -n "$requested_sha" ] && [ "$local_head" = "$requested_sha" ]; then
      printf '\nPull failed, but %s is already at %s; continuing with the local source.\n' "$install_root" "$expected_ref" >&2
    else
      printf '\nCannot update %s from %s.\n' "$install_root" "$repo_url" >&2
      if [ -n "$expected_ref" ]; then
        printf 'Requested --ref %s resolves to %s; local HEAD is %s.\n' "$expected_ref" "${requested_sha:-<not present>}" "${local_head:-<unknown>}" >&2
      fi
      printf '%s\n' 'The checkout is not at the requested commit, so the installer stopped before building unexpected code.' >&2
      printf '%s\n' 'If the source was synced another way, rerun with --offline (or --ref <commit> when HEAD already is that commit).' >&2
      exit 1
    fi
  fi
fi
cd "$install_root"
if [ -n "$expected_ref" ]; then
  if ! expected_sha=$(git rev-parse --verify --quiet "$expected_ref^{commit}"); then
    printf 'Requested --ref %s is not present in %s; fetch or merge it first.\n' "$expected_ref" "$install_root" >&2
    exit 1
  fi
  actual_sha=$(git rev-parse HEAD)
  if [ "$actual_sha" != "$expected_sha" ]; then
    printf 'Install root HEAD is %s, but --ref requires %s (%s).\n' "$actual_sha" "$expected_ref" "$expected_sha" >&2
    exit 1
  fi
fi

deps_stamp=node_modules/.harness-install-deps.sha256
dependency_digest() {
  node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const hash = createHash("sha256");
for (const file of process.argv.slice(1).sort()) {
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
' package-lock.json package.json packages/*/package.json
}

deps_digest=$(dependency_digest)
if [ -d node_modules ] && [ -f "$deps_stamp" ] && [ "$(cat "$deps_stamp")" = "$deps_digest" ]; then
  printf 'Dependencies unchanged (%s); skipping npm ci.\n' "${deps_digest:0:12}"
else
  printf '%s\n' 'Installing dependencies. The Electron runtime downloads separately and a first run can take several minutes; later runs reuse the caches.'
  npm ci
  printf '%s\n' "$deps_digest" > "$deps_stamp"
fi
node node_modules/electron/install.js
npm run build -w @harness-anything/daemon
npm run build -w @harness-anything/cli
npm run build -w @harness-anything/gui
node -e "const fs=require('fs'),path=require('path');const root=path.dirname(require.resolve('electron/package.json'));const rel=fs.readFileSync(path.join(root,'path.txt'),'utf8').trim();const bin=path.join(root,'dist',rel);fs.accessSync(bin,fs.constants.X_OK);console.log('Electron runtime: '+bin)"
(cd packages/cli && npm link)

if [ "$(uname -s)" = Linux ] && [ -f node_modules/electron/dist/chrome-sandbox ]; then
  sandbox_path="$install_root/node_modules/electron/dist/chrome-sandbox"
  if [ "$(id -u)" -eq 0 ]; then
    chown root:root "$sandbox_path"
    chmod 4755 "$sandbox_path"
  elif command -v sudo >/dev/null; then
    printf '%s\n' 'Electron chrome-sandbox needs root ownership on Linux; requesting sudo.'
    sudo chown root:root "$sandbox_path"
    sudo chmod 4755 "$sandbox_path"
  else
    printf '%s\n' "Warning: run 'sudo chown root:root $sandbox_path && sudo chmod 4755 $sandbox_path' before launching ha gui." >&2
  fi
fi

printf '\nInstalled source CLI at %s\n' "$install_root"
printf 'Run: ha edge join <invite-link>\n'
printf 'GUI: ha gui   (headless check: npm run smoke:gui:headless)\n'
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  printf 'Wayland session detected. Launch the GUI with: ELECTRON_OZONE_PLATFORM_HINT=auto ha gui\n'
fi
