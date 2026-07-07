#!/usr/bin/env sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
token_file="$repo_root/.harness/server/daemon-push-token"

if [ "${HARNESS_DAEMON_GIT_PUSH:-}" = "1" ] && [ -f "$token_file" ]; then
  expected="$(cat "$token_file")"
  if [ "${HARNESS_DAEMON_GIT_TOKEN:-}" = "$expected" ]; then
    exit 0
  fi
fi

cat >&2 <<'MSG'
Harness Anything rejected this direct push.

This canonical repository is daemon-owned. Submit writes through the daemon-backed
ha client/API over SSH instead of pushing authored state directly.

Use:
  HARNESS_DAEMON_MODE=remote ha <command>

Server policy: fail closed for non-daemon write paths; this hook does not inspect
commit contents.
MSG
exit 1
