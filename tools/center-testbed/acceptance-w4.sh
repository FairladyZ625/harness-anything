#!/usr/bin/env bash
# PLT-Center W4 acceptance: three concurrency phases plus the mixed-mode fault
# isolation scenario, all on real Docker containers, one command from a fresh
# clone:
#
#   bash tools/center-testbed/acceptance-w4.sh
#
# Phase 1 — single remote writer baseline: the existing W3-B write smoke (five
#   automatic-lease scenarios) and the W3-C dual-class sync smoke (three
#   conflict scenarios) must both pass on a fresh stack.
# Phase 2 — three concurrent edges writing the SAME task (lease queue) and
#   DISTINCT tasks interleaved, plus a concurrent same-document overwrite that
#   must stage (never silently lose) the losers. Mechanical assertions:
#   every applied receipt's event exists in canonical exactly once; the event
#   revision sequence is exactly 1..head; all edges converge to one headDigest.
# Phase 3 — ten edges under sustained concurrency; mid-flight one edge
#   container is killed while holding a short-TTL lease (orphan reap + FIFO
#   takeover) and the center is restarted once (warm boot: lease/queue state
#   survives, writer epoch continuity); the same three assertions close it.
# Phase 4 — mixed-mode isolation: the center daemon serves a local-mode repo
#   and a remote-edge repo; the remote-edge repo is latched on purpose and the
#   local repo must keep reading and writing (including through the fleet
#   channel) until the latch self-heals after repair.
#
# GITLAB_TOKEN comes from the environment or the conventional token file; the
# value never reaches any committed file. Artifacts land in W4_OUT (default: a
# fresh mktemp dir); the structured summary prints on stdout.

set -euo pipefail
cd "$(dirname "$0")"

WORKSPACE=/data/workspace
W4_RUN_TAG="w4-$(date +%s)"
W4_TOKEN_FILE="${W4_TOKEN_FILE:-$HOME/.harness-secrets-center-testbed-token}"
W4_OUT="${W4_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/w4-acceptance.XXXXXX")}"
W4_PHASE3_MS="${W4_PHASE3_MS:-240000}"
W4_SHARED_TTL_MS="${W4_SHARED_TTL_MS:-25000}"
W4_VICTIM="${W4_VICTIM:-edge-10}"
W4_SKIP_BUILD="${W4_SKIP_BUILD:-0}"
declare -a W4_RESULTS=()

note() { echo "[w4] $*"; }
phase_pass() { W4_RESULTS+=("PASS  $1"); note "PASS: $1"; }
fail() {
  echo "[w4] FAILED: $*" >&2
  echo "[w4] artifacts: $W4_OUT (stack left up: docker compose logs center)" >&2
  exit 1
}
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
iso_now() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"))'; }

# ---- token resolution (runbook fix: one command from a fresh clone) --------
if [ -z "${GITLAB_TOKEN:-}" ] && [ -f "$W4_TOKEN_FILE" ]; then
  GITLAB_TOKEN="$(cat "$W4_TOKEN_FILE")"
  note "GITLAB_TOKEN resolved from $W4_TOKEN_FILE"
fi
export GITLAB_TOKEN
[ -n "$GITLAB_TOKEN" ] || fail "GITLAB_TOKEN is empty and $W4_TOKEN_FILE is missing; export GITLAB_TOKEN=\$(cat <token-file>) or set W4_TOKEN_FILE"

mkdir -p "$W4_OUT/receipts"
RECEIPTS="$W4_OUT/receipts/all.jsonl"
: > "$RECEIPTS"
note "run tag $W4_RUN_TAG; artifacts in $W4_OUT"

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
  got=$(jsonget "$1" "$2" 2>/dev/null) || fail "field $2 missing in $1: $(head -c 400 "$1")"
  [ "$got" = "$3" ] || fail "assertion failed: $2 = '$got', expected '$3' (receipt: $(head -c 400 "$1"))"
}

run_ha() { # run_ha <container> <root> <out-file> <args...> — capture, assert ok, record identity
  local container="$1" root="$2" out="$3"; shift 3
  docker compose exec -T "$container" ha --json --root "$root" "$@" > "$out" || fail "ha $* on $container failed: $(head -c 400 "$out")"
  record_identities "$out"
}
record_identities() { # record_identities <receipt-file> — append applied identities to the manifest
  python3 - "$1" >> "$RECEIPTS" <<'PY' || true
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if r.get("ok") is True and r.get("opId"):
    print(json.dumps({"opId": r["opId"], **({"eventId": r["eventId"]} if r.get("eventId") else {})}))
PY
}
worker_identities() { # worker_identities <worker-jsonl>
  python3 - "$1" >> "$RECEIPTS" <<'PY' || true
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("ok") is True and r.get("opId") and r.get("t") in ("create", "start", "append", "release"):
        print(json.dumps({"opId": r["opId"], **({"eventId": r["eventId"]} if r.get("eventId") else {})}))
PY
}

