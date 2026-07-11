# Review

Status: not-started

收口前必须写入实际复核结论；初始 not-started 且无 findings 会阻止 legacy `ha task complete`。Execution Review 产出 `approved`、`changes_requested` 或 `dismissed`，不是 decision 原语。若 review 暴露承重选路问题，再运行 `ha decision propose ...`（ADR-0027 D5）。

对 Execution round，`review/v2` 要记录实际检查的 `evidence_checked` ID（可以为零）、非空语义 rationale、findings，以及 `approved`、`changes_requested`、`dismissed` 之一。locator、digest、归属与 checker receipt 检查只是机械输入，不是充分性 verdict（依据 `dec_mrg3z1we/CH3-CH4`、ADR-0027 D5-D6）。Fact 保持 `0..N` 显式晋升；不得为了通过 review 而把交付 Evidence 复制进 Fact。

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
