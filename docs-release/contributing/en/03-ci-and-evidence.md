# CI and evidence

Every contribution needs evidence. Evidence is not confidence language; it is a
command, test result, CI run, diff, review note, or reasoned "not run" entry that
a reviewer can inspect.

## Local checks

The smallest useful pre-PR loop is:

```bash
git diff --check
```

For public docs changes, also run:

```bash
npm run harness:check-private-boundary
npm run harness:check-docs-release-map
```

For package, CLI, kernel, tool, GUI, or contract changes, run the PR-sized gate:

```bash
npm run check:pr
```

Before claiming implementation readiness for broad public changes, run:

```bash
npm run check
```

If a command is not run, the PR must say exactly which command was skipped and
why. "Not needed" is not enough; name the scope reason.

## Test tiers

The repository uses tiered test lanes:

| Command | Use |
| --- | --- |
| `npm run test:fast` | Pure or near-pure behavior tests. |
| `npm run test:contract` | Public API, schema, and cross-package contracts. |
| `npm run test:integration` | CLI, filesystem, store, migration, and slower behavior. |
| `npm test` | Full Node test suite. |
| `npm run test:gui` | GUI test lane. |

New Node tests under `packages/**` or `tools/**` must put exactly one valid
`// harness-test-tier: fast|contract|integration` declaration on their first
line. The runner rejects missing, repeated, or invalid declarations.

## CI lanes

Pull requests run the `rewrite-ci` workflow. Required PR signals include the
typecheck, fast/contract, integration, boundary, package-policy, GUI build,
Node 26 compatibility, supply-chain, and PR body lint lanes as configured by the
repository.

The full aggregate `npm run check` lane is reserved for `main`, scheduled runs,
and manual dispatch. Do not treat a pull-request skip of the full-check job as a
failure when the PR lanes passed by design.

## Merge discipline

`main` advances through GitHub's protected merge path. Do not merge a pull request into
`main` before the required checks and reviews pass.

If an emergency direct merge is explicitly approved, the person performing it is
responsible for immediately rebasing every pull request already in the queue and
rerunning the required gates. The emergency merge is not complete until queued
work has a fresh base.

After approval and passing required checks, enable GitHub auto-merge. GitHub
will merge the pull request when the protected branch rules are satisfied.

## Evidence in the PR

The PR template asks for:

- base `origin/main` SHA and merge-base;
- last fetch time and sync method;
- public diff command;
- local verification commands;
- GitHub Actions `rewrite-ci` run URL;
- reviewer evidence and blocking findings;
- residual risk.

Fill these fields honestly. Empty verification sections slow review down because
maintainers must reconstruct the evidence from scratch.

## Failing checks

When a check fails:

1. Read the failure, not just the job name.
2. Fix the PR branch.
3. Re-run the smallest local command that proves the fix.
4. Push normally and wait for CI again.

Do not force-push or direct-push to `main` to escape a failure. A failing gate is
part of the contribution, and resolving it is part of the work.
