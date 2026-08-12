# {{title}}

Task Contract: harness-task v1

## Brief

一句话说明任务目标与范围。

## Goal

说明本任务要完成的可验证结果，以及交付物的形态与落点：什么形式、交给谁、放在哪里、谁第一个用。

## Context

记录输入背景与「看哪里」清单（要读的代码、文档、契约的具体路径）。冷启动 agent 必须先区分三元语：task 记录要做什么，fact 记录已经观察到什么，decision 记录承重选择为什么成立。

## Constraints

列出不能假设的前提与不能越界的范围：哪些现状不得改变、哪些动作未经授权不得做（外部与破坏性动作默认禁止）。

## Checkpoint

写明什么时候必须停下来上报或求裁决：命中即停条件（越界、绕 gate、与既有裁决冲突、牵连面超出预估），以及计划性回报点（如拆解完成后、发 PR 前）。

## CI/Gate Authority Stop Condition

如果本任务不是 CI/gate/governance 任务，却需要修改 CI/gate 权威面才能通过，停止实现，记录 blocker，并请求或创建治理任务。唯一例外是任务明确授权 CI/gate/governance 改动，或紧急修复 main 的 break-glass；break-glass 必须记录原因、范围和后续治理任务。

## Implementation Plan

- 确认现有代码、文档和契约。
- 用 `ha task progress append <task-id> --text "..." --evidence type:PATH:summary` 记录关键进展。
- 对未来 decision 或跨任务推理所需的承重观察，使用 `ha fact record --task <task-id> --statement "..." --source "..." --confidence high` 显式晋升；Fact 保持 `0..N`，交付证据归入 Execution outputs。
- 对选路、推翻、长期边界或派生后续工作的承重选择，运行 `ha decision propose ...`；fact 支撑 decision 或 decision 派生 task 时，用 `ha decision relate ...` 建边。
- 用测试和检查验证行为。

## Verification

- **停止点 = 本次改动面的定向测试全绿 + 本地 commit。完整门矩阵是 GitHub CI 的活，不是这台机器的活。** 点名本任务改动面需要的具体测试文件或 `--tier` 选择，并把 runner 的真实输出贴进本节，别只写「全绿」——输出是产物，断言不是。不要为了求安心在本机串行跑全量：一台机器顺序跑完所有 job 严格慢于 CI 并行跑，而且会占住全机槽预算、把同机其他 worker 全堵在后面。`npm run check:ci` 仍然保留，用于**刻意在本地复现某个 CI 失败**，它不是停止点。
- 列出本任务额外需要的 review 与人工验收条件。
- 依据 `dec_mrg3z1we/CH4`，Fact 是 `0..N` 的显式晋升，不是 review 或 completion 的数量门；交付通过 Execution outputs、review、closeout 与适用的 completion gates 验证。
