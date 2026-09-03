# Legacy Ledger Recovery: When a Repository Refuses Every Command

Status: recovery path for a registered repository whose ledger still carries legacy migration
events that the current generation rejects on read. This page repairs that repository in place. For
moving an older-generation repository into a freshly initialized one, read
[migration-genesis-replay.md](migration-genesis-replay.md) instead.

## The symptom

You upgraded, and now the repository answers every command the same way:

```console
$ ha task list
error code=repo_unavailable hint=this workspace stays latched until its ledger data verifies: repair the data-shape cause below, then rerun the command; the next attempt re-probes the ledger and re-attaches automatically once the data verifies. Cause: migration task entity is invalid
```

Three things are true in that one line:

- The daemon did not lose your data, and it did not lock you out by accident. It refuses to attach
  the repository because the ledger does not verify against the current canonical-event contract.
- The cause is a data-shape defect, not an infrastructure fault. The example above names
  `migration task entity is invalid`; another repository in the same situation names a different
  field. The recovery path is the same either way.
- The latch is self-healing by design. Once the data verifies, the next command re-probes the
  ledger and re-attaches automatically. You do not restart anything to finish that step.

Read the `Cause:` text before anything else. This page covers the data-shape class, where the cause
points at an event or entity inside your ledger. If the hint instead says the workspace stays
latched until its *Git or lock infrastructure* recovers, or until its *projection* verifies, this is
not your page: follow that hint's own instruction (`ha daemon projection rebuild` for the projection
class, the named infrastructure repair otherwise).

## What is actually wrong

The current daemon reads the ledger through a strict canonical-event parser. A repository migrated
by an earlier generation can still contain migration events that do not satisfy today's contract —
for example a `migration-import-event/v1` whose task entity is missing the `provenance` field that
is now required. The parser refuses the whole ledger, the repository's cell stays unattached
("latched"), and every command that needs the repository returns `repo_unavailable`.

The repair is not a manual data edit. Three pieces already exist in the daemon, and together they
make one recovery command sufficient:

- **Recovery admission.** `ha migrate import` and `ha migrate rekey-facts` enter a latched
  repository through the repository's single-writer recovery ingress. Ordinary commands stay
  rejected while the data does not verify.
- **Oracle rebuild.** The migration oracle no longer trusts a stale derived cache. When the cached
  projection does not match the canonical event head, it rebuilds a disposable view by replaying the
  inspected, normalized canonical stream, and accepts that view only at the exact event head. You do
  not touch `.harness/cache/task.sqlite` by hand.
- **Provenance restatement.** `ha migrate rekey-facts` plans an in-place restatement for the exact
  legacy shape whose `payload.entity.provenance` key is absent: it adds
  `provenance: "imported_snapshot"` and normalizes an embedded legacy task body at the same time.
  Every other invalid shape keeps its typed rejection.

Nothing here relaxes validation. The restated bytes must still pass the same strict canonical-event
serialization as any other write; the recovery only supplies the field today's contract requires and
yesterday's writer omitted.

## How recovery admission behaves

One recovery at a time, per repository, through one queue:

- The first recovery command claims the repository's recovery ingress and then joins the existing
  single-writer queue. A second recovery command arriving while the first is still settling is
  rejected with `recovery_conflict` and names the command to wait for.
- A dry-run publishes nothing and does not clear the latch. Only an apply does.
- Recovery is the only way in. An edge node or a direct file write cannot open an unavailable
  ledger; there is no second admission mechanism to find or invent.

## Before you start

1. **Run every command from the repository's registered root**, so the daemon resolves the right
   repository. For multi-repository routing see
   [operations-server-daemon.md](operations-server-daemon.md).
2. **Freeze the repository's other writers** — other agents, GUI sessions, scheduled jobs. The
   recovery command runs through the daemon's single-writer queue, so it does not need the daemon
   stopped; it does need nothing else writing to that ledger.
3. **Commit the cut.** The ledger must be a completely committed snapshot. The recovery and the
   importer both refuse an uncommitted source, and that refusal is correct: an uncommitted cut
   cannot be verified or replayed.
