#!/usr/bin/env bash
# Host-side W3-A fencing smoke. The center container keeps serving on :7443;
# smoke-epoch.mjs starts a second center writer against the same state volume,
# then proves the first process cannot append after the epoch advances.
set -euo pipefail
cd "$(dirname "$0")"

WORKSPACE=/data/workspace
RUN_TAG=$(date +%s)
TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

ha() { docker compose exec -T "$1" ha --json --root "$WORKSPACE" "${@:2}"; }
jsonget() {
  python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in [p for p in sys.argv[2].split('.') if p]:
    value = value[int(part)] if isinstance(value, list) else value[part]
print(value)
PY
}

ha edge-1 task create --title "W3-A persistent writer epoch fencing $RUN_TAG" --preset standard-task > "$TMP/create.json"
TASK_ID=$(jsonget "$TMP/create.json" taskId)
ha edge-1 task start "$TASK_ID" > "$TMP/start.json"
[ "$(jsonget "$TMP/start.json" canonicalOutcome)" = "applied" ] || { echo "[smoke-epoch] task start did not apply canonically: $(cat "$TMP/start.json")" >&2; exit 1; }

docker compose exec -T -e "TESTBED_EPOCH_TASK_ID=$TASK_ID" center node /opt/testbed/smoke-epoch.mjs
docker compose restart center >/dev/null
for _ in $(seq 1 120); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' plt-center-center)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect --format '{{.State.Health.Status}}' plt-center-center)" = "healthy" ] || { echo "[smoke-epoch] replacement center did not become healthy" >&2; exit 1; }
ha edge-1 task progress append "$TASK_ID" --text "fresh center write after epoch fencing" > "$TMP/fresh.json"
[ "$(jsonget "$TMP/fresh.json" canonicalOutcome)" = "applied" ] || { echo "[smoke-epoch] fresh center did not append: $(cat "$TMP/fresh.json")" >&2; exit 1; }
echo "TESTBED EPOCH FENCING PASS: candidate fenced stale center at zero writes; restarted center appended fresh epoch."
