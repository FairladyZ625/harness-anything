# {{title}}

Task Contract: harness-task v1

## Brief

一句话说明任务目标与范围。

## Goal

说明本任务要完成的可验证结果，以及交付物的形态与落点：什么形式、交给谁、放在哪里、谁第一个用。

## Context

记录输入背景与已知事实。冷启动 agent 必须先区分三元语：task 记录要做什么，fact 记录已经观察到什么，decision 记录承重选择为什么成立。

## Required Reading

按读取顺序列出代码、文档与契约的具体路径，并标明每项的权威级别；不得把互相冲突的来源并列而不裁定优先级。

## Entry Conditions

列出开工前必须已经成立的条件。条件不成立时停止并上报，不自行虚构上游输入。

## Dependencies

列出上游依赖、交接输入、并发 ownership 与下游接收方；说明每项依赖如何判定已满足。

## Execution Surface

声明执行所在的仓库、worktree、分支与 base，以及允许写入的范围。具体绝对 `cwd` 由派工参数注入，不手抄成可漂移的路径。

### 硬红线

CI workflow、阈值与预算、required checks、凭据与宿主服务、删除断言、allowlist 计数变化不得修改；命中即停并列出精确请求。

### 决策授权范围

派工按 active derives 边来源 Decision 的当前状态自动注入「本任务授权范围」。仅 `in_effect` 的 chosen 条款生效；被 supersede 或退场后下一次派工不再授权。允许把编码被该决策取代的旧契约的门禁 / 测试断言更新为新契约，条件是保留并补齐负例、引用决策 id、closeout 列出改动的门禁文件。范围内直接执行并报备，范围外或硬红线才停；没有派生决策时不产生此默认授权。不得把摘要当成完整决策或额外台账写权。

## Constraints

列出不能假设的前提与不能越界的范围：哪些现状不得改变、哪些动作未经授权不得做（外部与破坏性动作默认禁止）。

## Checkpoint

写明什么时候必须停下来上报或求裁决：命中即停条件（硬红线、注入授权范围外、绕 gate、与既有裁决冲突、牵连面超出预估），以及计划性回报点（如拆解完成后、发 PR 前）。

## Implementation Plan

- 确认现有代码、文档和契约。
- 用 `ha task progress append <task-id> --text "..." --evidence type:PATH:summary` 记录关键进展。
- 对未来 decision 或跨任务推理所需的承重观察，使用 `ha fact record --task <task-id> --statement "..." --source "..." --confidence high` 显式晋升；Fact 保持 `0..N`，交付证据归入 Execution outputs。
- 对选路、推翻、长期边界或派生后续工作的承重选择，运行 `ha decision propose ...`；fact 支撑 decision 或 decision 派生 task 时，用 `ha relation relate ...` 建边。
- 用测试和检查验证行为。

## Deliverable Contract

写明交付物的形态、落点、接收者与第一个使用方，以及任务完成时必须提交或回报的字段。不要把通用 worker 纪律复制到这里。

## Evidence Protocol

写明证据粒度与 reviewer 必须拒收的条件；修复缺陷时再写明阴性对照或变异检查。这里描述如何证明，`Verification` 描述什么必须为真。

只在观察到值得留存的现场、或某个 decision 需要证据时才记 fact：`ha fact record --task <task-id> ...`，回执保存在 Execution outputs 中。Fact 是 decision 的 evidence 输入，因此在接受或 reckon 该 decision 前，用 `ha relation relate --source-ref decision/<decision-id>/<claim-id> --target-ref fact/F-XXXXXXXX --type evidenced-by --rationale "<why>" --expected-version 0` 把它挂到对应主张上。如果 proposal 还没有 fact evidence，`ha decision propose` 仍会成功，但回执会指向这两个命令。

## Verification

- **停止点 = 本地 commit + 推送任务分支 + 该交付 SHA 的 GitHub CI 全绿。** 本地运行 `node tools/run-manifest-gates.mjs --changed origin/main` 与定向测试作为反馈；每完成一块一致的改动就 commit 并推送，即使受影响测试仍红，因为 GitHub CI 才是完整权威，而且推送前无法读取对应 SHA 的结果。点名本任务改动面需要的具体测试文件并贴出真实 runner 输出；`npm run check:ci` 只用于刻意复现某个 CI 失败，不是停止点。
- 剩余定向集合固定为：①受影响的 integration 文件经 `node tools/run-node-tests.mjs --file <path>` 运行；②对改动的每个错误码、消息文本、协议字段名执行 `git grep`，找出其它包里的消费者测试并跑绿。
- 列出本任务额外需要的 review 与人工验收条件。
- fact 按需记录——观察到值得留存的现场或某个 decision 需要证据时才记，不是完成配额；交付通过 Execution outputs、review、closeout 与全部适用 completion gate 验证。
