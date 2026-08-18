# PLT-Center W1 implementation report

## 删除清单 vs 新增清单（动第一刀前留痕）

| 删除 / 收窄 | 新增 / 保留 |
| --- | --- |
| registry 中未表达 repo mode 的歧义；旧记录省略 mode 时明确解释为 `local`。 | 闭合 `local / remote-center / remote-edge` registry 字段、CLI/RPC 参数和 attach receipt。 |
| `remote-center` / `remote-edge` 的隐式本地写入与非 local doc watcher。 | Host 与 Cell 共用 command-family mode admission。 |
| Host/Cell 各自维护 reprobe timestamp/throttle 的重复转移。 | 一个最小 `probe/latch/clear` recovery machine，保留 Host reopen 与 Cell rebind 两种 owner action。 |
| `repairsLatch` 布尔旁路。 | 闭合 recovery-command 表：`ledger-migrate` 可修复 data-shape latch，`receipt-show` 可穿越两类 latch 且不自行清闩。 |
| unavailable 的伪造 `recoveryMs: 0` 与 status summary 漏计 unavailable。 | unknown duration 为 `null`；summary 计 attached + unavailable。 |
| `readLiveEventRelationTruth` 直接打开 SQLite 的 identity bypass。 | post-merge 显式消费 identity-bound `TaskProjection.readRelationTruth()`；缺失时 fail closed。 |
| stale dist / projection schema mismatch 时继续服务。 | source-vs-dist freshness admission 与只读 projection schema admission，错误给出 stop/rebuild/restart 路径。 |
| crash 后 canonical event 已存在仍返回 projection `pending`，以及无 event 时含糊建议。 | `receipt-show` 以 canonical event / prepared recovery 为 settlement authority，区分 `applied / op_rejected / indeterminate`。 |

## Challenge

M1-D 已有 deterministic opId、prepared refs、startup recovery 和 `receipt-show`。另建 receipt DB 会制造第二结算权威，因此实现复用 canonical event / prepared-ref recovery，只补三态结算和 latch 下可查询性。

design-v2 的完整 admission 还提到 ABI/layout/epoch；task_plan Goal 把本线 M1-B 收窄为 stale dist 与 kernel projection schema。epoch、remote lease、sync、remote write-back 均未吸收。

## M1 落点

### M1-A repo mode 契约

- `packages/kernel/src/daemon/registry.ts:12`：闭合 mode vocabulary；decode 兼容省略字段为 `local`，mutation 持久化显式 mode。
- `packages/daemon/src/repo-mode.ts:6`：按 mode、command family、ingress source 做统一 admission。
- `packages/daemon/src/daemon-host.ts:76`、`packages/daemon/src/repo-cell.ts:95`：register receipt 暴露 mode，Host/Cell 双层收口；non-local watcher 禁用。
- `packages/cli/src/daemon/control.ts` 与 protocol contract/server：`ha daemon repo register --mode ...` 穿透到 registry。

### M1-B 版本 admission

- `packages/daemon/src/runtime-admission.ts:11`：仅 built daemon 运行时扫描 cli/kernel/daemon/application source 与 dist mtime；source `.ts` 执行不误报。
- `packages/kernel/src/projection/projection-schema.ts:4`：只读 schema probe；没有增加 gate allowlist 或可写 SQLite road。
- `packages/daemon/src/repo-cell.ts:47`：获取 writer lock 前执行 build/schema admission；错误包含 stop、build/remove cache、restart 路径。

### M1-C Host/Cell 状态机统一

- `packages/daemon/src/recovery-state.ts:4`：recovery-command 表；`packages/daemon/src/recovery-state.ts:14`：共享 probe/latch machine。
- `packages/daemon/src/daemon-host.ts:40` 与 `packages/daemon/src/repo-cell.ts:66`：Host reopen / Cell rebind 复用同一 throttle state machine；`repairsLatch` 路径已删除。
- `packages/daemon/src/daemon-host.ts:43`、`:119`：unavailable `recoveryMs: null`，summary 计入 unavailable。
- `packages/kernel/src/projection/rebuildable-task-projection.ts:62`、`:94`：relation truth 从 identity-bound TaskProjection 读取；原 `readLiveEventRelationTruth` 已删除。post-merge 缺显式 truth 时 hard-fail。

### M1-D receipt / 结算契约

- `packages/daemon/src/repo-cell.ts:198`：无 canonical/recoverable event 返回 `op_rejected`；prepared recovery indeterminate 返回 `indeterminate`。
- `packages/daemon/src/repo-cell.ts:204`、`:212`：canonical event 可达即稳定结算 `applied`，即使 L2 catch-up 尚未完成；低层 `readDocReceipt` 的 pending 语义保留。
- `packages/daemon/test/json-rpc-protocol.test.ts:348`：全 killpoint crash matrix 先查 receipt；仅 `before_event_write / after_event_write` 允许安全 retry，`after_head_write` 及以后不盲重试，并断言 event 唯一。
- `packages/daemon/test/repo-cell-latch-recovery.test.ts`：`receipt-show` 在 infrastructure latch 保持期间可用。

