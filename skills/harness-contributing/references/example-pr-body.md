# English

## Summary

Document the repository's contribution workflow through one public skill and
make the public entry pages point to that authority (#1234).

## What Changed

- Added a public contribution skill and replaced duplicated procedural prose
  with links to that skill.

## Machine-Readable Declarations

### Optional Evidence Claims

- None. This example makes no CI-attribution or performance claim.

## Governance Declaration

- Protected surface touched: no
- Protected surface scope: not applicable
- Authority: not applicable
- Machine-check boundary: the declaration exists; reviewers decide whether it is sufficient.
- Break-glass: no

## Verification

- Delivery and base anchors: read from the frozen submission record (the execution `Commit` field via `ha task show <task-id> --json`); not hand-copied into this body.
- Public diff command: `git diff --stat origin/main...HEAD`
- Private evidence commit/path: not applicable
- GitHub Actions `rewrite-ci` run URL: pending until the PR is opened
- Commands recorded below ran exactly as written; anything not run is listed with a reason.
- Not run: the full aggregate, `npm test`, `npm run check`,
  `npm run harness:check-package-policy`, `npm run harness:smoke-cli-package`,
  and other unrelated jobs. The manifest-selected `boundaries` job ran and
  passed the six `harness:*` boundary/contract commands indirectly; typecheck
  passed directly, while GitHub CI remains authoritative.

## Residual Risk

- The live PR template or gate manifest may change; contributors must read both
  from their current branch instead of copying this example.
