# Behavior Corpus Classification

KR-10 does not introduce a legacy compatibility layer. The old implementation is
only a behavior corpus and negative evidence source. Any future migration intake
must create an explicit assisted report instead of changing the default runtime
or package API.

Machine-checkable source: `behavior-corpus-classification.json`.

| Classification | Count | Notes |
| --- | ---: | --- |
| preserve | 0 | No old behavior has been selected for preservation in this cutover slice. |
| intentional-change | 2 | Package name and workspace CLI bin use `harness-anything`; old package/API names are not preserved. |
| old-bug | 0 | No old bug classification was needed for this cutover slice. |
| unsupported-input | 1 | Old task schema/API compatibility is unsupported by design. |
| needs-decision | 0 | No unclassified behavior differences remain. |

## Cutover Evidence Notes

- Default package identity is `harness-anything`.
- CLI package identity is `@harness-anything/cli`.
- The default CLI package artifact bin is `harness-anything`; external npm publish is intentionally out of scope.
- Retired old runtime paths are blocked by `harness:check-cutover-readiness`.
- Package artifact executability is verified by `harness:smoke-cli-package`, which builds, packs, installs into a temporary consumer, and runs `harness-anything --json gui` with GUI dry-run enabled.