wait_healthy() {
  local deadline=$((SECONDS + 1500))
  while [ "$(docker inspect --format '{{.State.Health.Status}}' plt-center-center)" != "healthy" ]; do
    if [ $SECONDS -ge $deadline ]; then
      docker compose logs --tail 60 center >&2 || true
      fail "center did not become healthy within 25min (cold rebuilds are minute-level; see logs above)"
    fi
    sleep 5
  done
}
wait_running() { # wait_running <service>
  for _ in $(seq 1 60); do
    [ "$(docker inspect --format '{{.State.Running}}' "plt-center-$1")" = "true" ] && return 0
    sleep 2
  done
  fail "service $1 did not reach running state"
}
wait_edge_ready() { # wait_edge_ready <edge> — the entrypoint registers the workspace only after its daemon is up; before that `ha` exits non-zero with an empty stderr
  for _ in $(seq 1 90); do
    if docker compose exec -T "$1" ha --json --root "$WORKSPACE" task list > "$W4_OUT/ready-$1.json" 2>/dev/null \
       && [ "$(jsonget "$W4_OUT/ready-$1.json" ok 2>/dev/null || echo false)" = "true" ]; then return 0; fi
    sleep 2
  done
  fail "edge $1 daemon did not become ready within 180s (entrypoint log: $(docker compose logs --tail 5 "$1" 2>&1 | tail -3 | tr '\n' ' '))"
}
lease_assignment() { # lease_assignment <task-id> -> assignmentId or empty
  docker compose exec -T center cat /data/fleet-state/leases.json > "$W4_OUT/leases.json"
  python3 - "$W4_OUT/leases.json" "$1" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
for key, row in state.get("leases", {}).items():
    if key.split("|", 1)[1] == sys.argv[2]:
        print(row.get("assignment", {}).get("assignmentId")); break
PY
}
sync_edge() { # sync_edge <edge> <out>
  docker compose exec -T "$1" ha --json daemon fleet edge sync --host center --port 7443 --ca /data/shared/fleet/fleet.crt \
    --node-id "$1" --credential "$1-machine-secret" --assignment "assignment-$1" --view-root /data/view --quota-bytes 268435456 > "$2" \
    || fail "edge $1 fleet sync failed: $(head -c 300 "$2")"
}
edge_cut() { # edge_cut <edge> -> "<revision> <headDigest>"
  docker compose exec -T "$1" cat "/data/view/repos/$REPO_ID/views/$1-view/current.json" \
    | python3 -c 'import json,sys; c=json.load(sys.stdin)["cut"]; print(c["revision"], c["headDigest"])'
}
verify_canonical() { # verify_canonical <label> [extra verifier args...]
  local label="$1"; shift
  docker compose cp "$RECEIPTS" center:/tmp/w4-receipts.jsonl >/dev/null
  docker compose exec -T center node /opt/testbed/acceptance-w4-verify.mjs --receipts /tmp/w4-receipts.jsonl "$@" > "$W4_OUT/verify-$label.json" \
    || { cat "$W4_OUT/verify-$label.json"; fail "canonical verification failed for $label"; }
  python3 - "$W4_OUT/verify-$label.json" "$label" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"[w4] verify[{sys.argv[2]}]: head revision {r['headRevision']} digest {r['headDigest'][:19]}... events {r['events']} receipts checked {r['receiptsChecked']} missing {r['receiptsMissing']}")
