# 22 · Agent Skills 与 Runtime Contract

- **状态**: canonical
- **日期**: 2026-06-10

## 1. 核心原则

Harness 不接管 native agent runtime。Codex、Claude Code、Aider、OpenHands 等 runtime 的优势在于即时打断、纠偏、共创和工具执行；Harness 提供的是任务包、证据、检查、投影和发布安全。

## 2. Agent 必须学会的 6 条规则

1. **看绑定**：操作 task 前读取 `INDEX.md` 的 `lifecycle.engine`。
2. **只改自己拥有的状态**：`engine=local` 才能用 `harness task status set`；外部 engine 的状态用外部 runtime/UI/CLI。
3. **写产物走 Harness**：progress、findings、docs 通过 Harness command/WriteCoordinator，不手写绕过。
4. **公开发布先 redaction**：外部 comment 只能用 `harness closeout publish` 生成的 PublishableProjection。
5. **遇到 stale 不瞎猜**：snapshot stale 时报告 warning，继续做 local artifacts，不臆造外部状态。
6. **merge/pull 后先查合并契约**：执行 `git pull`、merge、rebase 或切到 PR 后，先运行
   `harness check --post-merge --json`，按结构化 `hint` 修复，再继续任务写入。

## 3. Skill snippet：local task

```md
When working in Coding Agent Harness:
- Read `INDEX.md` first.
- After `git pull`, merge, rebase, or PR checkout, run `harness check --post-merge --json`.
- Follow post-merge hints before editing authored task docs.
- If `lifecycle.engine: local`, you may use:
  - `harness task status set <task> active|blocked|in_review|done|cancelled`
  - `harness task progress append <task> --text ...`
  - `harness check <task> --json`
- Do not edit `.harness/` cache/journal files.
- Do not manually change `lifecycle.engine` or `bindingFingerprint`.
```

## 4. Skill snippet：external-bound task

```md
This task is bound to an external LifecycleEngine.
- Harness reads status by snapshot only.
- Do not run local status commands.
- Use the external engine's own workflow to change status.
- You may still write task artifacts with Harness commands.
- If `harness snapshot` returns stale/unavailable, report it and continue local artifact work if safe.
```

## 5. CLI should generate skill fragments

Skill text must not drift from CLI behavior。Implementation rule：

```bash
harness skill emit --engine local
harness skill emit --engine multica
```

The emitted text is used in docs/tests; manual copies are secondary。

## 6. Runtime origin binding

| Origin | Default binding | How agent knows |
| --- | --- | --- |
| local Claude/Codex/Aider session | `local` | project `harness.yaml` + skill prompt |
| Multica-launched agent | `multica` | Multica system prompt + `--lifecycle multica` |
| GitHub issue bot future | `github` | GitHub app prompt/context |
| unknown | `local` if enabled; otherwise error | CLI config |

## 7. Repair prompt shape

`harness check --repair-prompt` can output a bounded prompt：

```md
Task: <id>
Status snapshot: canonical=<status>, raw=<raw>, freshness=<freshness>
Problems:
- <code>: <message>
Allowed commands:
- ...
Forbidden commands:
- ...
Next safe action:
- ...
```

Never include private raw logs in repair prompt by default。

`harness check --post-merge --json` uses the same bounded repair discipline: stable `code`, affected paths, and a
single next safe action. Agent skills must treat hard-fail codes as stop-and-fix before continuing authored writes.

## 8. Human-in-loop boundaries

Agent cannot：

- confirm human review；
- waive P0/P1 findings；
- rebind lifecycle engine；
- mark external task done via Harness；
- publish private-only evidence。

Agent can：

- prepare closeout packet；
- propose done / ask human to mark done；
- surface stale external status；
- create superseding task when user instructs。
