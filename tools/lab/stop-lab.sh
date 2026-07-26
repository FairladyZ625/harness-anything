#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LAB_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
LAB_AUTHORED_ROOT="$LAB_ROOT/harness"
LAB_USER_ROOT="${HARNESS_T3_LAB_USER_ROOT:-/Users/lizeyu/.harness-t3-lab}"
LAB_RUNTIME_ROOT="${HARNESS_T3_LAB_RUNTIME_ROOT:-/private/tmp/harness-anything-t3-lab-$(id -u)}"
LAB_AUTHORITY_MANIFEST="$LAB_USER_ROOT/authority/authority-t3-lab.json"
CLI_ENTRY="$LAB_ROOT/packages/cli/dist/cli/src/index.js"

PRODUCTION_PID=45717
PRODUCTION_ROOT="/Users/lizeyu/Projects/coding-agent-harness/harness-anything"
PRODUCTION_USER_ROOT="/Users/lizeyu/.harness-production"
PRODUCTION_SOCKET_DIR="/var/folders/94/y2lgzz5158397x9pqnzb9xp00000gn/T/harness-anything-501"
PRODUCTION_AUTHORITY_MANIFEST="/Users/lizeyu/.harness/authority/harness-anything-production/authority-production.json"

fail() {
  printf 't3-lab stop refused: %s\n' "$*" >&2
  exit 1
}

[[ "$LAB_ROOT" != "$PRODUCTION_ROOT" ]] || fail "lab root resolves to the production root"
[[ "$LAB_USER_ROOT" != "$PRODUCTION_USER_ROOT" ]] || fail "lab user root resolves to the production user root"
[[ "$LAB_AUTHORITY_MANIFEST" != "$PRODUCTION_AUTHORITY_MANIFEST" ]] || fail "lab authority manifest resolves to the production manifest"
[[ "$LAB_RUNTIME_ROOT" != "$PRODUCTION_SOCKET_DIR" ]] || fail "lab runtime root resolves to the production socket directory"
[[ "$LAB_RUNTIME_ROOT/" != "$PRODUCTION_SOCKET_DIR/"* ]] || fail "lab runtime root is inside the production socket directory"
[[ -f "$CLI_ENTRY" ]] || fail "CLI build is missing: $CLI_ENTRY"

uid="$(id -u)"
endpoint_id="$(node -e 'const { createHash } = require("node:crypto"); const userRoot = require("node:path").resolve(process.argv[1]); process.stdout.write(`u-${createHash("sha256").update(`${userRoot}\0default`).digest("hex").slice(0, 16)}`);' "$LAB_USER_ROOT")"
LAB_SOCKET="$LAB_RUNTIME_ROOT/harness-anything-$uid/daemon-$uid-$endpoint_id.sock"
[[ "$(dirname -- "$LAB_SOCKET")" != "$PRODUCTION_SOCKET_DIR" ]] || fail "lab socket resolves to the production socket directory"

matching_pids=()
conflicting_pids=()
while IFS= read -r pid; do
  pid="${pid//[[:space:]]/}"
  [[ -n "$pid" && "$pid" != "$$" ]] || continue
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$args" ]] || continue
  if [[ "$args" == *"--socket $LAB_SOCKET"* || "$args" == *"--user-root $LAB_USER_ROOT"* ]]; then
    if [[ "$args" == *"--root $LAB_ROOT"* && "$args" == *"--socket $LAB_SOCKET"* && "$args" == *"--user-root $LAB_USER_ROOT"* && "$args" == *"--authority-manifest $LAB_AUTHORITY_MANIFEST"* ]]; then
      matching_pids+=("$pid")
    else
      conflicting_pids+=("$pid")
    fi
  fi
done < <(ps -axo pid=)

(( ${#conflicting_pids[@]} == 0 )) || fail "processes partially match lab isolation keys: ${conflicting_pids[*]}"
(( ${#matching_pids[@]} <= 1 )) || fail "multiple lab daemon processes match: ${matching_pids[*]}"

if (( ${#matching_pids[@]} == 0 )); then
  printf 't3-lab already stopped; no matching process found (socket=%s user-root=%s)\n' "$LAB_SOCKET" "$LAB_USER_ROOT"
  exit 0
fi

lab_pid="${matching_pids[0]}"
[[ "$lab_pid" != "$PRODUCTION_PID" ]] || fail "matched PID is the protected production daemon"
[[ -S "$LAB_SOCKET" ]] || fail "refusing to signal PID $lab_pid because the exact lab socket is absent"

export TMPDIR="$LAB_RUNTIME_ROOT"
export HARNESS_DAEMON_USER_ROOT="$LAB_USER_ROOT"
export HARNESS_DAEMON_REPO_ID="canonical"

node "$CLI_ENTRY" --root "$LAB_ROOT" daemon stop \
  --repo canonical \
  --socket "$LAB_SOCKET" \
  --user-root "$LAB_USER_ROOT" \
  --timeout-ms 10000 \
  --json

for _ in {1..100}; do
  if ! ps -p "$lab_pid" -o pid= >/dev/null 2>&1; then
    printf 't3-lab stopped: pid=%s socket=%s user-root=%s\n' "$lab_pid" "$LAB_SOCKET" "$LAB_USER_ROOT"
    exit 0
  fi
  sleep 0.1
done

fail "lab daemon PID $lab_pid is still alive after the graceful stop request"
