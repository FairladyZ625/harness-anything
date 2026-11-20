#!/usr/bin/env bash
set -euo pipefail

repo_url=${HARNESS_REPO_URL:-https://github.com/FairladyZ625/harness-anything.git}
install_root=${HARNESS_INSTALL_ROOT:-"$HOME/.local/share/harness-anything"}
npm_prefix=${HARNESS_NPM_PREFIX:-"$HOME/.local/share/harness-anything-npm"}
pull_mode=pull
expected_ref=

usage() {
  cat <<'EOF'
Usage: install-source.sh [--offline|--no-pull] [--ref <commit>]

  --offline, --no-pull  Build the existing checkout without contacting the remote.
                        Fails when the checkout does not exist yet.
  --ref <commit>        Install exactly this commit. With network access, fetch it
                        and detach HEAD if needed and the checkout is clean.
  -h, --help            Show this help.
EOF
}

retry_download() {
  local label=$1 action=$2 attempt=1 delay=1 status=0
  shift 2
  while :; do
    if "$action" "$attempt" "$@"; then
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -eq 4 ]; then
      return "$status"
    fi
    printf '%s failed. Retrying in %s seconds (retry %s/3).\n' "$label" "$delay" "$attempt" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

git_download() {
  local attempt=$1
  shift
  if [ "$attempt" -eq 1 ]; then
    git "$@"
  else
    git -c http.version=HTTP/1.1 "$@"
  fi
}

electron_download() {
  node node_modules/electron/install.js
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
if [ ! -e "$install_root/.git" ]; then
  if [ "$pull_mode" = off ]; then
    printf 'Cannot install offline: %s is not a git checkout.\n' "$install_root" >&2
    printf '%s\n' 'Run the installer once with network access, or copy an existing checkout to that path first.' >&2
    exit 1
  fi
  retry_download 'Git clone' git_download clone -- "$repo_url" "$install_root"
elif [ "$pull_mode" = pull ] && [ -z "$expected_ref" ]; then
  if ! retry_download 'Git pull' git_download -C "$install_root" pull --ff-only; then
    printf 'Cannot update %s. If the source was synced another way, rerun with --offline.\n' "$install_root" >&2
    exit 1
  fi
fi
cd "$install_root"
if [ -n "$expected_ref" ]; then
  expected_sha=$(git rev-parse --verify --quiet --end-of-options "$expected_ref^{commit}" || true)
  actual_sha=$(git rev-parse HEAD)
  if [ "$actual_sha" != "$expected_sha" ]; then
    if [ "$pull_mode" = off ]; then
      printf 'Offline install requires HEAD at %s. Current HEAD is %s.\n' "$expected_ref" "$actual_sha" >&2
      exit 1
    fi
    checkout_status=$(git status --porcelain)
    if [ -n "$checkout_status" ]; then
      printf 'Cannot switch to %s: %s has local changes. Commit or remove them, then retry.\n' "$expected_ref" "$install_root" >&2
      exit 1
    fi
    if retry_download 'Git fetch' git_download fetch --no-tags -- origin "${expected_sha:-$expected_ref}"; then
      expected_sha=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
    elif [ -z "$expected_sha" ]; then
      exit 1
    else
      printf 'Using the local commit %s after fetch failed.\n' "$expected_sha" >&2
    fi
    git checkout --detach "$expected_sha"
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
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
  printf '%s\n' "$deps_digest" > "$deps_stamp"
fi
if ! retry_download 'Electron download' electron_download; then
  if [ -n "${ELECTRON_MIRROR:-}${NPM_CONFIG_ELECTRON_MIRROR:-}${npm_config_electron_mirror:-}${npm_package_config_electron_mirror:-}" ]; then
    printf '%s\n' 'Electron download failed with the configured mirror.' >&2
    exit 1
  fi
  printf '%s\n' 'Electron default download failed. Retrying with https://npmmirror.com/mirrors/electron/.' >&2
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ retry_download 'Electron mirror download' electron_download
fi
# Upgrade step: daemon, CLI and GUI are built together. A running Electron window keeps the
# bundle it started with, so `ha gui` must be restarted after this block; rebuilding only the
# CLI leaves the old GUI contract to reject new daemon fields.
npm run build -w @harness-anything/daemon
npm run build -w @harness-anything/cli
npm run build -w @harness-anything/gui
printf '%s\n' 'Rebuilt daemon, CLI and GUI; quit any running GUI window and rerun `ha gui` to load the new bundle.'
node -e "const fs=require('fs'),path=require('path');const root=path.dirname(require.resolve('electron/package.json'));const rel=fs.readFileSync(path.join(root,'path.txt'),'utf8').trim();const bin=path.join(root,'dist',rel);fs.accessSync(bin,fs.constants.X_OK);console.log('Electron runtime: '+bin)"
(cd packages/cli && npm_config_prefix="$npm_prefix" npm link)
bin_dir="$npm_prefix/bin"
cli_entry="$bin_dir/ha"
if [ ! -x "$cli_entry" ]; then
  if [ -x "$npm_prefix/ha" ] || [ -f "$npm_prefix/ha.cmd" ]; then
    bin_dir="$npm_prefix"
    cli_entry="$bin_dir/ha"
  else
    printf 'npm link did not create an executable CLI entry at %s.\n' "$cli_entry" >&2
    printf '%s\n' 'The build succeeded, but the printed instructions would not run; fix the npm prefix and rerun.' >&2
    exit 1
  fi
fi

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
printf 'CLI entry: %s\n' "$cli_entry"
printf 'Next: "%s" --version\n' "$cli_entry"
printf 'Run: "%s" edge join <invite-link>\n' "$cli_entry"
printf 'GUI: "%s" gui\n' "$cli_entry"
printf 'GUI headless check: cd "%s" && npm run smoke:gui:headless\n' "$install_root"
printf '# To use `ha` in new terminals, add this line to your shell profile:\n'
printf 'export PATH="%s:$PATH"\n' "$bin_dir"
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  printf 'Wayland session detected. Launch the GUI with: ELECTRON_OZONE_PLATFORM_HINT=auto "%s" gui\n' "$cli_entry"
fi
