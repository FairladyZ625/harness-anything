# 19 · Unit / Contract / Smoke / CI Matrix

- **状态**: canonical
- **日期**: 2026-06-10
- **继承**: `archive/references/testing-standard.md` 与 `archive/references/ci-cd-standard.md`

## 1. 测试金字塔

| 层 | 目标 | 工具建议 | 必须覆盖 |
| --- | --- | --- | --- |
| Domain unit | 纯模型正确性 | `node:test` + assert | 6 态、三轴联合评估、fingerprint、Relation invariants |
| Schema tests | 外部输入 decode | Effect Schema + fixtures | harness.yaml/frontmatter/snapshot/journal/publishNote |
| Port contract | 每个实现满足同一行为 | shared contract suite | LifecycleEngine/ArtifactStore/TemplateLibrary |
| Store integration | 文件/SQLite/git/journal | temp repo + real git | crash recovery、lock、FIFO、rebuild |
| CLI e2e | 用户/agent 命令面 | child process | S1/S2/S4、错误码、JSON 输出 |
| Dashboard smoke | 投影渲染 | static HTML parse / optional browser | mixed engine, stale, close-ready, warnings |
| Migration smoke | legacy intake | old fixtures | scan → plan → create intake task → manual review marker |
| Redaction/security | 公私边界 | secret fixtures | publishNote 拒绝 private/raw/secret |
| Public/private boundary | 公开仓库泄漏防线 | git index checks + ignore checks | `harness` 被 ignore 且没有 private path 被 tracked |
| Agent behavior | agent-facing loop | scripted prompts / golden repair | check 输出可被 agent 修复；命令所有权 skill 不漂移 |

## 2. P0 contract tests

| Test ID | Scenario | Expected |
| --- | --- | --- |
| T-P0-001 | 手改 `lifecycle.engine` | `binding_tampered` |
| T-P0-002 | 外部绑定任务执行 local status set | error `engine_owns_status`，不写文件 |
| T-P0-003 | 两进程同 task progress append | same-task FIFO，无丢失 |
| T-P0-004 | flush 前 kill -9 | 重启 replay，不丢不重 |
| T-P0-005 | 删除 SQLite 后 rebuild | projection semantic diff = empty |
| T-P0-006 | Multica adapter 返回未知状态 | canonical=`unknown` + warning，不阻塞 local |
| T-P0-007 | Multica unreachable with cache | stale-but-usable + timestamp |
| T-P0-008 | Multica unreachable no cache | unavailable-no-cache + warning |
| T-P0-009 | publishNote 包含 token/raw log | reject before adapter call |
| T-P0-010 | `legacy transition request symbol` symbol in public port | import/type scan fail |
| T-P0-011 | production import from old runtime path | CI fail |
| T-P0-012 | generated projection edited by hand | checker warning/error based on policy |

## 3. Smoke scenarios

### S1 Local happy path

```bash
harness init --root fixtures/tmp-repo --lifecycle local
harness new-task --root fixtures/tmp-repo --title "Local smoke"
harness task status set --root fixtures/tmp-repo <task> active
harness task progress append --root fixtures/tmp-repo <task> --text "Implemented first slice"
harness check --root fixtures/tmp-repo <task>
harness task status set --root fixtures/tmp-repo <task> in_review
harness task status set --root fixtures/tmp-repo <task> done
harness task archive --root fixtures/tmp-repo <task> --reason "smoke complete"
harness check --root fixtures/tmp-repo --json
```

Assertions：

- every status transition produces authored diff；
- `check` JSON has coordinationStatus, closeoutReadiness, packageDisposition separately；
- archive moves package and writes tombstone；
- no network calls。

### S2 External read-only adapter

```bash
harness new-task --root fixtures/tmp-repo --lifecycle multica --ref FAI-37 --title "External smoke"
harness snapshot --root fixtures/tmp-repo <task> --json
harness check --root fixtures/tmp-repo --json
```

Assertions：

- no external transition call；
- raw + canonical both present；
- external status not written to authored frontmatter；
- stale cache written only to generated/cache path。

### S3 Mixed project

- 3 local tasks + 2 multica-bound tasks。
- Dashboard lists all local packages; engine column present。
- No aggregate “project completion percentage”。

### S4 Legacy intake

- Run scan over a fixture based on `archive/docs-release/guides/task-state-machine.md` style legacy task。
- Produce intake ledger with preserve/recreate/archive recommendation。
- No new task created without explicit apply flag。

## 4. CI job layout

`harness-anything/.github/workflows/rewrite-ci.yml` 当前必须至少包含 bootstrap required checks：

- `typecheck`
- `unit-contract`
- `boundaries`

`boundaries` job 必须运行 import boundary、forbidden symbol 和 private-boundary gates。Slice 2 后新增 store durability jobs；Slice 4 后新增 rebuild invariant；Slice 6 后新增 redaction/publish safety；Slice 7.5 后新增 GUI security job(覆盖 31A §8 六测试)。专项 job 在对应 Slice 前缺失是 blocker；在 Slice 0/1 前不要求伪造空实现。

```yaml
name: rewrite-ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node, npm-ci, npm-run-typecheck]
  unit-contract:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node, npm-ci, npm-test]
  boundaries:
    runs-on: ubuntu-latest
    steps: [checkout, setup-node, npm-ci, npm-run-check-boundaries, npm-run-check-private-boundary]
```

Required checks names must match real workflow job names; no generic placeholder allowed。Future job names are reserved, but must only be added when the matching implementation/tests exist.

## 5. Coverage policy

V1 不追数字崇拜；追 contract coverage：

- every error code has at least one fixture；
- every schema has valid + invalid fixture；
- every port implementation runs shared contract suite；
- every load-bearing invariant has at least one failing test if violated；
- every public command has success + failure test；
- every adapter has golden raw payloads。

## 6. Review evidence

Every implementation PR closeout must list：

- commands run；
- fixtures added；
- gates passed/failed；
- residual risk；
- if a gate was skipped, why and owner/date。

没有证据，不算完成。