PY
}
convergence_check() { # convergence_check <label> <expected-revision> <expected-digest> <edges...>
  local label="$1" want_rev="$2" want_digest="$3"; shift 3
  for edge in "$@"; do
    sync_edge "$edge" "$W4_OUT/sync-$edge.json"
    local cut
    cut=$(edge_cut "$edge")
    [ "$cut" = "$want_rev $want_digest" ] || fail "convergence[$label]: $edge cut '$cut' != canonical '$want_rev $want_digest'"
    note "convergence[$label]: $edge at cut ${cut%% *} digest ${cut#* }"
  done
  phase_pass "convergence[$label]: $# edge(s) byte-identical headDigest with canonical"
}
launch_worker() { # launch_worker <out-prefix> <edge> <args...>
  docker compose exec -T "$2" node /opt/testbed/acceptance-w4-worker.mjs "${@:3}" > "$1.jsonl" 2> "$1.err" &
  WORKER_PIDS+=("$!:$1")
}
wait_workers() { # wait_workers <tolerated-prefix...> — worker files whose nonzero exit is expected
  local pid pair prefix tolerated
  for pid in "${WORKER_PIDS[@]}"; do
    pair="${pid%%:*}"
    wait "$pair" || {
      tolerated=0
      for prefix in "$@"; do case "${pid#*:}" in "$prefix"*) tolerated=1 ;; esac; done
      [ $tolerated -eq 1 ] || fail "worker ${pid#*:} exited nonzero: $(tail -c 400 "${pid#*:}.err" 2>/dev/null)"
    }
  done
}
own_task() { # own_task <kv-file> <edge> — "<edge> <task-id>" lines; hyphens make env-file sourcing unusable
  sed -n "s/^$2 //p" "$1"
}
worker_summary() { # worker_summary <jsonl> — prints "applied failed", fails on missing summary
  python3 - "$1" <<'PY'
import json, sys
last = None
for line in open(sys.argv[1]):
    line = line.strip()
    if line:
        try:
            last = json.loads(line)
        except Exception:
            pass
if not last or last.get("t") != "summary":
    print(f"worker {sys.argv[1]} produced no summary (last: {last})")
    sys.exit(1)
print(last.get("applied", 0), last.get("failed", 0))
PY
}
conflict_for() { # conflict_for <edge> <logical-path> -> staged conflict id
  docker compose exec -T "$1" node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1], want = process.argv[2];
    for (const entry of fs.readdirSync(path.join(root, ".harness", "conflicts")).sort()) {
      if (!entry.startsWith("cflt-")) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(root, ".harness", "conflicts", entry, "manifest.json"), "utf8"));
      if (manifest.state === "staged" && manifest.paths.some((row) => row.path === want)) { console.log(entry); process.exit(0); }
    }
    process.exit(1);' "$WORKSPACE" "$2" | tr -d '\r\n'
}
staged_conflict_ids() { # staged_conflict_ids <edge> — unresolved divergences only
  docker compose exec -T "$1" node -e '
    const fs = require("fs"), path = require("path");
    const dir = path.join(process.argv[1], ".harness", "conflicts");
    if (!fs.existsSync(dir)) process.exit(0);
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.startsWith("cflt-")) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, entry, "manifest.json"), "utf8"));
      if (manifest.state === "staged") console.log(entry);
    }' "$WORKSPACE" | tr -d '\r'
}
resolve_staged_conflicts() { # resolve_staged_conflicts <edge> — smoke-sync scenario 3 deliberately leaves one staged; until it is exited, every later edge command reports applied+pull_blocked
  local count=0 id
  while read -r id; do
    [ -n "$id" ] || continue
    docker compose exec -T "$1" ha --json --root "$WORKSPACE" doc conflict discard-local "$id" > "$W4_OUT/discard-$1-$id.json" \
      || fail "conflict cleanup on $1 failed for $id: $(head -c 200 "$W4_OUT/discard-$1-$id.json")"
    count=$((count + 1))
  done < <(staged_conflict_ids "$1")
  [ $count -eq 0 ] || note "resolved $count staged conflict(s) left by the phase-1 smokes on $1"
}

note "== phase 0: fresh stack =="
docker compose --profile scale down -v --remove-orphans >/dev/null 2>&1 || true
if [ "$W4_SKIP_BUILD" != "1" ]; then docker compose build --quiet || docker compose build; fi
docker compose up -d
wait_healthy
for edge in edge-1 edge-2 edge-3; do wait_running "$edge"; wait_edge_ready "$edge"; done
REPO_ID=$(docker compose exec -T center node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repoId)' /data/shared/testbed-state.json)
phase_pass "phase 0: fresh stack healthy (seed, center, edge-1..3)"

note "== phase 1: single remote writer baseline (existing smokes) =="
bash smoke-write.sh > "$W4_OUT/phase1-smoke-write.log" 2>&1 || { tail -20 "$W4_OUT/phase1-smoke-write.log"; fail "smoke-write.sh failed"; }
bash smoke-sync.sh > "$W4_OUT/phase1-smoke-sync.log" 2>&1 || { tail -20 "$W4_OUT/phase1-smoke-sync.log"; fail "smoke-sync.sh failed"; }
# smoke-sync scenario 3 ends with a deliberately unresolved staged divergence;
# exit it before the concurrency phases so mirrors start from a clean base.
for edge in edge-1 edge-2 edge-3; do resolve_staged_conflicts "$edge"; sync_edge "$edge" "$W4_OUT/p1-resync-$edge.json"; done
phase_pass "phase 1: smoke-write (5 scenarios) + smoke-sync (3 scenarios) green"

