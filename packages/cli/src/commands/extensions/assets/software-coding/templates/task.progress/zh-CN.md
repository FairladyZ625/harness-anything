# Progress

在提交 active Execution 时，用可重复的 `ha task submit <task-id> --execution-id <execution-id> --lease-credential <saved-credential> --claim "..." --commit-sha <sha> --deliverable "..." --evidence-ref <ref> --verification "..."` 输入记录交付进展；不再有独立的 task-progress 写命令。承重观察仍须用 `ha fact record --task <task-id> ...` 显式晋升。

## Log

- 记录关键实现步骤、验证结果和阻塞。

## Evidence

| ID | Type | Evidence | Status |
| --- | --- | --- | --- |
