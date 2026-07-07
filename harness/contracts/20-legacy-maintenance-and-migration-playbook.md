# 20 · Legacy Maintenance 与 Legacy Intake Playbook

- **状态**: canonical
- **日期**: 2026-06-14
- **证据源**: `archive/docs-release/guides/migration-playbook.md`、`archive/docs-release/guides/task-state-machine.md`、`archive/references/testing-standard.md`

> 2026-06-14 修订：本文 supersedes 旧 bulk migration / retired cutover 叙事。未来只承诺 Legacy Intake、agent-assisted rebuild 和 forward-only dogfood。

## 1. 版本策略

| 线 | 名称 | 策略 |
| --- | --- | --- |
| Legacy Harness | v1 / current package | 继续维护 bugfix、security、documentation、critical install/runtime breakage；不加新功能。 |
| Rewrite Harness | v2 / clean-room kernel | 所有新功能进入此线：LifecycleEngine、local engine、WriteCoordinator、TemplateLibrary、new dashboard。 |

硬规则：不要在 v1 中实现 v2 架构能力；那会延长双线痛苦。

## 2. 兼容声明

- v2 不保证读取 v1 task package 后得到相同 lifecycle/dashboard 状态。
- v2 不保证 `legacy binding record`、旧 task state guide、旧 dashboard queues 的 schema 兼容。
- v2 提供 **Legacy Intake** 与 agent-assisted rebuild；migration 是重建，不是自动兼容。
- v1 历史任务的最终事实仍由用户/agent 审阅确认。

## 3. Legacy Intake，而不是 bulk migration

```text
legacy scan → safe docs copy plan → legacy index → user/agent review → create new task from legacy → attach evidence pointers
```

Intake ledger 记录：

| 字段 | 含义 |
| --- | --- |
| `sourcePath` | 旧任务/文档路径 |
| `detectedState` | 从旧 scanner/文档推测的状态，仅供参考 |
| `evidencePointers` | progress/review/walkthrough/commit/PR links |
| `recommendedTreatment` | preserve / recreate / supersede / archive / ignore |
| `confidence` | high/medium/low |
| `humanReviewRequired` | 是否必须人工确认 |
| `newTaskCandidate` | 可选的新 v2 task draft |

## 3.1 Legacy storage

Legacy storage 必须位于 authored harness root 下，推荐布局：

```text
harness/
  legacy/
    index.json
    collision-report.json
    docs/
    tasks/
    rebuild-guide.md
```

禁止在 repo 根级另建独立 `legacy/` 根。Legacy 是 harness 的历史证据区，必须可被 CLI/GUI/daemon 通过 harness layout 统一发现。

## 3.2 Copy collision policy

Legacy copy 永不覆盖目标路径。

| 类型 | 冲突后缀 |
| --- | --- |
| 目录 | `-legacy-import-N` |
| 文件 | `.legacy-import-N` 插入扩展名前 |

示例：

- `standards` → `standards-legacy-import-1`
- `repo-governance.md` → `repo-governance.legacy-import-1.md`

每次冲突必须写入 collision report，包含 source path、target path、chosen path、reason。

## 4. 命令面建议

V2 可以实现以下迁移命令：

```bash
harness legacy scan <path> --json
harness legacy intake-plan <path> --out legacy-intake.md
harness new-task --from-legacy <id> --json
harness legacy link-evidence <new-task> --source <old-path>
harness legacy archive-source <old-path> --reason <reason>
```

所有写命令默认需要 `--apply`；无 `--apply` 只读。

旧 `migrate-*` 命令若保留，只能作为兼容 alias 或 thin wrapper 指向 Legacy Intake；不得继续承诺 full semantic migration 或 retired cutover。

## 5. 迁移模式

| 模式 | 何时使用 | 写入策略 |
| --- | --- | --- |
| preserve-only | 历史任务已完成，只需保留证据 | 不创建新 task；生成 legacy index。 |
| active-recreate | 历史任务仍在执行 | `new-task --from-legacy <id>` 创建新 task，搬关键 evidence pointer，不机械复制旧状态。 |
| semantic-rewrite | 用户明确要求把历史任务变成 v2 可读包 | 仅作为 agent rebuild 流程；agent 读取旧材料后重写 task_plan/findings/progress；需要 review。 |
| supersede | 旧任务方向已变 | 新 task `supersedes` 旧 path/ref；旧任务归档。 |

### 5.1 旧 schema 字段对照(仅 migration 工具实现者需要;从 02 迁来,实现主干文档不再保留考古内容)

Legacy scanner 读取旧任务包时按此表识别与建议；任何旧字段都不得原样进入 v2 schema:

| 旧(v1 legacy binding record / 状态) | v2 处置 |
| --- | --- |
| `legacy binding record`/`ExternalTaskRef` 独立 schema | 翻译为 `LifecycleBinding` frontmatter 块 |
| `syncMode` | 丢弃(v2 无 sync 概念) |
| `bindingRole` | 丢弃；M2.5 Legacy Intake 不生成 Relation。父子、DAG、depends-on、blocks 等关系产品化归 PLT-TaskTree；旧关系线索只进入 legacy index/evidence note，供后续重建时人工/agent 参考。 |
| `stateBackend`/`issueBackend` 双字段 | 合并翻译为单一 `engine` |
| sync log / drift records | 丢弃 |
| `titleSnapshot` | 保留(展示用) |
| 旧三套状态词表(`taskStates`/`lifecycleStates`/`closeoutStates`) | 经迁移映射表翻译到三轴;无法翻译的进 intake report 由人裁决 |


## 6. 老版本维护范围

允许：

- install/build/package bug；
- security issue；
- data-loss bug；
- migration helper docs；
- critical checker false positive 修正。

拒绝：

- 把 LifecycleEngine 接进 v1；
- 在 v1 中新增三轴状态；
- 在 v1 中实现 WriteCoordinator；
- 让 v1 dashboard 支持 mixed engines；
- 让 v1 legacy binding record 兼容 v2 binding。

## 7. 迁移验收

一次 Legacy Intake 完成必须提供：

- scan output；
- intake ledger；
- legacy index；
- collision report；
- 创建的新 task 列表；
- 未迁移项与理由；
- human review notes；
- `harness check` 输出；
- legacy source 未被覆盖/删除的证据。

## 8. 用户文案

建议公开说法：

> v2 是 clean-room rewrite。我们会继续维护 v1 的稳定性与安全问题，但新功能只进入 v2。v1 历史任务不会被自动“升级”；我们提供 Legacy Intake、可索引历史证据、证据链接和 agent-assisted 重建工具，帮助你把仍然有价值的历史工作安全带入 v2。
