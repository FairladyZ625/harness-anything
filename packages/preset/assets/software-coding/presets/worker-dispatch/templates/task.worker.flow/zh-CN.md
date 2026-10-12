# {{title}} — Worker Flow

## Dispatch Goal

写明本 Worker 独立负责的调度目标，以及成功移交后下游可以继续做什么。

## Scope Boundaries

- 范围内：
- 范围外：
- Worker 可以修改的文件或系统：

## Inputs and Dependencies

- 必读上下文与来源材料：
- 上游决策或任务：
- 必须核验的假设：

## Acceptance Criteria

- [ ] 请求的结果可以被观察或复核。
- [ ] 相关测试或检查通过。
- [ ] 移交中附有证据。

## Stop Conditions

当范围、权限、必要输入或破坏性选择不清楚时，停止并上报。

## Commit and Handoff

- 只提交本次派活负责的文件。
- 回报 commit、变更文件、验证结果和残余风险。
- 交付前先 rebase 到最新 `origin/main`，再重跑证据命令。
- task-bound 回执只经 `ha doc sync --submit --task <task-id>` 提交。
- 仓库交付先用 `ha task push <task-id>` 发布，再用 `ha task pr <task-id>` 创建 PR，用 `ha task ci <task-id> --wait` 等 CI 出结论（`--json` 取全文，`--timeout <秒>` 限定上限），交付 SHA 全绿后才提交。Worker 不得合并。
- `pending` / `not_started` 不是结论：not_started 会说明原因——无 PR → 先 `ha task pr`；PR 冲突 → rebase 到基线再推；排队 → 继续等。
- CI 变红时先运行 `ha task ci <task-id>` 读失败用例、断言与完整日志，并对照 origin/main 最近 CI 的同一用例：main 也红的记入报告、不修、不等；其余判定为本次改动引起后修复，再推送、再读，直到交付 SHA 全绿。
