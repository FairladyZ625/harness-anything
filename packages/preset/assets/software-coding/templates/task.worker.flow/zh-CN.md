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
- 回执只经 `ha doc sync --submit --path tasks/<pkg>/artifacts/reports/<file>.md` 提交。
