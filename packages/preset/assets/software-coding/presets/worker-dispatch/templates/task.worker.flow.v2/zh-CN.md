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

当范围、权限、必要输入或破坏性选择阻断进度时，使用派工注入的 `ha task escalate <task-id> --question "<问题>" --option "<选项>" --recommend "<建议>" --reason "<阻塞原因>"` 命令；每个选项重复一次 `--option`。不要只在报告里写裁决请求。

## Commit and Handoff

- 只提交本次派活负责的文件。
- 描述完成结果与原因、验证结果和残余风险；commit 与变更文件以冻结的 submission 为准。
- 交付前先 rebase 到最新 `origin/main`，再重跑证据命令。
- 提交时会接纳任务包文档；这些文件不再单独运行文档同步。
- 仓库交付在最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实，再用 `ha task push <task-id>` 发布、用 `gh pr create --head <task-id>` 创建 PR，并运行 `gh pr checks <task-id> --watch` 等待当前 PR head 的 checks 出结论。Worker 不得合并。
- 任务交付时序、检查等待期间的工作、失败修复与会话交接统一遵循 `# Worker Role`。任务合同声明的 CI 仍是完成门禁。
- 如果 PR 冲突，先 rebase 到最新 `origin/main`，再次推送并重读检查。
