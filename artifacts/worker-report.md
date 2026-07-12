# Fact→Execution 迁移命令 worker report

日期：2026-07-12（Asia/Taipei）
范围：只实现命令、分类、fixture 与真实 ledger dry-run；未对 592 条当前孤儿执行 apply，未改私有 `harness/`。

## 1. CLI 面

主命令：

```text
ha migrate fact-execution [--dry-run|--apply --confirm-plan <id>]
  [--batch-size <1..200>] [--batch <1-based>] [--sample-size <n>] [--json]
```

- 默认 `--dry-run`；`--apply` 不会扩大到人工差集，只处理三信号交集。
- dry-run 返回稳定 `planId`；plan hash 覆盖全部孤儿的分类、ref 与 statement。ledger 或分类变化会令旧确认失效。
- apply 必须带完全匹配的 `--confirm-plan`，否则 `plan_confirmation_required`。
- 默认每批 50，最大 200；`--batch` 选择固定一基批次。已迁移 Fact 仍参与稳定 plan/batch 定位，但不会重复写。
- 每个 apply batch 经一个 coordinated journal flush 写入；报告列出 batch selected/ready/skipped、全量人工确认清单、抽样及目标 execution。
- 回滚策略：每批独立生成 repository commit，使用 `git revert <batch-commit>` 补偿回滚；命令自身不硬删 Fact 或 Execution。

示例：

```bash
ha --root /path/to/repo migrate fact-execution --dry-run --batch-size 50 --json
ha --root /path/to/repo migrate fact-execution --apply \
  --confirm-plan fxm_eaa558b19ba08a0e --batch-size 50 --batch 1 --json
```

第二条仅为后续授权后的调用形态，本包没有执行。

## 2. 三信号分类与词表

三信号：

1. `memoryClass=episodic`；
2. relation graph 中没有 active `decision --evidenced-by--> fact`；
3. statement 命中交付措辞。

分类真值表：

| orphan | episodic | delivery wording | 结果 |
| --- | --- | --- | --- |
| 否 | 任意 | 任意 | 排除（仍是承重引用） |
| 是 | 是 | 是 | `automatic`，可进入 apply batch |
| 是 | 是 | 否 | `manual`，禁止自动迁移 |
| 是 | 否 | 是 | `manual`，禁止自动迁移 |
| 是 | 否 | 否 | `bearing_observation`，留在 Fact |

词表与正则类别：

- `pull-request`：`PR #123`、`pull request`、合并请求；
- `merged`：merged/merge commit/已合入/合入 main/合并完成；
- `ci`：CI/rewrite-ci/GitHub Actions/流水线；
- `test-pass`：tests passed/测试通过/测试全绿/验绿；
- `check-pass`：`npm run check`、check passed/green、gates green、全量 check 通过；
- `commit-sha`：commit、merge/work SHA、40 位 SHA、提交哈希/记录；
- `diff`：diff、差异文件/清单；
- `screenshot`：screenshot/截图；
- `report`：report/报告。

fixture 阳性/阴性对照覆盖：交集自动、两种差集、双否定承重观察、已有 evidenced-by 排除。

## 3. done-task 归档 Execution 方案

- 若 task 有且仅有一个 active execution：将 inline `OutputEvidence` 追加到该 execution.outputs，不改变 execution/task lifecycle。
- 若 task 已 done 且无 active execution：按 `planId + taskId` 派生稳定 `exe_<ULID-shape>`，创建合法 `execution/v2`：
  - `state=accepted`，claimed/submitted/closed 同一迁移时刻；
  - `primary_actor.executor.id=fact-execution-migration`；
  - `session_bindings=[]`，因为它不是伪造的历史运行会话；
  - output 为 inline evidence；submission 写 `source=fact-migration`、plan id、evidence refs 与无 receipt 的已知缺口。
- 同 task 后续 batch 复用同一归档 execution，并幂等追加；不会创建多个随机承载体。
- 非 done 且无 active execution、或出现多个 active execution，fail-closed 为 skip；本次真实 dry-run 有 26 条均属前者。

