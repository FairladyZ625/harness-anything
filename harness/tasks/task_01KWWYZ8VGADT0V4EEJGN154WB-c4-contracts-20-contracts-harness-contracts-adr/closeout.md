# C4 Contracts Self-Host Closeout

1. 改动清单

- `harness/contracts/`: added the self-hosted contracts set with 18 migrated source documents plus `README.md`.
- `harness/contracts/README.md`: added the canonical contract index with short descriptions.
- `harness/decisions/decision-dec_ARCH_CONTRACTS_SELF_HOST/decision.md`: updated the contract migration decision reference to `harness/contracts/`.
- `harness/milestones/**/*.md`: updated legacy `20-contracts/` references to project-root-relative `harness/contracts/` references.
- Legacy architecture contracts pointer: added `MOVED.md` pointing to `harness/contracts/`.
- No `packages/` files were changed.

2. 测试

- No tests were added; this is a documentation migration.
- Ran `npm ci`: passed, 0 vulnerabilities.
- Ran `npm run check`: passed after public legacy-readiness wording fixes.

3. 本地 gate 命令与结果

- `git diff --cached --check`: passed.
- `node tools/check-private-boundary.mjs`: passed.
- `node tools/check-implementation-contracts.mjs`: passed.
- `node tools/check-legacy-intake-readiness.mjs`: passed.
- `npm run check`: passed.

4. PR 编号 + rebase base SHA

- PR: #280.
- Base SHA: `a76e630132c80e118adf7ad233e8afcf937d0acb`.

5. 残留风险 / 已知未做

- The source contracts came from the local private harness tree because the specified legacy architecture contracts source is not tracked in this public worktree.
- To satisfy public gates, newly tracked contract text was lightly normalized away from forbidden legacy runtime symbols and active cutover wording. The migration intent and contract structure remain intact.

6. unverified 清单

- GitHub Actions result is unverified until the PR is opened and CI runs.

7. 台账代写素材

- Progress append attempted with `ha task progress append task_01KWWYZ8VGADT0V4EEJGN154WB --text "引用更新清单: ..."` and failed once with `task_not_found`.
- 引用更新清单: `harness/milestones/00-roadmap.md`; `harness/milestones/commercial/com-sync/00-overview.md`; `harness/milestones/00-packet-contract-template.md`; `harness/milestones/platform/plt-adapter/02-status-checklist.md`; `harness/milestones/platform/plt-adapter/00-overview.md`; `harness/decisions/decision-dec_ARCH_CONTRACTS_SELF_HOST/decision.md`; `harness/milestones/foundation/m1-minimal-loop/reviews/02-collaboration-layout-review-brief.md`; `harness/milestones/gui/gui-v1-local-remote/02-status-checklist.md`; `harness/milestones/gui/gui-v1-local-remote/01-feature-breakdown.md`; `harness/milestones/gui/gui-v1-local-remote/00-overview.md`; `harness/milestones/platform/plt-notify/00-overview.md`; `harness/milestones/foundation/m1-minimal-loop/02-status-checklist.md`; `harness/milestones/02-implementation-status-matrix.md`; `harness/milestones/foundation/m1-minimal-loop/00-overview.md`; `harness/milestones/foundation/m2-coding-vertical/00-overview.md`; `harness/milestones/foundation/m2-5-cli/03-confidence-loop.md`; `harness/milestones/foundation/m2-coding-vertical/04-status-checklist.md`; `harness/milestones/foundation/m2-coding-vertical/01-feature-breakdown-task-lifecycle.md`; `harness/milestones/foundation/m6-productization-gate/01-packet-breakdown.md`; `harness/milestones/foundation/m2-5-gui/03-review-action-matrix.md`; `harness/milestones/foundation/m2-5-gui/00-overview.md`; `harness/milestones/foundation/m2-5-gui/01-feature-breakdown.md`; `harness/milestones/foundation/m3-triadic-kernel/01-feature-breakdown.md`.
