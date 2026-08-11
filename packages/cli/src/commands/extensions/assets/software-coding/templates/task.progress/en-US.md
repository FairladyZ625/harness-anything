# Progress

Record delivery progress when submitting the active Execution with repeatable `ha task submit <task-id> --execution-id <execution-id> --lease-credential <saved-credential> --claim "..." --commit-sha <sha> --deliverable "..." --evidence-ref <ref> --verification "..."` inputs. There is no standalone task-progress write command. Load-bearing observations must still be promoted with `ha fact record --task <task-id> ...`.

## Log

- Record key implementation steps, verification results, and blockers.

## Evidence

| ID | Type | Evidence | Status |
| --- | --- | --- | --- |
