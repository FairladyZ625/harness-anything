# Decisions

## 用途

这个文件夹是本仓库**承重决策（load-bearing decision）的实体存储**。每个决策是一个 `decision-<id>/` 子目录，内含 `decision.md`（`decision-package/v1`）。这里是"为什么这么选"的事实源；ADR 是它面向人的叙述投影（见 `../adr/README.md` 与 ADR-0020）。

## 怎么用

- **不要手写/手改这里的 markdown**。决策走命令：`ha decision propose ...` 立项、`ha decision accept ...`（或 reject/defer/supersede）裁决、`ha decision relate ...` 连证据、`ha decision amend ...` 维护状态。CLI 负责写 frontmatter、lifecycle state、fact 证据与 relation 边。
- 一个决策承载：`question` / `chosen` / `rejected(+why_not)` / `claims` / `relations`。承重的 why 属于这里，不属于散落的 prose 台账。
- 决策与 task/fact 的关联用 relation 记录（`decision -> task` implements、`fact -> decision` supports 等），不要只靠正文口头引用。

## 放什么 / 不放什么

- ✅ 放：需要 lifecycle + 证据 + 关系的承重选择。
- ❌ 不放：一次性的实现笔记（进 task 的 `progress.md`）、纯观察事实（record 成 fact 进 task 的 `facts.md`）、面向人的长篇论证叙述（那是 `adr/`）。
- ❌ 不放：手写的 `.md`。目录内容由 `ha decision propose` 等命令派生，手改会与投影漂移。

## 相关命令

`ha decision propose` · `ha decision accept` · `ha decision list` · `ha decision relate`
