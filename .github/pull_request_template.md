# English

## Summary

## What Changed

<!-- Persisted format changes ship an explicit `ha migrate` conversion and a frozen old-sample rejection → migration → current-reader test in the same PR; see `docs-release/data-format-migrations.md`. -->

-

<!-- After task submit, generate this block with `node tools/gates/render-task-pr-body.mjs --task <task-id>`. -->
<!-- harness:submission-facts:start -->
<!-- harness:submission-facts:end -->

## Machine-Readable Declarations

<!-- These declarations are checked by jobs in `.github/workflows/pr-body.yml`; `tools/gate-manifest.json` is the authority for their workflow mapping. -->
<!-- Keep every uncommented keyword and its value on the same line, flush left, exactly once, without a Markdown list marker. -->
<!-- Required only when any package.json or package-lock.json changes: replace the rejected `none` sentinel with a complete deterministic description; otherwise delete the entire next line. -->

Dependency-Change: none

<!-- Required only when packages/kernel/fixtures/canonical-events/**/accepted*.json changes. Name one command from `ha migrate --help`, or explain in one sentence why the refresh does not require a migration. -->
<!-- Event-Migration: ha migrate <name> -->
<!-- Event-Migration: none — <why no event migration is required> -->

### Optional Evidence Claims

<!-- Evidence claims are checked by the `evidence-contract` job in `.github/workflows/pr-body.yml`. No claim means N/A. -->
<!-- Keep every uncommented claim keyword, field, and value on the same line. Remove the comment markers from one complete block only when making that claim. -->
<!-- `Evidence-Type: ci` may replace `CI-Attribution: ...`; `Evidence-Type: performance` may replace `Performance-Claim: ...`. -->
<!-- CI-Attribution: <what this CI run proves> -->
<!-- run-url: https://github.com/<owner>/<repo>/actions/runs/<run-id> -->
<!-- commit-sha: <full 40-character SHA> -->
<!-- failed-test: <test name, or none if no test failed> -->
<!-- scope: <evidence scope> -->
<!-- owner: <responsible owner> -->
<!-- Performance-Claim: <what this paired performance evidence proves> -->
<!-- run-url: https://github.com/<owner>/<repo>/actions/runs/<run-id> -->
<!-- commit-sha: <full 40-character SHA> -->
<!-- failed-test: <test name, or none if no test failed> -->
<!-- scope: <performance scope> -->
<!-- owner: <responsible owner> -->
<!-- fixture: <fixture name> -->
<!-- phase: <measured phase> -->
<!-- baseline: <full 40-character SHA or HTTPS evidence URL> -->

<!-- The task renderer owns and rewrites Governance Declaration / 治理声明 from ledger authorization on every render; it removes the section when no protected surface is touched. -->
<!-- Human supplements and emergency declarations belong in a separate ## Governance Exception / ## 治理例外 section. The renderer preserves that section verbatim. -->
<!-- For an emergency, record Break-glass: yes, Break-glass reason, Break-glass scope, and Follow-up governance task in the manual section. -->

## Governance Declaration

- Protected surface touched: no
- Protected surface scope:
- Authority: not applicable
- Machine-check boundary: this PR only asserts the declaration exists; reviewers decide whether it is true and sufficient.

## Verification

- Public diff command:
- Private evidence commit/path:
- Commands recorded below ran exactly as written; anything not run is listed with a reason.
- Not run: none

## Residual Risk

-
