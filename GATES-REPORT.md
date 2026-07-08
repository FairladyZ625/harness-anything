# check:local:gates static self-check report

Task: task_01KX1B60464SS5YA9R5PC2W2K3
Branch: codex/fast-tier-gates
Base: origin/main 5784913010cf6ef9370789bcfac424634e8e3a33

## Summary

- Added optional local command: `npm run check:local:gates`
- Default fast command remains: `npm run check:local` -> `node tools/run-local-check.mjs`
- No CI workflow, Mergify, branch-protection, required-check, checker semantics, or gate manifest changes.
- The new runner derives its static checker list from `tools/gate-manifest.json` plus `package.json` script resolution.

## Enumerator Rules

`tools/run-local-gates-check.mjs` selects manifest gates that satisfy all of:

- non-aggregate gate
- `tier` is `pr-required`
- gate belongs to a manifest-declared pull-request gate job
- gate command is `npm run harness:*`
- package script resolves to `node tools/check-*.mjs` or `node tools/scan-*.mjs`
- gate category is not `smoke`

## 枚举定稿

Command: `npm run check:local:gates`

Final green run: passed in 19.6s.

| Checker | Workflow job | Elapsed |
| --- | --- | ---: |
| check-file-complexity | boundaries | 0.3s |
| check-import-boundaries | boundaries | 0.5s |
| check-write-coordinator-boundary | boundaries | 0.3s |
| check-bypass-write-boundary | boundaries | 0.5s |
| check-kernel-dead-exports | boundaries | 1.3s |
| check-relation-cycle-substrate | boundaries | 0.3s |
| scan-forbidden-symbols | boundaries | 0.4s |
| check-private-boundary | boundaries | 0.3s |
| check-gate-surface | boundaries | 0.3s |
| check-locale-content | boundaries | 0.2s |
| check-catalog-schema | boundaries | 0.3s |
| check-runtime-release-readiness | boundaries | 0.8s |
| check-package-policy | package-policy | 0.3s |
| check-implementation-contracts | boundaries | 0.4s |
| check-schema-contracts | boundaries | 0.5s |
| check-legacy-intake-readiness | boundaries | 0.4s |
| check-supply-chain | supply-chain | 12.6s |

## Verification

`npm ci`

- Result: passed, 593 packages installed, audited 603 packages, found 0 vulnerabilities.
- Reason: initial `check-supply-chain` run found stale local `node_modules`/network state (`npm audit` TLS disconnect and `npm sbom` missing/invalid dependency tree). `npm ci` restored the local dependency tree from lockfile before final gate evidence.

`npm run check:local:gates`

- Result: passed in 19.6s after the dead-export self-proof was removed.
- Earlier green sample before self-proof: passed in 15.4s.

`npm run check:local`

- Result: passed fast tier in 30.2s.
- Output shape: `Local check (fast tier): 15 steps, QoS wrapper: taskpolicy -c utility`.

`node --test tools/run-local-gates-check.test.mjs`

- Result: 2 tests passed.

`npm run test:list | rg 'run-local-gates-check|run-local-check'`

- Result included both `tools/run-local-check.test.mjs` and `tools/run-local-gates-check.test.mjs`.

## Self-Proof Evidence

Temporary injection:

```ts
export const codexDeadExportSelfProof = true;
```

Injected into `packages/kernel/src/index.ts`, then removed with an explicit patch after verification.

Failure evidence from `npm run check:local:gates`:

```text
▶ check-kernel-dead-exports  (npm run harness:check-kernel-dead-exports)
Kernel dead-export check failed:
- kernel export codexDeadExportSelfProof has zero non-test consumers and is not allowlisted
✖ check-kernel-dead-exports failed (exit 1) after 1.3s

Local manifest static gate check stopped at: check-kernel-dead-exports.
```

## Residual Risks

- `check-supply-chain` depends on live npm audit/SBOM behavior and dominated elapsed time in the final run. It passed after `npm ci`, but local network or stale `node_modules` can still cause transient failures.
- The selector intentionally skips direct PR-body env checkers and smoke gates; it targets static `harness:*` checker scripts, not every PR-required workflow command.
- Local runtime was Node v25.8.0/npm 11.11.0 while package engines require Node >=24. CI still covers the required Node 24/26 matrix.