没有复用普通 ExecutionSaga claim/submit 链路：该链路会 reserve lease、要求 primary Session 并推进 task 到 in_review，不适合历史归档。迁移路径仍用 WriteCoordinator，且写前同时跑 Execution schema decode/encode 与 `validateOutputEvidence`，没有扩大正常 saga 状态机。

## 4. 原 Fact 归档方案

Fact 不删除、不 invalidate，也不伪造“另一条 Fact 推翻它”。Fact schema 新增可选 trace：

```yaml
migration:
  schema: fact-migration/v1
  state: migrated
  plan_id: fxm_...
  execution_ref: execution/<task>/<execution>
  evidence_id: fact-migration:<plan>:<fact>
  migrated_at: <ISO timestamp>
```

parser/formatter/schema/JSON schema/field contract 均识别此 trace。原 statement/source/provenance 完整保留；重复 apply 根据 trace 幂等跳过。

## 5. 真实 ledger dry-run

命令（只读，JSON 原始输出保存在本机 `/tmp/fact-execution-dry-run.json`，未写 ledger）：

```bash
HARNESS_DAEMON_MODE=direct node packages/cli/src/index.ts \
  --root /path/to/harness-anything \
  --actor human:lizeyu --json migrate fact-execution \
  --dry-run --batch-size 50 --sample-size 8
```

结果快照：

| 指标 | N |
| --- | ---: |
| scanned Fact | 700 |
| active evidenced-by 引用 | 108 |
| 当前孤儿 | 592 |
| episodic 孤儿 | 518 |
| 交付措辞孤儿 | 348 |
| 三信号交集自动候选 | 319 |
| 可直接承载 | 293 |
| 自动候选但无合法承载 | 26 |
| 双口径差集、待人工确认 | 228 |
| 双否定承重观察 | 45 |

- plan：`fxm_eaa558b19ba08a0e`；50/批共 7 批。
- 第 1 批：50 selected，44 ready，6 skip；未 apply。
- 26 个全局 skip 原因均为 `non_done_without_active_execution`，没有 multiple-active 冲突。
- charter 实证是 699/591；运行时 ledger 已前进为 700/592。两者都是约 85%，报告采用命令实际读到的当前快照，不把新数据强行裁成 591。
- CLI JSON 的 `manualConfirmation` 含完整 228 条差集清单；`samples` 每类按 `--sample-size` 给样例。

自动样例：

- `fact/task_01KV5V8MFCZRJ5Y6GVV6GW02M8/F-Z7BSBNWN`：episodic + `npm run check passed`，done→archival execution。
- `fact/task_01KV867W31N1RXB74TAECHSX73/F-4BMFCHJC`：episodic + PR #75 merged + check passed，done→archival execution。
- `fact/task_01KWC5WX85MZ6ZA7KN3NCWWD3B/F-EE32E7ST`：episodic + PR #76 merged + CI passed。

人工差集样例：

- `fact/task_01KV2ZKQ7P5ANNH8ZXPHNXBJ7G/F-YMWN9Q01`：episodic，但内容是 cancelled placeholder，无交付措辞。
- `fact/task_01KV85WNQ57CRBPGS78RBA1CAG/F-2BR9E9BG`：semantic，但命中 `npm run check ... 通过`。
- `fact/task_01KWC0ZQM51WP9Z4844SZFSEDW/F-9DBP9PXC`：semantic，但命中 PR/commit。

承重观察样例：

- `fact/task_01KWPQ4EPMR87S4VMDEYTKDPW4/F-SEM05FTD`：milestone dossier 正确落点/结构边界。
- `fact/task_01KWS3S1MEH99M39GN012GA5YP/F-4R1VW5QR`：Canonical ADR/Decision 引用边界。
- `fact/task_01KWT9823XEWFW5E7DXE2V115N/F-3B6RMMG8`：preset write-scope 规则观察。
- `fact/task_01KWVX4ZNNC81K50YK87J1YJM5/F-D4F06NVH`：supersede scaffold 结构性缺陷。

## 6. 改动清单（file:line）

