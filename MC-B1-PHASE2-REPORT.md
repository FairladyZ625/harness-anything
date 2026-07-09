# MC-B1 Phase2 Report

## 回报点 1

### RPC 签名草案

- `repo.task.claim`
  - input: `{ repo: { repoId }, payload: { taskId: string, ttlMs?: number } }`
  - actor: daemon per-request authenticated actor, not caller-supplied principal
  - success: `{ ok: true, taskId, holder, acquiredVia: "claim", acquiredAt, leaseExpiresAt, orphan: false }`
  - collision failure: code `task_claim_collision`, details include current `holder` and `leaseExpiresAt`

- `repo.task.holder`
  - input: `{ repo: { repoId }, payload: { taskId: string } }`
  - success: `{ ok: true, taskId, holder: TaskHolderRecord | null, effectiveHolder, orphan, leaseExpiresAt }`
  - expired lease reports `orphan: true`; it does not rewrite authored Markdown

- `repo.task.release`
  - input: `{ repo: { repoId }, payload: { taskId: string } }`
  - actor: daemon per-request authenticated actor
  - success: `{ ok: true, taskId, released: true, previousHolder, releasedAt }`
  - non-holder failure: code `task_release_not_holder`, details include current holder if any

### Holder Record 字段形状

Runtime state path: `.harness/task-holders/<taskId>.json` under `layout.localRoot`; this is local-only and must stay out of git.

```json
{
  "schema": "task-holder/v1",
  "taskId": "task_...",
  "holder": {
    "principalId": "person-or-actor-id",
    "displayName": "Display Name",
    "primaryEmail": "person@example.com",
    "providerId": "transport-derived",
    "credential": {
      "kind": "unix-uid",
      "issuer": "local",
      "subject": "501"
    }
  },
  "acquiredVia": "claim",
  "acquiredAt": "2026-07-10T00:00:00.000Z",
  "leaseExpiresAt": "2026-07-10T00:30:00.000Z",
  "releasedAt": null,
  "updatedAt": "2026-07-10T00:00:00.000Z",
  "version": "iso-timestamp-plus-random"
}
```

`acquiredVia` is typed as `"claim" | "assignment"` in the record, but v0 only writes `"claim"`.

### Registry 新增行

- `task.holder.runtime-state`: road `A`, bearing `task-holder`, `leaseRequired: false`, channel `{ pathClass: "coordinator-runtime-state", zoneClass: "task-holder-runtime-state" }`, direct write evidence for the task holder runtime service.
- `task.holder.runtime-event`: no separate row planned unless a new event write surface appears; holder audit should reuse existing `runtime-event.coordinated-jsonl` / `runtime-event.direct-fallback` rows.

If the checker discovers a distinct new runtime event callsite, I will register it as a D-road runtime-event audit row rather than adding a checker exemption.

## Final Implementation Notes

- Implemented task holder runtime state in `packages/kernel/src/local/task-holder-state.ts`.
- Runtime holder records live under `.harness/task-holders/<taskId>.json` via `layout.localRoot`; authored task Markdown is not used for lease-derived state.
- Added daemon RPCs:
  - `repo.task.claim`
  - `repo.task.holder`
  - `repo.task.release`
- Added CLI commands:
  - `ha task claim <taskId> [--ttl-ms <ms>]`
  - `ha task holder <taskId>`
  - `ha task release <taskId>`
- Claim/release mutations serialize through the daemon runtime queue when daemon-bound; direct local mode uses the same holder service.
- Lease enforcement is default-off and enabled only by `HARNESS_TASK_LEASE_ENFORCEMENT=1|true`.
- Enforcement is applied at task lifecycle/progress/fact writer boundaries, plus daemon API `tasks.status.set` and `tasks.progress.append`; `coordinator.enqueue` is not used as a blanket gate.
- Runtime event audit now records actor identity for direct holder RPCs and inner `repo.command.run` action/task details for task status/progress/fact transitions.
- Write-road registry gained `task.holder.runtime-state`; runtime event writes reuse the existing runtime-event registry rows.

## Verification

- `npm run check:local` passed.
- Additional focused checks run during implementation:
  - `npm run typecheck -- --pretty false`
  - `npm run lint -- --max-warnings=0`
  - `npm run harness:check-import-boundaries`
  - `npm run harness:check-write-road-registry`
  - `node --test packages/application/test/task-holder-service.test.ts`
  - `node --test packages/daemon/test/task-holder-rpc.test.ts packages/cli/test/task-lease-cli.test.ts`