note "== phase 2: three concurrent edges, shared + distinct tasks =="
P2_TASKS="$W4_OUT/phase2-tasks.kv"
: > "$P2_TASKS"
for edge in edge-1 edge-2 edge-3; do
  run_ha "$edge" "$WORKSPACE" "$W4_OUT/p2-create-$edge.json" task create --title "W4 P2 own $edge $W4_RUN_TAG" --preset standard-task
  echo "$edge $(jsonget "$W4_OUT/p2-create-$edge.json" taskId)" >> "$P2_TASKS"
done
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p2-create-shared.json" task create --title "W4 P2 shared contention $W4_RUN_TAG" --preset standard-task
P2_SHARED=$(jsonget "$W4_OUT/p2-create-shared.json" taskId)
declare -a WORKER_PIDS=()
for edge in edge-1 edge-2 edge-3; do
  launch_worker "$W4_OUT/p2-own-$edge" "$edge" --node "$edge" --mode own --tag "P2-$W4_RUN_TAG" --task "$(own_task "$P2_TASKS" "$edge")" --rounds 3 --appends 3 --gap-ms 200
  launch_worker "$W4_OUT/p2-shared-$edge" "$edge" --node "$edge" --mode shared --tag "P2-$W4_RUN_TAG" --task "$P2_SHARED" --rounds 4 --appends 2
done
wait_workers
for edge in edge-1 edge-2 edge-3; do
  summary=$(worker_summary "$W4_OUT/p2-own-$edge.jsonl") || fail "phase 2 own worker $edge: $summary"
  read -r _ failed <<< "$summary"
  [ "$failed" = "0" ] || fail "phase 2 own worker $edge recorded failed writes: $(grep '\"ok\":false' "$W4_OUT/p2-own-$edge.jsonl" | head -2)"
  summary=$(worker_summary "$W4_OUT/p2-shared-$edge.jsonl") || fail "phase 2 shared worker $edge: $summary"
  read -r _ failed <<< "$summary"
  [ "$failed" = "0" ] || fail "phase 2 shared worker $edge recorded failed writes: $(grep '\"ok\":false' "$W4_OUT/p2-shared-$edge.jsonl" | head -2)"
done
for f in "$W4_OUT"/p2-*.jsonl; do worker_identities "$f"; done
note "phase 2 concurrent workers finished: $(cat "$W4_OUT"/p2-*.jsonl | grep -c '\"ok\":true') applied writes"

note "== phase 2b: concurrent same-document overwrite stages, never silently loses =="
SHARED_DOC=context/shared-notes.md
for edge in edge-1 edge-2 edge-3; do sync_edge "$edge" "$W4_OUT/p2cf-sync-$edge.json"; done
for edge in edge-1 edge-2 edge-3; do
  # The prose policy keeps region structure: replace the body under the TOP
  # heading while preserving every sub-heading region the smokes left behind
  # (a legal additive-region change), so all three candidates are legal writes
  # over one base — exactly one can land, the others must stage.
  docker compose exec -T "$edge" node -e '
    const fs = require("fs");
    const file = process.argv[1], marker = process.argv[2];
    const body = fs.readFileSync(file, "utf8");
    const at = body.indexOf("\n## ");
    const heading = body.split("\n", 1)[0], tail = at < 0 ? "" : body.slice(at + 1);
    fs.writeFileSync(file, `${heading}\n\n${marker}\n${tail ? `\n${tail}` : ""}`);' \
    "$WORKSPACE/harness/$SHARED_DOC" "Region replaced by $edge at $W4_RUN_TAG."
done
for edge in edge-1 edge-2 edge-3; do
  ( docker compose exec -T "$edge" ha --json --root "$WORKSPACE" doc sync --submit --path "$SHARED_DOC" > "$W4_OUT/p2cf-$edge.json" 2> "$W4_OUT/p2cf-$edge.err" ) || true &
