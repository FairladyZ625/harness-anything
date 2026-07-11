# How authored records live on disk

[The three-primitive kernel](../../learn/en/01-three-primitive-kernel.md) argues
that decision, task, and fact are the whole core, and that they store
asymmetrically — decisions centralized, tasks as containers, facts embedded. This
page shows what that looks like as actual files: the directories, the frontmatter
each file must carry, and the ID shapes the schemas enforce.

Every entity is the same physical thing: a plain Markdown file with a YAML
frontmatter block on top. The frontmatter is not decoration — it is validated
against a schema in `packages/kernel/src/schemas/` before the file is accepted,
so the fields below are contracts, not conventions.

## Directory layout

```text
  <repo root>/
  ├── decisions/                        centralized: the spine
  │   ├── <a decision doc>.md
  │   └── <another decision doc>.md
  │
  ├── objects/
  │   └── sha256/<2 hex>/<62 hex>        content-addressed blobs
  │
  └── <tasks root>/
      └── task_<ULID>-<slug>/           one directory per task
          ├── INDEX.md                  frontmatter: task-package/v2
          ├── task_plan.md              narrative: the plan
          ├── progress.md               narrative: how far
          ├── review.md                 narrative: judgment
          ├── closeout.md               narrative: the wrap-up
          ├── facts.md                  the local fact ledger
          ├── executions/exe_<ULID>.md  one immutable delivery round
          └── reviews/rev_<ULID>.md     one immutable judgment round

  <sessions root>/
  └── <session-id>.md                   captured Session manifest
```

Three primitives, but only two storage sites. **Decisions** live together in a
top-level `decisions/` directory — they are the one projection a human is meant to
watch, so they are kept in one place. **Tasks** are containers: each task is its
own directory named `task_<ULID>-<slug>/`, holding a small set of files. **Facts**
have no directory of their own at all — they are recorded inside the `facts.md`
ledger of the task that produced them. A fact never migrates out; if it matters
elsewhere, a decision references it in place.

The `objects/sha256/` tree is different from those authored Markdown surfaces. It
is the content-addressed blob store. A blob is addressed by its SHA-256 digest and
stored as `objects/sha256/<first-two-hex>/<remaining-hex>`, with a descriptor
carrying `ref`, `sha256`, `size`, and `mediaType`. Session exports use this as a
claim-check: the session body is written to the blob store first, then the journal
payload carries a `bodyRef` and the flush materializes the authored session
document from that verified blob. In v0 this store has no garbage collection and
no chunking; large or obsolete blobs remain whole files until a later storage
version defines a collection policy.

## The execution chain

Each valid claim creates a new authored Execution under its Task. The Execution
owns Session bindings, `OutputEvidence` value objects, and—once submitted—a
six-field packet: `completion_claim`, `deliverables`, `evidence_refs`,
`verification_notes`, `known_gaps`, and `residual_risks`. Only the claim must be
non-empty; every array may be empty, so text-only delivery and zero Evidence are
valid (dec_mrg3z1we/CH1; ADR-0027 D1, D3).

`OutputEvidence` is not another Entity or a closed list of semantic media
types. It is owned by its Execution and locates content through exactly one of
five substrates: inline, repository-relative file, parseable URL, authored CAS
object, or registry entity reference. Reviews are separate immutable files for
one submitted Execution; `review/v2` records `evidence_checked`, findings,
verdict, and non-empty rationale (dec_mrg3z1we/CH2-CH4; ADR-0027 D5-D6).

## The decision file

A decision document carries frontmatter validated against `decision-package/v1`
(`packages/kernel/src/schemas/decision-package.ts`). The load-bearing fields:

| Field | What it holds |
|---|---|
| `decision_id` | stable ID, pattern `dec_...` |
| `title` | the choice, in one line |
| `state` | `proposed → accepted → active → retired / rejected / deferred` |
| `riskTier` | `low` / `medium` / `high` |
| `urgency` | `low` / `medium` / `high` |
| `vertical`, `preset` | which domain and profile it belongs to |
| `applies_to` | `{ modules[], productLines[] }` — its scope |
| `proposedBy` | the actor who raised it |
| `arbiter` | the actor who decides it |
| `question` | what is being decided |
| `chosen[]` | the option(s) taken (each an anchored `{ id, text }`) |
| `rejected[]` | options not taken, each carrying a `why_not` |
| `claims[]` | the load-bearing assertions the choice rests on |
| `relations[]` | typed edges to other entities |
| `provenance[]` | at least one entry binding it to what produced it |

