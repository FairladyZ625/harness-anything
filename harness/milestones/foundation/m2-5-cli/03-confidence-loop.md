# M2.5-CLI · Confidence Loop

- **状态**: canonical-preimplementation-review
- **日期**: 2026-06-14

## 1. 信心结论

对新策略有实现级信心，但不是“什么都不查就 100%”。经过漏洞扫描后，剩余风险均可通过 M2.5-CLI packet 覆盖，不需要推翻策略。

最终策略成立的理由：

- 用户已明确拒绝复杂历史任务迁移；Legacy Intake 的目标更小、更可验证。
- 旧任务不进入 active task tree，避免状态映射、schema rewrite、路径重写和嵌套关系重建四类高风险。
- 可安全复制的文档与 task package 分开处理，降低迁移 blast radius。
- 所有降级影响都被列为明确 packet，而不是靠口头“以后改”。

## 2. 漏洞扫描与修复

| 漏洞 | 风险 | 修复 |
| --- | --- | --- |
| 降级后旧 `retired cutover` gate 仍在 `npm run check` | 后续实现被历史 gate 卡住，或者 agent 误以为还要 retired cutover | TP-M2.5-CLI-13 替换 scripts/gates；M2 文档标 historical/deprecated |
| Legacy 位置若在 repo 根级 `legacy/` | 与 harness authored state 分裂，GUI/CLI 不好统一索引 | 固定为 authored harness root 下 `harness/legacy/` 或等价 |
| 同名复制策略不明确 | 一键 intake 可能覆盖用户文件 | 后缀钉死：dir `-legacy-import-N`，file `.legacy-import-N` |
| “Preset 搬模板”误解 | 7 个 preset 会被实现成模板正文复制，污染抽象 | 明确：模板素材进入 vertical template catalog；preset 只选择/组合/收紧 |
| Dev mode 归属不清 | custom vertical 被普通项目误开启 | user/app-local dev-mode + project `harness.yaml` gate 双层 |
| 未完成旧任务重建不可追溯 | 新旧任务关系丢失，审计困难 | `new-task --from-legacy <id>` 必做 |
| locale fallback 静默 | 用户以为双语模板完整但实际降级 | check 输出 fallback warning |
| schema 新字段无版本策略 | 以后 project config 漂移 | schema version bump + compatibility tests |
| CLI/GUILayout 并行抢定义 | GUI 先实现旧语义，返工 | 先 CLI 再 GUI；GUI 消费稳定 Service/CLI contract |
| completion 只靠事后 check | agent 可绕过 review 直接 done | 命令面硬拦 terminal status；`task-complete` sanctioned；`--force` 可审计 |
| preset deletion 复杂度爆炸 | anchor/mutability/requiredWhen 变成过度控制 AI | 砍掉删除机制；Vertical 保持最小核心，Preset 只叠加 |
| relation/nesting 被塞进 M2.5 | M2.5 被 PLT-TaskTree 级复杂度拖住 | 明确 PLT-TaskTree owns parent/child/DAG/task tree；M2.5 不碰 relation schema |

## 3. Go 条件

可以开始写 M2.5-CLI 的前提：

- 本目录 `00-overview.md`、`01-feature-breakdown.md`、`02-status-checklist.md` 完成。
- `ha decision show E21` / `ha decision show E22` 记录相关裁决。
- `harness/contracts/20` 和 `harness/contracts/24` 不再把 retired cutover 当未来策略。
- `harness/milestones/README.md` 把 M2.5 拆成 CLI 与 GUI 两条。

以上条件满足后，策略层面可以进入实现；实现必须继续按 packet 做 targeted review 和 `npm run check`。
