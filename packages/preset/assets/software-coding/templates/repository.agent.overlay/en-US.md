## Harness CLI (software/coding)

- Use `ha <command>` or `npx harness-anything <command>` and inspect command help before composing writes.
- Create task packages with `ha task create --title "<title>"`; do not hand-scaffold task directories, and replace every required `task_plan.md` placeholder before dispatch or `runtime run` rejects it with `plan_placeholder`.
- Select from the effective catalog with `ha preset list`. Packages reported unavailable must not be used to publish guidance or create a task.
- Milestone creation requires an explicit `--task-class milestone`; the preset ID does not infer task class.
- Both `--opt value` and `--opt=value` are accepted for value options; an unsupported option is rejected with `unknown_field`.
- `runtime run --mission` takes a synced mission name, not a file path; submit the mission with `ha doc sync --submit` first or dispatch rejects it with `mission_not_found`.
- Closeout order is start → submit → independent `review-execution` → `review-consent` → complete; an out-of-order lifecycle action is `invalid_transition`, and self-review is `actor_unauthorized`.
- `ha task complete --path` resolves paths from the project repository root and rejects paths absent from the submitted commit with `invalid_proof`.
- Before completion, replace `closeout.md` with the exact sections `## Summary`, `## Verification`, `## Residual Risk`, and `## Same Mechanism Elsewhere`, or completion rejects it with `closeout_placeholder`.

## Repository Scaffolds

- Context lives under `harness/context/`.
- Standards live only under `harness/governance/standards/`.
- Artifact source documents are located through generic entity descriptors; milestone documents and canonical decision packages remain under the configured authored root.
- Read each folder's README instead of duplicating its rules here.

## Architecture-aware Changes

- Before broad source search, check for `harness/context/architecture/architecture-manifest.json`.
- If present, read the architecture README and only the relevant stable view or flow before choosing an implementation layer.
- If absent, architecture remains opt-in and ordinary coding work continues without a fabricated model.

## Governance Routing

- Repository workflow and preservation: `harness/governance/standards/repository-governance.md`.
- Decision writing: `harness/governance/standards/decision-writing.md`.
- Load only standards applicable to the current task.

## Script Discovery

- Use `ha script list` and `ha script inspect <id>` to inspect vertical script declarations.
- A declaration is not proof of execution support. Run a script only when inspection explicitly reports execution as available.
