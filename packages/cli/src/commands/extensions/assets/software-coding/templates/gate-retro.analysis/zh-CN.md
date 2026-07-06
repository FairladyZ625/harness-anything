# Gate 架构回溯分析骨架

> 这是编辑骨架。最终报告写入 `artifacts/gate-retro.analysis.md`; 本文件保留为写作指引。

<!-- gate-retro:ground-truth-warning -->
## Ground-Truth Rule

每条架构腐烂指控都必须带可复现证据:命令 + 输出。禁止纯印象报告。本轮 171→162 基线勘误就是显著教训:凭记忆转述的数字不是证据。

先用 `artifacts/gate-retro.snapshot.json` 做机器上下文,再用命令验证 claim,最后再写 finding。

<!-- gate-retro:snapshot-summary -->
## Snapshot Summary

- Snapshot: `artifacts/gate-retro.snapshot.json`
- Gate surface command: `node tools/check-gate-surface.mjs`
- PR approximation command: `npm run check:pr`
- Full command: `npm run check`
- Previous snapshot used:
- New files/modules since previous snapshot:
- check:pr vs check difference:

<!-- gate-retro:adr-checklist -->
## ADR-0022 D6 Checklist

每条 finding 都要回答四问。

| Question | Answer | Evidence ref |
| --- | --- | --- |
| Boundary gate 还是 local-consistency? |  |  |
| 图不变量是否使用 AST import 层、import graph 或等价图工具? |  |  |
| 权威是否在 gate 实现外部? |  |  |
| boundary claim 是否有 documented bypass fixture? |  |  |

ADR-0023 D4 提醒:架构评审只能引用 boundary / release-policy / meta-governance 证据。local-consistency gate 不能证明架构边界守住了。

<!-- gate-retro:defect-patterns -->
## Defect Pattern Attribution

把每个确认的 friction 归因到一个或多个 ADR-0022 缺陷模式。

| Pattern | Applies? | Evidence ref |
| --- | --- | --- |
| regex 守图不变量 |  |  |
| 权威自指 |  |  |
| 权威可同 PR 改写 |  |  |
| ADR 有文无码 |  |  |
| 执法面发散 |  |  |

<!-- gate-retro:evidence-ledger -->
## Reproducible Evidence Ledger

每条 claim 一段证据。没有这种证据块,不得写腐烂 finding。

<!-- finding:start -->
### Finding: 替换为 claim 标题

- Severity: local / boundary / load-bearing
- ADR-0022 D6 category: boundary / local-consistency
- ADR-0022 defect pattern:
- ADR-0023 D4 evidence class:
- Claim:

Command:

```sh
# command run from repository root
```

Output:

```text
# paste relevant output; do not paraphrase the only evidence
```

Interpretation:

Decision/ADR projection:

- 如果是承重问题,运行 `ha decision propose ...` 并在这里引用 decision ref。
- 如果不是承重问题,说明为什么不需要 decision。
<!-- finding:end -->

<!-- gate-retro:decision-projection -->
## Decision / ADR Projection Gate

| Load-bearing issue | Decision proposed? | Decision ref | ADR projection needed? | Owner |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

如果承重问题只停留在报告里,本报告不完整。必须先落 decision,必要时再投影到 ADR。

<!-- gate-retro:verdict -->
## Verdict

- Overall status: no new rot / monitor / decision proposed / blocked
- Required follow-up tasks:
- Residual risk:

