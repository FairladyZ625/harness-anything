# Behavior Corpus Classification

M2 final cutover uses this report as a behavior corpus and negative evidence
source. Migration intake is represented by explicit evidence files and
`migrate-verify --full-cutover`, while the default package and CLI surface stay
on the Harness-Anything implementation.

Machine-checkable source: `behavior-corpus-classification.json`.

| Classification | Count | Notes |
| --- | ---: | --- |
| preserve | 0 | No old behavior has been selected for preservation in this cutover slice. |
| intentional-change | 2 | Package name and workspace CLI bin use `harness-anything`; old package/API names are not preserved. |
| old-bug | 0 | No old bug classification was needed for this cutover slice. |
| unsupported-input | 1 | Prior task files require explicit migration evidence. |
| needs-decision | 0 | No unclassified behavior differences remain. |

## Cutover Evidence Notes

- Default package identity is `harness-anything`.
- CLI package identity is `@harness-anything/cli`.
- The default CLI package artifact bin is `harness-anything`; external npm publish is intentionally out of scope.
- Retired old runtime paths are blocked by `harness:check-cutover-readiness`.
- Full cutover verification is active through `migrate-verify --full-cutover`.
- Package artifact executability is verified by `harness:smoke-cli-package`, which builds, packs, installs into a temporary consumer, and runs `harness-anything --json gui` with GUI dry-run enabled.
