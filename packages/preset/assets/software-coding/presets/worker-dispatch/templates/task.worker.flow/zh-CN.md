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
- 仓库交付先用 `ha task push <task-id>` 发布，再用 `ha task pr <task-id>` 创建 PR。之后用托管平台 CLI 和你自己的平台凭据直接读取检查；GitHub 使用 `gh pr checks <PR-number> --watch`。确认检查对应已推送的交付 SHA 全绿后才提交。Worker 不得合并。
- 检查仍在等待时继续等。GitHub 检查失败时用 `gh run view <run-id> --log-failed` 读取日志，并对照 origin/main 最近 CI 的同一用例：main 也红的记入报告、不修、不等；其余判定为本次改动引起后修复、再推送，并重读平台检查，直到交付 SHA 全绿。CLI 无法读取检查时，报告错误并把 CI 标为 unverified。
- 排队的检查仍在等待，继续等到有明确结论。
- 如果 PR 冲突，先 rebase 到最新 `origin/main`，再次推送并重读检查。
