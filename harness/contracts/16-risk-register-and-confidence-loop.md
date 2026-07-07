# 16 · Risk Register 与 Confidence Loop

- **状态**: canonical
- **日期**: 2026-06-10

## 1. 信心定义

我不把“100% 信心”定义为不会出 bug；那是不真实的。这里采用工程可执行定义：

> 在写第一行代码前，所有已知 P0/P1 风险都已被命名，并且每个风险都有明确的 mitigation：设计不变量、实现 contract、测试 gate、slice stop condition 或必须回答的问题。

按这个定义，本目录达到 **strategy-level high confidence**；implementation-level confidence 取决于 Slice 2 的 write-coordination-contract 和 Slice 6 的 publish-note-safety 是否按本目录补齐。

## 2. Grill 后风险重判(clean-room rewrite 前提)

| 原 Grill finding | clean-room rewrite 下的新判断 | 状态 |
| --- | --- | --- |
| P0: 现有 states.mts 与 canonical 6 态矛盾 | 解除为兼容风险；旧代码被替换，不约束新模型。 | dissolved |
| P0: policies.mts 已驱动 transition，否定“无 transition” | 改写为命名精确性风险：Kernel 无 provider-neutral transition；LocalEngine 有 local 原生命令。 | resolved by 03 §5 / 07 |
| P1: closeout 与状态不对齐会让归档卡住 | 转为三轴联合评估风险；归档属于 packageDisposition，不由 done 自动触发。 | resolved by 02 §3 / 05 §4 |
| P1: legacy binding record 删除破坏现有测试 | clean-room 下允许破坏；需要 legacy importer 而非兼容 schema。 | dissolved + migration playbook |
| P1: 引擎不可达时 check 失明 | 仍然有效，已补 stale 三态 + last-known snapshot。 | resolved if implemented |
| P1: mapping 放 Vertical 会 N×M 爆炸 | 仍然有效，已改为 Engine-owned mapping。 | resolved |
| P1: 写队列 prior art 不存在 | 仍然有效，已改为“方向验证，需新建 WriteCoordinator”。 | open until Slice 2 |
| P1: 绑定不可变无法强制 | 仍然有效，已补 fingerprint + writer 拒绝 + checker。 | resolved if tested |

## 3. 当前 P0 风险

| ID | 风险 | 失败场景 | Mitigation | Gate |
| --- | --- | --- | --- | --- |
| P0-R1 | WriteCoordinator 不够强 | 两个 agent 同时改同一 task，SQLite 显示 active 但 Markdown 丢状态；clone 后世界变了。 | Slice 2 前锁定 WAL/journal、per-task lock、same-task FIFO、watermark、crash replay。 | kill-before-flush test + rebuild invariant |
| P0-R2 | Binding immutability 未机器强制 | 用户或 agent 手改 `lifecycle.engine` 把 local task 伪装成 multica task。 | binding fingerprint、writer denylist、checker `binding_tampered`。 | tamper fixture |
| P0-R3 | publishNote 泄密 | closeout publish 把 private findings/raw log/token 发到 Multica/GitHub comment。 | `PublishableProjection` 类型化构造 + redaction scanner + idempotency key。 | redaction fixture + type test |
| P0-R4 | 旧代码漏进新内核 | 为了快，implementation import 旧 scanner/policy，重新带回三套状态机。 | `no-legacy-dependency` import graph gate；旧路径 retirement checklist。 | CI import scan |

## 4. 当前 P1 风险

| ID | 风险 | 失败场景 | Mitigation | Gate |
| --- | --- | --- | --- | --- |
| P1-R1 | statusMapping 有损导致误判 | Linear `blocked` 是 label 而非 status，adapter 只看 status 导致 active 误报。 | Engine mapping 支持 status/label/custom field evaluator；golden snapshots。 | adapter contract tests |
| P1-R2 | stale snapshot 被误当 truth | Multica down，last-known `done` 被 dashboard 当 fresh。 | freshness enum mandatory；UI 显示 stale age；check warning。 | stale test |
| P1-R3 | local status 命令误用于外部绑定 | Agent 在 multica-bound task 上执行 `task status set done`。 | CLI ownership guard；skill prompt；错误码 `engine_owns_status`。 | CLI e2e |
| P1-R4 | Template/Preset 冲突 | Preset 覆盖 template slot 后 locale 缺失，生成空文档。 | fail-closed template resolver；locale equivalence check。 | template fixture |
| P1-R5 | Legacy migration 被用户期待为自动兼容 | 用户以为旧任务可一键升级，结果历史证据丢失。 | 明确 legacy intake，不自动重写；agent-assisted migration with review. | migration dry-run fixture |
| P1-R6 | Agent skill 与 CLI 漂移 | 文档说一个命令，CLI 实际另一个。 | CLI help generated into skill snippets；skill smoke。 | generated-doc consistency test |

## 5. Confidence loop

每个 slice 的 confidence loop：

1. **Pre-flight**：确认本 slice 依赖的 contract 文件已 closed。
2. **Implement smallest path**：只做本 slice scope，不借机扩展。
3. **Run gates**：unit + contract + import boundary + slice-specific e2e。
4. **Adversarial review**：reviewer 必须攻击本 slice 所触碰的不变量。
5. **Evidence closeout**：记录 commands、fixtures、known residual。
6. **Promote or stop**：P0/P1 未闭环不得进入下一 slice。

## 6. 未命名风险检查表

实现前最后一问：

- 是否有任何状态写路径绕过 LifecycleEngine/LocalEngine？
- 是否有任何文件写绕过 ArtifactStore/WriteCoordinator？
- 是否有任何外部输入绕过 Schema decode？
- 是否有任何公开输出绕过 PublishableProjection？
- 是否有任何 old runtime production import？
- 是否有任何 generated projection 被当成 authored fact？
- 是否有任何 task 绑定了两个 engine 或允许原地 rebind？

若任一为是，本目录不再有 high confidence，必须补 ADR。
