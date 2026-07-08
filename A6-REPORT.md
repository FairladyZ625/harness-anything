# MC-A6 Claim-Check Blob Channel Report

## 设计定稿

CEO裁决后继续采用 v0 git-tracked `harness/objects/sha256/<2>/<62>` 布局。

### 存储布局

- v0 object root: `harness/objects/`
- digest namespace: `harness/objects/sha256/`
- object path: `harness/objects/sha256/<first-2-hex>/<remaining-62-hex>`
- ref format: repo-root-relative portable path, for example `harness/objects/sha256/ab/cdef...`
- write semantics: immutable content addressing. Writer computes sha256 over exact bytes, writes durably, verifies bytes after rename, and never overwrites an existing object with different content.
- dedupe semantics: same bytes map to the same object path; repeated writes return the same ref and do not create another object.
- v0 explicitly does not implement GC, chunking, remote backend, or migration of old records.

### Journal payload schema

For `machine_artifact_write`, keep the existing `boundary` and materialized `path`, but replace inline `body` with a generic claim-check descriptor:

```json
{
  "boundary": "provenance-session",
  "path": "harness/sessions/<sessionId>.md",
  "bodyRef": {
    "ref": "harness/objects/sha256/<aa>/<62-hex>",
    "sha256": "<64-hex>",
    "size": 12345,
    "mediaType": "text/markdown; charset=utf-8"
  }
}
```

Compatibility rule: `machine_artifact_write` apply/read paths continue accepting legacy `{ "body": "..." }` payloads. New session exporter payloads use `bodyRef` only; no duplicate body or excerpt is written into the journal payload.

### Generic primitive shape

The store layer exposes a generic content-addressed blob primitive, not a session-specific helper:

- `writeContentAddressedBlob(rootInput, body, mediaType) -> { ref, sha256, size, mediaType }`
- `readContentAddressedBlob(rootInput, descriptor) -> bytes after sha256 + size verification`
- `readContentAddressedTextBlob(rootInput, descriptor) -> UTF-8 text after sha256 + size verification`
- `machine_artifact_write` can materialize any text artifact from a descriptor once future callers adopt it.

## 测试证据

Verification run:

- `npm run typecheck` -> pass.
- `node --test --experimental-strip-types packages/application/test/provenance-session-exporter.test.ts packages/kernel/test/store/crash-before-watermark.test.ts` -> 15 tests pass.
- `node --test --experimental-strip-types packages/application/test/provenance-session-exporter.test.ts` -> 10 tests pass after final test import cleanup.
- `npm run check:local` -> pass after rebase to latest `origin/main`, fast tier, 15 steps, 18.6s.
- `node tools/check-bypass-write-boundary.mjs` -> pass after allowlist line update for durable bytes write, current=125 previous=124 delta=1.
- `node tools/check-duplicate-definitions.mjs` -> pass.
- `node tools/check-kernel-dead-exports.mjs` -> pass.

Covered behaviors:

- session exporter journal payload stores `bodyRef` and does not contain inline transcript text.
- blob ref can be read back and matches the materialized session markdown.
- identical export content dedupes to one object path.
- corrupted blob read fails on sha256 mismatch.
- legacy inline `body` machine artifact recovery remains compatible.

Broad `tools/check-*.mjs` loop was also run. It exposed the three task-related static failures above, all fixed and rerun green. The same broad loop also hit non-task/precondition failures: `check-pr-body-bilingual.mjs` needs a PR body, `check-pr-governance.mjs` needs changed-file inputs, `check-supply-chain.mjs` failed on npm registry/socket and existing GUI dependency state, and `check-cli-structure.mjs` reported the pre-existing `packages/cli/src/commands/core/task-query.ts` line-count issue (origin/main has 301 lines). Those were not changed in this task.

## 体积数据

Pre-implementation runtime source-log samples:

- Recent Codex runtime JSONL samples under `~/.codex/sessions`, last 50 files: largest observed files were 7.05 MB, 7.32 MB, 10.96 MB, 13.39 MB, 13.53 MB, and 15.17 MB.
- Recent Claude JSONL samples under `~/.claude/projects`, last 50 files: largest observed files were 0.77 MB, 0.80 MB, 1.00 MB, 1.86 MB, and 5.31 MB.
- This worktree had no pre-existing `harness/sessions/*.md` samples.

Post-implementation real export measurement, using a real Codex runtime log source and a temporary harness root:

- exported session: `490b91f6-8b2c-466c-aa56-1d21f50bc6c8`
- rendered markdown size: 682 bytes
- blob size: 682 bytes
- bodyRef: `harness/objects/sha256/0c/a22a9811820a61a0c01cd1c818af7e5e008f0711219075a5aad456324cca42`

This is a single measured export, not an upper-bound claim.

## 残留风险

CEO裁决理由,原样引用:

1. 内层 ledger 是 master 单副本、无 remote、永不 clone/fetch——git 历史膨胀的代价≈本地磁盘,当前可接受;git 化换来持久性(ledger 的备份面=这个 git 仓)。
2. 内容寻址天然去重,增长有界于「不同内容的导出数」。
3. ledger 远程化(fleet 阶段)本来就是既定的后端重裁点:届时 blob 换外部/远程存储,接口(四元组 {ref,sha256,size,mediaType})不变,旧 blob 留在本地历史不迁移。
4. 你采样的 15MB 是 runtime JSONL 源日志,不是渲染后的 markdown 导出体积——若实现后能顺手跑一次真实导出,把实际体积记进 residual risk;跑不了就标 unverified。

Remaining risks:

- No GC in v0; orphaned content-addressed objects can accumulate.
- No chunking or remote backend in v0; very large unique exports still become single git-tracked blobs.
- Existing inline journal records are not migrated; compatibility is read/apply only.
