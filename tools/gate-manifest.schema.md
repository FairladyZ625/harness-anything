# Gate Manifest Schema

`tools/gate-manifest.json` is the structured source of authority for gate
policy. Changing it is a governance change under ADR-0023 D2/D5.

## Top-Level Shape

- `governanceNotice`: header-equivalent notice for JSON consumers. JSON has no
  comments, so this field carries the required governance warning.
- `schema`: stable schema id. Current value:
  `harness-anything/gate-manifest/v2`.
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
- `deterministic`: boolean classification. `true` means the gate judges only
  repository source/configuration with reproducible local inputs. Aggregate
  wrappers, external-API checks, live-registry checks, wall-clock enforcement,
  and headed-environment checks are `false` even when they contain deterministic
  subchecks.
- `positiveControl`: object with `status` (`covered`, `documented-gap`, or
  `not-applicable`) and a non-empty `evidence` array. Evidence contains a fixture
  or test path when one exists; gaps and non-applicable aggregate/control-flow
  gates use an explicit explanation instead of inventing coverage.
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
  `rewrite-ci.yml`, and branch protection. Its `classes` array uses `local`,
  `pr`, `main-full`, `nightly`, and `manual`. `rewriteCi.scheduleOnly: true`
  distinguishes a step inside the `full-check` job that runs only on schedule.

## Graph Invariants

`tools/check-gate-manifest-invariants.mjs` fails closed when:

1. a `deterministic: true` gate omits `pr` from
   `executionSurfaces.classes`; or
2. canonical surface labels, declared workflow jobs, and the actual
   `.github/workflows/rewrite-ci.yml` job/step graph disagree.

The checker also requires the v2 classification and positive-control fields on
every gate. Its positive-control test deliberately declares a deterministic gate
without `pr` and asserts a red result.

## Sample Entries

Boundary gate sample:

```json
{
  "id": "check-import-boundaries",
  "deterministic": true,
  "positiveControl": {
    "status": "covered",
    "evidence": ["tools/check-import-boundaries.test.mjs"]
  },
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
  "bypassFixtureRequired": true,
  "executionSurfaces": {
    "classes": ["local", "pr", "main-full"]
  }
}
```

Local-consistency gate sample:

```json
{
  "id": "check-schema-field-coverage",
  "deterministic": true,
  "positiveControl": {
    "status": "covered",
    "evidence": ["tools/check-schema-field-coverage.test.mjs"]
  },
  "command": "npm run harness:check-schema-field-coverage",
  "category": "local-consistency",
  "tier": "pr-required",
  "authoritySource": [
    "packages/kernel/src/entity/field-contracts.ts",
    "tools/check-schema-field-coverage.mjs"
  ],
  "consumerScope": ["entity schema field contract coverage"],
  "bypassFixtureRequired": false,
  "executionSurfaces": {
    "classes": ["local", "pr", "main-full"]
  }
}
```

Release-policy gate sample:

```json
{
  "id": "check-package-policy",
  "deterministic": true,
  "positiveControl": {
    "status": "documented-gap",
    "evidence": ["No dedicated positive-control fixture is registered for check-package-policy."]
  },
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
  "bypassFixtureRequired": false,
  "executionSurfaces": {
    "classes": ["local", "pr", "main-full"]
  }
}
```

## Current Reconciliation

The registry records:

- 51 gates: 42 deterministic and 9 non-deterministic/composite.
- 36 `harness:*` leaf gates from `package.json`; 34 are in `check`, 32 are in
  `check:pr`, and 35 execute in pull-request workflow jobs. The only
  `harness:*` gate outside the PR workflow is the non-deterministic,
  schedule-only `check-enforcement-debt-sunset`.
- 11 formerly main-only deterministic gates added to the existing `boundaries`
  required context: `check-cli-help-contract`, `check-cli-error-codes`,
  `check-error-classification`, `check-duplicate-definitions`,
  `check-integrity-single-source`, `check-docs-release-map`,
  `check-template-command-surface`,
  `check-service-mappability`, `check-api-contract-registry`,
  `check-schema-field-coverage`, and `smoke-legacy-intake`.
- `check-gate-manifest-invariants` executes locally, in `boundaries`, and in
  non-PR `full-check` confirmation runs.
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
registered as gates. `metadata-source-proof` looks up the latest successful
`rewrite-ci/source-validation` commit status on the exact PR head SHA and fails
closed to full execution on absence or API error. `source-validation-proof`
records that status only after all source-validation jobs succeed; reuse runs do
not record a new proof.
