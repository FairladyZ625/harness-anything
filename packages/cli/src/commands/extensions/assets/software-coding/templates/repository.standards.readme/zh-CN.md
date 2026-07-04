# Standards

## 用途

这个文件夹存放**仓库级标准（standards）**：治理约定、编码/流程规范等长期有效、跨任务复用的规则。`AGENTS.md` 只做薄指针，具体规则的事实源在这里。

## 怎么用

- 每份标准是一个独立 `.md`（如 `repo-governance.md`）。Agent 在动手前按 `AGENTS.md` 的任务阅读矩阵，只加载当前任务相关的标准，不要全量灌。
- 标准是"怎么做事"的规则集；它不是决策记录（承重选择 → `../decisions/`），也不是架构事实（系统结构 → `../context/architecture/`）。
- 新增/修改标准应保持单一事实源：一条规则只在一处定义，别在 `AGENTS.md` 和这里各存一份（ADR-0021 D3 反漂移原则）。

## 放什么 / 不放什么

- ✅ 放：治理约定、目录/命名规范、提交与分支规范、复用度高的流程规则。
- ❌ 不放：一次性任务说明、承重的架构选择（→ decisions/adr）、随时间变化的运行时事实（→ context）。

## 相关命令

标准以 authored 文档维护并纳入 checker 校验；`repo-governance.md` 由 init 的 `repository.governance` seededDoc 物化。