## 验证输出

### Mission 定向 integration

命令：

```text
node --test packages/daemon/test/daemon-host-recovery.test.ts packages/daemon/test/repo-cell-latch-recovery.test.ts packages/daemon/test/json-rpc-protocol.test.ts packages/daemon/test/doc-sync-slice-a.test.ts packages/kernel/test/store/daemon-registry.test.ts packages/kernel/test/store/relation-graph-projection.test.ts packages/kernel/test/store/projection-identity-binding.test.ts
```

真实 runner 汇总：

```text
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 57217.028125
```

其中 crash/receipt 与性能输出：

```text
✔ RepoCell new generation recovers before_event_write without a duplicate publication
✔ RepoCell new generation recovers after_event_write without a duplicate publication
✔ RepoCell new generation recovers after_head_write without a duplicate publication
✔ RepoCell new generation recovers after_git_commit without a duplicate publication
✔ RepoCell new generation recovers before_worktree_rename without a duplicate publication
✔ RepoCell new generation recovers after_worktree_rename without a duplicate publication
✔ RepoCell new generation recovers after_sqlite_commit without a duplicate publication
✔ RepoCell new generation recovers before_response_write without a duplicate publication
✔ RepoCell new generation recovers after_response_write without a duplicate publication
ℹ doc-single-write-p50=227.693ms samples=216.085,218.754,218.951,227.693,276.448,286.372,297.982
```

### 根 gate

命令：`npm run check:local`

真实 runner 汇总：

```text
Local check (fast tier): 41 steps, QoS wrapper: taskpolicy -c utility, cores: 16.

ℹ tests 178
ℹ suites 0
ℹ pass 178
ℹ fail 0
ℹ duration_ms 18268.459
✓ test:fast (19.2s)

ℹ tests 407
ℹ suites 0
ℹ pass 407
ℹ fail 0
ℹ duration_ms 49886.881125
✓ test:contract (50.8s)

[gate-allowlist] check-bypass-write-boundary: current=72 previous=72 delta=0
Bypass write boundary check passed (72 governed filesystem/SQLite call(s)).
[gate-allowlist] check-kernel-dead-exports: current=260 previous=260 delta=0
Kernel dead-export check passed (260 allowlisted zero-consumption export(s), 193 consumed export(s)).
integration shard check passed: current=72 previous=72 delta=0 shards=6
Gate surface check passed (55 manifest gates, 0 drift findings).
derived-contracts: ok (6 declarations)
schema-closure: ok

Local check passed (fast tier) in 113.0s.
```

runner 明确提示该 tier 不执行 integration/gui；本 mission 的 integration 修改面已由上方 87-test 定向集覆盖，GUI 未触及。

## Production +/- 行数

相对 `origin/main`，仅统计 `packages/cli/src`、`packages/daemon/src`、`packages/kernel/src`：

```text
+199 / -73 production lines
```

完整 diff（含测试，不含本报告）：`21 files changed, 292 insertions(+), 86 deletions(-)`。

## Commits

- `8223d109` `feat(daemon,kernel): harden local repository admission`
- `31375134` `refactor(kernel): bind relation truth to projections`
- `a41b46c6` `fix(daemon): settle canonical receipts after restart`

本报告由独立 `fix(docs)` commit 收口。未 push，未创建 PR。

## Residual risks

- mtime admission 只在 built daemon 路径启用；若未来构建布局不再是 `packages/cli/dist/{package}/src/**`，必须同步 `staleDistFiles` 映射与测试。
- schema mismatch repair 通过删除 rebuildable cache 恢复；它不会迁移或保留 cache 内任何非 canonical 状态，符合当前 cache 可重建前提。
- `remote-edge` 的 replica read surface 保持现状；本线只收紧 command families，没有改 M2 replica/lease/sync/write-back 语义。
- canonical receipt 证明 event 已在 canonical cut，但 authored worktree/projection 可见性仍由各 receipt 的专用字段表达；调用方不应把 generic `applied` 等同于所有派生视图已 catch up。

## 未预见但实际触及的面

- 新增 `packages/kernel/src/projection/projection-schema.ts`，用于避开对 gate allowlist 的修改；gate 配置最终零 diff。
- 扩展 JSON-RPC RBAC integration 中 register receipt 的 mode 断言。
- 重读 `fleet-transport.integration.test.ts` 与 `replica-pull.integration.test.ts` 后确认默认 local 仍允许 authenticated assignment ingress，因此没有修改这两份 M2 测试或生产面。
- 未新增测试文件，只扩展既有 integration 文件；`tools/test-tier-manifest.mjs` 无需登记变更。
