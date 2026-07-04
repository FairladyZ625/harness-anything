# Repository Governance

- Authored shared state lives under `harness/`.
- Generated local state lives under `.harness/` and must remain untracked.
- Kernel primitives: `task` is the work unit, `fact` is a task-local immutable observation in `facts.md`, and `decision` is the load-bearing why in `decisions/`.
- Use relation records to connect fact -> decision, decision -> task, and decision -> decision. Do not rely on prose-only ledgers for load-bearing links.
- Task identities use random `task_<ULID>` values; titles and slugs are display metadata.
