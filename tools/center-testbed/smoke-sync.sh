#!/usr/bin/env bash
# Host-side dual-class sync smoke for the PLT-Center testbed (W3-C). Assumes
# `docker compose up -d --wait` succeeded on a reseeded fresh stack. Drives the
# three design-v2 §3/§4 conflict scenarios with real containers:
#   1. transition conflict (class A): a task transition that would carry local
#      task documents is refused whole when the center moved underneath the
#      edge's base — nothing transitions, the divergence is staged under
#      .harness/conflicts, and the discard-local exit unblocks the retry.
#   2. doc conflict (class B): both edges edit the shared document; the losing
#      round reports CONFLICT_STAGED with base/local/center staged, discards
#      local, and a second divergence is resolved by overwrite-center.
#   3. pull blocked (§4 scenario two): the edge's own command applies at the
#      center while another edge moved a document this edge still holds dirty
#      locally; the receipt reports canonicalOutcome=applied together with
#      mirrorOutcome=pull_blocked and stages the divergence.

set -euo pipefail
cd "$(dirname "$0")"

WORKSPACE=/data/workspace
SMOKE_TMP=$(mktemp -d)
RUN_TAG=$(date +%s)
cleanup() { rm -rf "$SMOKE_TMP"; }
trap cleanup EXIT
REPO_ID=$(docker compose exec -T center node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repoId)' /data/shared/testbed-state.json)
SHARED=context/shared-notes.md

log() { echo "[smoke-sync] $*"; }
fail_smoke() { echo "[smoke-sync] FAILED: $*" >&2; exit 1; }

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

expect_in() { # expect_in <file> <field> <comma-separated alternatives>
  local got
  got=$(jsonget "$1" "$2") || fail_smoke "field $2 missing in $1: $(head -c 400 "$1")"
  case ",$3," in *",$got,"*) return 0 ;; *) fail_smoke "assertion failed: $2 = '$got', expected one of $3 (receipt: $(head -c 400 "$1"))" ;; esac
}

