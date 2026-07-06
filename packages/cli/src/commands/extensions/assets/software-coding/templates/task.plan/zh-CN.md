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
- 对会支撑 review、PR、架构判断或后续选择的观察，运行 `ha fact record --task <task-id> --statement "..." --source "..." --confidence high`。
- 对选路、推翻、长期边界或派生后续工作的承重选择，运行 `ha decision propose ...`；fact 支撑 decision 或 decision 派生 task 时，用 `ha decision relate ...` 建边。
- 用测试和检查验证行为。

## Verification

- 列出需要通过的本地检查、CI 和 review。
- E75 门：进入 `ha task review` / `ha task complete` 前必须已有至少一条真实 fact；没有 fact 就没有可裁决的产出。
