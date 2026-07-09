# Changelog

Harness Anything has not published a versioned release yet. This changelog uses
date-based, source-checkout anchors until there is a real release artifact to
name.

Entries are grouped by user-visible capability, not by individual PR title.
Source data for this first changelog pass: merged GitHub PRs through #492
(`gh pr list --state merged --limit 500 --json number,title,mergedAt`), the
July 9, 2026 documentation canon, and the local code evidence named below.

## Unreleased - source checkout through 2026-07-09

### Agent accountability loop

- Built the core decision / task / fact ledger on plain Markdown plus git:
  local task lifecycle commands, decision records, fact records, typed
  relations, and SQLite projections that can be rebuilt from authored files.
  Representative PRs: #1, #2, #3, #4, #17, #102-#110, #124, #144, #155, #157,
  #179.
- Hardened completion so "done" is not just a status write: task completion
  requires evidence, review verdicts, closeout checks, CI input, and code-doc
  reconciliation anchors. Representative PRs: #17, #28, #119, #120, #157,
  #171, #200, #478.
- Standardized command receipts, error codes, help output, command events, and
  capabilities so agents receive machine-readable feedback instead of prose-only
  failure messages. Representative PRs: #73, #75, #76, #78, #82, #143, #229,
  #278.

### Task trees and relation semantics

- Added hierarchical tasks: task creation can bind a parent, task reads can show
  trees, and the parent field is create-time immutable. Representative PRs:
  #184, #188, #460.
- Added task-to-task `depends-on` relations and cycle rejection, including
  planner support for subtask expansion without automatic execution.
  Representative PRs: #184, #202.
- Added relation graph and graph panorama surfaces over tasks, decisions, facts,
  and relation edges. Representative PRs: #110, #133, #168, #179, #480.

### Local daemon and multi-repo coordination

- Added a local JSON-RPC daemon path for command execution behind one write
  coordinator. Representative PRs: #233, #236, #239, #245, #253, #264.
- Added user-level repo registration and multi-repo routing so one local daemon
  can serve multiple harness repositories by repo id. Representative PRs: #292,
  #294, #296, #304, #430.
- Added daemon identity and authorization hooks for repositories with
  `harness/people.yaml`; without that roster, local daemon connections remain
  trusted by the local transport boundary. Representative PRs: #243, #270.

Boundary: this is local daemon coordination. It is not an HTTP API, public TCP
service, remote tunnel product, or SSH team-concurrency workflow.

### Desktop inspection surface

- Added an Electron GUI workspace and route registry, then wired the renderer
  through the local daemon bridge for real task, document, decision, fact, and
  relation reads. Representative PRs: #8, #45, #53, #58, #273, #299, #446,
  #464, #480.
- Added read-oriented GUI surfaces: task board grouping and filters, favorites,
  relation graph, fact triage pool, cross-entity links, and copy-context.
  Representative PRs: #432, #462, #484, #486, #492.

Boundary: the GUI is a source-run inspection surface. It is not a released
desktop app, does not claim signed installers or auto-update, and should not be
described as the place to manage task lifecycle or arbitrate decisions.

### Write-path integrity

- Required real actor attribution for local ledger writes:
  `HARNESS_ACTOR`, `HARNESS_GIT_AUTHOR_NAME`, and `HARNESS_GIT_AUTHOR_EMAIL`
  are load-bearing for write commands. Representative PRs: #490.
- Added optimistic concurrency checks for decision snapshots, idempotent
  byte-identical fact append behavior, and content-addressed blob storage for
  large session/export bodies. Representative PRs: #476, #482, #488.
- Routed more write paths through ports and the write journal so kernel,
  application, CLI, daemon, and GUI boundaries stay explicit. Representative
  PRs: #194, #255, #320, #442, #458.

### Ledger isolation, safety, and governance

- Changed `ha init` to isolate the harness ledger as a private nested git
  repository, keeping ordinary code commits from accidentally carrying harness
  records. Representative PRs: #249, #311, #472.
- Added protected-surface, private-boundary, duplicate-definition,
  import-boundary, schema-field, relation-cycle, docs-map, runtime-readiness,
  package-policy, and supply-chain gates. Representative PRs: #97, #153, #204,
  #205, #213, #226, #282, #302, #470.
- Added release-readiness and supply-chain checks for future publication:
  runtime status, package smoke, npm audit, SBOM, OSV documentation, license
  policy, Dependabot coverage, and AGPL service-release checklist.
  Representative PRs: #54, #55, #426.

Boundary: no npm package release, signed installer, notarized desktop build,
auto-update feed, or published release artifact is claimed here.

### Developer workflow and docs

- Added bilingual public README and docs tracks, then moved public messaging
  toward the accountability-layer narrative. Representative PRs: #26, #43,
  #99, #174, #181, #203, #261.
- Added extension and preset surfaces for coding workflows, modules, scripts,
  milestones, doc-canon sync, dogfood utilization audits, and create-milestone
  scaffolding/rendering. Representative PRs: #18, #33, #34, #60, #61, #161,
  #178, #201, #283, #315, #345.
- Improved local and CI feedback with tiered test runners, manifest-driven
  gates, merge-queue hardening, and faster low-risk check paths. Representative
  PRs: #51, #79, #95, #197, #221, #302, #408.

## Earlier source history - 2026-06-11 to 2026-07-04

This period established the project shape:

- Kernel, write coordinator, task lifecycle, local CLI, and SQLite projection
  foundations.
- AGPL licensing, npm workspace packaging, initial GUI shell, adapter
  placeholders, and early governance checks.
- Legacy intake and migration commands, coding vertical templates, preset and
  module runtime, and the first public bilingual documentation.

Representative PRs: #1-#64, #70-#181.

## Current non-claims

- No published npm package release is claimed.
- No signed or notarized desktop installer is claimed.
- No auto-update or release-feed capability is claimed.
- No GUI task-management write product is claimed.
- No remote tunnel, attach-token, public network daemon, HTTP API, or
  notification subscription product is claimed.
- No cross-platform desktop runtime validation is claimed beyond the repository
  gates documented in release posture.
