# How authored records live on disk

[The three-primitive kernel](../../learn/en/01-three-primitive-kernel.md) argues
that decision, task, and fact are the whole core, and that they store
asymmetrically — decisions centralized, tasks as containers, facts
independently. This page shows what that looks like as actual files: the
directories, the contract each file must carry, and the ID shapes the schemas
enforce.

Authored Markdown is the published document surface of accepted entities.
`packages/kernel/src/store/sqlite-task-event-store.ts` derives it from
canonical SQLite events and required objects. The paths below describe that
authored surface; the acceptance boundary is described in
[the write path](02-write-path.md).

## Directory layout

```text
  <repo root>/
  ├── decisions/                          centralized: the spine
  │   └── decision-dec_<id>/              one directory per decision
  │       └── decision.md                 frontmatter: decision-package/v1
  │
  ├── tasks/
  │   └── task_<24 hex>-<slug>/           one directory per task
  │       ├── INDEX.md                    frontmatter: task-package/v2
  │       ├── task-contract.json          machine-owned: task-contract/v1
  │       ├── task_plan.md                narrative: the plan
  │       ├── closeout.md                 narrative: wrap-up + submission source
  │       ├── executions/exe_<24 hex>.md  one immutable delivery round
  │       ├── reviews/rev_<id>.md         one immutable judgment round
  │       └── artifacts/                  dispatch and delivery artifacts
  │
  ├── facts/
  │   └── F-<Crockford-8>.md              one managed fact document per record
  │
  ├── sessions/
  │   └── <session-id>.md                 captured Session manifest
  │
  ├── entities/                           attached artifact entities
  │   └── architecture-decision-records/ADR-<id>.json
  │
  └── <local root>/store/generations/<generation>/
      ├── ledger.sqlite                   canonical event ledger
      └── objects/sha256/<2 hex>/<62 hex> content-addressed objects
```

The three primitives have distinct authored storage sites. **Decisions** live
together in a top-level `decisions/` directory — they are the one projection a
human is meant to watch, so they are kept in one place; each decision is its own
`decision-dec_<id>/` directory whose entity record is `decision.md`. **Tasks**
are containers: each task is its own `task_<24 hex>-<slug>/` directory holding
contract files and narrative documents. **Facts** have their own top-level
`facts/` directory, one document per `facts/F-<id>` record. A task-associated
fact also has one active `task/<id> -> fact/F-<id>` `produces` edge; standalone
facts simply have no such edge.

Canonical content objects live beside `ledger.sqlite`, under the active local
`store/generations/<generation>/objects/sha256/` directory.
`packages/kernel/src/store/sqlite-event-store.ts` verifies required content
claims and synchronizes object bytes and directory links before accepting the
referencing events. Authored object copies are publication output, not the
acceptance record.

## The execution chain

An Execution is one delivery round under a task: `executions/exe_<id>.md`,
schema `execution/v1`, carrying `actor`, `sessionBindings`, and a `submission`.
It is not assembled from CLI flags — `ha task submit` takes no submission
packet arguments. Instead the daemon **derives** the Submission from the
task package's realized `closeout.md`
(`packages/daemon/src/repo-cell-submit.ts`). The closeout Summary must name
one delivery commit, or at least one `artifact:path@revision` anchor;
`deliverables` come from that commit's `git diff`, `outputs` records deleted
paths and artifact anchors, and `artifacts`/`commitSha` are settled alongside.
The resulting packet has six fields: `completionClaim`, `deliverables`,
`outputs`, `verificationNotes`, `knownGaps`, and `residualRisks`. Derivation
failures reject as `closeout_placeholder` or `invalid_submission`; a changed
submitted cut requires an explicit `ha task submit --amend`.

A Review is a separate immutable file for one submitted Execution, schema
`review/v1` (`packages/kernel/src/domain/review.ts`): `verdict` is one of
`approved`, `changes_requested`, `dismissed`, with a non-empty `reason` and
`evidenceChecked[]`, bound to that round by `submissionDigest`.
`review-consent/v1` then pins consent to the same review and submission digest
(`ha task review-consent`).

## The decision file

A decision document carries frontmatter validated against `decision-package/v1`
(`packages/kernel/src/domain/decision-event-document.ts`). The load-bearing
fields:

| Field | What it holds |
|---|---|
| `decision_id` | stable ID, pattern `dec_...` |
| `title` | the choice, in one line |
| `state` | `proposed`, `in_effect`, `rejected`, `deferred`, `superseded`, `outcome_retired` |
| `riskTier` | `low` / `medium` / `high` |
| `urgency` | `low` / `medium` / `high` |
| `vertical`, `preset` | which domain and preset it belongs to |
| `decisionClass` | `ordinary` or `standing_policy` |
| `applies_to` | `{ modules[], productLines[] }` — its scope |
| `workspaceRevision` | the canonical revision at judgment time |
| `proposer`, `arbiter` | the raising and deciding actors, each a `{ principal, executor }` identity |
| `proposedAt`, `decidedAt` | proposal and judgment timestamps |
| `question` | what is being decided |
| `chosen[]` | the option(s) taken (each `{ id, text, rationale }`) |
| `rejected[]` | options not taken, each carrying a `whyNot` |
| `claims[]` | load-bearing assertions, each `{ id, text, loadBearing, fulfillment }` |
| `relations[]` | typed edges to other entities |
| `judgmentConsents[]` | consent records pinned to specific content pins |
| `provenance[]` | exactly one session identity binding it to the run that produced it |

