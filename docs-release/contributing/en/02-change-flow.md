# Change flow

## Start with one reviewable scope

A contribution should answer:

- What problem does this solve?
- What files or surfaces may change?
- What is explicitly out of scope?
- What evidence will prove the change?

Keep unrelated cleanup out of the PR. If you find a neighboring bug, either fix
it only when it blocks the current change or open a separate issue/PR.

## Respect the architecture boundary

Harness Anything treats Markdown in git as authored source of truth and derived
stores as rebuildable projections. Do not introduce a second source of truth for
tasks, decisions, facts, or relations. Do not bypass the write path for
load-bearing authored records.

When changing application behavior, prefer existing package boundaries and
public surfaces. Avoid deep imports across packages unless the current public
surface cannot express the change and the PR explicitly explains why.

## Use the existing command surface

CLI changes should go through registered commands, descriptors, help text,
receipt shapes, error codes, and tests together. A command that works but cannot
be discovered by `--help`, cannot emit structured output, or returns an
unregistered error shape is not finished.

When you add or change tests under `packages/**` or `tools/**`, update
`tools/test-tier-manifest.mjs`. Unclassified tests are expected to fail closed.

## Docs changes

Public user-facing docs live in `docs-release/`, root README files, and package
README files. The root `docs/` directory is not the public release channel for
this repository.

Docs should describe the current release posture honestly. Do not claim a
published npm package, signed installer, notarized build, hosted service, or
finished GUI product unless the release posture and gates have changed first.

For docs-only PRs, still treat private-boundary and path leakage checks as real
gates. Public docs must not reveal private planning paths, local filesystem
paths, or unpublished operating state.

## Dependency and package changes

Dependency, package, and release-adjacent changes have a higher review burden.
They must preserve the current package policy unless the PR is explicitly a
release-boundary task:

- non-CLI workspace packages remain private before an explicit publish task;
- version and publish impact must be stated in the PR;
- package smoke and supply-chain checks may be required even when the code diff
  looks small.

## Commit discipline

Commit messages stay concise and English by convention. The PR body carries the
full bilingual explanation.

Before committing:

```bash
git status --short
git diff --check
```

Only stage files that belong to the stated scope. Do not reset, reformat, or
stage someone else's unrelated local changes.
