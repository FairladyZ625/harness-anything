# Contributing

Harness Anything is a repo-native harness. Public code and docs live in this repository; private planning, reviews, ledgers, and generated local state must not be committed to the public package surface.

## Public / Private Boundary

- Do not commit `.harness-private/**`, local agent entry files, or generated runtime/cache state.
- Public changes belong in source, tests, examples, `docs-release/**`, or tool scripts.
- Keep authored task evidence separate from generated projections and local worktree state.

## Contributor License Agreement (CLA)

External contributions require a one-time CLA signature. The project is
licensed under AGPL-3.0-or-later, and the CLA preserves the maintainers'
ability to offer the code under additional license terms; see [CLA.md](CLA.md)
for the full text. When you open your first pull request, the `cla` workflow
will prompt you — sign by posting the comment it requests. Your signature is
recorded once and covers future contributions.

## Change Flow

1. Branch from latest `origin/main`.
2. Keep implementation changes scoped to the task or issue.
3. Add or update tests for behavior changes.
4. Run `npm run check:local` before requesting review. It is the lightweight
   local stop gate: incremental TypeScript build, changed-file lint, and tests
   for affected package/tool paths under the machine-wide load budget. It is a
   sanity check, not a substitute for GitHub CI.
5. GitHub CI is the complete pull-request authority and runs every manifest-
   declared job. Record the `check:local` output and the GitHub CI run in the PR,
   and list any deferred work. `npm run check:ci` remains available for explicit
   local diagnosis, but is not the default stop condition.
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
