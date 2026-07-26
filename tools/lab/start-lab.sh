#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LAB_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
LAB_AUTHORED_ROOT="$LAB_ROOT/harness"
LAB_USER_ROOT="${HARNESS_T3_LAB_USER_ROOT:-$HOME/.harness-t3-lab}"
LAB_RUNTIME_ROOT="${HARNESS_T3_LAB_RUNTIME_ROOT:-/private/tmp/harness-anything-t3-lab-$(id -u)}"
LAB_AUTHORITY_ROOT="$LAB_USER_ROOT/authority"
LAB_AUTHORITY_MANIFEST="$LAB_AUTHORITY_ROOT/authority-t3-lab.json"
CLI_ENTRY="$LAB_ROOT/packages/cli/dist/cli/src/index.js"

PRODUCTION_PID="${HARNESS_T3_PRODUCTION_PID:-45717}"
PRODUCTION_GIT_DIR="$(git -C "$LAB_ROOT" rev-parse --path-format=absolute --git-common-dir)"
PRODUCTION_ROOT="$(dirname -- "$PRODUCTION_GIT_DIR")"
PRODUCTION_USER_ROOT="${HARNESS_T3_PRODUCTION_USER_ROOT:-$HOME/.harness-production}"
PRODUCTION_AUTHORITY_MANIFEST="${HARNESS_T3_PRODUCTION_AUTHORITY_MANIFEST:-$HOME/.harness/authority/harness-anything-production/authority-production.json}"
PRODUCTION_KEY_DIRECTORY="$(dirname -- "$PRODUCTION_AUTHORITY_MANIFEST")/keys/canonical"
PRODUCTION_ARGS="$(ps -p "$PRODUCTION_PID" -o args= 2>/dev/null || true)"
PRODUCTION_SOCKET="$(sed -n 's/.* --socket \([^ ]]*\).*/\1/p' <<<"$PRODUCTION_ARGS")"
PRODUCTION_SOCKET_DIR="$(dirname -- "$PRODUCTION_SOCKET")"

fail() {
  printf 't3-lab start refused: %s\n' "$*" >&2
  exit 1
}

[[ -n "$PRODUCTION_ARGS" ]] || fail "protected production daemon PID $PRODUCTION_PID is not running"
[[ -n "$PRODUCTION_SOCKET" ]] || fail "protected production daemon socket could not be resolved"
[[ "$LAB_ROOT" != "$PRODUCTION_ROOT" ]] || fail "lab root resolves to the production root"
[[ "$LAB_USER_ROOT" != "$PRODUCTION_USER_ROOT" ]] || fail "lab user root resolves to the production user root"
[[ "$LAB_AUTHORITY_MANIFEST" != "$PRODUCTION_AUTHORITY_MANIFEST" ]] || fail "lab authority manifest resolves to the production manifest"
[[ "$LAB_RUNTIME_ROOT" != "$PRODUCTION_SOCKET_DIR" ]] || fail "lab runtime root resolves to the production socket directory"
[[ "$LAB_RUNTIME_ROOT/" != "$PRODUCTION_SOCKET_DIR/"* ]] || fail "lab runtime root is inside the production socket directory"
[[ -d "$LAB_AUTHORED_ROOT/.git" ]] || fail "lab authored ledger is not an independent Git repository: $LAB_AUTHORED_ROOT"
[[ -f "$CLI_ENTRY" ]] || fail "CLI build is missing; run npm run build -w @harness-anything/cli in $LAB_ROOT"
[[ -f "$PRODUCTION_AUTHORITY_MANIFEST" ]] || fail "production manifest copy source is unavailable"
[[ -d "$PRODUCTION_KEY_DIRECTORY" ]] || fail "production key copy source is unavailable"
command -v jq >/dev/null 2>&1 || fail "jq is required to prepare the lab-only manifest"

uid="$(id -u)"
endpoint_id="$(node -e 'const { createHash } = require("node:crypto"); const userRoot = require("node:path").resolve(process.argv[1]); process.stdout.write(`u-${createHash("sha256").update(`${userRoot}\0default`).digest("hex").slice(0, 16)}`);' "$LAB_USER_ROOT")"
LAB_SOCKET="$LAB_RUNTIME_ROOT/harness-anything-$uid/daemon-$uid-$endpoint_id.sock"
[[ "$(dirname -- "$LAB_SOCKET")" != "$PRODUCTION_SOCKET_DIR" ]] || fail "lab socket resolves to the production socket directory"

