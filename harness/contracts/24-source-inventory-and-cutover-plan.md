# 24 · Source Inventory 与 Legacy Intake Plan

- **状态**: canonical
- **日期**: 2026-06-14

> 2026-06-14 修订：原 `Cutover phases` 中的 default switch/retired cutover 叙事已退役。M2-P7 的 retired cutover 证据保留为历史证据；后续路线改为 Legacy Intake + forward-only dogfood。

## 1. 输入材料清单

| 输入 | 用途 | 处置 |
| --- | --- | --- |
| `kernel-rewrite-2026-06.zip` | 当前 rewrite 设计基线 | 本 final 包以其为基底扩展。 |
| `lifecycle-engine-redesign.zip` | 生命周期外挂设计过程 + GRILL | 吸收关键决策与风险；不作为直接实现目录。 |
| `goal-boundary.zip` | 目标边界 skill | 固化为 14。 |
| `归档.zip` | 当前/旧 Harness 完整源码与 docs | behavior corpus、legacy maintenance/migration evidence。 |
| `cah-multica-feasibility-2026-06-10.tar.gz` | 早期 Multica 可行性包 | 历史参考；旧 dual-sync 路线已废弃。 |

## 2. 旧源码观察

从 `归档.zip` 看到的结构：

```text
scripts/
  domain/
  application/
  adapters/
  infrastructure/
  kernel/task/
  lib/task-lifecycle/**
  commands/**
references/
  testing-standard.md
  ci-cd-standard.md
  ...
docs-release/guides/
  migration-playbook.md
  task-state-machine.md
```

这些说明旧 Harness 已经有：

- CLI / command registry；
- dashboard/projection；
- migration playbook；
- review/workbench；
- lifecycle scanner；
- preset/template machinery；
- testing/CI governance references。

但这些实现把 lifecycle、review、closeout、queue 混在一起，正是 rewrite 的理由。

## 3. Legacy Intake policy

| 旧路径/能力 | V2 处理 |
| --- | --- |
| `legacy lifecycle module` | behavior corpus；不生产导入。 |
| `legacy scanner module` | behavior corpus；projection 逻辑重写。 |
| `legacy task kernel module` | schema/状态词表观察；不兼容。 |
| `references/testing-standard.md` | 原则继承，升级到 19。 |
| `references/ci-cd-standard.md` | 原则继承，升级到 19。 |
| `docs-release/guides/migration-playbook.md` | 迁移经验继承，改为 Legacy Intake。 |
| `docs-release/guides/task-state-machine.md` | 旧状态复杂度证据；不移植状态机。 |

## 4. Superseded cutover phases

以下历史阶段只解释 rewrite 起源，不再作为未来 M2.5/PLT-TaskTree exit criteria：

1. **Harness-Anything bootstrap**：创建 `harness-anything/` 独立 monorepo + `harness/` 私有 harness repo；旧 final-v2 路径只留 pointer。
2. **New package skeleton**：在 `harness-anything/packages/` 创建 kernel/cli/gui/adapters workspace packages，不 import 旧代码，不拆 package 级 Git 子仓库。
3. **New CLI behind experimental bin**：例如 `harness2` 或 feature flag，仅测试使用。
4. **Behavior corpus comparison**：用旧 fixtures 比较输出，差异分类。
5. **Default switch**：不再用 retired cutover 作为证明；改为新任务 forward-only dogfood。
6. **Retirement**：旧 runtime paths 不作为生产依赖；历史任务进入 harness 内 legacy storage。

## 4.1 Replacement strategy

未来替代策略：

1. 新项目或新任务直接使用 Harness Anything 默认布局。
2. 可安全复制的 authored docs 进入 `harness/` 对应位置。
3. 旧 task package 进入 `harness/legacy/tasks/` 并写 index。
4. 未完成旧任务通过 `new-task --from-legacy <id>` 重建。
5. 主线 gate 验证 Legacy Intake readiness、legacy index、collision report、rebuild provenance，而不是 retired cutover。

## 5. No-legacy-dependency gate

CI 扫描规则：

- production code 不得 import `legacy lifecycle module`、`legacy scanner module`、`legacy task kernel module` old files；
- tests 可 import old fixtures，但必须位于 `behavior-corpus/`；
- old path string 出现在 docs/decision log OK，出现在 implementation code fail。

## 6. Behavior corpus 分类

比较旧行为与新行为时，差异必须标记：

| 分类 | 含义 |
| --- | --- |
| preserve | 新实现应保持同等用户结果。 |
| intentional-change | 新架构刻意改变。 |
| old-bug | 旧行为是 bug。 |
| unsupported-input | 旧输入不再支持。 |
| needs-decision | 需要用户/architect 决策，阻断 Legacy Intake / parity corpus acceptance。 |

未分类差异不得合并。

## 7. Release communication

- v1: maintenance line, no new architecture features。
- v2: rewrite line, Legacy Intake assisted but not automatic。
- changelog 必须清楚写破坏性变化：legacy binding record、state machine、dashboard queue、migration semantics。
- `retired cutover` 不得作为未来 release promise；只能以 deprecated historical evidence 出现。