**Actor identity and the arbiter role.** `proposer` and `arbiter` are both
`ActorIdentity` values — a `principal` (the person) plus an optional `executor`
(the acting agent). Decision outcome actions bind an arbiter role at the action
layer: an agent cannot judge its own proposal
(`packages/kernel/src/domain/entity-field-contracts.ts`). A judgment is not
just a field write — `decision-judgment-consent/v1` records consent pinned to
a specific `decision-content-pin/v1`.

Accepted operations are identified by their SQLite command outcomes and event
intervals; see `packages/kernel/src/store/sqlite-event-store.ts` and
[the write path](02-write-path.md).

## The task package

A task is a directory, `task_<24 hex>-<slug>/`. Inside, `INDEX.md` is the
entity record, with frontmatter validated against `task-package/v2`:

| Field | What it holds |
|---|---|
| `task_id` | the task's stable id |
| `title` | what the task is |
| `lifecycle` | the lifecycle binding `{ engine: kernel/task-lifecycle/v1, status }` |
| `packageDisposition` | the package's disposition state |
| `workKind` | the work kind (docs, code, ...) |
| `riskTier`, `urgency` | risk and urgency |
| `vertical`, `preset`, `profile` | domain, preset, and profile |
| `packagePath` | the package's path in the repository |
| `owner` | the owner of `INDEX.md` itself (`machine`) |

The task's `status` lives inside its `lifecycle` binding, and it is a real
state machine — a task moves through `planned`, `active`, `blocked`,
`in_review`, `done`, and `cancelled`. `task-contract.json`
(`task-contract/v1`) is the machine-owned contract: task class,
vertical/preset/profile, `presetSnapshotDigest`, scaffold digests,
`completionGates`, and each document's slot and owner (`machine` or
`doc-sync`). The `## Documents` section of `INDEX.md` lists those owners one by
one: machine-owned files are rewritten by the daemon, while `doc-sync`-owned
narrative documents (`task_plan.md`, `closeout.md`, ...) flow through
`ha doc status` / `ha doc sync --submit`. Task state comes from canonical
events; `packages/kernel/src/store/sqlite-task-event-store.ts` publishes their
document view to `INDEX.md`.

## Fact documents

A fact is recorded as a `facts/F-<id>.md` managed document — not a frontmatter
file, but a `# Facts` document maintained by `ha fact record`, with one record
section per fact under `## Records`. The fields:

| Field | What it holds |
|---|---|
| `F-<id>` | pattern `F-` + 8 Crockford base32 characters |
| `Statement` | the observation itself |
| `Evidence source` | where the observation came from |
| `Observed at` | when it was observed |
| `Confidence` | `low` / `medium` / `high` |
| `State` | `standing` or `superseded_fact` |
| `Task` | optional owning task |

The document prints only what recall needs; the full event payload
(`fact-event/v1`, `packages/kernel/src/domain/fact-event.ts`) also carries
`memoryClass`, `memoryTags`, optional `taskId` and `domainTypes`, and the
`supersedes: { factRef, rationale }` that marks an older record
`superseded_fact`.

**Facts are append-only.** A fact is created by `ha fact record`; a correction
appends a new record carrying `supersedes` rather than editing the old one.
That is why a fact can be trusted as evidence: the statement you read is the
statement that was recorded, next to the source that says under what conditions
it was observed.

Append-only does not mean every duplicate append is an error. When a fact
append replays a record whose `fact_id` already exists, the store compares the
formatted record bytes. If the existing record and the incoming record are
byte-for-byte the same, the append is an idempotent no-op and the file body is
left unchanged. If the id matches but the bytes differ, the write is still
rejected as a duplicate fact id.

## The common thread: attribution

The three primitives attribute differently, but none permits an anonymous
write. A decision's frontmatter carries `provenance[]` — exactly one
`SessionProvenanceV1`: `runtime` (the name of the producing runtime),
`sessionId`, `transcriptReachability`, and `boundAt`
(`packages/kernel/src/domain/agent-runtime.ts`). A task package's ownership is
carried by `task-contract.json` and its document-owner declarations; a fact
carries `Evidence source` and `Observed at`. And underneath all three, every
canonical event envelope carries `actor` (`principal` + `executor`) and
`source` — every record on disk can answer "who or what wrote this, and when."
The full story is in
[06 · Provenance, verdicts, and the event ledger](06-provenance-and-events.md).

The next question is what happens when one of these files is written — how a
record actually reaches disk safely and attributably. That is
[02 · The single write path](02-write-path.md).
