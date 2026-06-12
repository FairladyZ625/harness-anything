# Contributing

Harness Anything is a repo-native harness. Public code and docs live in this repository; private planning, reviews, ledgers, and generated local state must not be committed to the public package surface.

## Public / Private Boundary

- Do not commit `.harness-private/**`, local agent entry files, or generated runtime/cache state.
- Public changes belong in source, tests, examples, `docs-release/**`, or tool scripts.
- Keep authored task evidence separate from generated projections and local worktree state.

## Change Flow

1. Branch from latest `origin/main`.
2. Keep implementation changes scoped to the task or issue.
3. Add or update tests for behavior changes.
4. Run `npm run check` before requesting review.
5. In the PR, list the verification commands and any deferred work.

## Review Expectations

- Do not mark human Dashboard confirmation from an agent.
- Do not claim formal package release or publish readiness unless the release milestone explicitly owns it.
- For lifecycle, projection, schema, package surface, or cutover changes, include evidence from the relevant contract tests and checker gates.
