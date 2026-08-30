---
name: harness-contributing
description: Contribute a public change to Harness Anything from a GitHub issue through an isolated worktree, scoped tests, manifest-selected gates, a complete bilingual PR body, review triage, and maintainer merge. Use when a human or coding agent is preparing or updating a contribution to this repository.
---

# Harness Contributing

This is the executable contribution path for this repository. Start with a
public issue or a maintainer-approved scope, work in one isolated worktree, and
finish with a reviewable pull request. The current
[`tools/gate-manifest.json`](../../tools/gate-manifest.json),
[`package.json`](../../package.json), and
[`pull_request_template.md`](../../.github/pull_request_template.md) remain the
machine-readable authorities they describe; inspect them instead of relying on
remembered job names or template fields.

## Boundary

Use only public repository source, public issue/PR discussion, and evidence a
reviewer may see. Never copy local planning records, generated runtime state,
local agent instructions, credentials, private URLs, or absolute machine paths
into the branch or PR body. Before every commit, inspect the complete staged
diff and confirm every path belongs to the stated public scope.

The contribution scope grants authority to change the stated files and run
local checks. Push the branch or open/update its PR only when the user or
maintainer asked for that external action. No contribution grants authority to
push to `main`, bypass a gate, force-push, or merge. A maintainer owns the final
merge.

> 中文：只使用公开仓库、公开 issue/PR 和 reviewer 可见的证据。不要把本地规划、
> 运行状态、凭证、私有链接或本机绝对路径放进公开 diff 或 PR。贡献者只能提交提案，
> 不能直推或自行合入 `main`。

## Environment and worktree

Node.js 24 or newer and git are required. For a new checkout, run:

```bash
git clone https://github.com/FairladyZ625/harness-anything.git
cd harness-anything
git fetch origin
node --version
git status --short --branch
```

Stop if Node is older than 24 or the checkout already has changes you do not
own. Do not implement on the primary checkout or shared `main`. From the primary
checkout, create exactly one task worktree from current `origin/main`:

```bash
git worktree add .worktrees/<slug> -b <branch> origin/main
cd .worktrees/<slug>
npm ci
git merge-base --is-ancestor origin/main HEAD
git status --short --branch
```

Replace `<slug>` with a short filesystem-safe scope and `<branch>` with the
public contribution branch, such as `fix/<slug>` or `docs/<slug>`. If either
name already belongs to another worktree, choose a new name; never share that
worktree. `git merge-base --is-ancestor` must exit zero before editing.

Read the issue and relevant source in this worktree. State, in one sentence,
the problem, allowed change surface, excluded surface, and proof required. Ask
for a maintainer decision rather than guessing when the public issue does not
settle a load-bearing choice.

> 中文：从最新 `origin/main` 创建独立 worktree；每个贡献者或 agent 使用自己的
> branch/worktree。先确认 Node 24+、安装依赖、写清范围，再开始编辑。

## Make the change and test its surface

Keep the patch to the smallest coherent solution. Inspect nearby code and tests
before adding a new abstraction. Preserve unrelated changes and generated
files.

Every new Node test under `packages/` or `tools/` must:

- have a filename ending in `.test.mjs`, `.test.js`, `.test.ts`, `.spec.mjs`,
  `.spec.js`, or `.spec.ts`; and
- put exactly one of these declarations on line 1:

```js
// harness-test-tier: fast
// harness-test-tier: contract
// harness-test-tier: integration
```

Choose `fast` for pure or near-pure behavior, `contract` for public API/schema
or cross-package contracts, and `integration` for CLI, filesystem, store,
migration, or other slower behavior. The rules are enforced by
[`tools/test-tier-manifest.mjs`](../../tools/test-tier-manifest.mjs); there is no
central file list to edit.

Run each changed or newly added Node test through the repository runner:

```bash
node tools/run-node-tests.mjs --file <repo-relative-test-file>
```

Repeat `--file` for multiple exact files when they form one test surface. For a
docs-only change, run the closest docs checker or checker test if one exists;
do not invent a meaningless test. Always inspect the patch:

