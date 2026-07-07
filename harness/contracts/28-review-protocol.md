# 28 · 架构 / 实现评审协议

- **状态**: canonical
- **日期**: 2026-06-10
- **目的**: 定义每个文档变更、实现 Slice、外部 adapter、legacy 迁移工具进入主线前必须如何被审查。

## 1. 评审目标

评审不是确认“文档写得像不像”，而是找出会让 rewrite 失败的结构性问题：状态权威、写一致性、公私泄漏、旧代码回流、adapter runtime 泄漏、agent 误用、CI gate 缺失。

## 2. 角色

| 角色 | 职责 |
| --- | --- |
| Author | 写实现或文档；必须列出 Non-goals 和 Stop 条件。 |
| Architecture Reviewer | 对照 00–29 和 13 决策记录查边界。 |
| Hostile Reviewer | 主动寻找 P0/P1；不得只挑措辞。 |
| Migration Reviewer | 只看 legacy 使用、迁移提示、是否误承诺兼容。 |
| Security/Public-Safe Reviewer | 只看 publishNote、redaction、secret、private evidence。 |

小 PR 可合并角色；Slice 2/3/5/6 不可合并 Architecture 与 Hostile Reviewer。

## 3. Severity rubric

| 等级 | 定义 | 示例 |
| --- | --- | --- |
| P0 | 合并后会破坏 load-bearing invariant 或让系统不可恢复 | 无 journal 的 delayed frontmatter write；一个 Task 可绑定两个 engine；外部 comment 未 redaction。 |
| P1 | 真实工作流中高概率失败，但可通过补合同或实现修复 | snapshot stale 未定义；mapping unknown 行为不明确；per-task lock 无跨进程语义。 |
| P2 | 值得修，但不阻断当前 Slice | 命名不够清晰；dashboard 文案；非关键 adapter fixture 不全。 |

## 4. 必审问题

每次评审必须回答：

1. 是否仍符合 clean-room，不生产导入旧 runtime？
2. 是否仍是一 Task 一 engine，不可变？
3. 是否把 local 状态命令与 provider-neutral external transition 混淆？
4. 是否保证 markdown SoT 与 SQLite projection 可重建？
5. 是否有 durable journal / crash recovery / ordering 证据？
6. 是否把 closeout readiness 与 engine done 合并？
7. 是否有 public/private 边界和 redaction fixture？
8. 是否有 `harness check --json` 可被 agent 修复？
9. 是否出现跨引擎聚合或 runtime queue 控制？
10. 是否需要更新 13 决策记录？

## 5. Evidence requirements

PR 描述必须附：

| 类型 | 最低证据 |
| --- | --- |
| Type / build | `tsc -b` 或等价输出。 |
| Unit | 受影响 domain/port/schema tests。 |
| Contract | schema decode / import-boundary / forbidden-symbol scan。 |
| Smoke | 至少一个端到端命令或 fixture。 |
| Crash / concurrency | Slice 2/3 必须有 kill/replay 或 simulated crash。 |
| Security | Slice 6 必须有 secret/redaction/idempotency fixtures。 |
| Migration | legacy 工具必须有 sample legacy package → migration report。 |

## 6. Hostile review procedure

Hostile Reviewer 用以下顺序：

1. 找“第二真理源”：有没有状态同时写文档和外部引擎；有没有 SQLite 成了事实源；有没有 stale cache 被误当 authority。
2. 找“状态合并”：有没有把 `done`、`ready`、`archived` 合成一个词。
3. 找“逃逸接口”：有没有 transition/assign/rerun/cancel 进入 Kernel port。
4. 找“安全捷径”：有没有 agent 生成 comment 直接发外部系统。
5. 找“旧代码回流”：有没有生产 import 旧 `legacy task kernel module` 或旧 `legacy task modules`。
6. 找“无证据自信”：有没有把 open question 当已解决。

输出格式：

```md
## Verdict

Viable / Viable with Changes / Not Viable for this slice

## P0
- [P0-x] Title — concrete failure scenario — cited file/section — required fix

## P1
...

## P2
...

## Required before merge
...
```

## 7. Confidence rule

禁止写“100% 有信心”作为结论。允许写：

> Strategy confidence: High, because every known P0/P1 is named and has a required gate before the slice that could trigger it.

如果存在 unnamed risk、没有 owner 的 P1、没有 gate 的 P0，则 confidence 必须降级。

## 8. Web / external-source rule

涉及外部工具状态模型、Effect API、SQLite/Git 并发、Node/CI 能力、open-source agent 行为时，Reviewer 必须查官方或 primary source。不得凭记忆写“某工具支持 X”。

## 9. Decision update rule

任何 PR 若改变下列事项，必须同步更新 `ha decision show/list` 并要求用户确认：

- 状态词表；
- binding immutability；
- provider-neutral transition 禁令；
- local-first 战略；
- public/private 发布边界；
- 文档 SoT / SQLite projection；
- legacy 兼容承诺。

## 10. Merge gate summary

合并前必须同时满足：

- 无 P0；
- P1 要么修复，要么记录到 25 且不阻断当前 Slice；
- 文档和测试对齐；
- 禁用词扫描通过；
- `harness check` 或相应 checker 输出可机器读；
- reviewer 未发现 scope creep。
