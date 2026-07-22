# Repository Governance

- Authored shared state lives under `harness/`.
- Generated local state lives under `.harness/` and must remain untracked.
- Kernel primitives: `task` is the work unit, `fact` is a task-local immutable observation in `facts.md`, and `decision` is the load-bearing why in `decisions/`.
- Use relation records to connect fact -> decision, decision -> task, and decision -> decision. Do not rely on prose-only ledgers for load-bearing links.
- Task identities use random `task_<ULID>` values; titles and slugs are display metadata.
- Public implementation work, including small docs/template PRs, starts from latest `origin/main` in `.worktrees/<slug>` on a `codex/<slug>` branch. Treat the shared repository root as coordinator-only; do not edit public source, docs, or root config there.
- Background/parallel workers must use their own `.worktrees/<slug>` checkout and leave coordinator-owned global state to the coordinator through handoff notes and evidence.
- In a repository that provides the corresponding surfaces, package adjacency is governed by `tools/package-boundaries.json` and `harness:check-package-boundaries`: new forbidden edges fail, existing debt may only decrease, deep-subpath consumers are sunset-ratcheted, and source-path strings are real edges. Full-root direct-write ownership is governed once by `tools/write-road-registry.json` and `harness:check-write-road-registry`; do not add a second duplicate bypass inventory.
