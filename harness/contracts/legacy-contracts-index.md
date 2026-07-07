# 20 Contracts 读法

- **状态**: canonical map
- **日期**: 2026-06-13
- **目的**: 给实现合同、schema、CI、review、write coordination、daemon/API 等可执行约束提供统一入口。
- **目标读者**: 实现 worker、reviewer、gate 作者、需要把设计落成代码的人。

`20-contracts/` 是“可执行约束层”。如果 foundation 说系统应该是什么，这里说代码、任务、review 和 gate 必须怎样验证。任务包引用本目录时应指向具体文件和章节，不要只写“读 contracts”。

## 快速选择

| 任务类型 | 必读合同 |
| --- | --- |
| 新任务建包、边界确认 | `14-goal-boundary-contract.md`、`28-review-protocol.md` |
| 风险和不确定性管理 | `16-risk-register-and-confidence-loop.md` |
| Effect TS / Service / Layer 实现 | `17-effect-ts-implementation-contract.md` |
| frontmatter、harness.yaml、snapshot、publish schema | `18-schema-contracts-and-validation.md` |
| 测试、smoke、CI matrix | `19-test-smoke-ci-matrix.md` |
| legacy 维护和迁移 | `20-legacy-maintenance-and-migration-playbook.md`、`24-source-inventory-and-cutover-plan.md` |
| repo/context package tree | `21-repository-context-package-tree.md` |
| agent skill 和 runtime contract | `22-agent-skills-and-runtime-contracts.md` |
| blocker 开工前裁决 | `25-blocker-decision-checklist.md` |
| WriteCoordinator / journal / lock / replay | `37-write-coordination-contract.md` |
| publishNote 安全 | `38-publish-note-safety-contract.md` |
| daemon / REST / WS / terminal / Service mappability | `39-daemon-api-service-contract.md` |
| 脚本执行宿主 / 沙箱 / 回传通道 / script 门面 | `40-script-execution-contract.md` |

## 文档职责

| 文件 | 管什么 | 不管什么 |
| --- | --- | --- |
| `14-goal-boundary-contract.md` | North Star、Done、Non-goals、Evidence 结构 | 单个任务的具体执行记录 |
| `16-risk-register-and-confidence-loop.md` | 风险登记、信心循环、GRILL 结果吸收方式 | 具体代码 diff |
| `17-effect-ts-implementation-contract.md` | Effect TS Service/Layer/Schema/Queue 边界 | GUI 布局 |
| `18-schema-contracts-and-validation.md` | schema 形态、validation、frontmatter/harness.yaml | 某个里程碑是否完成 |
| `19-test-smoke-ci-matrix.md` | test/smoke/CI 的最低矩阵 | GitHub Actions 具体 run 截图 |
| `20-legacy-maintenance-and-migration-playbook.md` | 旧代码维护政策、迁移流程 | 新功能产品愿景 |
| `21-repository-context-package-tree.md` | repo/context/package tree 位置和生成物边界 | 目录美学整理 |
| `22-agent-skills-and-runtime-contracts.md` | skill、runtime origin、repair loop | 人类产品交互 |
| `24-source-inventory-and-cutover-plan.md` | 旧源码清单、cutover 禁止生产导入 | adapter 产品 PRD |
| `25-blocker-decision-checklist.md` | blocker 决策清单 | 已关闭 decision 的历史讨论全文 |
| `28-review-protocol.md` | P0/P1/P2 rubric、review 协议 | 自动生成 review 结论 |
| `37-write-coordination-contract.md` | journal/lock/replay/watermark 细则 | storage 背后的产品理由 |
| `38-publish-note-safety-contract.md` | publishNote marker、幂等、安全边界 | GitHub/Linear adapter 全量 PRD |
| `39-daemon-api-service-contract.md` | daemon API、terminal WS、transport、Service mappability、handler gate | GUI 视觉和 workspace 布局 |
| `40-script-execution-contract.md` | 通用 ScriptHost、脚本 manifest/元数据、沙箱 scope、回传通道、`harness script` 门面 | 具体某个脚本的业务逻辑 |

## 39 号合同的特殊地位

`39-daemon-api-service-contract.md` 是 M2.5 的核心合同。它把用户对 terminal、SSH、remote daemon、tmux/durable session、统一协议、多 transport、分发更新、Service/API 可映射性的讨论落成实现约束。

关键规则：

- GUI 不直接调用业务文件系统逻辑；GUI 通过 daemon/API，daemon handler 再调用 typed Service。
- local 和 remote 不允许两套业务协议；只能是统一 API 的不同 transport。
- terminal session 由 daemon 托管，direct pty 只是降级或最小验证，M2.5 需要 durable backend 设计与验证。
- handler 不承载业务语义，不新增长期 `payload: unknown` 债务。
- 新增 Service 必须能映射到 CLI、GUI、daemon API 的共同 surface。

## 与其他目录的关系

| 目录 | 关系 |
| --- | --- |
| `10-foundation/` | foundation 是概念源；contract 是实现约束源。冲突时先查 decision log，再补低优先级文档。 |
| `30-implementation-start/` | early slice 需要继承这里的 blocker contract。 |
| `40-gui-and-apps/` | GUI 产品行为指向 40；API/terminal/transport 权威源指向 20/39。 |
| `harness/milestones/` | roadmap 定义何时做；contracts 定义做成什么才算过。 |
| `governance/standards/` | governance standard 应从 contracts 提炼可检查规则。 |

## 维护规则

- 合同必须可被 reviewer 或 gate 使用；纯愿景不要放这里。
- 合同变化要同步任务包模板、roadmap status checklist 和治理标准。
- 如果合同增加新禁止项，必须写清楚现存任务是否回溯阻塞。
- GUI/daemon/terminal 相关合同变化必须同步 `40-gui-and-apps/README.md`。