done
wait
# Concurrent same-region doc rounds settle per the W3-C region contract:
# region REPLACEMENT is a legal additive change, so pushes serialize and the
# final document holds exactly one pusher's bytes — the LAST applied writer.
# Every displaced writer is staged by its own round (push-rejected base
# staging, or the post-push pull finding a newer same-path write); canonicalOutcome/
# syncState are the authority (ok alone is inverted on the push-rejected
# staging path — W4 finding, failure report filed separately).
CANON_DOC=$(docker compose exec -T center git -C "$WORKSPACE/harness" show "refs/ha/canonical:$SHARED_DOC")
P2CF_WINNER=$(grep -o "Region replaced by edge-[0-9]* at $W4_RUN_TAG" <<< "$CANON_DOC" | sed 's/Region replaced by //; s/ at.*//')
[ "$(grep -c "Region replaced by edge-" <<< "$CANON_DOC")" = "1" ] || fail "phase 2b: canonical holds $(grep -c 'Region replaced by edge-' <<< "$CANON_DOC") concurrent-write markers, expected exactly 1"
grep -q "## Edge one wins" <<< "$CANON_DOC" || fail "phase 2b: the preserved sub-heading region was lost from canonical"
APPLIED_COUNT=0
for edge in edge-1 edge-2 edge-3; do
  outcome="$(jsonget "$W4_OUT/p2cf-$edge.json" canonicalOutcome 2>/dev/null || echo missing)"
  state="$(jsonget "$W4_OUT/p2cf-$edge.json" syncState 2>/dev/null || echo missing)"
  case "$outcome:$state" in
    applied:SYNCED|applied:CONFLICT_STAGED|op_rejected:CONFLICT_STAGED) ;;
    *) fail "phase 2b: $edge settled outside the contract ($outcome/$state): $(head -c 300 "$W4_OUT/p2cf-$edge.json")" ;;
  esac
  [ "$outcome" = "applied" ] && APPLIED_COUNT=$((APPLIED_COUNT + 1))
  # A round that SAW a divergence must have staged that divergence with its
  # local bytes — that is the "staging, never silent" guarantee. A round that
  # ended SYNCED and was overwritten later is ordinary last-writer-wins: its
  # event stays immutable in canonical history.
  if [ "$state" = "CONFLICT_STAGED" ]; then
    docker compose exec -T "$edge" sh -c "grep -r \"replaced by $edge at\" $WORKSPACE/.harness/conflicts/*/local/$SHARED_DOC" >/dev/null \
      || fail "phase 2b: $edge reported a divergence but its local bytes were not staged (silent loss)"
    note "phase 2b: $edge divergence staged (local bytes preserved; receipt $outcome/$state)"
  fi
done
[ $APPLIED_COUNT -ge 1 ] || fail "phase 2b: no concurrent push applied at the center"
for edge in edge-1 edge-2 edge-3; do
  [ "$edge" = "$P2CF_WINNER" ] || docker compose exec -T "$edge" ha --json --root "$WORKSPACE" doc conflict discard-local "$(conflict_for "$edge" "$SHARED_DOC")" > "$W4_OUT/p2cf-discard-$edge.json" \
    || fail "phase 2b: discard-local cleanup failed for $edge"
done
phase_pass "phase 2b: $APPLIED_COUNT push(es) applied serially, final doc = $P2CF_WINNER, every displaced writer staged (no silent loss)"

note "== phase 2 assertions =="
verify_canonical p2
convergence_check p2 "$(jsonget "$W4_OUT/verify-p2.json" headRevision)" "$(jsonget "$W4_OUT/verify-p2.json" headDigest)" edge-1 edge-2 edge-3
phase_pass "phase 2: no lost update, revisions strictly monotonic 1..$(jsonget "$W4_OUT/verify-p2.json" headRevision), 3 edges converged"

note "== phase 3: ten edges, sustained concurrency, kill + center restart =="
# --no-deps: naming the edges alone is not enough — `up` re-runs an exited
# `service_completed_successfully` dependency (the seed), which reseeds the
# ledger and replaces the fleet TLS material mid-acceptance. Center health is
# already proven by this script; the edges only need the network.
docker compose --profile scale up -d --no-deps --wait edge-4 edge-5 edge-6 edge-7 edge-8 edge-9 edge-10
for n in 4 5 6 7 8 9 10; do wait_edge_ready "edge-$n"; done
P3_TASKS="$W4_OUT/phase3-tasks.kv"
: > "$P3_TASKS"
for n in 1 2 3 4 5 6 7 8 9; do
  edge="edge-$n"
  run_ha "$edge" "$WORKSPACE" "$W4_OUT/p3-create-$edge.json" task create --title "W4 P3 own $edge $W4_RUN_TAG" --preset standard-task
  echo "$edge $(jsonget "$W4_OUT/p3-create-$edge.json" taskId)" >> "$P3_TASKS"
