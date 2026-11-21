## Office Collaboration (office/collab)

- 结构化报告、方案、规范、简报或核对表使用 `deliverable-task`。
- 跨人或跨角色移交职责时使用 `handoff-task`。
- 将会议讨论转化为带责任人的行动项时使用 `minutes-task`。

## Deliverables and Freshness

- 在 `verified` / `upstream-verified` profile 下，随交付文档一并提交 `artifacts/deliverable-manifest.json`（跟踪上游基线时同时提交 `artifacts/upstream-freshness.json`）。
- 若上游基线发生变更，须刷新交付内容并更新基线摘要后再修订提交。

## Handoff Discipline

- 正式工作交接须提交 `artifacts/handoff.json`，完整包含 `ownerTransfer`、`deliverables`、`openItems` 与 `acceptanceCriteria` 四要素。

## Meeting Minutes

- 在 `minutes.md` 中完整记录会议元数据、关键结论、带责任人与截止期的行动项以及待决问题。
