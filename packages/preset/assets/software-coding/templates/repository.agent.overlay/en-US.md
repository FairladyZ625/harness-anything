## Harness CLI (software/coding)

- Use `ha <command>` or `npx harness-anything <command>` and inspect command help before composing writes.
- Create task packages with `ha task create --title "<title>"`; do not hand-scaffold task directories.
- Select from the effective catalog with `ha preset list`. Packages reported unavailable must not be used to publish guidance or create a task.
- Milestone creation requires an explicit `--task-class milestone`; the preset ID does not infer task class.

## Repository Scaffolds

- Context lives under `harness/context/`.
- Standards live only under `harness/governance/standards/`.
- ADR projections live under `harness/adr/`, milestone documents under `harness/milestones/`, and canonical decision packages under `harness/decisions/`.
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
