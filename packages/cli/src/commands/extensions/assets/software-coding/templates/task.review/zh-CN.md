# Review

Status: not-started

收口前必须写入实际复核结论；初始 not-started 且无 findings 会阻止 task-complete。review 产出 task 裁决（PASS/FAIL），不是 decision 原语。若 review 暴露承重选路问题，再运行 `ha decision propose ...`。

E75：review 前必须已有真实 fact；缺 fact 时先运行 `ha record fact --task <task-id> ...`。

## Reviewer

- Agent: pending
- Mode: read-only review before merge

## Findings

| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