4. **Back up the ledger.** Tag the ledger's own nested git repository, not the outer project
   repository:

   ```bash
   git -C <project-root>/harness tag backup/pre-migrate-<name>-<yyyymmdd>
   git -C <project-root>/harness rev-parse backup/pre-migrate-<name>-<yyyymmdd>
   ```

   The tag must resolve to the ledger repository's own `HEAD`. A tag attempted from an outer
   project-repository commit is rejected by git, because those objects do not exist in the nested
   ledger repository.

## The recovery, step by step

| Step | You run | Expected shape | Then |
| --- | --- | --- | --- |
| 1. Confirm the symptom | `ha task list` | `error code=repo_unavailable … Cause: <data-shape cause>`, exit 1 | If the cause is a data-shape defect, continue. |
| 2. Freeze writers, commit the cut | `git -C <project-root>/harness status --porcelain` | empty | Commit outstanding ledger edits first. |
| 3. Back up | `git -C <project-root>/harness tag …` | tag resolves to ledger `HEAD` | Keep the tag; do not delete it after success. |
| 4. Preview | `ha migrate rekey-facts --dry-run` | counts line, one row per restated event, marker line | Reconcile the counts (below). |
| 5. Apply | `ha migrate rekey-facts` | same counts and rows, marker line without the preview op | — |
| 6. Prove idempotency | `ha migrate rekey-facts --dry-run` | every count `0`, no rows | Done; nothing was left half-applied. |
| 7. Confirm re-attach | `ha task list` | task rows, no error | The repository is usable again. |

### 4. Preview the recovery plan

```bash
ha migrate rekey-facts --dry-run
```

```text
maps:
counts: rekeyedFacts=0  factEvents=0  producesEdges=0  retargetedRelations=0  rewrittenRelationEvents=0  rewrittenEmbeddedRelationEvents=0  rewrittenMigrationTaskEvents=<N>  rewrittenDecisionEvents=0  rewrittenTaskEvents=0  rewrittenAgentEvents=0  rewrittenSettingsEvents=0
migrationTaskProvenanceRestatements:
migration-<op-id>	events/<shard>/migration-<op-id>.json
… one row per restated event …
schema=fact-rekey-id-map/v1  markerOpId=op_<sha256>
```

Add `--json` for the same receipt as one machine-readable object.

### 5. Reconcile, then apply

Reconcile before you apply. Two checks, both mechanical:

- `rewrittenMigrationTaskEvents` is the number of legacy migration task events the recovery will
  restate. It must equal the number of `migrationTaskProvenanceRestatements` rows, and you should
  be able to account for it against your own history — how many tasks did that older migration
  import?
- Every other count is `0`. A non-zero count on another rewrite surface means the recovery is
  planning work this page does not describe. Stop and read that report before applying.

Then apply:

```bash
ha migrate rekey-facts
```

The apply prints the same counts and the same rows, and ends with the marker line
`schema=fact-rekey-id-map/v1` without the preview `markerOpId`. The restated events keep their
identity — same `eventId`, same `opId`, same revision — and change only the missing provenance key,
plus the normalization of an embedded legacy task body where one is present. The command then
rebuilds the projection from the repaired ledger.

If the ledger still uses the legacy `flat/v1` object layout, the apply receipt ends with an advisory
line naming `ha migrate ledger`. That is an observation about layout, not an error, and it does not
affect this recovery.

### 6. Prove idempotency

```bash
ha migrate rekey-facts --dry-run
```

```text
maps:
counts: rekeyedFacts=0  factEvents=0  producesEdges=0  retargetedRelations=0  rewrittenRelationEvents=0  rewrittenEmbeddedRelationEvents=0  rewrittenMigrationTaskEvents=0  rewrittenDecisionEvents=0  rewrittenTaskEvents=0  rewrittenAgentEvents=0  rewrittenSettingsEvents=0
schema=fact-rekey-id-map/v1
```

Every count is `0`, there are no restatement rows, and no preview marker. A second apply with the
same result is also safe: repeat apply is a no-op.

### 7. Confirm the repository re-attached

```bash
ha task list
```

Task rows come back and no error is printed. You did not run a re-attach command, and none exists:
the latch re-probes on the next command after the data verifies.

### If you also need to merge an external snapshot

