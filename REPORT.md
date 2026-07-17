Fixed the production canonical-ingress feedback loop to override inherited `HARNESS_DAEMON_MODE=direct` with daemon-backed `local` for its CLI client subprocesses.
Verified the simulated CI regression test (2/2 pass) and root `check:local` (exit 0); no runner or unrelated test environment semantics changed.

## D12 / D13 — frozen INDEXED recovery

D12 root cause was a double publication inside production restart recovery. `recoverFromOperationRecord()` already materialized and immutably ensured the exact V2 event, but recovery then called `completeAuthorityCommittedReceiptV2()`, which published it again with a new observation `recordedAt`. The immutable event log correctly rejected those different bytes and the fail-closed recovery loop left the operation `INDEXED`. Recovery now derives the integrity tuple from the single recovered event, so the operation advances to `COMMITTED` without replaying the canonical append.

The production-composition regression fixture establishes `WRITES_FROZEN`, demotes one real committed task append to `INDEXED`, removes its V2 event to model the crash boundary, restarts the production lifecycle, and verifies one event, `COMMITTED`, and a passing frozen-phase final scan.

D13 needs no proof or phase relaxation for this incident: startup recovery runs before serving and before the cutover scan, and the recovered operation is terminal by the time the frozen control plane scans. `drain --classify` remains rejected in `WRITES_FROZEN`; fail-closed scan behavior is unchanged.

## D12b — production exception and root cause

The production-shaped probe used a read-only copy of `~/.harness/authority/harness-anything-production/authority/`, a fresh clone of `ROOT/harness` at `f9fa45ac8d5f5e1c7fbb2646ccac948513c2382e`, and a read-only copy of the existing runtime V2 event. The authority state copy matched all five production source-file SHA-256 digests. The real `findPublicationForOperation` crossed the direct docs commit and found merge `f47f272f42251c1135cfa7ffcfacc19f410f19c3`; `assertPublicationMatchesMutationSet` and the rev-1 replica change checks both passed.

The real recovery function produced the following verbatim exception message and stack; only the absolute worktree prefix is normalized to `ROOT` for release hygiene:

```text
AuthorityAttributionEventV2ProtocolDamageError: different bytes already exist for (workspace-harness-anything-production, namespace-harness-anything-production:834021364284871de1489e6c442b779b)
    at authorityAttributionEventV2ProtocolDamage (file:///ROOT/.worktrees/authority-pubproof-fix/packages/kernel/src/integrity/authority-attribution-event-v2-log.ts:59:17)
    at ensureAuthorityAttributionEventV2 (file:///ROOT/.worktrees/authority-pubproof-fix/packages/kernel/src/store/authority-attribution-event-v2-log.ts:87:11)
    at Object.ensure (file:///ROOT/.worktrees/authority-pubproof-fix/packages/kernel/src/store/authority-attribution-event-v2-log.ts:56:24)
    at Object.publish (file:///ROOT/.worktrees/authority-pubproof-fix/packages/application/src/authority/durable-committed-event-publisher-v2.ts:50:40)
```

The existing immutable event was valid and had `recordedAt=2026-07-17T19:32:42.594Z`. Restart recovery nevertheless called the publisher from `recoverFromOperationRecord`, which performed a fresh observation with a new `recordedAt`; `eventLog.ensure` correctly rejected those different canonical bytes. D12 had removed only the second publication performed while completing the receipt, leaving this first replay publication intact.

Recovery now uses the already durable event as `materializeExactEvent` when present and invokes the publisher only when the event is actually missing. The production-shaped post-fix replay returned `COMMITTED` with canonical event digest `51fe566be9cc86face924744d8cf54c6da6001a2a5648f1043f9b49f9e8a33a5`, made zero publisher calls, and preserved the event file SHA-256 `2ea391ba34b9738f3b3a79b9be0e61ea830bf8ee02079fab29c87c3ecd30700f` byte-for-byte.

The regression fixture keeps the existing V2 event, demotes the operation to `INDEXED`, adds a non-authority direct docs commit above the operation merge, restarts, and verifies `COMMITTED` plus a passing frozen final scan. Fail-closed deferrals now emit a structured daemon log entry with event `authority.recovery.deferred`, the opId in `requestId` and message, an `errorCode`, and the exception summary; logging failures are no longer swallowed by the recovery catch.
