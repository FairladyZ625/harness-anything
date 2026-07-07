# 37 · Write Coordination Contract

- **状态**: canonical blocker contract for Slice 2
- **日期**: 2026-06-11
- **目的**: 把 WriteCoordinator 从“方向正确”收束成实现前合同，避免 Slice 2 在代码里临场发明 journal/lock/replay 语义。
- **关系**: 细化并取代 05 §3 中与本文件冲突的任何表述(05 已四处让权);`WriteOp.kind` 词表以本文件 §3 为准。

## 1. Slice Gate

Slice 2 不得开始实现，除非本文件被 dispatch packet 引用，并且测试计划覆盖 §8。

Slice 1 可以定义 port/type，但不得写 fs/git/sqlite/process，也不得实现 local status command。

## 2. Writer Model

- Markdown/git 是 authored source of truth。
- SQLite projection 可删可重建，不承载 authored truth。
- `WriteCoordinator` 是唯一生产写入口。
- 同一 Task 的 writes 必须 FIFO。
- 跨 Task writes 可重排，但 commit/report 必须列出 op ids。
- 每个 flush 只有一个 committer。

## 3. Journal Format

Journal 是 append-only JSONL。

```ts
type JournalRecord = {
  schema: "write-journal/v1"
  opId: string
  taskId: string
  kind: "package_create" | "transition_local" | "progress_append" | "doc_write" | "package_archive"
  actor: { kind: "agent" | "human" | "system"; id: string }
  at: string
  payloadRef?: { path: string; sha256: string }
  payload?: Record<string, unknown>
}
```

Rules:

- `opId` is idempotency key.
- large bodies use `payloadRef`; journal never stores unbounded markdown/log body inline.
- append must fsync before acknowledging enqueue.
- malformed record blocks recovery and requires manual repair report.

## 4. Locks

Two lock levels are required:

1. **Global committer lock**: one flush process per repo.
2. **Per-task lock**: same-task FIFO and mutation isolation.

Implementation may use lock files, but tests must prove:

- two processes appending same task do not interleave incorrectly;
- second committer either waits or exits with typed lock error;
- stale lock handling is explicit and never silently discards journal records.

Stale lock detection (locked decision, V1):

- lock file records `{ pid, hostname, acquiredAt }`;
- a lock is stale iff its `pid` is no longer alive on the same host (`process.kill(pid, 0)` fails), or `acquiredAt` is older than a 60s TTL with no heartbeat refresh;
- breaking a stale lock requires writing a `lock-takeover` line into the journal (actor, old pid, reason) before acquiring — silent takeover is forbidden;
- cross-host locks are out of scope for V1 (single-machine assumption; revisit via ADR if shared volumes appear).
- lock files are single-clone coordination only. Cross-person conflicts are Git merge concerns and must be caught by
  `harness check --post-merge` / CI invariants, not by `.harness/locks`.

## 5. Replay

Recovery algorithm:

1. read journal records in append order;
2. drop already-applied `opId`s using watermark;
3. validate payload hashes before applying body refs;
4. apply operations to authored files;
5. stage touched paths;
6. commit with op ids;
7. rebuild incremental projection;
8. advance watermark only after commit + projection succeeds.

Replay must be idempotent: repeated recovery yields the same authored files, same projection semantics, and no duplicate progress lines.

Idempotency mechanism (locked decision, V1): dedup is **opId-based, not content-based**. The watermark's applied-op set is the only dedup authority; `progress_append` does not rewrite or scan authored markdown for duplicates. Two distinct ops with identical text are two authored lines by design. Corollary: an op may never be applied to authored files unless its `opId` is recorded as applied in the same flush that commits it.

## 5.1 Journal Retention

After watermark advance, applied journal records are dead weight. V1 policy: on successful flush, records whose `opId` is covered by the watermark may be compacted away by rewriting the journal file under the global committer lock; compaction failure is non-fatal (journal grows, correctness unaffected). No time-based expiry — only watermark-covered records are eligible.

## 6. Watermark

Watermark is a rebuildable control record, not authored truth.

```ts
type WriteWatermark = {
  schema: "write-watermark/v1"
  lastCommittedOpIds: string[]
  lastCommitSha: string
  projectionHash: string
  updatedAt: string
}
```

If watermark is missing, recovery scans git history and authored files where possible, then emits a repair report before applying pending journal entries.

## 7. Flush Policy

V1 flush policy:

- explicit flush after each CLI command;
- batch flush may be introduced later only after crash tests pass;
- no delayed background daemon in V1.

## 8. Required Tests

| Test | Requirement |
| --- | --- |
| `journal-idempotency.test.ts` | same op replayed twice produces one authored change |
| `same-task-fifo.test.ts` | concurrent same-task appends preserve order |
| `global-committer-lock.test.ts` | two flushers cannot commit simultaneously |
| `crash-before-watermark.test.ts` | kill after file write before watermark recovers without duplicate |
| `payload-hash.test.ts` | tampered payloadRef blocks recovery |
| `sqlite-rebuild.test.ts` | deleting SQLite and rebuilding yields semantic diff empty |
| `post-merge-invariants.test.ts` | duplicate TaskId, generated tracked files, conflict markers, and binding tamper fail closed |

## 8.1 ArtifactStoreWriter 内部 seam(2026-06-12 补充)

`ArtifactStoreWriter` 是 flusher 与 store 写实现之间的接口，定义在 `kernel/src/ports/artifact-store-writer.ts`。

```ts
// ports/artifact-store-writer.ts（内部 seam，不出口到 application）
interface ArtifactStoreWriter {
  readonly writeDocument: (write: DocumentWrite) => Effect.Effect<ArtifactWriteReceipt, ArtifactStoreError>;
  readonly archivePackage: (taskId: TaskId) => Effect.Effect<TaskPackageRead, ArtifactStoreError>;
}
// DocumentWrite { taskId, path, body } / ArtifactWriteReceipt { taskId, path, sha256 }
```

**no-tag 理由**：`ArtifactStoreWriter` 故意不带 Effect `Context` tag，没有 DI 注入路径。这是架构约束而非疏忽：

- 若带 tag，application 层可通过依赖注入直接调用写方法，绕过 `WriteCoordinator.enqueue → flush` 流程，破坏 WAL/lock/FIFO 不变量。
- flusher（WriteCoordinator 内部）是唯一允许实例化并调用 `ArtifactStoreWriter` 的地方；store 层外部调用即 gate 红（见 04 §3 规则 8）。
- `ArtifactStore` 公共端口只暴露读取侧（`readTaskPackage` + `findBindingByExternalRef`）；写侧通过此 seam 封装在 store 实现层内部。

## 9. Stop Conditions

Stop if implementation needs:

- writing SQLite before authored markdown;
- acknowledging enqueue before journal fsync;
- skipping git commit for authored changes;
- background daemon to make correctness work;
- treating projection/watermark as source of truth.

## 10. Direct Authored Edits 与 progress_append 增量语义(2026-07-02 修订,ADR-0016)

本节为 ADR-0016(canonical 索引 `ha decision show E60`)对本契约的修订,不推翻 §1-§9 任何机制。

### 10.1 管辖边界(机器读/人读判据)

- 系统要读回并据此做决策的字节(INDEX.md frontmatter、status、packageDisposition、relations)**必须**经 WriteCoordinator 写入。
- 只给人类读的字节(progress.md 正文等 authored prose)**可以**由 agent 直接编辑,编辑后自行 git commit。coordinator 对 prose 写入是可选保障通道,不是必须关卡。
- per-task advisory lock(§4)只互斥**协调器写者**;编辑器直接写入不经过锁。"命令飞行中同时手工编辑同一文件"是未定义行为(毫秒级窗口);指引:手工编辑在无 pending op 时进行。
- 读取侧校验(frontmatter schema、lifecycle 不变量、checker)是结构化字段的真正执法者;coordinator 防意外,checker 防偏差。

### 10.2 progress_append payload 修订(delta 语义)

- **修订前**:enqueue 时读全文件拼接,journal 存完整新文件内容,apply 整体覆盖写。缺陷:crash replay 用旧快照覆盖期间的手工编辑(丢失更新);journal 随 progress.md 线性膨胀。
- **修订后**:journal 只存**追加文本增量**;flush/replay 时读当时磁盘文件,增量追加到末尾后写回。§5 的 opId watermark 幂等去重不变——本修订使实现与 §5 "progress_append does not rewrite or scan authored markdown" 的锁定语言对齐。
- **崩溃窗口与 apply-marker**:增量应用**非幂等**(重复应用 = 重复追加,不同于旧快照的幂等覆盖)。故 delta 应用在写盘后立即 fsync 一条 `apply-marker/v1` 记录进 journal;replay 见 marker 即跳过文件写入但照常 commit/watermark。watermark 提供 at-least-once,apply-marker 把"文件已写、watermark 未记"的重复追加窗口收窄至单次文件写与其 fsync 之间(微秒级)。故 §5 "不重复应用"对 delta 是**无 crash 路径承诺**;残余 fsync 级窗口内重放的后果仅限人读 prose 重复、不破坏机器读不变量。
- **兼容**:存量 journal 中全量快照式 progress_append op 按旧语义(整体覆盖)replay;新旧以 payload 形状区分。
- **测试要求**(并入 §8):增量追加正确性;恢复保留手工编辑;旧格式兼容 replay;append 无格式化/规范化行为的契约守护;apply-marker 崩溃窗口不重复追加。

### 10.3 动词无关条款

WriteOp 联合类型按动词扩展(archive/tombstone/supersede/未来 M4 代谢 op);**永不新建第二协调器**(Delete/Archive/Metabolism Coordinator)——第二套 journal/committer 自造双写窗口。策略(删什么/何时)归服务层,本契约只管执行的原子与可恢复。
