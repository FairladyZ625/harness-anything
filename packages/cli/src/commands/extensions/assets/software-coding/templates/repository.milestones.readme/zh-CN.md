# Milestones

## 用途

这个文件夹存放**里程碑与路线图（roadmap）**：交付路线、产品线分组、里程碑状态、以及每个里程碑的宪章/exit 记录。它回答"我们要按什么顺序交付什么、现在到哪了"。

## 怎么用

- 顶层放全局视图：路线图总表、决策台账索引（`00-decision-ledger.md`）、产物契约模板、parity / implementation-status 矩阵。全局路线图正文见同目录的 `00-roadmap.md`。
- 每条产品线一个子目录（如 `foundation/ platform/ gui/ product/ commercial/`），每个里程碑在对应产品线目录内建自己的文件夹。
- 里程碑推进属于**编排/规划活动**，不是承重架构选择；承重选择请开 decision（`../decisions/`）并从里程碑文档指针过去，不要在这里重述决策内容。

## 放什么 / 不放什么

- ✅ 放：路线图、里程碑状态与 exit gate 记录、跨里程碑的 parity/status 矩阵、产品线分组。
- ❌ 不放：单个决策的完整论证（→ `../decisions/` + `../adr/`）、日常任务进展（→ task package）、技术架构事实源（→ `../context/architecture/`）。

## 相关命令

里程碑目前以 authored 文档维护；跨里程碑的承重选择用 `ha decision propose ...` 落库，再从这里指针引用。
