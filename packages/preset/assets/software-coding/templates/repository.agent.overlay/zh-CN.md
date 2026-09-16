## Harness CLI (software/coding)

- **通用软件工程实践原则（General Software Engineering Principles）**：
  1. **验证先行（Verification-First / TDD）**：修 Bug 必须先写出或定位复现用例（测试跑红），再编码变绿；添加功能必须有针对性测试，绝不交付未经测试验证的代码。
  2. **做最小有效切片（Minimal Blast Radius）**：选用能满足当前需求的最简实现，不引入猜测性抽象与多余配置；同等正确性下代码越少越好，删除与新增同等计功。
  3. **零非预期回退（Zero Unintended Regressions）**：修改只局限于任务直接涉及的路径，保护项目既有功能与已有测试不受破坏。
- **软件交付的黄金路径（The Golden Path）**：
  1. **创建任务**：`ha task create --title "..."` 明确目标、范围与验收标准；
  2. **获取租约**：`ha task start <task-id>` 获取独占 Lease 保护当前实现，防止多进程并发冲突；
  3. **实施与取证**：在隔离环境中编码与编写测试，使用 `ha fact record --statement "..." --source "..." --task <task-id>` 记录关键测试证据；
  4. **收口提炼（Closeout）**：在 `closeout.md` 中写实 Summary（改动总结）、Verification（测试依据）、Residual Risk（已知风险）和 Same Mechanism Elsewhere（同机制排查）。最后一节写清机制、搜索范围和发现。**重要：系统执行记录（Execution）直接从 closeout.md 提炼吸收**，切忌只更新工件而漏写收口；
  5. **提交与独立把关**：`ha task submit <task-id>` 提交交付包；由独立评审者基于客观测试证据进行复核（执行者严禁自审，自审以 `actor_unauthorized` 拒绝），门禁通过后 `ha task complete <task-id>` 完成销账；
  6. **动态查证**：CLI 完全自描述，随时运行 `ha <command> --help` 或 `ha capabilities` 查看当前命令语法，严禁死记静态命令序列。

## Repository Scaffolds

本项目 Harness 目录结构与职责划分：
- `harness/harness.yaml`：仓库治理配置基准与全局设置。
- `harness/tasks/`：任务包集合。每个任务包独立管理其 `task_plan.md`、`closeout.md` 与工件产物。
- `harness/decisions/`：架构与设计决策台账（记录背景、选型、被否决项及支撑证据）。
- `harness/facts/`：客观证据台账（不可篡改的实测与验证记录）。
- `harness/context/`：项目长效知识库（架构说明、业务指引、集成说明、技术调研）。
- `harness/governance/standards/`：团队或项目约定的工程规范集合。
- 读取各目录自己的 README，不在本文件重复复制细节。

## Architecture-aware Changes

- 大规模修改或模块重构前，优先查阅 `harness/context/architecture/` 中的架构指引与系统分层。
- 遵循项目既定的分层边界与模块依赖方向，不破坏已有的架构契约，不臆造虚假的间接层。

## Governance Routing

进行工程交付与协作时，遵循项目治理规范：
- 仓库变更与分支管理：遵循 `harness/governance/standards/repository-governance.md` 及项目自身约定，保持工作区隔离与清晰提交。
- 技术决策记录：重大选型遵循 `harness/governance/standards/decision-writing.md`，明确 Why 与 Why-Not。
- 团队特有规范：优先读取 `harness/governance/standards/` 下的相关文档或项目根目录的开发指南。

## Script Discovery

- 使用 `ha script list` 与 `ha script inspect <id>` 查看项目中声明的扩展脚本与自动化工具。
- 仅在 inspect 明确报告 execution available 时运行脚本。
