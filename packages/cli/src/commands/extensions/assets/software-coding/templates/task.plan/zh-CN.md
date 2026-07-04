# {{title}}

Task Contract: harness-task v1

## Brief

一句话说明任务目标与范围。

## Goal

说明本任务要完成的可验证结果。

## Context

记录输入背景、相关约束和不应改变的边界。冷启动 agent 必须先区分三元语：task 记录要做什么，fact 记录已经观察到什么，decision 记录承重选择为什么成立。

## Implementation Plan

- 确认现有代码、文档和契约。
- 用 `ha task progress append <task-id> --text "..." --evidence type:PATH:summary` 记录关键进展。
- 对会支撑 review、PR、架构判断或后续选择的观察，运行 `ha record fact --task <task-id> --statement "..." --source "..." --confidence high`。
- 对选路、推翻、长期边界或派生后续工作的承重选择，运行 `ha decision propose ...`；fact 支撑 decision 或 decision 派生 task 时，用 `ha decision relate ...` 建边。
- 用测试和检查验证行为。

## Verification

- 列出需要通过的本地检查、CI 和 review。
- E75 门：进入 `task-review` / `task-complete` 前必须已有至少一条真实 fact；没有 fact 就没有可裁决的产出。
