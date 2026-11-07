# English

## Summary

Document the repository's contribution workflow through one public skill and
make the public entry pages point to that authority (#1234).

## What Changed

- Added a public contribution skill and replaced duplicated procedural prose
  with links to that skill.

## Machine-Readable Declarations

### Optional Evidence Claims

- None. This example makes no CI-attribution or performance claim.

## Governance Declaration

- Protected surface touched: no
- Protected surface scope: not applicable
- Authority: not applicable
- Machine-check boundary: the declaration exists; reviewers decide whether it is sufficient.
- Break-glass: no

## Verification

- Delivery facts: inserted from the frozen submission by `tools/gates/render-task-pr-body.mjs`; this docs-only example has no repository commit or production delta.
- Public diff command: `git diff --stat origin/main...HEAD`
- Private evidence commit/path: not applicable
- CI status: read from the PR checks after opening; no run URL is copied into the body.
- Commands recorded below ran exactly as written; anything not run is listed with a reason.
- Not run: the full aggregate, `npm test`, `npm run check`,
  `npm run harness:check-package-policy`, `npm run harness:smoke-cli-package`,
  and other unrelated jobs. The manifest-selected `boundaries` job ran and
  passed the six `harness:*` boundary/contract commands indirectly; typecheck
  passed directly, while GitHub CI remains authoritative.

## Residual Risk

- The live PR template or gate manifest may change; contributors must read both
  from their current branch instead of copying this example.

# 中文

## 摘要

用一份公开 skill 记录仓库的贡献流程，并把公开入口页指向该权威（#1234）。

## 改动内容

- 新增公开贡献 skill，并把重复的流程说明替换为指向该 skill 的链接。

## 验证

- 交付事实由 `tools/gates/render-task-pr-body.mjs` 从冻结的 submission 生成；本仅文档示例没有仓库 commit 或 production delta。
- 上节英文 Verification 中列出的命令、未运行项与理由同样适用于中文两段。
