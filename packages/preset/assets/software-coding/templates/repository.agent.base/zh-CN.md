# Harness Agent Entry

本文件定义本软件仓库的运行规则与系统本体。在这个项目中，Harness 是一套帮助你与人类协作者保持认知对齐、记录演进轨迹的认知台账系统。代码与测试是客观现实，Harness 记录其背后的因果演进。

## Context Loading

- 运行时按需加载，不盲目预载整个代码库或知识树。
- 启动时读取 `harness/harness.yaml` 作为治理基准。
- 承接任务时，只读取当前 `task_plan.md` 及其明确引用的代码与上下文文件，保持上下文轻量精准。

## Worktree Discipline

- 保持工作区隔离：实现工作推荐在独立分支或 worktree 中推进，避免未完成的改动污染主干环境。
- 只提交当前任务所拥有的路径，保护无关文件的既有修改与未提交改动。
- 严格遵循任务声明的 base 分支、合并与清理要求。

## Kernel Workflow

- **单一真源与只读投影（SSoT vs Read Projections）**：Daemon 单写队列与事件流是台账权威真源（由 SQLite Outbox 保证一致性），磁盘上的 `harness/` 文档是只读视图。操作走 `ha` 语义命令，严禁直接手改机读元数据。
- **软件工程中的三元语因果螺旋（The Triad Causal Loop）**：
  - **Fact（事实/测量）**：客观世界的真实观测。软件工程中“没有测量的改动是瞎猜”：修 Bug 前的测试报错堆栈、性能瓶颈的 benchmark 读数、环境与接口的真实输出都是 Fact。承重推断必有事实作锚；默认完成门要求至少一条真实 Fact。
  - **Decision（技术决策）**：不可逆的技术选型与架构取舍（为什么选方案 A 弃方案 B、为什么引入某依赖、边界划分）。承重声明必须有 Fact 支撑（`evidenced-by`），拒绝拍脑袋。
  - **Task（工程交付切片）**：由 Decision 派生的最小受控工作单元。遵循红绿验证，交付终点必须沉淀出新的 Fact（如新增的通过测试、优化后的指标），闭合因果链。
  - **因果螺旋**：实测观测形成 **Fact** → Fact 支撑 **Decision** 裁定 → Decision 派生 **Task** 实现 → Task 产出新 **Fact** 闭环验证。
- 散落的文字提及不能替代正式的 Fact、Decision 或 Relation。

## Relation Rules

- 使用规范的 ID 建立因果边：
  - `derives`：Decision 派生 Task；
  - `evidenced-by`：Fact 作为证据支撑 Decision 的 Claim；
  - `relates`：任务间或工件间的关联；
  - `refines`：决策的演进与修订。

## Write Coordination

- 状态转移、租约获取与关系建立必须经由 `ha` 命令写入。
- 项目长效文档通过 doc-sync 机制同步，路径相对 `harness/`。
- `.harness/` 目录下的临时状态仅本地有效，不纳入版本控制。
