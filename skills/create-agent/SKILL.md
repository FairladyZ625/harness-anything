---
name: create-agent
description: Create or update a Harness Anything business Agent — a declared identity with its own instructions, prompts, skills, role, preset, runtime targets, and permission mode — instead of only naming a model. Use when a user asks to create an agent, define a new worker/commander/reviewer, give an agent its own job, or split one generic agent into business-specific ones.
---

# Create an Agent

An Agent is an **entity with a declaration**, not a model name. The model is one field. What makes
it an Agent for a business is the rest of the declaration: what it is responsible for, what it reads,
how it decides, which skills specialize it, which preset shapes its tasks, and where it must stop.

Read the current contract before writing anything:

```bash
ha agent --help
ha agent inspect <existing-id>        # a real declaration, including instructions and runtime targets
ha agent list                         # every installed identity with role, preset and status
```

`packages/kernel/src/domain/agent-squad-schema.ts` (`agent-declaration/v1`) is the schema authority.
Do not copy a declaration shape from documentation; copy it from the live `--help` output and a
working declaration.

## Decide the job before the fields

Answer these five before writing JSON. If any answer is "it depends", the split is wrong.

1. **Business result.** What outcome exists only because this Agent exists? Not "implements tasks" —
   every worker does that.
2. **Decision authority.** Which calls does it make alone, which does it escalate, and to whom?
   This becomes `role` plus the stop conditions in `instructions`.
3. **Read scope.** Which sources must it open to be right, and which are noise? Named paths become
   `skills`, read-set lines and prompts.
4. **Done evidence.** What proves its work is done? This must match the completion gates its
   `preset` will apply, or it will declare completion it cannot evidence.
5. **Failure shape.** What does it do when a premise is false, a tool is denied, or evidence is
   missing? "Ask the user" is not available in unattended dispatch; the answer belongs in
   `instructions` as a concrete action plus what it reports.

Then check whether the Agent should exist at all: if the only difference from an existing Agent is
the model, do not create it — select the model on the existing Agent's runtime target
(`runtimes[].model`). Two identities with the same instructions and different models are a model
matrix entry, not two Agents.

## Declaration fields and what each one really does

| Field | Effect | Write it as |
| --- | --- | --- |
| `id` | Stable identity; appears in dispatch provenance and task records | lowercase entity slug; never renamed to rebrand, use `retire --successor` |
| `name` | Display label | business name, not a model name |
| `instructions` | Injected first, exactly as written, on every dispatch | the job, the authority boundary, the stop conditions, the output contract |
| `role` | Selects the role baseline prompt (`worker` / `commander` / `reviewer`) | the actual discipline, not aspiration |
| `runtimes` | Runtime kinds this Agent may run on, each with an optional `model` and `effort` | at least one installed kind; empty means any compatible kind |
| `instance` | Node-local runtime instance pin | omit unless the Agent must run on one specific instance |
| `permissionMode` | Unattended sandbox default; `read-only` also enables attach to a frozen submitted cut | `workspace-write` by default; `read-only` for reviewers and analysts |
| `skills` | Skill directories resolved at spawn; a missing path fails the dispatch | project-relative paths to directories containing `SKILL.md` |
| `prompts` | Extra prompt blocks appended after the role baseline | recurring read-sets and per-dispatch conventions, not the job |
| `preset` | Task-shaping preset this Agent's tasks start from | a preset that exists on the target repository |

Two constraints that bite:

- **`skills[].path` is resolved on the serving node, not at authoring time.** A path that exists in
  your checkout but not on the node fails the dispatch with `agent_skill_not_found`.
  `ha agent validate --source <file>` resolves the same paths before install; run it.
- **`instructions` is injected verbatim on every dispatch.** Length is a per-dispatch tax. Put
  durable judgment here, put reference detail in a skill, put per-task facts in the task plan.

## Authoring loop

```bash
# 1. Write the declaration where the repository keeps its agents (harness/agents/<id>.json here).
#    Start from a working declaration, not from a schema sketch.
ha agent inspect <closest-existing-agent>

# 2. Validate before install: schema, runtime targets available on this node, skill paths resolve.
ha agent validate --source harness/agents/<id>.json

# 3. Preview, then install. --expected-version guards an update against a concurrent edit.
ha agent install --source harness/agents/<id>.json --dry-run
ha agent install --source harness/agents/<id>.json
ha agent install --source harness/agents/<id>.json --expected-version <n>

# 4. Prove it dispatches: a dry-run spawn assembles the real prompt without starting a runtime.
ha agent run <id> --task <task-id> --dry-run
```

`--dry-run` on `agent run` is the cheapest proof that the declaration composes: it shows the
identity prefix, instructions, role baseline, prompts, preset, resolved skill paths, and mission in
the order the runtime would receive them. Read it; a declaration that validates can still assemble a
prompt with the wrong emphasis.

## Leave an iteration path

Give the Agent a way to improve itself instead of freezing the first draft:

- Mount `self-iteration` in `skills` when the Agent should propose changes to its own declaration
  after a delivery. Without it, an unattended Agent has no channel to report that its instructions
  are wrong except a running commentary the owner never reads.
- Keep `instructions` about judgment and `skills` about procedure, so a later proposal can change
  one without rewriting the other.
- Do not paste a second copy of a skill's rules into `instructions`. Two sources drift, and the
  Agent will follow the wrong one.

## Updating, retiring, and what not to do

```bash
ha agent inspect <id>                                   # current declaration + expected-version
ha agent install --source <file> --expected-version <n> # update in place
ha agent retire <id> --reason "<why>" --successor <id>  # keep history and deep links
ha agent delete <id> --reason "<why>" --expected-version <n>
```

- **Never hand-edit the installed declaration store.** Updates go through `ha agent install`, which
  writes through the center single-write path and records a version. A hand edit has no version and
  no rollback.
- **Never copy another Agent's declaration and change one field.** You inherit stop conditions and
  read scope that do not belong to the new job. Start from the job, then borrow the specific lines.
- **Do not create an Agent to hold a permission.** Permissions come from the runtime and the task
  lease, not from an identity.
- **Do not create an Agent per task.** If the identity would be used once, it is a task, not an
  Agent.

## Output contract

Report: the declaration path, the five job answers in one line each, `ha agent validate` result,
`ha agent install` receipt (version), the `--dry-run` prompt's section order, and any field left at
its default with the reason.