- `packages/cli/src/commands/fact-execution-classifier.ts:14`：词表；`:62`：relation-aware 三信号分类。
- `packages/cli/src/commands/fact-execution-migration.ts:37`：plan/apply 主流程；`:76`：报告；`:156`：execution 目标选择；`:185`：coordinated writes；`:209`：归档 execution。
- `packages/cli/src/cli/parse-migration-args.ts:87`：flags 与 batch 参数解析。
- `packages/cli/src/cli/command-spec/command-spec-migration-diagnostics.ts:101`：命令 help/receipt contract。
- `packages/cli/src/commands/core/migration.ts:15`：迁移 runner 路由。
- `packages/daemon/src/protocol/method-registry.ts:246`：将新 action 登记为 repo-write，保持 daemon action 分类穷尽。
- `packages/kernel/src/domain/fact-record.ts:18`：FactMigrationTrace；`:49`：round-trip formatter/parser。
- `packages/kernel/src/schemas/fact-record.ts:7`、`packages/kernel/schemas/json/fact-record.schema.json:1`：schema。
- `packages/kernel/src/entity/field-contracts.ts:70`、`packages/kernel/src/entity/registry.ts:150`：migration lifecycle/D2 disposition 声明。
- `packages/cli/test/fact-execution-migration-cli.test.ts:12`：端到端正负、apply、幂等 fixture。
- `packages/kernel/test/domain/fact-record.test.ts:47`：Fact trace round-trip。
- `packages/cli/test/parse-args.test.ts:158`：CLI parse characterization。

## 7. 本地验证

- `npm run typecheck`：PASS。
- targeted 154 tests（Fact domain + migration CLI + parse characterization）：154 PASS / 0 FAIL。
- touched-file ESLint：PASS。
- `git diff --check`：PASS。
- `npm run check:local`：PASS，16/16 steps；fast 314/314、contract 399/399；最终 fresh run 49.5s。
- gate 过程记录：先修复新测试缺 tier marker、再补 daemon action 分类；一次 contract 并发运行出现 2 个 GUI daemon socket flake，原失败文件独立复跑 14/14，之后两次完整 contract 均 399/399。没有豁免或修改 gate 判定。

## 8. 分支 / commit

- branch：`claude-code/fact-execution`
- base：`b620d9b42d94bbb49669825b03f9f1a5d8905a71`（与 fetch 后 origin/main 相同）
- commit：本报告与实现同属最终 `HEAD`（自引用 commit 无法在提交前写入；交付回执提供解析后的 SHA）。
- 未 push、未发 PR。

## 9. 残余风险

- 词表是保守规则，中文“完成/已做”但没有指定交付词的 episodic Fact 会进入人工差集，不会被误自动迁移；代价是 recall 低于 charter 初次约 378 条措辞估算（本次严格规则 348）。
- 26 条三信号交集属于 non-done 且无 active execution。本命令 fail-closed；CEO 需先判断它们应 done、cancelled 排除，或另开人工承载策略。
- inline evidence 不带 receipt/sha claim；报告和 archival submission 明示此缺口。delivered coverage 不在本迁移范围。
- rollback 依赖每批 repository commit 的 `git revert`；不要把多个批次 squash 后再期待逐批回滚。
- dry-run 是 2026-07-12 的移动 ledger 快照；正式 apply 前必须重跑并重新确认新 planId。

## 给 CEO

Progress 摘要：命令、三信号分类、稳定 plan 确认、分批、done-task archival execution、Fact 迁移 trace、幂等与真实 dry-run 均已完成；当前实读 592 孤儿，319 自动交集（293 ready/26 fail-closed）、228 人工差集、45 承重观察。本包没有执行真实 apply。

优先保留的承重观察 fact 候选：

- `F-SEM05FTD`：milestone dossier 的实体/目录落点边界；
- `F-4R1VW5QR`：Canonical ADR/Decision 引用边界；
- `F-3B6RMMG8`：preset write-scope 合法范围；
- `F-CHCA4ZYK`：不存在 task id 可产生空包目录的结构性行为；
- `F-D4F06NVH`：supersede scaffold 缺失的结构性缺陷；
- `F-3B04E5AP` / `F-5PY6HXK0` / `F-668B5547`：W8 generated-view exemption、写入旁路移除、AST seal 规则。