mkdir -p "$LAB_USER_ROOT" "$LAB_RUNTIME_ROOT" "$LAB_AUTHORITY_ROOT/keys"
chmod 700 "$LAB_USER_ROOT" "$LAB_RUNTIME_ROOT" "$LAB_AUTHORITY_ROOT" "$LAB_AUTHORITY_ROOT/keys"

if [[ ! -d "$LAB_AUTHORITY_ROOT/keys/canonical" ]]; then
  cp -a "$PRODUCTION_KEY_DIRECTORY" "$LAB_AUTHORITY_ROOT/keys/canonical"
fi

manifest_tmp="$(mktemp "$LAB_AUTHORITY_ROOT/.authority-t3-lab.XXXXXX")"
trap 'rm -f -- "$manifest_tmp"' EXIT
jq \
  --arg service_state_root "$LAB_AUTHORITY_ROOT" \
  --arg canonical_root "$LAB_ROOT" \
  --arg key_registry_path "$LAB_AUTHORED_ROOT/authority-key-registry.json" \
  --arg key_state_directory "$LAB_AUTHORITY_ROOT/keys/canonical" \
  '.serviceStateRoot = $service_state_root
   | .repos[0].canonicalRoot = $canonical_root
   | .repos[0].keyRegistryPath = $key_registry_path
   | .repos[0].keyStateDirectory = $key_state_directory
   | .repos[0].viewId = "view-t3-lab"
   | .repos[0].sessionId = "session-t3-lab"
   | .repos[0].admissionTokenRef = "admission-t3-lab"' \
  "$PRODUCTION_AUTHORITY_MANIFEST" >"$manifest_tmp"
chmod 600 "$manifest_tmp"
mv -f -- "$manifest_tmp" "$LAB_AUTHORITY_MANIFEST"
trap - EXIT

matching_pids=()
conflicting_pids=()
while IFS= read -r pid; do
  pid="${pid//[[:space:]]/}"
  [[ -n "$pid" && "$pid" != "$$" ]] || continue
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$args" ]] || continue
  if [[ "$args" == *"--socket $LAB_SOCKET"* || "$args" == *"--user-root $LAB_USER_ROOT"* ]]; then
    if [[ "$args" == *"--root $LAB_ROOT"* && "$args" == *"--socket $LAB_SOCKET"* && "$args" == *"--user-root $LAB_USER_ROOT"* ]]; then
      matching_pids+=("$pid")
    else
      conflicting_pids+=("$pid")
    fi
  fi
done < <(ps -axo pid=)

(( ${#conflicting_pids[@]} == 0 )) || fail "processes partially match lab isolation keys: ${conflicting_pids[*]}"
(( ${#matching_pids[@]} <= 1 )) || fail "multiple lab daemon processes match: ${matching_pids[*]}"

export TMPDIR="$LAB_RUNTIME_ROOT"
export HARNESS_DAEMON_USER_ROOT="$LAB_USER_ROOT"
export HARNESS_DAEMON_REPO_ID="canonical"

if (( ${#matching_pids[@]} == 1 )); then
  [[ -S "$LAB_SOCKET" ]] || fail "matching lab daemon ${matching_pids[0]} has no socket at $LAB_SOCKET"
  node "$CLI_ENTRY" --root "$LAB_ROOT" daemon status --repo canonical --socket "$LAB_SOCKET" --user-root "$LAB_USER_ROOT" --json
  printf 't3-lab already running: pid=%s socket=%s user-root=%s\n' "${matching_pids[0]}" "$LAB_SOCKET" "$LAB_USER_ROOT"
  exit 0
fi

node "$CLI_ENTRY" --root "$LAB_ROOT" daemon start --service \
  --repo canonical \
  --socket "$LAB_SOCKET" \
  --user-root "$LAB_USER_ROOT" \
  --authority-manifest "$LAB_AUTHORITY_MANIFEST" \
  --json

node "$CLI_ENTRY" --root "$LAB_ROOT" daemon status \
  --repo canonical \
  --socket "$LAB_SOCKET" \
  --user-root "$LAB_USER_ROOT" \
  --json

printf 't3-lab started: socket=%s user-root=%s authority-manifest=%s\n' \
  "$LAB_SOCKET" "$LAB_USER_ROOT" "$LAB_AUTHORITY_MANIFEST"