done
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p3-create-shared.json" task create --title "W4 P3 shared contention $W4_RUN_TAG" --preset standard-task
P3_SHARED=$(jsonget "$W4_OUT/p3-create-shared.json" taskId)
P3_DEADLINE=$(now_ms); P3_DEADLINE=$((P3_DEADLINE + W4_PHASE3_MS))
declare -a WORKER_PIDS=()
for n in 1 2 3 4 5 6 7 8 9; do
  edge="edge-$n"
  launch_worker "$W4_OUT/p3-own-$edge" "$edge" --node "$edge" --mode own --tag "P3-$W4_RUN_TAG" --task "$(own_task "$P3_TASKS" "$edge")" --rounds 999 --appends 1 --gap-ms 300 --deadline-epoch-ms "$P3_DEADLINE"
done
launch_worker "$W4_OUT/p3-shared-edge-1" edge-1 --node edge-1 --mode shared --tag "P3-$W4_RUN_TAG" --task "$P3_SHARED" --rounds 999 --appends 1 --deadline-epoch-ms "$P3_DEADLINE"
launch_worker "$W4_OUT/p3-shared-edge-2" edge-2 --node edge-2 --mode shared --tag "P3-$W4_RUN_TAG" --task "$P3_SHARED" --rounds 999 --appends 1 --deadline-epoch-ms "$P3_DEADLINE"
launch_worker "$W4_OUT/p3-shared-$W4_VICTIM" "$W4_VICTIM" --node "$W4_VICTIM" --mode shared --tag "P3-$W4_RUN_TAG" --task "$P3_SHARED" --rounds 999 --appends 1 --ttl-ms "$W4_SHARED_TTL_MS" --hold-ms 15000 --deadline-epoch-ms "$P3_DEADLINE"
note "phase 3: 12 concurrent writers on 10 edges for $((W4_PHASE3_MS / 1000))s (window started)"

# Lease-survival anchor: wait until edge-1's own-task lease exists, then restart
# the center mid-load and prove the row, holder rights, and queue survive.
EDGE1_TASK="$(own_task "$P3_TASKS" edge-1)"
for _ in $(seq 1 60); do
  [ "$(lease_assignment "$EDGE1_TASK")" = "assignment-edge-1" ] && break
  sleep 1
done
[ "$(lease_assignment "$EDGE1_TASK")" = "assignment-edge-1" ] || fail "phase 3: edge-1 never acquired its own-task lease"
note "phase 3: restarting the center mid-load (edge-1 holds $EDGE1_TASK)"
docker compose restart center >/dev/null
wait_healthy
P3_RESTART_AT=$(iso_now)
CENTER_LOGS=$(docker compose logs center 2>&1)
echo "$CENTER_LOGS" | grep "warm restart; lease state kept" >/dev/null || fail "phase 3: center restart was not the warm path (lease state not kept)"
[ "$(lease_assignment "$EDGE1_TASK")" = "assignment-edge-1" ] || fail "phase 3: edge-1's held lease row did not survive the center restart"
note "phase 3: warm restart verified; lease row for $EDGE1_TASK survived"

# Kill the victim while it holds the shared lease; the reaper must release the
# orphan and the FIFO queue must hand the task to a live contender.
VICTIM_HOLDING=""
for _ in $(seq 1 180); do
  holder=$(lease_assignment "$P3_SHARED")
  if [ "$holder" = "assignment-$W4_VICTIM" ]; then VICTIM_HOLDING=1; break; fi
  sleep 1
done
[ -n "$VICTIM_HOLDING" ] || fail "phase 3: $W4_VICTIM never held $P3_SHARED within 180s (holder now: $(lease_assignment "$P3_SHARED"))"
P3_KILL_AT=$(iso_now)
docker compose kill "$W4_VICTIM" >/dev/null
note "phase 3: killed $W4_VICTIM at $P3_KILL_AT while holding $P3_SHARED (ttl ${W4_SHARED_TTL_MS}ms); waiting for the reaper"
# The reaper's lease_released wakes the FIFO head, so the row legitimately
# transitions victim -> (briefly empty) -> live contender. The assertion is
# "no longer held by the dead node", plus the audit event (checked by the
# verifier) and a post-kill start receipt from a live contender below.
P3_REAPED=0
for _ in $(seq 1 $((W4_SHARED_TTL_MS / 1000 + 30))); do
  if [ "$(lease_assignment "$P3_SHARED")" != "assignment-$W4_VICTIM" ]; then P3_REAPED=1; break; fi
  sleep 1
done
[ $P3_REAPED -eq 1 ] || fail "phase 3: the orphaned lease for $P3_SHARED stayed with the dead node (holder: $(lease_assignment "$P3_SHARED"))"
note "phase 3: orphan lease released by the reaper; row now: '$(lease_assignment "$P3_SHARED" || true)'"