```bash
git status --short
git diff --check
git diff --stat
git diff -- <changed-paths>
```

> 中文：测试文件名必须匹配 `.test`/`.spec` 约定，首行必须且只能声明一个
> `fast|contract|integration` tier。先跑改动面的精确测试；docs-only 改动若没有
> 对应行为测试，不要为了凑数新增无意义测试。

## Run local gates

Do not use `npm run check:local` as the contribution loop, and do not run the
full aggregate merely to approximate GitHub. GitHub CI is authoritative. Run
the exact local job surface selected from the current gate manifest, plus
typecheck.

First list the current pull-request job names and tiers:

```bash
node -e 'const m=require("./tools/gate-manifest.json"); console.log([...new Set(m.gates.filter(g=>!g.aggregate).flatMap(g=>(g.executionSurfaces?.rewriteCi?.pullRequestJobs??[]).map(job=>`${g.tier}\t${job}`)))].sort().join("\n"))'
```

Then run every job that matches the changed surface:

```bash
node tools/run-manifest-gates.mjs --workflow-job <job>
npm run typecheck
```

`boundaries` is the usual job for public source, tool, and documentation
boundaries. Use the manifest's other current PR jobs when the patch touches
their surface—for example tests, package policy, dependencies/supply chain, or
the GUI. Record every command and result in the PR body, including a scoped
reason for anything not run.

One gate has a local credential exception. If `boundaries` reaches
`check-github-required-contexts` and fails only because no GitHub repository or
token is available, preserve that output and rerun the same job with only that
gate excluded:

```bash
node tools/run-manifest-gates.mjs --workflow-job boundaries --exclude check-github-required-contexts
```

Do not use that exclusion for any other failure, and never treat it as a CI
waiver. The required GitHub context must still pass on the PR.

> 中文：从 `tools/gate-manifest.json` 读取当前 job/tier，用
> `run-manifest-gates` 跑改动面对应的 job，并始终运行 `npm run typecheck`。
> 本地只有 `check-github-required-contexts` 可在确认确实缺 GitHub 凭证后单独排除；
> 该排除不适用于 CI，也不能掩盖其他失败。

## Commit with the contributor identity

Confirm the author identity before committing:

```bash
git config --get user.name
git config --get user.email
```

If either is empty or wrong, the contributor must set their own identity before
continuing:

```bash
git config user.name "<your name>"
git config user.email "<your email>"
```

Stage only named contribution paths, recheck the staged patch, and commit:

```bash
git add <changed-paths>
git diff --cached --check
git diff --cached --stat
git diff --cached -- <changed-paths>
git commit -m "<feat|fix|refactor|docs|test|ci>: <concise English summary>"
```

Do not mention an AI author in the commit message. Use the actual human or
agent operator's configured git identity.

## Prepare the bilingual PR body

Do this after all contribution commits, because the production-delta gate
measures committed `HEAD` from its merge-base. Refresh and synchronize first,
then rerun affected tests and gates if the rebase changes the branch:

```bash
git fetch origin
git rebase origin/main
git rev-parse origin/main
git merge-base origin/main HEAD
git status --short --branch
```

Copy the current template; never reconstruct its sections from memory:

```bash
cp .github/pull_request_template.md /tmp/harness-anything-pr-body.md
${EDITOR:-vi} /tmp/harness-anything-pr-body.md
```

Fill every uncommented section in the complete `# English` block and the
complete `# 中文` block. Preserve their order and the shared checklist. Use
`not applicable` plus a reason where appropriate instead of deleting a section.
Keep machine-readable declarations exactly once and only in the English block,
flush left as the template instructs. Do not claim CI, human review, or a test
that has not happened.

To obtain `Production-Delta`, replace the template's `N` and `M` with zero as a
provisional declaration, run the authoritative calculator, replace it with the
printed `+N/-M`, and run again until it passes:

```bash
node tools/gates/production-delta.mjs --base origin/main --pr-body-file /tmp/harness-anything-pr-body.md
${EDITOR:-vi} /tmp/harness-anything-pr-body.md
node tools/gates/production-delta.mjs --base origin/main --pr-body-file /tmp/harness-anything-pr-body.md
```

