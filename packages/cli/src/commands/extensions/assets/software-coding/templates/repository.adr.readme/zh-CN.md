# ADR

## Usage

- 这个文件夹存放**架构决策记录（ADR）**：面向人的、叙述性的架构选择说明。它是 `../decisions/` 里承重决策的可读投影（见 ADR-0020）。
- 仅当"仓库本地 ADR"比"harness 决策包"更合适时，才在此存放轻量 ADR。
- 承重的 harness 选择优先走 `ha decision propose ...`，让决策获得 lifecycle state、fact 证据与 relation 边，再把 ADR 作为它的叙述投影。
- 已 accept 的 ADR 应从相关 task 或 decision 实体链接过来，保持可追溯。
