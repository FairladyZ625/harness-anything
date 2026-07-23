# S3 Unknown Resolution Report

## 最终 realization

依据 `dec_01KY79W8F8R22PB6RRV760V7NY`，两条 `unknown` 按各自真实语义分别收口：

### `task-review`：`single-entry`

CLI `packages/cli/src/commands/core/task-gates.ts#runTaskGatesCommand` 是该写路唯一真实 materializing ingress。

API/GUI 的 `reviewTask` 经 `packages/application/src/local-controller-service.ts#makeLocalControllerService` 调用 `startTaskReview`；后者只返回 `execution_submission_required`，不写入或 materialize review 写路。`tools/write-road-discovery.mjs` 现在同时核验：

- controller 的精确调用集合；
- `startTaskReview` guard 的精确调用集合；
- `execution_submission_required` 错误码。

三项都匹配时，API/GUI request-guard 才不作为 authored 写 surface 进入 intent-compiler criterion，使其按 `no-authored-ingress-surfaces` 规则对本写路结构性 not-applicable。任一实现漂移都会失败闭合，重新暴露 API/GUI surface 并要求归属。

### `governance-rebuild`：`parity-debt`

API/GUI surface 保留在 discovery 与 registry 中，因为它确实是条件 materializer：

- CLI `packages/cli/src/commands/governance.ts#runGovernanceRebuild` 无条件执行完整重建，另外写 `Harness-Ledger.md`，archive 模式还会写归档。
- API/GUI `rebuildGovernance` 经 `queryTaskProjection` / `readTaskProjection` 条件性进入 `packages/kernel/src/projection/sqlite-task-projection.ts#rebuildTaskProjection`，只 materialize SQLite projection。

两种 ingress 对同一 projection materialization 意图存在真实语义分歧，因此登记为 `parity-debt`：

- compiler refs：`runGovernanceRebuild` 与 `rebuildTaskProjection`；
- owner：`governance.projection.rebuild`；
- sunset：`2026-10-31`；
- reason：要求 owner 在 sunset 前收敛语义，或明确保留该分歧。

## 改动文件

- `tools/write-road-discovery.mjs`
  - 增加 `task-review` request-guard 的失败闭合源码识别。
- `tools/check-write-road-registry.test.mjs`
  - 增加合规 `parity-debt` 正向用例。
  - 增加 request-guard not-applicable 正向用例。
  - 增加 guard 开始 materialize 时重新发现 surface 的负向用例。
- `tools/write-road-registry.json`
  - `task-review` 改为 `single-entry`，只保留 CLI surface。
  - 从 task lifecycle 写路 row 移除非 materializing 的 `tasks.review` / `reviewTask`。
  - `governance-rebuild` 改为 `parity-debt`，保留 CLI/API/GUI surfaces。
- `S3-UNKNOWN-RESOLUTION-REPORT.md`
  - 记录最终裁决、实现、门证据与风险。

`packages/**` 未修改。

## 门证据

最终提交前的 fresh 结果：

- `node tools/check-write-road-registry.mjs`：通过；criterion 为 `unified=6 parity-debt=4 single-surface-debt=20 single-entry=41 unknown=0`。
- `node --test tools/check-write-road-registry.test.mjs`：19/19 通过。
- `node tools/check-cli-daemon-parity.mjs`：通过；覆盖 26 个 live typed write commands。
- `node tools/check-file-complexity.mjs`：通过。
- `npm run lint -- --no-fix`：通过。
- `npm run test:contract`：完成且无失败。
- `git diff --check`：通过。

## 残余风险

- request-guard discovery 有意对实现形状敏感。无语义变化的调用重构也可能让门变红；这是失败闭合复核信号，不是运行时风险。
- `governance-rebuild` 的 parity debt 仍是显式治理债：CLI 与 API/GUI 的触发条件、工件范围不同，需 owner 在 `2026-10-31` 前收敛或正式保留差异。
- 本任务不改变 API 命名、HTTP method 或 `packages/**` 实现，也不臆造新的 materializer。
