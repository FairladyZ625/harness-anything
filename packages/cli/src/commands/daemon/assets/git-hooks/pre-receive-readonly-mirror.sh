#!/usr/bin/env sh
set -eu

cat >&2 <<'MSG'
Harness Anything rejected this push.

This repository is a read-only mirror for git fetch/context reads. Fetch from it,
but send all writes to the canonical daemon-backed ha path.
MSG
exit 1