For a docs-only branch this is normally `Production-Delta: +0/-0`; never assume
that value for a source change. If production churn exceeds 200 lines or net
growth exceeds +300, fill both architectural-justification sections.

Preflight the two complete language blocks through the requested environment
interface, then run the manifest's full PR-body job:

```bash
export PR_BODY="$(cat /tmp/harness-anything-pr-body.md)"
node tools/check-pr-body-bilingual.mjs --env PR_BODY
export PR_BASE_SHA="$(git merge-base origin/main HEAD)"
export PR_HEAD_SHA="$(git rev-parse HEAD)"
node tools/run-manifest-gates.mjs --workflow-job pr-body-lint
unset PR_BODY PR_BASE_SHA PR_HEAD_SHA
```

[`references/example-pr-body.md`](references/example-pr-body.md) is a completed
docs-only example that exercises every section. It is a fixture, not a template:
always copy the live repository template for a real PR.

> 中文：所有 commit 完成后再计算 `Production-Delta`。PR body 必须保留模板的完整
> 英文块、完整中文块和共享 checklist；机读声明只在英文块顶格出现一次。不得把未发生
> 的 CI、人工 review 或测试写成已完成。

## Push and open the PR

Push only the contribution branch to a remote where the contributor has write
access:

```bash
git push -u <write-remote> HEAD
```

With an authenticated GitHub CLI, open the PR against the canonical `main`:

```bash
gh auth status
gh pr create --repo FairladyZ625/harness-anything --base main --head <github-user>:<branch> --title "<PR title>" --body-file /tmp/harness-anything-pr-body.md
```

If the branch is in the canonical repository rather than a fork, use
`--head <branch>`. Save the PR URL. Update the body rather than replacing it
with a shorter hand-written summary when later commits change scope or delta.

## Review and merge

Watch the protected checks and read the actual failure output:

```bash
gh pr checks <pr-number> --repo FairladyZ625/harness-anything --watch
gh pr view <pr-number> --repo FairladyZ625/harness-anything --comments
```

Triage every concrete reviewer or bot finding. Before merge, each P0/P1/P2
finding must be fixed, explained as a false positive, deferred with an owner and
reason, or left explicitly blocking. For a fix, edit the same worktree, rerun
the smallest proving test and affected manifest jobs, make another prefixed
commit, push normally, and update the PR body and `Production-Delta`. Never
force-push to escape a failed check.

External contributors and their agents stop after the PR is green, current,
conflict-free, and fully reviewed. A maintainer performs the repository's normal
merge-commit path; only that maintainer may run:

```bash
gh pr merge <pr-number> --repo FairladyZ625/harness-anything --merge --delete-branch
```

Do not squash, rebase-merge, direct-push, or use an admin bypass. The
contribution is complete when GitHub reports the PR merged or closed with a
clear reason.

> 中文：逐条处理 CI、human review 和 bot comment；P0/P1/P2 必须完成 triage。
> 外部贡献者或 agent 在 PR 全绿、无冲突、review 完成后停下，由 maintainer 用普通
> merge commit 合入。不得 squash、rebase merge、直推或 admin bypass。

## Agent contributor notes

An agent follows the same path and evidence standard as a human. It must keep
the declared scope visible, preserve unrelated work, show exact commands and
results, and leave external actions such as pushing or opening a PR within the
user's granted authority. It must not report human review, Dashboard
confirmation, release readiness, or merge approval on anyone else's behalf.

Before handoff, report:

- what changed and what stayed out of scope;
- exact tests and manifest jobs run, with pass/fail results;
- commands not run and the scoped reason;
- the production delta and PR-body preflight result;
- open findings, residual risk, and the files needing human attention; and
- that merge remains maintainer-owned.

> 中文：agent 必须保留无关改动、如实报告命令结果，且不能替人声称人工确认、发布
> 就绪或合入批准。handoff 要写清改动、验证、未跑项、风险和 maintainer 合入边界。
