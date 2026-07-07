# Gate 架构回溯分析骨架

> 这是编辑骨架。最终报告写入 `artifacts/gate-retro.analysis.md`; 本文件保留为写作指引。

<!-- gate-retro:ground-truth-warning -->
## 事实基准规则

每条架构腐烂指控都必须带可复现证据:命令 + 输出。禁止纯印象报告。本轮 171→162 基线勘误就是显著教训:凭记忆转述的数字不是证据。

先用 `artifacts/gate-retro.snapshot.json` 做机器上下文,再用命令验证声明,最后再写发现。

<!-- gate-retro:snapshot-summary -->
## 快照摘要

- 快照: `artifacts/gate-retro.snapshot.json`
- Gate surface 命令: `node tools/check-gate-surface.mjs`
- PR 近似命令: `npm run check:pr`
- 完整命令: `npm run check`
- 已使用的上一份快照:
- 相比上一份快照新增的文件/模块:
- check:pr 与 check 的差异:

<!-- gate-retro:adr-checklist -->
## ADR-0022 D6 检查清单

每条发现都要回答四问。

| 问题 | 答案 | 证据引用 |
| --- | --- | --- |
| 属于 boundary gate 还是 local-consistency? |  |  |
| 图不变量是否使用 AST import 层、import graph 或等价图工具? |  |  |
| 权威是否在 gate 实现外部? |  |  |
| boundary claim 是否有已记录的 bypass fixture? |  |  |

ADR-0023 D4 提醒:架构评审只能引用 boundary / release-policy / meta-governance 证据。local-consistency gate 不能证明架构边界守住了。

<!-- gate-retro:defect-patterns -->
## 缺陷模式归因

把每个确认的摩擦归因到一个或多个 ADR-0022 缺陷模式。

| 模式 | 是否适用 | 证据引用 |
| --- | --- | --- |
| regex 守图不变量 |  |  |
| 权威自指 |  |  |
| 权威可同 PR 改写 |  |  |
| ADR 有文无码 |  |  |
| 执法面发散 |  |  |

<!-- gate-retro:evidence-ledger -->
## 可复现证据台账

每条声明一段证据。没有这种证据块,不得写腐烂发现。

<!-- finding:start -->
### 发现: 替换为声明标题

- 严重程度: local / boundary / load-bearing
- ADR-0022 D6 分类: boundary / local-consistency
- ADR-0022 缺陷模式:
- ADR-0023 D4 证据类别:
- 声明:

命令:

```sh
# command run from repository root
```

输出:

```text
# paste relevant output; do not paraphrase the only evidence
```

解读:

决策/ADR 投影:

- 如果是承重问题,运行 `ha decision propose ...` 并在这里引用 decision ref。
- 如果不是承重问题,说明为什么不需要 decision。
<!-- finding:end -->

<!-- gate-retro:decision-projection -->
## 决策 / ADR 投影 Gate

| 承重问题 | 是否已提议决策 | 决策引用 | 是否需要 ADR 投影 | 负责人 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

如果承重问题只停留在报告里,本报告不完整。必须先落 decision,必要时再投影到 ADR。

<!-- gate-retro:verdict -->
## 结论

- 整体状态: 无新增腐烂 / 持续观察 / 已提议决策 / 阻塞
- 必需后续任务:
- 剩余风险:
