# {{title}}

Task Contract: harness-task v1

## Mission

一句话说明这项工作要让谁获得什么可验证能力。

## Usage Questions

| 问题 | 答案 |
| --- | --- |
| 谁第一个用 | 待填写 |
| 何时强制切换 | 待填写 |
| 旧路径何时废止 | 待填写 |

## Wave Decomposition

| 波次 | 目标 | 子任务锚 | 验收要点 |
| --- | --- | --- | --- |
| W0 | charter / canonical 对齐 | 待创建 | decision 与工作地图对齐 |
| W1 | 第一批可用能力 | 待创建 | 可被第一个使用方消费 |
| W2 | 收口与回归 | 待创建 | checker、gate、使用证明齐备 |

## Exit Criteria

- [ ] 结构正义：本工作的根任务、子任务树、本工作地图与 charter decision 锚齐备。
- [ ] 语义验收：Mission、使用侧三问、依赖入口和任务映射与实际执行一致。
- [ ] 对抗验证：引用 gate-retro 双镜头，覆盖已知缺陷 registry 复核与新增 diff 面扫描。
- [ ] 使用证明：第一个使用方已经按新路径消费，残余项有 owner 和后续入口。

## Context

- 工作地图：本 `task_plan.md`；工作 = 本根任务 + 其子任务树。
- 状态视图：`ha work show <根任务 id>`；`ha agenda --work <根任务 id>` 只看本工作的 agenda。
- Charter decision：`dec_*`，由 CEO 裁决后填写；本 preset 只校验存在，不代创建。

## Required Reading

按顺序列出 charter decision、本工作地图、相邻工作与承重代码/契约，并标明哪一份是冲突时的最终权威。

## Entry Conditions

列出进入本工作前必须已成立的产品裁决、使用方承诺与前置能力；未满足时不得启动对应波次。

## Dependencies

列出跨 task、跨波次与外部使用方的依赖/交接，给出 owner、就绪证据与下游接收方。

## Execution Surface

声明各波次使用的仓库、worktree、分支/base 与写入边界。具体绝对 `cwd` 由每次派工参数注入。

## PR/merge Operations

- 全局 merge-health 运维台账：`task_01KWYKCPG5FZA3AFVX9R8XX3B7`（Authority: `decision/dec_mrat6152`）。
- CEO / orchestrator 对 worktree 清理负责：每合并一个 PR 即清理对应远端分支、本地分支和 worktree，并定期 sweep；worker 结构性不会替全局清理。
- 同一 PR 两次入队仍合不进，视为系统信号：先读全局台账 facts，再跑 `npm run pr:doctor`，处置后把事件、尝试和结论作为 fact/progress 落回全局台账。

## Constraints

- 工作 = 根任务 + 其父子子树；本计划是工作地图，子树是执行面。
- 遵循 create-work guidance 和仓库内相邻样板。
- 不为 pre-public-release 以外的外部消费者加兼容 shim、dual-read、backfill 或迁移。

## Checkpoint

- 根任务创建后，先填好本工作地图，再建子任务。
- 每批波次完成时，对齐子任务树、本地图、`ha work show` 与 evidence。
- 进入 closeout 前，必须补齐 done 四层制与 gate-retro 双镜头证据。

## Implementation Plan

- 创建或确认 charter decision，并让它的 `dec_*` 锚出现在本工作地图中。
- 运行 `ha work create --title "<name>"` 建工作根。
- 阅读 create-work `PRESET.md`、`harness.yaml` 和相邻工作；保持本地图最新。
- 用 `ha task create --work <根任务 id>` 建每个子任务，保持波次表与 `ha work show` 同步。
- 校验链接、必需章节、重复行与状态一致性；运行相关仓库检查并记录 evidence。

## Deliverable Contract

写明本工作最终产物、落点、接收者、第一个使用方，以及每个波次必须回交的 task 级产物与状态。

## Evidence Protocol

写明使用证明与 reviewer 拒收条件；修复缺陷时再写明阴性对照或变异检查；不得用汇总性的「已通过」代替实际 runner 输出和消费证据。

在工作收口前闭合回环：至少用 `ha fact record --task <task-id> ...` 记录一条观察，并把回执保存在 Execution outputs 中。Fact 是 decision 的 evidence 输入，因此在接受或 reckon 该 decision 前，用 `ha relation relate --source-ref decision/<decision-id>/<claim-id> --target-ref fact/F-XXXXXXXX --type evidenced-by --rationale "<why>" --expected-version 0` 把它挂到对应主张上。如果 proposal 还没有 fact evidence，`ha decision propose` 仍会成功，但回执会指向这两个命令。

## Verification

- 本工作通过相关仓库检查与人工对账。
- 工作根、本地图、`ha work show` 与 charter decision 锚互相可追。
- 依据 `dec_mrg3z1we/CH4`，承重观察按需显式晋升为 `0..N` 条 Fact；交付证据放在 Execution outputs，不对 review 或 completion 设置 Fact 数量门。
