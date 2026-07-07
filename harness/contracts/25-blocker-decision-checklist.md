# 25 · Blocker Decision Checklist

- **状态**: canonical checklist
- **日期**: 2026-06-10

## 1. 开工前 P0 checklist

| ID | 问题 | 当前答案 | 状态 |
| --- | --- | --- | --- |
| B-P0-1 | 是否 clean-room，不兼容旧 schema？ | 是；旧代码只作 behavior corpus。 | closed |
| B-P0-2 | local 是否主线？ | 是；local engine 默认且 best-in-class。 | closed |
| B-P0-3 | Task 是否恰好一个 engine 且不可变？ | 是；fingerprint + writer/checker 强制。 | closed |
| B-P0-4 | Kernel 是否无 provider-neutral transition？ | 是；local 命令属于 LocalEngine；外部 transition 不进 Kernel。 | closed |
| B-P0-5 | canonical status 是什么？ | local 6 态：planned/active/blocked/in_review/done/cancelled。 | closed |
| B-P0-6 | mapping 归谁？ | Engine-owned。 | closed |
| B-P0-7 | snapshot 不可达怎么办？ | fresh/stale-but-usable/unavailable-no-cache。 | closed |
| B-P0-8 | 文档和 SQLite 谁是真理？ | Markdown/git 是 SoT；SQLite 可重建。 | closed |
| B-P0-9 | 并发写底线？ | WAL/journal + per-task lock + single committer + watermark;完整合同见 37。 | closed |
| B-P0-10 | publishNote 安全底线？ | PublishableProjection + redaction + idempotency。 | partially closed；Slice 6 前需规则集 |
| B-P0-11 | 旧任务怎么迁移？ | legacy intake + agent-assisted recreate；不自动兼容。 | closed |
| B-P0-12 | CI 必须挡什么？ | import boundary、no-legacy-dependency、rebuild、crash、redaction、schema。 | closed |

## 2. Slice 2 前必须引用并测试

Write-coordination-contract 已由 `37-write-coordination-contract.md` 锁定。Slice 2 task packet 必须引用它,并覆盖：

- journal 文件格式；
- flush cadence N/T；
- cross-process lock implementation；
- conflict policy same task；
- crash replay algorithm；
- SQLite watermark schema；
- git commit grouping and message format；
- journal retention/compaction。

未引用 37 或未覆盖 37 §8 测试,不得实现 LocalLifecycleEngine 完整写路径。

## 3. Slice 6 前必须补齐

Publish-note-safety 需要确定（落点：`harness/contracts/38-publish-note-safety-contract.md`，已落 skeleton，规则集未填充，未 canonical 化）：

- secret patterns；
- private path allow/deny list；
- summary length budget；
- link kinds allowlist；
- provider-specific comment length/format constraints；
- idempotency storage；
- retry/backoff；
- audit event fields。

未补齐不得调用外部 comment API。

## 3.1 Slice 7.5 前必须引用并测试

Electron security contract 已由 `40-gui-and-apps/31A-electron-security-contract.md` 锁定。GUI task packet 必须引用它,并覆盖 31A §8 全部 6 个测试(renderer-no-node / preload-allowlist / markdown-sanitize / local-api-auth / path-traversal / terminal-no-ingestion)。未引用或未覆盖,不得实现 GUI。

## 4. 任何时候触发的 Red Flag

- “为了迁移方便允许 rebind”；
- “先用 SQLite 当真理，后面再补文档”；
- “Multica adapter 先顺手 set status”；
- “旧 scanner 可先 import 过渡”；
- “publishNote 先发完整 walkthrough”；
- “Dashboard 做一个跨引擎总完成率”；
- “PRD 暂时放 Kernel，以后再抽”。

这些不是实现细节，是架构破坏。

## 5. 签核语义

当且仅当：

- 本 checklist P0 closed；
- Slice 当前 blocker closed；
- CI gate 可执行或有 owner/date/blocker；
- reviewer 无未关闭 P0/P1；

才允许进入下一实现 slice。
