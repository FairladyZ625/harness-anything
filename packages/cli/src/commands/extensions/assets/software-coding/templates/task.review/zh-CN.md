# Review

Status: not-started

收口前必须写入实际复核结论；初始 not-started 且无 findings 会阻止 `ha task complete`。review 产出 task 裁决（PASS/FAIL），不是 decision 原语。若 review 暴露承重选路问题，再运行 `ha decision propose ...`。

E75：review 前必须已有真实 fact；缺 fact 时先运行 `ha fact record --task <task-id> ...`。

## Reviewer

- Agent: pending
- Mode: read-only review before merge

## D8 Stop Condition Checklist

- [ ] 若本任务不是 CI/gate/governance 工作，review 确认没有为了让任务通过而修改 CI/gate 权威面。
- [ ] 若修改了 CI/gate 权威面，review 确认 task 或 PR body 引用了授权 ADR、decision 或 task。
- [ ] 若使用 break-glass，review 确认已记录原因、范围和后续治理任务。

## Findings

| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
