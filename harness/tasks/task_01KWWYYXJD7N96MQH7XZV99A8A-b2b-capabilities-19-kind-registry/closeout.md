# Closeout: task_01KWWYYXJD7N96MQH7XZV99A8A

## 1. 改动清单

- `packages/cli/src/cli/capability-entity-kinds.ts:1`: 新增共享 capability kind 派生源，合并 kernel `entityRegistryKinds` 与 `commandDescriptors`/`entityForCommand` 派生出的命令能力分组，并集中维护 capabilities 排除命令。
- `packages/cli/src/cli/parsers/capabilities.ts:3`: `knownEntityKinds` 改为 `new Set(capabilityEntityKinds)`，移除 19-kind 硬编码字面量。
- `packages/cli/src/commands/core/capabilities.ts:3`: capabilities runner 复用同一 `capabilityEntityKinds`，避免 parser 与 index 输出分叉。
- `tools/check-capabilities-kind-source.mjs:1`: 新增防回归检查脚本，regex 拒绝 capabilities parser 中包含 `"task"` 与 `"decision"` 的 `new Set([ ... ])` 硬编码 kind list。
- `tools/check-capabilities-kind-source.test.mjs:1`: 新增 checker 正反向测试。
- `tools/test-tier-manifest.mjs:69`: 将防回归测试纳入 contract tier，随 CI `test:contract` 执行。

## 2. 测试

- 新增 `tools/check-capabilities-kind-source.test.mjs`，覆盖：
  - 旧式 `new Set(["task", "decision", "fact"])` 会被拒绝。
  - registry-derived `new Set(capabilityEntityKinds)` 会通过。
- 已运行：
  - `node tools/check-capabilities-kind-source.mjs` -> passed
  - `npm run test:fast -- --concurrency=1` -> 207 passed
  - `npm run test:contract -- --concurrency=1` -> 289 passed
  - `npm run typecheck` -> passed
  - `npm run lint` -> passed
  - `git diff --check origin/main...HEAD` -> passed

## 3. 本地 gate 命令与结果

- `git fetch origin main && git rebase origin/main && npm run check:local`
- 结果：passed
- 摘要：branch already up to date; local check fast tier 14 steps passed in 15.5s, including typecheck, lint, test:fast, test:contract, import-boundaries, file-complexity, forbidden-symbols, private-boundary, gate-surface, runtime-release-readiness, implementation-contracts, schema-contracts, legacy-intake-readiness, package-policy.

## 4. PR 编号 + rebase base SHA

- PR: #278
- Rebase base SHA: `586bf68`
- Merge-base with `origin/main`: `586bf6889819`
- Branch head before closeout commit: `b6a0754`

## 5. 残留风险 / 已知未做

- `capabilityEntityKinds` 有意包含 kernel entity registry kinds 与 command-derived capability groups；这是为了保持 `graph capabilities` 等既有 capability index 行为。
- Cloud `rewrite-ci` 在 PR 创建后运行，当前 closeout只记录本地验证。
- 未触碰 daemon 红区。

## 6. `unverified` 清单

- `npm ci` 未本地运行。
- 完整 `npm run check` 未本地运行；按任务要求运行的是 `npm run check:local`。
- 完整 `npm test` 未本地运行；已运行 `test:fast` 与 `test:contract`，integration/gui 由 CI 覆盖。
- `npm run harness:smoke-cli-package` 未单独运行。
- GitHub Actions `rewrite-ci` 最终结果待 PR 页面确认。

## 7. 台账代写素材

- 进度 checkpoint 原文：`策略: 从 packages/kernel/src/domain/entity-kind-registry.ts 通过 bundled vertical 派生 kinds；同时复用 kernel entityRegistryKinds 覆盖内核实体`
- 实际执行台账写入命令：`ha task progress append task_01KWWYYXJD7N96MQH7XZV99A8A --text "..."`
- 结果：失败一次，`error code=task_not_found hint=task not found: task_01KWWYYXJD7N96MQH7XZV99A8A`；按 worker handbook 不再重试。
- Closeout 素材：本文件 1-6 节可作为任务 closeout 写回主台账。
