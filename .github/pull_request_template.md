> 本 PR 正文需中英双语填写：中文先行，英文跟随。Commit message 仍按既有约定填写，不强制双语。
> Fill this PR body bilingually: Chinese first, English follows. Commit messages keep the existing convention and are not required to be bilingual.

## 概要 / Summary


## 改动内容 / What Changed

-

## 任务与范围 / Task And Scope

- Harness 任务 / Harness task:
- 分支 / Branch:
- 公开范围 / Public scope:
- 私有计划 / 证据是否已更新 / Private planning/evidence updated: yes / no / not applicable
- 范围外 / Out of scope:

## 版本影响 / Version Impact

- 版本 / Version: `[旧版本]` -> `[新版本]` / 不改版本，原因是 [原因] / `[old]` -> `[new]` / no version change because [reason]
- 发布影响 / Publish impact: 不发布 / 只做发布准备 / 发布放到独立 release task / no publish / publish readiness only / publish intended in a separate release task

## 验证 / Verification

- `origin/main` 基准 SHA / Base `origin/main` SHA:
- 当前分支与 `origin/main` 的 merge-base / Branch merge-base with `origin/main`:
- 最近一次 `git fetch origin` 时间 / Last `git fetch origin` time:
- 同步方式 / Sync method: 不需要 / merge / rebase / none needed / merge / rebase
- 公开 diff 命令 / Public diff command:
- 私有证据 commit/path / Private evidence commit/path:
- Reviewer 证据路径 / Reviewer evidence path:
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
- [ ] `npm run harness:check-legacy-intake-readiness`
- [ ] `npm run harness:smoke-cli-package`
- [ ] GitHub Actions `rewrite-ci` passed
- 未运行 / Not run: [命令和原因 / command and reason]

## 审查证据 / Review Evidence

- 自查 / Self-review:
- Reviewer subagent:
- 人工审查 / Human review:
- 阻塞发现 / Blocking findings:

## PR 门禁清单 / PR Gate Checklist

- [ ] 分支基于最新 `origin/main`。 / Branch is based on latest `origin/main`.
- [ ] PR 描述使用本模板完整结构。 / PR body uses this full template.
- [ ] PR 正文中英双语，中文先行。 / PR body is bilingual with Chinese first.
- [ ] 不包含私有 harness 文件。 / No private harness files are included.
- [ ] 不包含被忽略的本地 agent 入口文件。 / No ignored local agent entry files are included.
- [ ] 本公开 PR 描述不包含本机绝对路径。 / No absolute local filesystem paths are included in this public PR body.
- [ ] CI 结果已链接或说明。 / CI results are linked or explained.
- [ ] open P0/P1/P2 findings 已关闭、带 owner 延后，或明确阻塞。 / Open P0/P1/P2 findings are closed, deferred with owner, or explicitly blocked.
- [ ] 合并方式和合并后分支清理计划清楚。 / Merge method and post-merge branch cleanup plan are clear.

## 残余风险 / Residual Risk

-

## 关联材料 / References

- 任务 / Task:
- 证据 / Evidence:
- 审查 / Review:
