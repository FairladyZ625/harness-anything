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
4. Run `npm run check:ci` before requesting review. It reads
   `tools/gate-manifest.json` and runs **every** job CI runs on a pull request —
   nine of them, and the `boundaries` job alone carries 35 gates. Do not
   substitute `npm run check:local`: that is a fast-tier subset and is not equal
   to any CI job, which is why "green locally, red in CI" keeps happening. Set
   `GITHUB_REPOSITORY` and `GITHUB_TOKEN` first; the `boundaries` job reads
   GitHub's live branch rules.
5. In the PR, paste the `npm run check:ci -- --json <path>` receipt rather than
   asserting the gates passed, and list any deferred work.
6. If you changed CLI code and use the built bin (`npx ha`), rebuild the
   workspace dist (`npm run build -w @harness-anything/cli`); running from
   source (`node packages/cli/src/index.ts`) is always fresh. Refresh a global
   install only when cutting a version. Local distribution and release steps
   live in the private harness `ci-cd-standard.md`; there is no public npm
   publish yet.

## Review Expectations

- Do not mark human Dashboard confirmation from an agent.
- Do not claim formal package release or publish readiness unless the release milestone explicitly owns it.
- For lifecycle, projection, schema, package surface, or cutover changes, include evidence from the relevant contract tests and checker gates.
