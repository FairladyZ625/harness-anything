# W3-A adversarial review follow-up (r2)

## Review disposition

The terra adversarial review at `tmp/orch/w3a-adversarial/w3a-adversarial-report.md` identified four P1 concurrency defects and three P2 gaps. All four P1 findings now have controlled regressions and fixes; P2-1 and P2-2 are fixed in this round. No CI, `.github/`, or gate-authority surface was changed.

## P1 red → green

- P1-1 allocation race: `writer-epochs.lock` now treats an empty lock as in-flight instead of dead, handles unlink races, and uses a durable append-only history floor. New 12-process regression requires epochs exactly `1..12`; the adversarial race probe now reports `No duplicate epoch observed`.
- P1-2 append check/use gap: the event store rechecks `beforeAppend` immediately before finalization and wraps final ref CAS in the same writer-epoch append fence. Controlled killpoint regression: `oldEpoch=1`, `successorEpoch=2`, receipt `op_rejected/writer_epoch_stale`, canonical event count remains `2`.
- P1-3 prepared recovery bypass: remote-center cells reject automatic prepared promotion and discard prepared refs on restart. Regression confirms a prepared ref exists after the simulated death, then recovery is attached with zero prepared refs and no canonical event promotion.
- P1-4 backup rollback: `writer-epochs.history` preserves a monotonic floor outside the replaceable state snapshot. Controlled restore regression: `1 → 2`, restore epoch-1 JSON, next allocation is `3`, historical epoch-2 assertion is stale.

## P2 fixes

- Stale task frames dispose all matching staged uploads and claim bytes before returning `writer_epoch_stale`; regression asserts durable upload count `0`.
- Added `fleet.receipt.get/v1` / `fleet.receipt.result/v1`; stale task client queries receipt over the same Fleet TLS session. Regression asserts the stale response carries `operation_not_published` receipt data.
- P2-3 review weakness addressed by converting race, rollback, append-window, prepared-recovery, upload-cleanup, and receipt-route probes into integration/contract assertions. Test-tier checker remains green at `current=80 previous=80`.

## Verification

```text
node --test packages/daemon/test/fleet-lease-broker.integration.test.ts packages/daemon/test/fleet-transport.contract.test.ts packages/daemon/test/fleet-transport.integration.test.ts packages/daemon/test/fleet-writer-epoch.integration.test.ts
ℹ tests 34
ℹ pass 34
ℹ fail 0

npm run check:local
Local check passed (fast tier) in 41.5s.
test:fast 204 passed; test:contract 428 passed; lint and all local boundary/static gates passed.

npm run harness:check-duplicate-definitions
Duplicate function definition check passed.

npm run harness:check-write-road-registry
Write-road registry check passed.

GITLAB_TOKEN="…" ./tools/center-testbed/smoke-epoch.sh
TESTBED EPOCH FENCING PASS: candidate epoch 2 fenced the stale center with zero canonical writes
TESTBED EPOCH FENCING PASS: candidate fenced stale center at zero writes; restarted center appended fresh epoch.
```

## Files touched

Production: `packages/daemon/src/fleet/writer-epoch.ts`, `packages/daemon/src/fleet/center.ts`, `packages/daemon/src/fleet/contract.ts`, `packages/daemon/src/fleet/edge.ts`, `packages/daemon/src/repo-cell.ts`, `packages/daemon/src/daemon-host.ts`, `packages/daemon/src/transport/auth-context.ts`, `packages/kernel/src/store/task-event-store.ts`.

Tests: `packages/daemon/test/fleet-writer-epoch.integration.test.ts`, `packages/daemon/test/fleet-lease-broker.integration.test.ts`, `packages/daemon/test/fleet-transport.contract.test.ts`.

## Residuals / unverified

- The history floor is an append-only sidecar in the fleet state root; a disaster restore that rolls back both the JSON snapshot and history still requires the higher-level ledger/recovery backup protocol to preserve the floor.
- Remote-center prepared publications are discarded on restart rather than auto-promoted; callers must retry/query the opId receipt.
- `npm run check:local -- --full` GUI lane was not run; targeted integration and Docker fencing were run.
- Production delta from `cd35a9a3`: `+127/-26`.
- Current local commit before report inclusion: `3dcb4a0ffd722e2e04d0a698c24eb8a99fefccc1`; report inclusion is amended into the final local commit.