The recovery above repairs the repository you are standing in. It does not merge anything in. If you
also have a second, external Harness repository to merge into this one, that is the genesis-replay
import path, and it now enters through the same recovery admission:

```bash
ha migrate import --source <path-to-other-repo>/harness --dry-run
ha migrate import --source <path-to-other-repo>/harness
```

The dry-run writes nothing and reconciles five active entity kinds — task / decision / fact /
relation / execution — against a same-cut or disposable rebuilt oracle. Read
[migration-genesis-replay.md](migration-genesis-replay.md) for the full procedure, the
`--resolve` conflict syntax, and the acceptance equality. Run the import dry-run first, every time.

## If something fails

| Report | What it means | Action |
| --- | --- | --- |
| `recovery_conflict` | Another recovery command already holds this repository's single-writer recovery ingress. | Wait for the command named in the hint to settle, then rerun. Do not open a second path in. |
| `publication_indeterminate` with a `git … update-ref …` hint | A commit was made outside the daemon, so the ledger branch no longer points at the last published event commit. | Run the `git -C … update-ref …` command exactly as printed — it moves only the branch pointer and leaves every file in place — then retry the recovery. The repository re-probes the repaired refs without restarting the daemon; if the first retry still reports the old latch, wait for `ha daemon status` to return to `ok` and retry again. |
| Source rejected as not completely committed | The ledger work tree has uncommitted changes. | Commit them (or park them), then rerun the dry-run. Do not migrate a dirty cut. |
| `migration_projection_oracle_cut_mismatch` | A stale derived projection does not match the canonical event head. | The oracle falls back to a disposable rebuild on its own. If the error persists, stop the source's writers and read the nested cause. Do not delete or move `.harness/cache/task.sqlite` by hand — a stale cache is rebuilt in place, and moving it away returns the same verdict. |
| A typed rejection other than the missing-provenance shape | The ledger contains an invalid event this recovery does not restate. | Keep the ledger, capture the named event and schema, and report it. Guessing a restatement for an undescribed shape is not a recovery. |
| Dry-run reports every count `0` before any apply, and `ha task list` still fails | The daemon predates the provenance-restatement branch, which skipped invalid events instead of planning their repair. | Upgrade the daemon to a build that carries the restatement, then rerun the dry-run. The count must be non-zero before the latch can clear. |
| `repo_unavailable` persisting after a clean idempotent dry-run | The latch cause was not the data-shape class this recovery settles. | Read the `Cause:` text again and follow the class-specific hint; see also [operations-server-daemon.md](operations-server-daemon.md). |

Two mistakes worth naming, because both look productive and neither is:

- Deleting or renaming the derived cache by hand does not help. A stale cache is rebuilt in place
  from the committed events; moving it away gets you a rebuilt cache and the same verdict.
- Editing the legacy event JSON by hand to add the missing field is not the same operation. The
  recovery restates events inside the single-writer queue, preserves identity, and re-validates the
  result. A hand edit outside that queue is exactly the outside-the-daemon commit that produces
  `publication_indeterminate`.

## FAQ

**Is my data at risk during this recovery?**
The recovery rewrites event files inside the daemon's single-writer queue, re-validates every
restated byte against the strict canonical-event contract, and rebuilds the projection from the
result. You tagged the ledger before starting, so the pre-recovery state is recoverable regardless.

**Why does the dry-run not fix anything?**
A dry-run publishes nothing and does not clear the latch. It exists so you can reconcile the plan —
which events, how many, and nothing else — before any byte changes.

**Do I need to stop the daemon?**
No. The recovery command runs through the daemon's single-writer queue; that queue is what makes the
rewrite safe. Stop the repository's *other* writers instead. A repaired `publication_indeterminate`
latch is re-probed by the resident daemon when you retry the command.

**My counts are not zero on the other surfaces. What do I do?**
Stop and read the report before applying. This page describes a recovery whose only planned work is
the provenance restatement; another non-zero count means a different plan, and it needs its own
understanding rather than a broader approval.

**Will the restated events look migrated?**
They already did. The restatement adds the `provenance` marker that says this task came in as an
imported snapshot; it does not change what happened, when it happened, or who did it.

**A command or flag I need isn't on this page.**
This page covers the recovery surface described above. Run `ha migrate --help` for the authoritative
command description.
