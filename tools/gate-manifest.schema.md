# Gate Manifest Schema

`tools/gate-manifest.json` is the structured source of authority for gate
policy. Changing it is a governance change under ADR-0023 D2/D5.

## Top-Level Shape

- `governanceNotice`: header-equivalent notice for JSON consumers. JSON has no
  comments, so this field carries the required governance warning.
- `schema`: stable schema id. Current value:
  `harness-anything/gate-manifest/v1`.
- `schemaDocumentation`: path to this schema explanation.
- `authorityBasis`: human-readable ADR/standard references for the schema.
- `sourceSnapshot`: source inventory used for this version, including GitHub
  branch-protection actual status.
- `categoryDefinitions`: category vocabulary. `boundary` and
  `local-consistency` are intentionally machine-readable for architecture
  review.
- `tierDefinitions`: tier vocabulary.
- `surfaces`: normalized inventories from `package.json`, `rewrite-ci.yml`, and
  branch protection.
- `gates`: full gate registry. Each entry has a stable `id`.

## Gate Entry Fields

Each gate entry must declare:

- `id`: stable kebab-case gate id.
- `aggregate`: optional boolean for aggregate gates such as `npm run check`.
- `command`: local command or equivalent CI command sequence.
- `category`: one of `boundary`, `local-consistency`, `smoke`,
  `release-policy`, or `meta-governance`.
- `tier`: one of `pr-required`, `main-only`, `nightly-only`, or `manual-only`.
- `tierReason`: required for every non-`pr-required` gate.
- `authoritySource`: non-empty array of authority files or declarations.
  Boundary gates must not use only their checker file as authority.
- `consumerScope`: non-empty array describing the real checked consumer surface.
- `githubContext`: required-context and workflow-job mapping.
- `allowlistPolicy`: whether allowlists/exceptions exist, where they live, and
  whether ADR/decision evidence is required.
- `changeControl`: whether ordinary implementation tasks may modify the gate and
  which protected surfaces are implicated.
- `bypassFixtureRequired`: `true` for boundary gates that require documented
  bypass fixture coverage under ADR-0022 D7.
- `executionSurfaces`: machine-readable reconciliation with `package.json`,
  `rewrite-ci.yml`, and branch protection.

## Sample Entries

Boundary gate sample:

```json
{
  "id": "check-import-boundaries",
  "command": "npm run harness:check-import-boundaries",
  "category": "boundary",
  "tier": "pr-required",
  "authoritySource": [
    "harness/adr/ADR-0022-gate-defense-graph-invariants-and-authority-derivation.md#d1",
    "package.json:workspaces",
    "packages/*/package.json"
  ],
  "consumerScope": ["cross-package import statements under packages/**"],
  "githubContext": {
    "requiredContexts": ["boundaries"],
    "workflowJobs": ["boundaries"],
    "nodeVersions": [24]
  },
  "bypassFixtureRequired": true
}
```

Local-consistency gate sample:

```json
{
  "id": "check-schema-field-coverage",
  "command": "npm run harness:check-schema-field-coverage",
  "category": "local-consistency",
  "tier": "main-only",
  "tierReason": "Registered in package.json check/check:pr but not executed by a pull_request rewrite-ci job; full-check runs it on main/schedule/manual.",
  "authoritySource": [
    "packages/kernel/src/entity/field-contracts.ts",
    "tools/check-schema-field-coverage.mjs"
  ],
  "consumerScope": ["entity schema field contract coverage"],
  "bypassFixtureRequired": false
}
```

Release-policy gate sample:

```json
{
  "id": "check-package-policy",
  "command": "npm run harness:check-package-policy",
  "category": "release-policy",
  "tier": "pr-required",
  "authoritySource": [
    "harness/governance/standards/ci-cd-standard.md#local-distribution-and-release",
    "package.json",
    "packages/*/package.json"
  ],
  "consumerScope": ["workspace package release policy"],
  "githubContext": {
    "requiredContexts": ["package-policy"],
    "workflowJobs": ["package-policy"],
    "nodeVersions": [24]
  },
  "bypassFixtureRequired": false
}
```

## Current Reconciliation

The registry records:

- 26 `harness:*` leaf gates from `package.json`.
- 24 `harness:*` leaf gates in `check:pr`; the omitted gates are
  `smoke-legacy-intake` and `smoke-cli-package`.
- 13 `harness:*` gates executed by pull-request `rewrite-ci` jobs:
  `check-file-complexity`, `check-import-boundaries`,
  `scan-forbidden-symbols`, `check-private-boundary`,
  `check-integration-test-shards`, `check-mergify-queue-contexts`,
  `check-gate-surface`, `check-runtime-release-readiness`,
  `check-implementation-contracts`, `check-schema-contracts`,
  `check-legacy-intake-readiness`, `check-package-policy`,
  `check-supply-chain`, and `smoke-cli-package`.
- 13 `harness:*` gates registered in package scripts but not executed by a
  pull-request `rewrite-ci` job:
  `check-cli-structure`, `check-cli-help-contract`,
  `check-cli-error-codes`, `check-error-classification`,
  `check-duplicate-definitions`, `check-integrity-single-source`,
  `check-docs-release-map`, `check-docmap-fresh`,
  `check-template-command-surface`, `check-service-mappability`,
  `check-api-contract-registry`, `check-schema-field-coverage`, and
  `smoke-legacy-intake`.
- 14 GitHub branch-protection required contexts:
  `boundaries`, `package-policy`, `typecheck (24)`, `fast-contract`,
  `integration-shard (1)`, `integration-shard (2)`,
  `integration-shard (3)`, `integration-shard (4)`,
  `integration-shard (5)`, `integration-shard (6)`, `supply-chain`,
  `gui-build`, `node26-compatibility`, and `pr-body-lint`.
- 2 PR-body meta-governance commands under the `pr-body-lint` required
  context: bilingual body structure and protected-surface governance
  declaration shape.

Workflow helper jobs listed under
`surfaces.rewriteCi.helperJobsNotRegisteredAsGates` are intentionally not
registered as gates because they only feed required gate jobs.
