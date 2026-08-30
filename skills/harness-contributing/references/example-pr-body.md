# English

## Summary

Document the repository's contribution workflow through one public skill and
make the public entry pages point to that authority.

## Architectural Justification

- Not required: this example has no production-source churn.

## What Changed

- Added a public contribution skill and replaced duplicated procedural prose
  with links to that skill.

## Gate Harvest / 门收割

Deleted-Production-Paths: none
Deleted-Gates-Fixtures: none
- Production net lines: the declaration below is calculator-backed.

## Machine-Readable Declarations

Production-Delta: +0/-0

### Optional Evidence Claims

- None. This example makes no CI-attribution or performance claim.

## Task And Scope

- Harness task: not applicable; this external example has no public issue
- Branch: `docs/contributing-smoke`
- Public scope: contribution skill and public contributing pages
- Private planning/evidence updated: not applicable
- Out of scope: source behavior, gate policy, and CI configuration

## Version Impact

- Version: no version change because this is documentation only
- Publish impact: no publish

## Governance Declaration

- Protected surface touched: no
- Protected surface scope: not applicable
- Authority: not applicable
- Machine-check boundary: the declaration exists; reviewers decide whether it is sufficient.
- Break-glass: no
- Break-glass reason: not applicable
- Break-glass scope: not applicable
- Follow-up governance task: not applicable

## Verification

- Base `origin/main` SHA: `b0a9b74fd921ada93f6854d10bf1ff116725f482`
- Branch merge-base with `origin/main`: `b0a9b74fd921ada93f6854d10bf1ff116725f482`
- Last `git fetch origin` time: 2026-08-30 UTC
- Sync method: none needed
- Public diff command: `git diff --stat origin/main...HEAD`
- Private evidence commit/path: not applicable
- Reviewer evidence path: this PR's review thread
- GitHub Actions `rewrite-ci` run URL: pending until the PR is opened
- [x] `npm ci`
- [x] `git diff --check`
- [ ] `npm run check`
- [x] `npm run typecheck`
- [ ] `npm test`
- [x] `npm run harness:check-import-boundaries`
- [x] `npm run harness:scan-forbidden-symbols`
- [x] `npm run harness:check-private-boundary`
- [ ] `npm run harness:check-package-policy`
- [x] `npm run harness:check-implementation-contracts`
- [x] `npm run harness:check-schema-contracts`
- [x] `npm run harness:check-legacy-intake-readiness`
- [ ] `npm run harness:smoke-cli-package`
- [ ] GitHub Actions `rewrite-ci` passed
- Not run: the full aggregate, `npm test`, package-policy, smoke CLI, and other
  unrelated jobs. The manifest-selected `boundaries` job ran and passed the six
  checked `harness:*` commands indirectly; typecheck passed directly, while
  GitHub CI remains authoritative.

## Review Evidence

- Self-review: checked scope, links, commands, bilingual structure, and public-only wording
- Reviewer subagent: not used
- Human review: pending on the PR
- Blocking findings: none at handoff

## Residual Risk

- The live PR template or gate manifest may change; contributors must read both
  from their current branch instead of copying this example.

## References

- Task: public contribution workflow documentation
- Evidence: local command results recorded in Verification
- Review: PR review thread when opened

---

# 中文

## 概要

用一份公开 skill 记录本仓唯一贡献流程，并让公开入口页引用这份权威说明。

## 架构辩护

- 不需要：这个示例没有生产源码增删。

## 改动内容

- 新增公开贡献 skill，并把重复的流程文字替换为指向该 skill 的链接。

## 门收割 / Gate Harvest

- 删除的生产路径：无。
- 同 commit 删除的门 / fixture：无。
- 生产净行数：引用英文块中由工具计算的唯一声明。

## 机读声明说明

- 英文块中的 `Production-Delta` 是唯一机读生产增删声明。
- 本示例没有依赖变化，也没有保留旧生产路径。
- 无；本示例不声明 CI 归因或性能证据。

## 任务与范围

- Harness 任务：不适用；此外部示例没有公开 issue
- 分支：`docs/contributing-smoke`
- 公开范围：贡献 skill 与公开贡献入口页
- 私有计划 / 证据是否已更新：不适用
- 范围外：源码行为、gate policy 与 CI 配置

## 版本影响

- 版本：纯文档改动，不修改版本
- 发布影响：不发布

