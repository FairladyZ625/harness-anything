Fixed the production canonical-ingress feedback loop to override inherited `HARNESS_DAEMON_MODE=direct` with daemon-backed `local` for its CLI client subprocesses.
Verified the simulated CI regression test (2/2 pass) and root `check:local` (exit 0); no runner or unrelated test environment semantics changed.

## D12 / D13 — frozen INDEXED recovery

D12 root cause was a double publication inside production restart recovery. `recoverFromOperationRecord()` already materialized and immutably ensured the exact V2 event, but recovery then called `completeAuthorityCommittedReceiptV2()`, which published it again with a new observation `recordedAt`. The immutable event log correctly rejected those different bytes and the fail-closed recovery loop left the operation `INDEXED`. Recovery now derives the integrity tuple from the single recovered event, so the operation advances to `COMMITTED` without replaying the canonical append.

The production-composition regression fixture establishes `WRITES_FROZEN`, demotes one real committed task append to `INDEXED`, removes its V2 event to model the crash boundary, restarts the production lifecycle, and verifies one event, `COMMITTED`, and a passing frozen-phase final scan.

D13 needs no proof or phase relaxation for this incident: startup recovery runs before serving and before the cutover scan, and the recovered operation is terminal by the time the frozen control plane scans. `drain --classify` remains rejected in `WRITES_FROZEN`; fail-closed scan behavior is unchanged.
