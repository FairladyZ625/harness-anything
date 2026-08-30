# Change flow

The executable edit, test-tier, targeted-test, and commit sequence lives in
[Make the change and test its surface](../../../skills/harness-contributing/SKILL.md#make-the-change-and-test-its-surface)
and
[Commit with the contributor identity](../../../skills/harness-contributing/SKILL.md#commit-with-the-contributor-identity).

## Reviewable scope

A contribution should solve one public problem and name its allowed surface,
excluded surface, and proof. Unrelated cleanup belongs in another issue or PR
unless it blocks the accepted change. Dependency, package, and release-adjacent
changes need an explicit impact statement because a small textual diff may
still change the shipped boundary.

## Architecture expectations

Markdown in git is authored source; derived stores are rebuildable
projections. Contributions must not introduce a second authored truth or bypass
an existing load-bearing write path. Changes should stay behind current package
boundaries and public surfaces unless the PR explains why those surfaces cannot
carry the behavior.

CLI behavior is complete only when its registered command, descriptor, help,
structured receipt, error contract, and relevant tests agree. Public docs live
in `docs-release/`, root README files, and package README files, and they must
describe the current release posture without promising an unshipped product.