## 治理声明

- 是否触碰 protected surface：否
- protected surface 范围：不适用
- 依据：不适用
- 机器检查边界：本段声明存在，是否充分由 reviewer 判断。
- Break-glass：否
- Break-glass 原因：不适用
- Break-glass 范围：不适用
- 后续治理任务：不适用

## 验证

- `origin/main` 基准 SHA：`b0a9b74fd921ada93f6854d10bf1ff116725f482`
- 当前分支与 `origin/main` 的 merge-base：`b0a9b74fd921ada93f6854d10bf1ff116725f482`
- 最近一次 `git fetch origin` 时间：2026-08-30 UTC
- 同步方式：不需要
- 公开 diff 命令：`git diff --stat origin/main...HEAD`
- 私有证据 commit/path：不适用
- Reviewer 证据路径：本 PR 的 review thread
- GitHub Actions `rewrite-ci` run URL：PR 创建后补充
- [x] `npm ci`
- [x] `git diff --check`
- [ ] `npm run check`
- [x] `npm run typecheck`
- [ ] `npm test`
- [x] `npm run harness:check-import-boundaries`
- [x] `npm run harness:scan-forbidden-symbols`
- [x] `npm run harness:check-private-boundary`
- [ ] `npm run harness:check-package-policy`
- [x] `npm run harness:check-implementation-contracts`
- [x] `npm run harness:check-schema-contracts`
- [x] `npm run harness:check-legacy-intake-readiness`
- [ ] `npm run harness:smoke-cli-package`
- [ ] GitHub Actions `rewrite-ci` passed
- 未运行：未跑完整聚合、`npm test`、package-policy、smoke CLI 及其他无关 job。
  manifest 选择的 `boundaries` job 间接运行并通过了上面勾选的六条 `harness:*`
  命令；typecheck 是直接运行并通过，最终以 GitHub CI 为准。

## 审查证据

- 自查：已检查 scope、链接、命令、双语结构和公开边界
- Reviewer subagent：未使用
- 人工审查：等待 PR review
- 阻塞发现：handoff 时无

## 残余风险

- 实际 PR template 或 gate manifest 可能变化；贡献者必须读取当前 branch 的文件，
  不能直接复制本示例。

## 关联材料

- 任务：公开贡献流程文档
- 证据：Verification 中记录的本地命令结果
- 审查：PR 创建后的 review thread

---

## PR Gate Checklist / PR 门禁清单

- [x] Branch is based on latest `origin/main`. / 分支基于最新 `origin/main`。
- [x] PR body uses this full template structure. / PR 描述使用本模板完整结构。
- [x] PR body uses two complete language blocks: `# English` first, then `# 中文`. / PR 正文使用两块完整正文：`# English` 在上，`# 中文` 在下。
- [x] PR body passes `tools/check-pr-body-bilingual.mjs`. / PR 正文通过 `tools/check-pr-body-bilingual.mjs`。
- [x] If the PR touches a manifest-derived protected surface, Governance Declaration is filled with authority evidence or break-glass fields. / 若 PR 触碰 manifest 派生的 protected surface，Governance Declaration 已填写依据或 break-glass 字段。
- [x] No private files are included. / 不包含私有文件。
- [x] No ignored local agent entry files are included. / 不包含被忽略的本地 agent 入口文件。
- [x] No absolute local filesystem paths are included in this public PR body. / 本公开 PR 描述不包含本机绝对路径。
- [x] Public diff is limited to the stated task scope. / 公开 diff 限于声明的任务范围。
- [x] Private planning/evidence updates are recorded when applicable. / 适用时已记录私有计划 / 证据更新。
- [x] Version and publish impact are stated. / 已说明版本与发布影响。
- [x] Local verification commands are recorded honestly. / 已如实记录本地验证命令。
- [x] CI results are linked or explained. / CI 结果已链接或说明。
- [x] Review evidence is recorded. / 已记录审查证据。
- [x] Open P0/P1/P2 findings are closed, deferred with owner, or explicitly blocked. / open P0/P1/P2 findings 已关闭、带 owner 延后，或明确阻塞。
- [x] Merge method and post-merge branch cleanup plan are clear. / 合并方式和合并后分支清理计划清楚。
- [x] No admin bypass is planned unless explicitly approved and recorded. / 除非明确批准并记录，否则不计划 admin bypass。