Two of these deserve a closer look.

**The integrity rule on `proposedBy` and `arbiter`.** The schema does not merely
type these two fields; it filters the whole record. A decision whose `proposedBy`
equals its `arbiter` — same kind and same id — is *rejected*. You cannot arbitrate
your own proposal. This is enforced at the schema level, so a malformed decision
of this shape never reaches disk in the first place.

**The `_coordinatorWatermark`.** A decision also carries an optional
`_coordinatorWatermark` field. You do not write this by hand; the single write
path stamps it when the record passes through. Its presence is the mark that a
write went through the one door rather than around it — the mechanics are the
subject of [02 · The single write path](02-write-path.md).

## The task package

A task is a directory, `task_<ULID>-<slug>/`. The ULID makes the id sortable and
unique; the slug makes the directory readable. Inside, `INDEX.md` is the entity
record, with frontmatter validated against `task-package/v2`:

| Field | What it holds |
|---|---|
| `task_id` | the task's stable id |
| `title` | what the task is |
| `lifecycle` | the lifecycle binding — carries the task's `status` |
| `vertical`, `preset` | which domain and profile it belongs to |
| `provenance[]` | at least one entry binding it to what produced it |

The task's `status` lives inside its `lifecycle` binding, and it is a real state
machine — a task moves through states like planned, active, blocked, in-review,
done, and cancelled rather than being a free-form note. The other files in the
directory are the narrative around that state: `task_plan.md` is the plan,
`progress.md` is how far it has gotten, `review.md` is the judgment on its output,
and `closeout.md` is the wrap-up. None of these are the source of truth for the
task's state — `INDEX.md`'s frontmatter is.

## The fact ledger

Facts are recorded in the task's `facts.md`, each validated against
`fact-record/v1` (`packages/kernel/src/schemas/fact-record.ts`):

| Field | What it holds |
|---|---|
| `fact_id` | pattern `F-` + 8 Crockford base32 characters |
| `statement` | the observation itself |
| `source` | where the observation came from |
| `observedAt` | when it was observed |
| `confidence` | `low` / `medium` / `high` |
| `memoryClass` | how the fact is classified for recall |
| `memoryTags[]` | tags for retrieval |
| `provenance[]` | at least one entry binding it to what produced it |

The `F-` id pattern is `F-` followed by exactly eight Crockford base32 characters
(the digits and uppercase letters, excluding the ambiguous `I`, `L`, `O`, `U`) —
short, unambiguous, and copy-safe.

**Facts are append-only.** A fact has exactly two authoring actions: *record* and
*invalidate*. There is no edit. Once written, a fact is frozen — if the world
changes, you record a new fact and, if the old one is now wrong, invalidate it;
you never rewrite the original. This is why a fact can be trusted as evidence: the
statement you read is the statement that was recorded, unaltered, next to the
provenance that says under what conditions it was observed.

Append-only does not mean every duplicate append is an error. When a fact append
replays a record whose `fact_id` already exists, the store compares the formatted
record bytes. If the existing record and the incoming record are byte-for-byte the
same, the append is an idempotent no-op and the file body is left unchanged. If
the id matches but the bytes differ, the write is still rejected as a duplicate
fact id.

## The common thread: provenance

Every one of the three entities carries a `provenance[]` array with at least one
entry. A provenance entry binds the record to the runtime and session that
produced it — it is what lets any file, read cold months later, still answer "who
or what created this, and when." Decisions, tasks, and facts differ in almost
every other way; on this they are identical. The full story of provenance and how
it is backfilled is in
[06 · Provenance, verdicts, and the event ledger](06-provenance-and-events.md).

The next question is what happens when one of these files is written — how a
record actually reaches disk safely and attributably. That is
[02 · The single write path](02-write-path.md).
