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
- 描述完成结果与原因、验证结果和残余风险；commit 与变更文件以冻结的 submission 为准。
- 交付前先 rebase 到最新 `origin/main`，再重跑证据命令。
- 提交时会接纳任务包文档；这些文件不再单独运行文档同步。
- 仓库交付在最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实，再用 `ha task push <task-id>` 发布、用 `gh pr create --head <task-id>` 创建 PR，并运行 `gh pr checks <task-id> --watch` 等待当前 PR head 的 checks 出结论。Worker 不得合并。
- 检查仍在等待时继续等。GitHub 检查失败时用 `gh run view <run-id> --log-failed` 读取日志，并对照 origin/main 最近 CI 的同一用例：main 也红的记入报告、不修、不等；其余判定为本次改动引起后修复、amend submission、重新生成 PR 正文事实段、再推送并重读检查，直到交付 SHA 全绿。CLI 无法读取检查时，报告错误并把 CI 标为 unverified。
- 排队的检查仍在等待，继续等到有明确结论。
- 如果 PR 冲突，先 rebase 到最新 `origin/main`，再次推送并重读检查。
