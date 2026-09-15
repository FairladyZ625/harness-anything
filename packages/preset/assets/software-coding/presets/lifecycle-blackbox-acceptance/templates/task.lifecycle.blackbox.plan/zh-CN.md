# {{title}}

Task Contract: harness-task v1

## Brief

执行 `lifecycle-blackbox-acceptance.md` 描述的源码盲 Task 生命周期验收。

## Goal

产出按时间排序的公开 CLI transcript，直到规范 Task status 为 `done`；若先遇到公开表面缺陷，则不绕行并停在首个缺陷。

## Context

这是 CLI 黑盒测量。可以读取 Task 自有文档与 artifacts，不得读取仓库源码路径。

## Required Reading

只读本 Task 的 `task_plan.md`、`closeout.md`、`lifecycle-blackbox-acceptance.md`，以及公开 `ha` help、回执与 explain。

## Entry Conditions

使用派工方提供的一次性仓库，并由不同 principal 执行独立 review。

## Dependencies

派工方提供隔离仓库和已安装候选 CLI；release owner 接收验收报告。

## Execution Surface

仅通过公开 CLI 和本次一次性 Task 自有文档及 artifacts 操作。

## Constraints

不得检查仓库源码路径、猜测未公开的 payload 字段，或绕过 lifecycle 与公开表面缺陷。

## Checkpoint

在剧本定义的首个缺陷处停止，或在 `ha task show` 显示规范 status 为 `done` 后停止。

## CI/Gate Authority Stop Condition

本次无 gate 验收不修改 CI 或 gate 权威面。

## Implementation Plan

依次执行 `lifecycle-blackbox-acceptance.md`：发现公开命令、运行 hooks 反例、执行双 principal 生命周期，并记录每条命令和输出。

## Deliverable Contract

把 transcript、标识符、首个失败分类、最终 projection 与解码后的 tool-call 路径清单写入本 Task 的 `artifacts/` 目录。

## Evidence Protocol

原样保留命令输出。完成前通过公开 CLI 至少记录一条观察 fact。reviewer 不独立或任何解码后的文件系统操作数指向仓库源码路径时，必须拒收本次运行。

## Verification

只通过公开 CLI 回执、`ha task show` 与 `ha explain` 验证。本验收任务不要求源码测试、`node tools/...` 命令、仓库 gate 或本地交付 commit。