# materialized <edge> <logical-path> — the registered workspace harness file
materialized() { docker compose exec -T "$1" sh -c "cat $WORKSPACE/harness/$2"; }
append_materialized() { # append_materialized <edge> <logical-path> <text-file>
  docker compose cp "$3" "$1:/tmp/append.txt" >/dev/null
  docker compose exec -T "$1" sh -c "cat /tmp/append.txt >> $WORKSPACE/harness/$2"
}
center_leases() { docker compose exec -T center cat /data/fleet-state/leases.json; }
lease_row() {
  center_leases > "$SMOKE_TMP/leases.json"
  python3 - "$SMOKE_TMP/leases.json" "$1" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
for key, row in state.get("leases", {}).items():
    if key.split("|", 1)[1] == sys.argv[2]:
        print(row.get("assignment", {}).get("assignmentId")); break
PY
}
conflict_ids() { # conflict_ids <edge>
  docker compose exec -T "$1" sh -c "ls $WORKSPACE/.harness/conflicts 2>/dev/null | grep '^cflt-' | tr '\n' ' '" | tr -d '\r\n'
}
# conflict_for <edge> <logical-path>: the staged (unresolved) conflict whose
# manifest names this path. Staged ids accumulate across scenarios, so picking
# by directory order would be wrong.
conflict_for() {
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

log "== scenario 1: a conflicted class-A transition is voided whole and staged =="
ha edge-1 task create --title "W3-C transition conflict $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s1-create.json"
expect "$SMOKE_TMP/s1-create.json" ok true
T1=$(jsonget "$SMOKE_TMP/s1-create.json" taskId)
PACKAGE1=$(jsonget "$SMOKE_TMP/s1-create.json" packagePath)
PLAN1="$PACKAGE1/task_plan.md"
# The center rewrites the plan while edge-1 keeps an older mirror base.
docker compose exec -T center sh -c "printf '\n## Rewritten at the center\n\nThe center moved this plan first.\n' >> $WORKSPACE/harness/$PLAN1"
ha center doc sync --submit --path "$PLAN1" > "$SMOKE_TMP/s1-center-write.json"
expect "$SMOKE_TMP/s1-center-write.json" ok true
printf '\n## Edge one local plan\n\nEdited on the edge against the older cut.\n' > "$SMOKE_TMP/s1-append.txt"
append_materialized edge-1 "$PLAN1" "$SMOKE_TMP/s1-append.txt"
ha edge-1 task start "$T1" > "$SMOKE_TMP/s1-start.json" 2> "$SMOKE_TMP/s1-start.err" || true
[ "$(jsonget "$SMOKE_TMP/s1-start.json" ok 2>/dev/null || echo missing)" = "false" ] || fail_smoke "the conflicted transition must be refused: $(head -c 400 "$SMOKE_TMP/s1-start.json" 2>/dev/null) $(head -c 200 "$SMOKE_TMP/s1-start.err")"
expect_in "$SMOKE_TMP/s1-start.json" code mirror_behind_center,base_blob_changed
[ -z "$(lease_row "$T1")" ] || fail_smoke "the center must not transition the task on a conflicted bundle"
C1=$(conflict_for edge-1 "$PLAN1") || fail_smoke "the divergence must be staged under .harness/conflicts"
docker compose exec -T edge-1 sh -c "cat $WORKSPACE/.harness/conflicts/$C1/manifest.json" > "$SMOKE_TMP/s1-manifest.json"
expect "$SMOKE_TMP/s1-manifest.json" paths.0.path "$PLAN1"
docker compose exec -T edge-1 sh -c "test -f $WORKSPACE/.harness/conflicts/$C1/base/$PLAN1 && test -f $WORKSPACE/.harness/conflicts/$C1/local/$PLAN1 && test -f $WORKSPACE/.harness/conflicts/$C1/center/$PLAN1" || fail_smoke "the staged conflict must carry base/, local/, and center/"
log "scenario 1a PASS: transition refused with $(jsonget "$SMOKE_TMP/s1-start.json" code), staged as $C1, no lease created"
# Exit: discard the local plan, then the same start applies on the fresh base.
ha edge-1 doc conflict discard-local "$C1" > "$SMOKE_TMP/s1-discard.json"
expect "$SMOKE_TMP/s1-discard.json" ok true
materialized edge-1 "$PLAN1" | grep -q "Rewritten at the center" || fail_smoke "discard-local must restore the recorded center bytes"
ha edge-1 task start "$T1" > "$SMOKE_TMP/s1-retry.json"
expect "$SMOKE_TMP/s1-retry.json" ok true
[ "$(lease_row "$T1")" = "assignment-edge-1" ] || fail_smoke "the retried transition must acquire the lease"
log "scenario 1b PASS: discard-local unblocked the transition; edge-1 now holds $T1"

log "== scenario 2: class-B shared doc conflicts stage and exit explicitly =="
ha edge-1 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-sync1.json"
expect "$SMOKE_TMP/s2-sync1.json" ok true
ha edge-2 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-sync2.json"
expect "$SMOKE_TMP/s2-sync2.json" ok true
# edge-1 edits locally; edge-2 edits and pushes a different version (same region).
printf '\n## Edge one notes\n\nOnly on edge one.\n' > "$SMOKE_TMP/s2-e1.txt"
append_materialized edge-1 "$SHARED" "$SMOKE_TMP/s2-e1.txt"
docker compose exec -T edge-2 sh -c "printf '# Shared notes\n\nRevised by edge two at the center.\n' > /tmp/replace.txt"
docker compose exec -T edge-2 node -e '
  const fs = require("fs");
  const target = process.argv[1];
  const body = fs.readFileSync(target, "utf8");
  const at = body.indexOf("# Shared notes");
  if (at < 0) process.exit(1);
  const replacement = fs.readFileSync("/tmp/replace.txt", "utf8").trim();
  fs.writeFileSync(target, body.slice(0, at) + replacement + "\n");' "$WORKSPACE/harness/$SHARED"
ha edge-2 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-push2.json"
expect "$SMOKE_TMP/s2-push2.json" ok true
ha edge-1 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-conflict.json" 2> "$SMOKE_TMP/s2-conflict.err" || true
[ "$(jsonget "$SMOKE_TMP/s2-conflict.json" ok 2>/dev/null || echo missing)" = "false" ] || fail_smoke "the divergent shared-doc round must not report ok: $(head -c 400 "$SMOKE_TMP/s2-conflict.json" 2>/dev/null)"
expect "$SMOKE_TMP/s2-conflict.json" syncState CONFLICT_STAGED
C2=$(conflict_for edge-1 "$SHARED") || fail_smoke "the shared-doc divergence must stage its own record"
docker compose exec -T edge-1 sh -c "cat $WORKSPACE/.harness/conflicts/$C2/manifest.json" > "$SMOKE_TMP/s2-manifest.json"
expect "$SMOKE_TMP/s2-manifest.json" paths.0.path "$SHARED"
materialized edge-1 "$SHARED" | grep -q "Edge one notes" || fail_smoke "the local bytes must survive the staged conflict untouched"
ha edge-1 doc conflict discard-local "$C2" > "$SMOKE_TMP/s2-discard.json"
expect "$SMOKE_TMP/s2-discard.json" ok true
materialized edge-1 "$SHARED" | grep -q "Revised by edge two" || fail_smoke "discard-local must adopt the center bytes"
log "scenario 2a PASS: CONFLICT_STAGED with base/local/center; discard-local adopted the center version"
# Second divergence, resolved by overwrite-center (region-compatible edit).
printf '\n## Edge one wins\n\nExplicit overwrite through the staged exit.\n' > "$SMOKE_TMP/s2-ow.txt"
append_materialized edge-1 "$SHARED" "$SMOKE_TMP/s2-ow.txt"
docker compose exec -T edge-2 sh -c "printf 'Center moved again inside the shared region.\n' >> $WORKSPACE/harness/$SHARED"
ha edge-2 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-push3.json"
expect "$SMOKE_TMP/s2-push3.json" ok true
ha edge-1 doc sync --submit --path "$SHARED" > "$SMOKE_TMP/s2-conflict2.json" 2> "$SMOKE_TMP/s2-conflict2.err" || true
C3=$(conflict_for edge-1 "$SHARED") || fail_smoke "the second divergence must stage its own record"
ha edge-1 doc conflict overwrite-center "$C3" > "$SMOKE_TMP/s2-overwrite.json"
expect "$SMOKE_TMP/s2-overwrite.json" ok true
materialized edge-1 "$SHARED" | grep -q "Edge one wins" || fail_smoke "overwrite-center must land the staged local bytes"
docker compose exec -T edge-2 ha --json daemon fleet edge sync --host center --port 7443 --ca /data/shared/fleet/fleet.crt --node-id edge-2 --credential edge-2-machine-secret --assignment assignment-edge-2 --view-root /data/view --quota-bytes 268435456 >/dev/null
log "scenario 2b PASS: overwrite-center landed the explicit local overwrite as ${C3}"

log "== scenario 3: applied at the center + pull blocked at the mirror =="
ha edge-1 task create --title "W3-C dual axis A $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s3-createA.json"
TA=$(jsonget "$SMOKE_TMP/s3-createA.json" taskId)
PACKAGEA=$(jsonget "$SMOKE_TMP/s3-createA.json" packagePath)
ha edge-1 task create --title "W3-C dual axis B $RUN_TAG" --preset standard-task > "$SMOKE_TMP/s3-createB.json"
TB=$(jsonget "$SMOKE_TMP/s3-createB.json" taskId)
PACKAGEB=$(jsonget "$SMOKE_TMP/s3-createB.json" packagePath)
ha edge-1 task start "$TA" > "$SMOKE_TMP/s3-startA.json"
expect "$SMOKE_TMP/s3-startA.json" ok true
# edge-1 keeps task B's plan dirty locally while edge-2 takes B and pushes its own plan.
printf '\n## Node one unsynced notes\n\nStill dirty locally.\n' > "$SMOKE_TMP/s3-e1.txt"
append_materialized edge-1 "$PACKAGEB/task_plan.md" "$SMOKE_TMP/s3-e1.txt"
ha edge-2 task start "$TB" > "$SMOKE_TMP/s3-startB.json"
expect "$SMOKE_TMP/s3-startB.json" ok true
printf '\n## Node two landed version\n\nPushed while node one was dirty.\n' > "$SMOKE_TMP/s3-e2.txt"
append_materialized edge-2 "$PACKAGEB/task_plan.md" "$SMOKE_TMP/s3-e2.txt"
ha edge-2 task progress append "$TB" --text "edge-2 pushed task B's plan with this transition" > "$SMOKE_TMP/s3-progressB.json"
expect "$SMOKE_TMP/s3-progressB.json" ok true
[ "$(jsonget "$SMOKE_TMP/s3-progressB.json" docSync.outcome)" = "applied" ] || fail_smoke "edge-2's carried documents must land: $(head -c 400 "$SMOKE_TMP/s3-progressB.json")"
# edge-1's own command applies at the center; the auto pull finds the diverged
# task B plan and must report the dual axis instead of pretending sync.
ha edge-1 task progress append "$TA" --text "applied at the center while the mirror diverged" > "$SMOKE_TMP/s3-progressA.json" 2> "$SMOKE_TMP/s3-progressA.err" || true
[ "$(jsonget "$SMOKE_TMP/s3-progressA.json" ok 2>/dev/null || echo missing)" = "false" ] || fail_smoke "a pull-blocked command must not report ok: $(head -c 400 "$SMOKE_TMP/s3-progressA.json" 2>/dev/null)"
expect "$SMOKE_TMP/s3-progressA.json" canonicalOutcome applied
expect "$SMOKE_TMP/s3-progressA.json" mirrorOutcome pull_blocked
docker compose exec -T edge-1 sh -c "test -f $WORKSPACE/.harness/conflicts/*/local/$PACKAGEB/task_plan.md" || fail_smoke "the pull-blocked divergence must be staged"
materialized edge-1 "$PACKAGEB/task_plan.md" | grep -q "Node one unsynced notes" || fail_smoke "the local dirty bytes must survive the blocked pull"
log "scenario 3 PASS: canonicalOutcome=applied with mirrorOutcome=pull_blocked, divergence staged, local bytes intact"

echo
log "staged conflicts on edge-1 (final): $(conflict_ids edge-1)"
echo "SMOKE PASS: all three dual-class sync conflict scenarios passed on real containers."
