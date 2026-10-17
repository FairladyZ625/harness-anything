#!/usr/bin/env bash
set -euo pipefail

repo_url=${HARNESS_REPO_URL:-https://github.com/FairladyZ625/harness-anything.git}
install_root=${HARNESS_INSTALL_ROOT:-"$HOME/.local/share/harness-anything"}

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
  git clone "$repo_url" "$install_root"
else
  git -C "$install_root" pull --ff-only
fi
cd "$install_root"
npm ci
npm run build -w @harness-anything/daemon
npm run build -w @harness-anything/cli
(cd packages/cli && npm link)

if [ "$(uname -s)" = Linux ] && [ -f node_modules/electron/dist/chrome-sandbox ]; then
  chmod 4755 node_modules/electron/dist/chrome-sandbox
fi

printf '\nInstalled source CLI at %s\n' "$install_root"
printf 'Run: ha edge join <invite-link> --observed-spki-sha256 <pin>\n'
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  printf 'Wayland session detected. Launch the GUI with: ELECTRON_OZONE_PLATFORM_HINT=auto ha gui\n'
fi