wait_workers "$W4_OUT/p3-shared-$W4_VICTIM"
# Plain `docker start`: `docker compose start` (like `up`) re-runs the exited
# seed dependency through center's depends_on chain, reseeding the ledger and
# rotating the fleet TLS material mid-acceptance. The container name is the
# deterministic compose plt-center-<service>.
docker start "plt-center-$W4_VICTIM" >/dev/null
wait_running "$W4_VICTIM"
wait_edge_ready "$W4_VICTIM"
for f in "$W4_OUT"/p3-*.jsonl; do worker_identities "$f"; done
python3 - "$W4_OUT/p3-shared-edge-1.jsonl" "$W4_OUT/p3-shared-edge-2.jsonl" "$P3_SHARED" "$P3_KILL_AT" <<'PY' || fail "phase 3: no live contender took over the shared task after the orphan reap"
import json, sys
shared, kill_at = sys.argv[3], sys.argv[4]
for path in sys.argv[1:3]:
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r.get("t") == "start" and r.get("ok") is True and r.get("taskId") == shared and r.get("at", "") >= kill_at:
            sys.exit(0)
print("no start receipt on the shared task after the kill")
sys.exit(1)
PY
python3 - "$W4_OUT/p3-own-edge-1.jsonl" "$P3_RESTART_AT" <<'PY' || fail "phase 3: edge-1 could not keep writing after the center restart"
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if line:
        r = json.loads(line)
        if r.get("t") == "append" and r.get("ok") is True and r.get("at", "") >= sys.argv[2]:
            sys.exit(0)
print("no applied append after the restart")
sys.exit(1)
PY
phase_pass "phase 3 faults: orphan reaped + FIFO takeover after kill; warm center restart kept lease/queue and holder write rights"
note "phase 3: $(cat "$W4_OUT"/p3-*.jsonl | grep -c '\"ok\":true') applied writes under 10-edge concurrency"

note "== phase 3 assertions =="
verify_canonical p3 --expect-lease-released "$P3_SHARED"
[ "$(jsonget "$W4_OUT/verify-p3.json" leaseReleasedAudit 2>/dev/null || echo false)" = "true" ] || fail "phase 3: lease_released audit event missing for $P3_SHARED"
convergence_check p3 "$(jsonget "$W4_OUT/verify-p3.json" headRevision)" "$(jsonget "$W4_OUT/verify-p3.json" headDigest)" edge-1 edge-2 edge-3 edge-4 edge-5 edge-6 edge-7 edge-8 edge-9 "$W4_VICTIM"
phase_pass "phase 3: no lost update, revisions strictly monotonic 1..$(jsonget "$W4_OUT/verify-p3.json" headRevision), 10 edges converged"

note "== phase 4: mixed-mode fault isolation on the center daemon =="
MIXED_ROOT=/data/mixed-edge
MIXED_REPO=plt-center-mixed
docker compose exec -T center ha --json --root "$MIXED_ROOT" init --repo-id "$MIXED_REPO" --person-id testbed-mixed --display-name "PLT Center Mixed" --name plt-center-mixed > "$W4_OUT/p4-init.json" \
  || fail "phase 4: mixed repo init failed: $(head -c 300 "$W4_OUT/p4-init.json")"
docker compose exec -T center ha --json daemon repo register --repo-id "$MIXED_REPO" --root "$MIXED_ROOT" --mode remote-edge > "$W4_OUT/p4-register.json" \
  || fail "phase 4: mixed repo registration failed: $(head -c 300 "$W4_OUT/p4-register.json")"
docker compose exec -T center ha --json --root "$MIXED_ROOT" task list > "$W4_OUT/p4-b-healthy.json" \
  || fail "phase 4: remote-edge repo did not read before the latch: $(head -c 300 "$W4_OUT/p4-b-healthy.json")"
mixed_repo_state() { # mixed_repo_state -> "<state> <mode>"
  docker compose exec -T center ha --json --root "$WORKSPACE" daemon status | python3 -c '
import json, sys
for row in json.load(sys.stdin)["repos"]:
    if row["repoId"] == "plt-center-mixed":
        print(row.get("state"), row.get("mode")); break
'
}
read -r b_state b_mode <<< "$(mixed_repo_state)"
[ "$b_state:$b_mode" = "attached:remote-edge" ] || fail "phase 4: expected attached/remote-edge before the latch, got $b_state/$b_mode"
note "phase 4: daemon serves local repo $REPO_ID + remote-edge repo $MIXED_REPO (both attached)"

docker compose exec -T center sh -c "mv $MIXED_ROOT/harness/.git $MIXED_ROOT/harness/.git-aside"
docker compose exec -T center ha --json daemon repo unregister --repo-id "$MIXED_REPO" > "$W4_OUT/p4-unregister.json" || fail "phase 4: unregister failed"
docker compose exec -T center ha --json daemon repo register --repo-id "$MIXED_REPO" --root "$MIXED_ROOT" --mode remote-edge > "$W4_OUT/p4-relatch.json" || fail "phase 4: relatch registration failed"
read -r b_state b_mode <<< "$(mixed_repo_state)"
[ "$b_state" = "unavailable" ] || fail "phase 4: mixed repo should be latched (unavailable), got $b_state"
docker compose exec -T center ha --json --root "$MIXED_ROOT" task list > "$W4_OUT/p4-b-latched.json" 2> "$W4_OUT/p4-b-latched.err" || true
[ "$(jsonget "$W4_OUT/p4-b-latched.json" code 2>/dev/null || echo missing)" = "repo_unavailable" ] \
  || fail "phase 4: latched repo read must report repo_unavailable, got: $(head -c 300 "$W4_OUT/p4-b-latched.json") $(head -c 200 "$W4_OUT/p4-b-latched.err")"
note "phase 4: $MIXED_REPO latched (repo_unavailable); proving the local repo is unaffected"

docker compose exec -T center ha --json --root "$WORKSPACE" task list > "$W4_OUT/p4-a-read.json" || fail "phase 4: local repo read failed while the sibling repo was latched"
run_ha center "$WORKSPACE" "$W4_OUT/p4-a-create.json" task create --title "W4 P4 local write under latch $W4_RUN_TAG" --preset standard-task
P4_TASK=$(jsonget "$W4_OUT/p4-a-create.json" taskId)
run_ha center "$WORKSPACE" "$W4_OUT/p4-a-start.json" task start "$P4_TASK"
run_ha center "$WORKSPACE" "$W4_OUT/p4-a-append.json" task progress append "$P4_TASK" --text "W4 P4 canonical-local write while the sibling repo is latched $W4_RUN_TAG"
run_ha center "$WORKSPACE" "$W4_OUT/p4-a-release.json" task release "$P4_TASK" --reason "W4 P4: latch-isolation probe complete"
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p4-fleet-create.json" task create --title "W4 P4 fleet write under latch $W4_RUN_TAG" --preset standard-task
P4_FLEET_TASK=$(jsonget "$W4_OUT/p4-fleet-create.json" taskId)
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p4-fleet-start.json" task start "$P4_FLEET_TASK"
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p4-fleet-append.json" task progress append "$P4_FLEET_TASK" --text "W4 P4 fleet write while the sibling repo is latched $W4_RUN_TAG"
run_ha edge-1 "$WORKSPACE" "$W4_OUT/p4-fleet-release.json" task release "$P4_FLEET_TASK" --reason "W4 P4: fleet-path isolation probe complete"
sync_edge edge-2 "$W4_OUT/p4-sync-edge-2.json"
phase_pass "phase 4 isolation: local repo read+write, fleet-path write, and edge sync green while the sibling repo was latched"

docker compose exec -T center sh -c "mv $MIXED_ROOT/harness/.git-aside $MIXED_ROOT/harness/.git"
P4_HEALED=0
for _ in $(seq 1 20); do
  if docker compose exec -T center ha --json --root "$MIXED_ROOT" task list > "$W4_OUT/p4-b-heal.json" 2>/dev/null \
     && [ "$(jsonget "$W4_OUT/p4-b-heal.json" ok 2>/dev/null || echo false)" = "true" ]; then P4_HEALED=1; break; fi
  sleep 2
done
[ $P4_HEALED -eq 1 ] || fail "phase 4: the latched repo did not self-heal after repair ($(mixed_repo_state))"
read -r b_state b_mode <<< "$(mixed_repo_state)"
[ "$b_state:$b_mode" = "attached:remote-edge" ] || fail "phase 4: healed repo should be attached/remote-edge, got $b_state/$b_mode"
phase_pass "phase 4: latched repo self-healed after infrastructure repair ($b_state/$b_mode)"

note "== phase 4 assertions (mixed-phase writes) =="
verify_canonical p4
phase_pass "phase 4: canonical integrity holds across the mixed-mode scenario"

echo
note "================ W4 ACCEPTANCE SUMMARY ($W4_RUN_TAG) ================"
printf '[w4] %s\n' "${W4_RESULTS[@]}"
echo "[w4] artifacts: $W4_OUT"
echo "[w4] head: revision $(jsonget "$W4_OUT/verify-p4.json" headRevision) digest $(jsonget "$W4_OUT/verify-p4.json" headDigest)"
echo "W4 ACCEPTANCE PASS: three phases + mixed-mode all green on real containers."
