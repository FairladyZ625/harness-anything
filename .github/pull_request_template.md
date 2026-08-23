> Fill this PR body as two complete language blocks: English first, then `---`, then Chinese. Commit messages keep the existing convention and are not required to be bilingual.
> 本 PR 正文需按两块完整正文填写：英文在上，然后 `---` 分隔，中文在下。Commit message 仍按既有约定填写，不强制双语。

# English

## Summary


## What Changed

-

## Machine-Readable Declarations

<!-- These declarations are checked by jobs in `.github/workflows/rebuild-gates.yml`, the authority for their exact formats; `tools/gate-manifest.json` does not enumerate these jobs. -->
<!-- Keep every uncommented keyword and its value on the same line. Keep each applicable declaration exactly once in the entire bilingual body, only in this English block, flush left without a Markdown list marker. -->
<!-- Replace N and M with the actual added and deleted production line counts, including zero when appropriate. -->
Production-Delta: +N/-M
<!-- If any package.json or package-lock.json changes, replace the rejected `none` sentinel with a complete deterministic description; otherwise delete the entire next line. -->
Dependency-Change: none
<!-- Optional: only when retaining an old production path, remove the surrounding comment markers from the next line and replace every placeholder. -->
<!-- Retained-Path: <path> until <YYYY-MM-DD> per <dec_id> -->

### Optional Evidence Claims

<!-- Evidence claims are checked by the `evidence-contract` job in `.github/workflows/rebuild-gates.yml`. No claim means N/A. -->
<!-- Keep every uncommented claim keyword, field, and value on the same line. Remove the comment markers from one complete block only when making that claim. -->
<!-- `Evidence-Type: ci` may replace `CI-Attribution: ...`; `Evidence-Type: performance` may replace `Performance-Claim: ...`. -->
<!-- CI-Attribution: <what this CI run proves> -->
<!-- run-url: https://github.com/<owner>/<repo>/actions/runs/<run-id> -->
<!-- commit-sha: <full 40-character SHA> -->
<!-- failed-test: <test name, or none if no test failed> -->
<!-- scope: <evidence scope> -->
<!-- owner: <responsible owner> -->
<!-- Performance-Claim: <what this paired performance evidence proves> -->
<!-- run-url: https://github.com/<owner>/<repo>/actions/runs/<run-id> -->
<!-- commit-sha: <full 40-character SHA> -->
<!-- failed-test: <test name, or none if no test failed> -->
<!-- scope: <performance scope> -->
<!-- owner: <responsible owner> -->
<!-- fixture: <fixture name> -->
<!-- phase: <measured phase> -->
<!-- baseline: <full 40-character SHA or HTTPS evidence URL> -->

## Task And Scope

- Harness task:
- Branch:
- Public scope:
- Private planning/evidence updated: yes / no / not applicable
- Out of scope:

## Version Impact

- Version: `[old]` -> `[new]` / no version change because [reason]
- Publish impact: no publish / publish readiness only / publish intended in a separate release task

## Governance Declaration

<!-- These governance fields are Markdown list items; unlike the flush-left declarations above, this parser accepts the `- ` prefix. -->
- Protected surface touched: yes / no
- Protected surface scope:
- Authority: [replace with one authorizing ADR-####, dec_<ID>, or task_<ID>; use not applicable only when no protected surface is touched]
- Machine-check boundary: this PR only asserts the declaration exists; reviewers decide whether it is true and sufficient.
- Break-glass: no / yes
- Break-glass reason: [required when Break-glass is yes]
- Break-glass scope: [required when Break-glass is yes]
- Follow-up governance task: task_<ID> [required when Break-glass is yes]

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
- [ ] `npm run harness:check-legacy-intake-readiness`
- [ ] `npm run harness:smoke-cli-package`
- [ ] GitHub Actions `rewrite-ci` passed
- Not run: [command and reason]

## Review Evidence

- Self-review:
- Reviewer subagent:
- Human review:
- Blocking findings:

## Residual Risk

-

## References

- Task:
- Evidence:
- Review:

---

# 中文

## 概要


## 改动内容

-

## 机读声明说明

- 这些声明由 `.github/workflows/rebuild-gates.yml` 中的 job 校验；每个未注释的关键词和值必须写在同一行。
- 未注释的机读声明只能在英文块各出现一次、必须顶格，不能加 Markdown 列表符号；下方治理字段仍是列表项，两类格式不要混用。
- 生产增删：在英文块把 N 和 M 替换为实际新增、删除行数，适用时可填零。
- 依赖变化：修改任意 `package.json` 或 `package-lock.json` 时，把英文行中的拒绝 sentinel `none` 换成完整的确定性变化描述；否则删除整行。
- 保留旧路径：仅在适用时把英文样例移出 HTML 注释，填写路径、到期日和 `dec_` id；否则保持注释。
- Evidence claim 完全可选；只有确实声明 CI 归因或性能证据时，才把一个完整英文样例块移出 HTML 注释并填满全部字段。

## 任务与范围

- Harness 任务：
- 分支：
- 公开范围：
- 私有计划 / 证据是否已更新：yes / no / not applicable
- 范围外：

## 版本影响

- 版本：`[旧版本]` -> `[新版本]` / 不改版本，原因是 [原因]
- 发布影响：不发布 / 只做发布准备 / 发布放到独立 release task

## 治理声明

- 以下治理字段可以保留 Markdown 列表符号；这与上方必须顶格的机读声明不同。
- 是否触碰 protected surface：yes / no
- protected surface 范围：
- 依据：[替换为一个有效的 ADR-####、dec_<ID> 或 task_<ID>；仅未触碰 protected surface 时填不适用]
- 机器检查边界：本 PR 只声明该段存在；声明是否真实、充分，由 reviewer 判断。
- Break-glass：no / yes
- Break-glass 原因：[Break-glass 为 yes 时必填]
- Break-glass 范围：[Break-glass 为 yes 时必填]
- 后续治理任务：task_<ID> [Break-glass 为 yes 时必填]

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
- [ ] `npm run harness:check-legacy-intake-readiness`
- [ ] `npm run harness:smoke-cli-package`
- [ ] GitHub Actions `rewrite-ci` passed
- 未运行：[命令和原因]

## 审查证据

- 自查：
- Reviewer subagent：
- 人工审查：
- 阻塞发现：

## 残余风险

-

## 关联材料

- 任务：
- 证据：
- 审查：

---

## PR Gate Checklist / PR 门禁清单

- [ ] Branch is based on latest `origin/main`. / 分支基于最新 `origin/main`。
- [ ] PR body uses this full template structure. / PR 描述使用本模板完整结构。
- [ ] PR body uses two complete language blocks: `# English` first, then `# 中文`. / PR 正文使用两块完整正文：`# English` 在上，`# 中文` 在下。
- [ ] PR body passes `tools/check-pr-body-bilingual.mjs`. / PR 正文通过 `tools/check-pr-body-bilingual.mjs`。
- [ ] If the PR touches a manifest-derived protected surface, Governance Declaration is filled with ADR/decision/task evidence or break-glass fields. / 若 PR 触碰 manifest 派生的 protected surface，Governance Declaration 已填写 ADR/decision/task 依据或 break-glass 字段。
- [ ] No private harness files are included. / 不包含私有 harness 文件。
- [ ] No ignored local agent entry files are included. / 不包含被忽略的本地 agent 入口文件。
- [ ] No absolute local filesystem paths are included in this public PR body. / 本公开 PR 描述不包含本机绝对路径。
- [ ] Public diff is limited to the stated task scope. / 公开 diff 限于声明的任务范围。
- [ ] Private planning/evidence updates are recorded when applicable. / 适用时已记录私有计划 / 证据更新。
- [ ] Version and publish impact are stated. / 已说明版本与发布影响。
- [ ] Local verification commands are recorded honestly. / 已如实记录本地验证命令。
- [ ] CI results are linked or explained. / CI 结果已链接或说明。
- [ ] Review evidence is recorded. / 已记录审查证据。
- [ ] Open P0/P1/P2 findings are closed, deferred with owner, or explicitly blocked. / open P0/P1/P2 findings 已关闭、带 owner 延后，或明确阻塞。
- [ ] Merge method and post-merge branch cleanup plan are clear. / 合并方式和合并后分支清理计划清楚。
- [ ] No admin bypass is planned unless explicitly approved and recorded. / 除非明确批准并记录，否则不计划 admin bypass。
