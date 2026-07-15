# {{title}}

Task Contract: harness-task v1

## Mission

一句话说明这个 milestone 要让谁获得什么可验证能力。

## Usage Questions

| 问题 | 答案 |
| --- | --- |
| 谁第一个用 | 待填写 |
| 何时强制切换 | 待填写 |
| 旧路径何时废止 | 待填写 |

## Wave Decomposition

| 波次 | 目标 | 子任务锚 | 验收要点 |
| --- | --- | --- | --- |
| W0 | charter / canonical 对齐 | 待创建 | decision、map、roadmap、dossier 对齐 |
| W1 | 第一批可用能力 | 待创建 | 可被第一个使用方消费 |
| W2 | 收口与回归 | 待创建 | checker、gate、使用证明齐备 |

## Exit Criteria

- [ ] 结构正义：本 milestone 的 root task、task tree、`00-overview.md`、`00-roadmap.md`、`dossier-data.md` 与 charter decision 锚齐备。
- [ ] 语义验收：Mission、使用侧三问、依赖入口和任务映射与实际执行一致。
- [ ] 对抗验证：引用 gate-retro 双镜头，覆盖已知缺陷 registry 复核与新增 diff 面扫描。
- [ ] 使用证明：第一个使用方已经按新路径消费，残余项有 owner 和后续入口。

## Context

- 映射文档：`harness/milestones/<line>/<slug>/00-overview.md`
- 路线图：`<harness root>/milestones/00-roadmap.md`
- 结构化表：`harness/milestones/dossier-data.md`
- Charter decision：`dec_*`，由 CEO 裁决后填写；本 preset 只校验存在，不代创建。

## PR/merge 运维

- 全局 merge-health 运维台账：`task_01KWYKCPG5FZA3AFVX9R8XX3B7`（Authority: `decision/dec_mrat6152`）。
- 治理文档：`harness/governance/standards/merge-queue-troubleshooting-standard.md`。
- CEO / orchestrator 对 worktree 清理负责：每合并一个 PR 即清理对应远端分支、本地分支和 worktree，并定期 sweep；worker 结构性不会替全局清理。
- 同一 PR 两次入队仍合不进，视为系统信号：先读全局台账 facts，再跑 `npm run pr:doctor`，处置后把事件、尝试和结论作为 fact/progress 落回全局台账。

## Constraints

- milestone = root task 任务树（执行面）+ 映射文档（理解面）。
- 遵循 create-milestone guidance 和仓库内相邻样板，只在配置的 milestones root 下写入。
- 不为 pre-public-release 以外的外部消费者加兼容 shim、dual-read、backfill 或迁移。

## Checkpoint

- root task 创建后，先建立 milestone map，再拆子任务。
- 每批波次完成时，对齐 task tree、map、状态视图与 evidence。
- 进入 closeout 前，必须补齐 done 四层制与 gate-retro 双镜头证据。

## CI/Gate Authority Stop Condition

如果本 milestone 不是 CI/gate/governance 工作，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。唯一例外是任务明确授权 CI/gate/governance 改动，或紧急修复 main 的 break-glass；break-glass 必须记录原因、范围和后续治理任务。

## Implementation Plan

- 创建或确认 charter decision，并让它的 `dec_*` 锚出现在每个 milestone 视图中。
- 运行 `ha task create --title "<name> 里程碑(root)" --vertical software/coding --preset create-milestone --long-running`。
- 阅读 create-milestone `PRESET.md`、`harness.yaml` 和相邻 milestone；在配置的 milestones root 下创建或更新 overview、index、summary 与状态视图。
- 用 root task fan out 子任务，保持任务映射表与 task tree 同步。
- 校验链接、必需章节、重复行与状态一致性；运行相关仓库检查并记录 evidence。

## Verification

- milestone 文件面通过相关仓库检查与人工对账。
- root task、map、roadmap、dossier-data 与 charter decision 锚互相可追。
- 依据 `dec_mrg3z1we/CH4`，承重观察按需显式晋升为 `0..N` 条 Fact；交付证据放在 Execution outputs，不对 review 或 completion 设置 Fact 数量门。
