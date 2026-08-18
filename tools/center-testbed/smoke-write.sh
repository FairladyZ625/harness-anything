#!/usr/bin/env bash
# Host-side write-path smoke for the PLT-Center testbed. Assumes
# `docker compose up -d --wait` succeeded (a reseeded fresh stack). Drives the
# five W3-B automatic-lease acceptance scenarios with real containers:
#   1. edge-1 runs the task create -> start -> progress -> submit closed loop;
#      the center ledger advances and the effect projects back to both edges.
#   2. edge-2's start on a task edge-1 holds parks in the center FIFO queue;
#      edge-1's release wakes the queue head and edge-2 acquires automatically.
#   3. an explicitly short lease TTL lapses; the center reaper releases the
#      orphan and edge-2 claims the task.
#   4. a center restart (warm boot) preserves the lease table; the original
#      holder still writes, and a queued second node still waits until release.
#   5. both edges start the same unheld task concurrently; exactly one wins
#      immediately and the other remains queued until the winner releases.

set -euo pipefail
cd "$(dirname "$0")"

WORKSPACE=/data/workspace
SMOKE_TMP=$(mktemp -d)
RUN_TAG=$(date +%s)
cleanup() { for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done; rm -rf "$SMOKE_TMP"; }
trap cleanup EXIT
REPO_ID=$(docker compose exec -T center node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repoId)' /data/shared/testbed-state.json)

log() { echo "[smoke-write] $*"; }
# Task-create derives its domain opId from the action content, so a re-run on a
# reused stack with identical titles would idempotently replay the first event
# (without the create-specific receipt fields) instead of creating a new task.
# RUN_TAG keeps every smoke run on distinct tasks.
fail_smoke() { echo "[smoke-write] FAILED: $*" >&2; exit 1; }

ha() { docker compose exec -T "$1" ha --json --root "$WORKSPACE" "${@:2}"; }

jsonget() {
  python3 - "$1" "$2" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for part in [p for p in sys.argv[2].split(".") if p]:
    value = value[int(part)] if isinstance(value, list) else value[part]
print(json.dumps(value) if isinstance(value, (dict, list, bool)) else value)
PY
}

expect() { # expect <file> <field> <want>
  local got
  got=$(jsonget "$1" "$2") || fail_smoke "field $2 missing in $1: $(head -c 400 "$1")"
  [ "$got" = "$3" ] || fail_smoke "assertion failed: $2 = '$got', expected '$3' (receipt: $(head -c 400 "$1"))"
}

center_leases() { docker compose exec -T center cat /data/fleet-state/leases.json; }

lease_row() { # lease_row <task-id> -> assignmentId or empty
  center_leases > "$SMOKE_TMP/leases.json"
  python3 - "$SMOKE_TMP/leases.json" "$1" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
for key, row in state.get("leases", {}).items():
    if key.split("|", 1)[1] == sys.argv[2]:
        print(row.get("assignment", {}).get("assignmentId")); break
PY
}

queue_count() { # queue_count <task-id>
  center_leases > "$SMOKE_TMP/leases.json"
  python3 - "$SMOKE_TMP/leases.json" "$1" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(sum(1 for key, rows in state.get("queue", {}).items() if key.split("|", 1)[1] == sys.argv[2] for _ in rows))
PY
}

wait_healthy() {
  for _ in $(seq 1 120); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' plt-center-center)" = "healthy" ] && return 0
    sleep 2
  done
  fail_smoke "center did not become healthy within 240s"
}

log "== scenario 1: automatic-lease closed loop on edge-1, projected to both edges =="
ha edge-1 task create --title "W3-B automatic lease write loop $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s1-create.json"
expect "$SMOKE_TMP/s1-create.json" ok true
T1=$(jsonget "$SMOKE_TMP/s1-create.json" taskId)
PACKAGE1=$(jsonget "$SMOKE_TMP/s1-create.json" packagePath)
ha edge-1 task start "$T1" > "$SMOKE_TMP/s1-start.json"
expect "$SMOKE_TMP/s1-start.json" ok true
EXE1=$(jsonget "$SMOKE_TMP/s1-start.json" executionId)
[ "$(jsonget "$SMOKE_TMP/s1-start.json" fleet.lease.assignmentId)" = "assignment-edge-1" ] || fail_smoke "edge-1 did not acquire the lease automatically"
ha edge-1 task progress append "$T1" --text "edge-1 wrote through the automatic lease; no explicit lease command was run" > "$SMOKE_TMP/s1-progress.json"
expect "$SMOKE_TMP/s1-progress.json" ok true
[ "$(jsonget "$SMOKE_TMP/s1-progress.json" mirror.outcome)" = "applied" ] || fail_smoke "edge-1 mirror auto-pull did not apply: $(head -c 300 "$SMOKE_TMP/s1-progress.json")"

cat > "$SMOKE_TMP/submission-t1.json" <<SUB
{"completionClaim":"complete","deliverables":[],"outputs":[],"verificationNotes":["testbed write smoke submission"],"knownGaps":[],"residualRisks":[],"commitSha":"$(printf 'a%.0s' $(seq 1 40))"}
SUB
docker compose exec -T edge-1 sh -c "cat > $WORKSPACE/submission-t1.json" < "$SMOKE_TMP/submission-t1.json"
ha edge-1 task submit "$T1" --execution-id "$EXE1" --from-file submission-t1.json > "$SMOKE_TMP/s1-submit.json"
expect "$SMOKE_TMP/s1-submit.json" ok true
[ "$(jsonget "$SMOKE_TMP/s1-submit.json" fleet.waitOutcome)" = "applied" ] || fail_smoke "submit was not applied at the center"

SYNC1=$(docker compose exec -T edge-2 ha --json daemon fleet edge sync --host center --port 7443 --ca /data/shared/fleet/fleet.crt --node-id edge-2 --credential edge-2-machine-secret --assignment assignment-edge-2 --view-root /data/view --quota-bytes 268435456)
echo "$SYNC1" > "$SMOKE_TMP/s1-sync2.json"
expect "$SMOKE_TMP/s1-sync2.json" ok true
CUT1=$(jsonget "$SMOKE_TMP/s1-sync2.json" cut.revision)
PROGRESS2=$(docker compose exec -T edge-2 sh -c "cat /data/view/repos/$REPO_ID/views/edge-2-view/cuts/$CUT1/files/$PACKAGE1/progress.md")
echo "$PROGRESS2" | grep -q "edge-1 wrote through the automatic lease" || fail_smoke "edge-2 view does not contain edge-1's progress entry"
log "scenario 1 PASS: task $T1 written via fleet, submit applied, both edges see cut $CUT1"

log "== scenario 2: edge-2 queues while edge-1 holds; release wakes the queue head =="
ha edge-1 task create --title "W3-B wait queue $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s2-create.json"
T2=$(jsonget "$SMOKE_TMP/s2-create.json" taskId)
ha edge-1 task start "$T2" > "$SMOKE_TMP/s2-start1.json"
expect "$SMOKE_TMP/s2-start1.json" ok true
docker compose exec -T edge-2 ha --json --root "$WORKSPACE" task start "$T2" > "$SMOKE_TMP/s2-start2.json" 2> "$SMOKE_TMP/s2-start2.err" &
WAIT2=$!
sleep 3
if ! kill -0 "$WAIT2" 2>/dev/null; then
  wait "$WAIT2" || true
  fail_smoke "edge-2's start completed without queueing: $(head -c 400 "$SMOKE_TMP/s2-start2.json")"
fi
[ "$(lease_row "$T2")" = "assignment-edge-1" ] || fail_smoke "lease row for $T2 should still be edge-1's"
ha edge-1 task release "$T2" --reason "smoke: handing the task to the queued collaborator" > "$SMOKE_TMP/s2-release.json"
expect "$SMOKE_TMP/s2-release.json" ok true
wait "$WAIT2"
expect "$SMOKE_TMP/s2-start2.json" ok true
[ "$(jsonget "$SMOKE_TMP/s2-start2.json" fleet.lease.assignmentId)" = "assignment-edge-2" ] || fail_smoke "edge-2 did not acquire automatically after the release"
ha edge-2 task progress append "$T2" --text "edge-2 took over from the wait queue without any lease command" > "$SMOKE_TMP/s2-progress2.json"
expect "$SMOKE_TMP/s2-progress2.json" ok true
[ "$(lease_row "$T2")" = "assignment-edge-2" ] || fail_smoke "lease row for $T2 should now be edge-2's"
log "scenario 2 PASS: queued start granted to edge-2 after edge-1's release"

log "== scenario 3: orphan lease reaped after a short TTL; edge-2 claims =="
ha edge-1 task create --title "W3-B orphan reap $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s3-create.json"
T3=$(jsonget "$SMOKE_TMP/s3-create.json" taskId)
ha edge-1 task start "$T3" --ttl-ms 8000 > "$SMOKE_TMP/s3-start1.json"
expect "$SMOKE_TMP/s3-start1.json" ok true
log "lease for $T3 expires at $(jsonget "$SMOKE_TMP/s3-start1.json" fleet.lease.expiresAt); waiting for the reaper"
for _ in $(seq 1 20); do
  [ -z "$(lease_row "$T3")" ] && break
  sleep 1
done
[ -z "$(lease_row "$T3")" ] || fail_smoke "the reaper did not clear the orphaned lease for $T3"
ha edge-2 task start "$T3" > "$SMOKE_TMP/s3-start2.json"
expect "$SMOKE_TMP/s3-start2.json" ok true
[ "$(jsonget "$SMOKE_TMP/s3-start2.json" fleet.lease.assignmentId)" = "assignment-edge-2" ] || fail_smoke "edge-2 could not claim the reaped task"
log "scenario 3 PASS: orphan reaped and reclaimed by edge-2"

log "== scenario 4: center restart keeps the lease table =="
ha edge-1 task create --title "W3-B restart survival $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s4-create.json"
T4=$(jsonget "$SMOKE_TMP/s4-create.json" taskId)
ha edge-1 task start "$T4" > "$SMOKE_TMP/s4-start1.json"
expect "$SMOKE_TMP/s4-start1.json" ok true
docker compose restart center >/dev/null
wait_healthy
[ "$(lease_row "$T4")" = "assignment-edge-1" ] || fail_smoke "the lease row for $T4 did not survive the center restart"
ha edge-1 task progress append "$T4" --text "the original holder still writes after the center restart" > "$SMOKE_TMP/s4-progress1.json"
expect "$SMOKE_TMP/s4-progress1.json" ok true
docker compose exec -T edge-2 ha --json --root "$WORKSPACE" task start "$T4" > "$SMOKE_TMP/s4-start2.json" 2> "$SMOKE_TMP/s4-start2.err" &
WAIT4=$!
sleep 3
kill -0 "$WAIT4" 2>/dev/null || fail_smoke "edge-2's start was not queued after the restart"
ha edge-1 task release "$T4" --reason "smoke: restart-survival queue handover" > "$SMOKE_TMP/s4-release.json"
expect "$SMOKE_TMP/s4-release.json" ok true
wait "$WAIT4"
expect "$SMOKE_TMP/s4-start2.json" ok true
[ "$(jsonget "$SMOKE_TMP/s4-start2.json" fleet.lease.assignmentId)" = "assignment-edge-2" ] || fail_smoke "edge-2 did not acquire after the post-restart release"
log "scenario 4 PASS: lease table, holder rights, and queue all survived the restart"

log "== scenario 5: simultaneous first-starts serialize into one grant and one FIFO waiter =="
ha edge-1 task create --title "W3-B concurrent first grab $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s5-create.json"
T5=$(jsonget "$SMOKE_TMP/s5-create.json" taskId)
docker compose exec -T edge-1 ha --json --root "$WORKSPACE" task start "$T5" > "$SMOKE_TMP/s5-start1.json" 2> "$SMOKE_TMP/s5-start1.err" &
START51=$!
docker compose exec -T edge-2 ha --json --root "$WORKSPACE" task start "$T5" > "$SMOKE_TMP/s5-start2.json" 2> "$SMOKE_TMP/s5-start2.err" &
START52=$!
for _ in $(seq 1 30); do
  LIVE51=0; LIVE52=0
  kill -0 "$START51" 2>/dev/null && LIVE51=1
  kill -0 "$START52" 2>/dev/null && LIVE52=1
  [ $((LIVE51 + LIVE52)) -eq 0 ] && fail_smoke "both simultaneous starts completed; expected one FIFO waiter (edge-1: $(head -c 300 "$SMOKE_TMP/s5-start1.json"), edge-2: $(head -c 300 "$SMOKE_TMP/s5-start2.json"))"
  [ $((LIVE51 + LIVE52)) -eq 1 ] && [ "$(queue_count "$T5")" = "1" ] && break
  sleep 0.5
done
HOLDER5=$(lease_row "$T5")
case "$HOLDER5" in
  assignment-edge-1) WINNER5=edge-1; WINPID5=$START51; WINFILE5="$SMOKE_TMP/s5-start1.json"; LOSER5=edge-2; WAITPID5=$START52; WAITFILE5="$SMOKE_TMP/s5-start2.json" ;;
  assignment-edge-2) WINNER5=edge-2; WINPID5=$START52; WINFILE5="$SMOKE_TMP/s5-start2.json"; LOSER5=edge-1; WAITPID5=$START51; WAITFILE5="$SMOKE_TMP/s5-start1.json" ;;
  *) fail_smoke "simultaneous first-start did not produce exactly one known holder for $T5 (holder='$HOLDER5', queue=$(queue_count "$T5"))" ;;
esac
[ "$(queue_count "$T5")" = "1" ] || fail_smoke "the losing simultaneous start was not parked exactly once"
wait "$WINPID5"
expect "$WINFILE5" ok true
[ "$(jsonget "$WINFILE5" fleet.lease.assignmentId)" = "$HOLDER5" ] || fail_smoke "the completed simultaneous start does not match broker holder $HOLDER5"
ha "$WINNER5" task release "$T5" --reason "smoke: concurrent winner hands off to FIFO loser" > "$SMOKE_TMP/s5-release.json"
expect "$SMOKE_TMP/s5-release.json" ok true
wait "$WAITPID5"
expect "$WAITFILE5" ok true
[ "$(jsonget "$WAITFILE5" fleet.lease.assignmentId)" = "assignment-$LOSER5" ] || fail_smoke "$LOSER5 did not acquire after the concurrent winner released"
log "scenario 5 PASS: $WINNER5 won exactly once; $LOSER5 queued and acquired after release"

echo
log "center lease table (final):"
center_leases > "$SMOKE_TMP/final-leases.json"
python3 - "$SMOKE_TMP/final-leases.json" <<'PY'
import json, sys
for key, row in json.load(open(sys.argv[1])).get("leases", {}).items():
    print(f"  {key.split('|', 1)[1]}: {row['assignment']['assignmentId']} (expires {row.get('expiresAt', '?')})")
PY
echo "SMOKE PASS: all five automatic-lease scenarios passed on real containers."
