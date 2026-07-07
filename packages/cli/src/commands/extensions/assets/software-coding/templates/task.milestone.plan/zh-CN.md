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
- 路线图：`harness/milestones/00-roadmap.md`
- 结构化表：`harness/milestones/dossier-data.md`
- Charter decision：`dec_*`，由 CEO 裁决后填写；本 preset 只校验存在，不代创建。

## Constraints

- milestone = root task 任务树（执行面）+ 映射文档（理解面）。
- 不手搓 milestone 文件面；创建后运行 create-milestone scaffold/check。
- 不为 pre-public-release 以外的外部消费者加兼容 shim、dual-read、backfill 或迁移。

## Checkpoint

- root task 创建后，先运行 scaffold 生成五件套，再拆子任务。
- 每批波次完成时，运行结构 checker 并把输出作为 progress evidence。
- 进入 closeout 前，必须补齐 done 四层制与 gate-retro 双镜头证据。

## CI/Gate Authority Stop Condition

如果本 milestone 不是 CI/gate/governance 工作，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。唯一例外是任务明确授权 CI/gate/governance 改动，或紧急修复 main 的 break-glass；break-glass 必须记录原因、范围和后续治理任务。

## Implementation Plan

- 创建或确认 charter decision，并把 `dec_*` 作为 scaffold 输入。
- 运行 `ha task create --title "<name> 里程碑(root)" --vertical software/coding --preset create-milestone --long-running`。
- 运行 `ha script run preset:create-milestone:scaffold --task <root-task-id> --input line=<line> --input slug=<slug> --input charterDecision=dec_* --input milestoneName="<name>" --input mission="<mission>"`。
- 用 root task fan out 子任务，保持任务映射表与 task tree 同步。
- 反复运行 `ha script run preset:create-milestone:check --task <root-task-id> --input line=<line> --input slug=<slug>`。

## Verification

- create-milestone checker 输出 green。
- root task、map、roadmap、dossier-data 与 charter decision 锚互相可追。
- E75 门：进入 review / complete 前必须已有至少一条真实 fact。
