# Persisted format migrations

A persisted format change ships its explicit conversion and frozen historical sample tests in the same change. Tests must demonstrate rejection with an actionable command, conversion, then use through the current reader and writer. Runtime readers never translate retired formats.

| Persisted data | Conversion boundary |
| --- | --- |
| Generation 1/2 ledger, historical task snapshots | `ha migrate ledger --help`: backup, dry-run, isolated conversion, verification, activation; preserve the source and report unsupported history. |
| Repository vertical declaration or installed vertical resource | `ha migrate completion --source <file> --mode dry-run`, then `--mode convert --destination <new-file>`. Review the candidate; repository declarations require acceptance through `ha doc sync --submit --path harness/vertical.json` and a reopen. |
| Installed preset object and active pin | Read the digest from `presets/active/<id>.json`; use `ha migrate completion --source <presets/preset-objects/digest> --mode dry-run`, then `--mode convert --destination <new-directory>`. Review the candidate and run `ha --root <repository> preset install --source <candidate-directory>`. The center repository writer queues installation and moves the pin; the original object remains untouched. |
| Authored settings and historical settings events | A format change must include its own explicit conversion through the settings acceptance boundary; historical events belong to ledger conversion. No settings format changes here. |
| Local settings | Convert the external file explicitly when its format changes; no generic conversion or automatic defaults. |
| Derived SQLite projections and replica state | Rebuild from continuous accepted history using the existing generation/schema invalidation path. Preserve future-version and history-gap failures. |

The completion converter recognizes the retired `software-coding-standard` vertical declaration and `standard` / `software-coding-standard` preset profiles. It preserves explicit completion declarations and unrelated content. Custom checker profiles require an explicit mapping and are rejected. Missing completion on an unrecognized vertical is rejected. A preset manifest does not require its own completion override.

Declaration conversion writes a new file and never overwrites the input or accepted history. Copy the reviewed repository candidate to `harness/vertical.json`, submit it with the command above, and reopen before continuing writes. Offline conversion never activates a pin. Concurrent edge installation requests use the same center RepoCell write queue; edges are not independent preset writers. The candidate must be accessible to the center installer. Updating a preset pin affects subsequent resolutions, not frozen task snapshots. A repository whose historical ledger cannot open must use the ledger conversion path; an online document append is not evidence of historical replay.

Historical samples live in `packages/preset/fixtures/completion-migration/`. Guidance tests and isolated integration tests cover the old decoder failure, explicit CLI migration, active catalog/resolution, preserved source bytes, idempotence, rejected unknown formats, and repository acceptance/reopen. They run through the existing tier manifest; no additional CI gate or compatibility reader is introduced.
