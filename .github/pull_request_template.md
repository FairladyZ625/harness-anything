## Summary


## What Changed

-

## Task And Scope

- Harness task:
- Branch:
- Public scope:
- Private planning/evidence updated: yes / no / not applicable
- Out of scope:

## Version Impact

- Version: `[old]` -> `[new]` / no version change because [reason]
- Publish impact: no publish / publish readiness only / publish intended in a separate release task

## Verification

- Base `origin/main` SHA:
- Branch merge-base with `origin/main`:
- Last `git fetch origin` time:
- Sync method: none needed / merge / rebase
- Public diff command:
- Private evidence commit/path:
- Reviewer evidence path:
- GitHub Actions `rewrite-ci` run URL:
- [ ] `npm ci`
- [ ] `git diff --check`
- [ ] `npm run check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run harness:check-import-boundaries`
- [ ] `npm run harness:scan-forbidden-symbols`
- [ ] `npm run harness:check-private-boundary`
- [ ] `npm run harness:check-package-policy`
- [ ] `npm run harness:check-implementation-contracts`
- [ ] `npm run harness:check-schema-contracts`
- [ ] GitHub Actions `rewrite-ci` passed
- Not run: [command and reason]

## Review Evidence

- Self-review:
- Reviewer subagent:
- Human review:
- Blocking findings:

## PR Gate Checklist

- [ ] Branch is based on latest `origin/main`.
- [ ] PR body uses this full template.
- [ ] No private harness files are included.
- [ ] No ignored local agent entry files are included.
- [ ] No absolute local filesystem paths are included in this public PR body.
- [ ] CI results are linked or explained.
- [ ] Open P0/P1/P2 findings are closed, deferred with owner, or explicitly blocked.
- [ ] Merge method and post-merge branch cleanup plan are clear.

## Residual Risk

-

## References

- Task:
- Evidence:
- Review:

---

## 摘要


## 改动内容

-

## 任务与范围

- Harness 任务：
- 分支：
- 公开范围：
- 私有计划 / 证据是否已更新：yes / no / not applicable
- 范围外：

## 版本影响

- 版本：`[旧版本]` -> `[新版本]` / 不改版本，原因是 [原因]
- 发布影响：不发布 / 只做发布准备 / 发布放到独立 release task

## 验证

- `origin/main` 基准 SHA：
- 当前分支与 `origin/main` 的 merge-base：
- 最近一次 `git fetch origin` 时间：
- 同步方式：不需要 / merge / rebase
- 公开 diff 命令：
- 私有证据 commit/path：
- Reviewer 证据路径：
- GitHub Actions `rewrite-ci` run URL：
- [ ] `npm ci`
- [ ] `git diff --check`
- [ ] `npm run check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run harness:check-import-boundaries`
- [ ] `npm run harness:scan-forbidden-symbols`
- [ ] `npm run harness:check-private-boundary`
- [ ] `npm run harness:check-package-policy`
- [ ] `npm run harness:check-implementation-contracts`
- [ ] `npm run harness:check-schema-contracts`
- [ ] GitHub Actions `rewrite-ci` passed
- 未运行：[命令和原因]

## 审查证据

- 自查：
- Reviewer subagent：
- 人工审查：
- 阻塞发现：

## PR 门禁清单

- [ ] 分支基于最新 `origin/main`。
- [ ] PR 描述使用本模板完整结构。
- [ ] 不包含私有 harness 文件。
- [ ] 不包含被忽略的本地 agent 入口文件。
- [ ] 本公开 PR 描述不包含本机绝对路径。
- [ ] CI 结果已链接或说明。
- [ ] open P0/P1/P2 findings 已关闭、带 owner 延后，或明确阻塞。
- [ ] 合并方式和合并后分支清理计划清楚。

## 残余风险

-

## 关联材料

- 任务：
- 证据：
- 审查：
