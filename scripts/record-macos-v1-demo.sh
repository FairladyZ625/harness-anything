#!/usr/bin/env bash
set -euo pipefail

app_bundle=${HARNESS_DEMO_APP:-/Applications/Harness Anything.app}
app_executable="$app_bundle/Contents/MacOS/Harness Anything"
bundled_node="$app_bundle/Contents/Resources/node/darwin-arm64/node"
bundled_cli="$app_bundle/Contents/Resources/app/packages/cli/dist/cli/src/index.js"
recording=${HARNESS_DEMO_OUTPUT:-$PWD/Harness-Anything-0.0.1-demo.mov}
demo_tmp=${HARNESS_DEMO_TMPDIR:-/tmp}

for required_path in "$app_executable" "$bundled_node" "$bundled_cli"; do
  if [[ ! -e "$required_path" ]]; then
    printf 'Missing packaged release component: %s\n' "$required_path" >&2
    exit 1
  fi
done

demo_root=$(mktemp -d "$demo_tmp/harness-anything-0.0.1-demo.XXXXXX")
demo_repo="$demo_root/repository"
demo_user_root="$demo_root/user-root"
demo_user_data="$demo_root/electron-user-data"
mkdir -p "$demo_repo" "$demo_user_root" "$demo_user_data"
git -C "$demo_repo" init --quiet
git -C "$demo_repo" config user.name "Harness Demo"
git -C "$demo_repo" config user.email "demo@harness-anything.local"
printf '# Harness Anything 0.0.1 demo\n' >"$demo_repo/README.md"
git -C "$demo_repo" add README.md
git -C "$demo_repo" commit --quiet -m "chore: initialize demo repository"

app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
  fi
  env -u HARNESS_DAEMON_ENDPOINT -u HARNESS_DAEMON_REPO_ID \
    TMPDIR="$demo_tmp" \
    "$bundled_node" "$bundled_cli" daemon stop \
    --user-root "$demo_user_root" --daemon-id default >/dev/null 2>&1 || true
}
trap cleanup EXIT

printf 'Demo repository: %s\n' "$demo_repo"
printf 'Recording output: %s\n' "$recording"
printf '%s\n' \
  'Shot list: repository picker -> identity bootstrap -> Provider -> Agent -> finish.' \
  'Press Control-Command-Escape when the recording is complete.'

env -u HARNESS_DAEMON_ENDPOINT -u HARNESS_DAEMON_REPO_ID \
  TMPDIR="$demo_tmp" \
  HARNESS_DAEMON_USER_ROOT="$demo_user_root" \
  HARNESS_GUI_ROOT="$demo_repo" \
  "$app_executable" --user-data-dir="$demo_user_data" &
app_pid=$!

screencapture -v "$recording"
printf 'Saved recording to %s\n' "$recording"
