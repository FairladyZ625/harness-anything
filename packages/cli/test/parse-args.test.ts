import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { commandDescriptors, commandRegistry } from "../src/cli/command-registry.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { parseArgs } from "../src/cli/parse-args.ts";
import { parserRegistry } from "../src/cli/parser-registry.ts";
import { parseCoreTaskArgs } from "../src/cli/parsers/core-task.ts";
import { parseVersionArgs } from "../src/cli/parsers/meta.ts";
import { runInitCommand } from "../src/commands/core/init.ts";
import { runTaskLifecycleCommand } from "../src/commands/core/task-lifecycle.ts";
import { runVersionCommand } from "../src/commands/core/version.ts";
import { requiresConflictMarkerPreflight } from "../src/cli/runner-registry.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { extensionActionKinds, extensionExecutorGroups, isExtensionAction } from "../src/commands/extensions/index.ts";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";

type ParsedAction = ParsedCommand["action"];

interface ParseCase {
  readonly name: string;
  readonly argv: ReadonlyArray<string>;
  readonly kind: ParsedAction["kind"];
  readonly fields?: Readonly<Record<string, unknown>>;
}

const rootDir = path.resolve(".");

const parseCases: ReadonlyArray<ParseCase> = [
  { name: "help", argv: ["--help"], kind: "help" },
  { name: "init", argv: ["init"], kind: "init", fields: { addNpmScripts: false } },
  { name: "init add npm scripts", argv: ["init", "--add-npm-scripts"], kind: "init", fields: { addNpmScripts: true } },
  { name: "init project name", argv: ["init", "--name", "human-kernel"], kind: "init", fields: { projectName: "human-kernel" } },
  {
    name: "new-task preset task",
    argv: ["task", "create", "--title", "Parser Task", "--parent", "task_parent", "--kind", "feat", "--risk-tier", "high", "--urgency", "medium", "--vertical", "software/coding", "--preset", "standard-task", "--profile", "baseline", "--module", "billing", "--long-running", "--locale", "en-US"],
    kind: "new-task",
    fields: { title: "Parser Task", parent: "task_parent", slug: "parser-task", workKind: "feat", riskTier: "high", urgency: "medium", vertical: "software/coding", preset: "standard-task", profile: "baseline", moduleKey: "billing", allowManualId: false, longRunning: true, locale: "en-US" }
  },
  {
    name: "new-task register module dry run",
    argv: ["task", "create", "--title", "Parser Task", "--register-module", "billing", "--module-title", "Billing", "--module-prefix", "BILL", "--module-scope", "packages/billing/**", "--dry-run"],
    kind: "new-task",
    fields: { registerModule: { key: "billing", title: "Billing", prefix: "BILL", scope: "packages/billing/**" }, moduleKey: "billing", dryRun: true }
  },
  {
    name: "new-task legacy rebuild",
    argv: ["task", "create", "--from-legacy", "legacy-1"],
    kind: "new-task",
    fields: { title: "Untitled task", fromLegacyId: "legacy-1", allowManualId: false }
  },
  { name: "task claim", argv: ["task", "claim", "task_1", "--ttl-ms", "60000"], kind: "task-claim", fields: { taskId: "task_1", ttlMs: 60000 } },
  { name: "task holder", argv: ["task", "holder", "task_1"], kind: "task-holder", fields: { taskId: "task_1" } },
  { name: "task release", argv: ["task", "release", "task_1"], kind: "task-release", fields: { taskId: "task_1" } },
  {
    name: "status set forced",
    argv: ["task", "transition", "task_1", "done", "--force", "--reason", "verified"],
    kind: "status-set",
    fields: { taskId: "task_1", status: "done", force: true, reason: "verified" }
  },
  { name: "progress append", argv: ["task", "progress", "append", "task_1", "--text", "hello", "--evidence", "log:artifacts/run.log:passed"], kind: "progress-append", fields: { taskId: "task_1", text: "hello", evidence: { type: "log", path: "artifacts/run.log", summary: "passed" } } },
  { name: "task amend", argv: ["task", "amend", "task_1", "--set", "taskClass:milestone"], kind: "task-amend", fields: { taskId: "task_1", patches: [{ field: "taskClass", value: "milestone" }] } },
  { name: "task archive", argv: ["task", "archive", "task_1", "--reason", "done", "--archived-by", "alice", "--archive-field", "packageDisposition"], kind: "task-archive", fields: { taskId: "task_1", reason: "done", archivedBy: "alice", archiveField: "packageDisposition" } },
  { name: "task archive ids", argv: ["task", "archive", "--ids", "task_1,task_2", "--reason", "done"], kind: "task-archive", fields: { ids: ["task_1", "task_2"], reason: "done" } },
  { name: "task archive filter before", argv: ["task", "archive", "--filter", "state:done", "--before", "2026-07-01", "--reason", "done"], kind: "task-archive", fields: { filter: "state:done", before: "2026-07-01", reason: "done" } },
  { name: "task supersede", argv: ["task", "supersede", "task_old", "--title", "New Task", "--slug", "custom-slug", "--reason", "changed"], kind: "task-supersede", fields: { oldTaskId: "task_old", title: "New Task", slug: "custom-slug", reason: "changed", allowOpenFindings: false } },
  { name: "task supersede by existing", argv: ["task", "supersede", "task_old", "--by", "task_new", "--confirm", "task_old", "--allow-open-findings", "--deleted-by", "alice"], kind: "task-supersede", fields: { oldTaskId: "task_old", byTaskId: "task_new", confirm: "task_old", allowOpenFindings: true, deletedBy: "alice" } },
  { name: "task delete reason position", argv: ["task", "delete", "--hard", "--reason", "cleanup", "--confirm", "task_1", "--deleted-by", "alice", "task_1"], kind: "task-delete", fields: { taskId: "task_1", mode: "hard", reason: "cleanup", confirm: "task_1", deletedBy: "alice" } },
  { name: "task delete skips option values before id", argv: ["task", "delete", "--soft", "--reason", "cleanup", "--deleted-by", "alice", "task_1"], kind: "task-delete", fields: { taskId: "task_1", mode: "soft", reason: "cleanup", deletedBy: "alice" } },
  { name: "task reopen", argv: ["task", "reopen", "task_1", "--reason", "followup"], kind: "task-reopen", fields: { taskId: "task_1", reason: "followup" } },
  { name: "task code-doc reconcile", argv: ["task", "code-doc", "reconcile", "task_1", "--commit", "0123456789abcdef0123456789abcdef01234567", "--path", "packages/cli/src/index.ts", "--path", "packages/application/src/index.ts", "--pr", "https://github.com/example/repo/pull/1", "--force"], kind: "task-code-doc-reconcile", fields: { taskId: "task_1", sha: "0123456789abcdef0123456789abcdef01234567", paths: ["packages/cli/src/index.ts", "packages/application/src/index.ts"], prRef: "https://github.com/example/repo/pull/1", force: true } },
  { name: "task review", argv: ["task", "review", "task_1", "--reviewer", "alice"], kind: "task-review", fields: { taskId: "task_1", reviewerId: "alice" } },
  { name: "task complete", argv: ["task", "complete", "task_1", "--ci", "passed", "--reviewer", "alice"], kind: "task-complete", fields: { taskId: "task_1", ciGate: "passed", reviewerId: "alice" } },
  { name: "task show", argv: ["task", "show", "task_1"], kind: "task-show", fields: { taskId: "task_1" } },
  { name: "task tree", argv: ["task", "tree", "task_1"], kind: "task-tree", fields: { taskId: "task_1" } },
  { name: "task relate depends-on", argv: ["task", "relate", "task_1", "depends-on", "task_2", "--rationale", "needs output"], kind: "task-relate", fields: { sourceTaskId: "task_1", relationType: "depends-on", targetTaskId: "task_2", rationale: "needs output", dryRun: false } },
  { name: "relation list", argv: ["relation", "list", "--entity", "task/task_1", "--source", "task/task_1", "--target", "task/task_2", "--type", "depends-on", "--state", "active"], kind: "relation-list", fields: { filters: { entity: "task/task_1", source: "task/task_1", target: "task/task_2", type: "depends-on", state: "active" } } },
  {
    name: "decision propose",
    argv: ["decision", "propose", "--id", "dec_TEST", "--title", "Decision", "--question", "Question?", "--chosen", "Chosen", "--rejected", "Rejected", "--why-not", "Because", "--risk-tier", "high", "--urgency", "medium", "--module", "kernel,cli", "--non-load-bearing", "--dry-run"],
    kind: "decision-propose",
    fields: { decisionId: "dec_TEST", title: "Decision", question: "Question?", chosen: [{ text: "Chosen" }], rejected: [{ text: "Rejected", why_not: "Because" }], riskTier: "high", urgency: "medium", modules: ["kernel", "cli"], claimLoadBearing: false, dryRun: true }
  },
  { name: "decision list", argv: ["decision", "list", "--search", "self-host", "--legacy-id", "E72", "--legacy-range", "E1-E72", "--state", "active", "--module", "m5-circulation", "--product-line", "kernel", "--compact"], kind: "decision-list", fields: { search: "self-host", legacyId: "E72", legacyRange: "E1-E72", state: "active", moduleKey: "m5-circulation", productLine: "kernel", compact: true } },
  { name: "decision show", argv: ["decision", "show", "E72"], kind: "decision-show", fields: { selector: "E72" } },
  { name: "decision accept", argv: ["decision", "accept", "dec_TEST", "--arbiter", "human:ZeyuLi", "--judgment-only", "Manual judgment"], kind: "decision-accept", fields: { decisionId: "dec_TEST", arbiter: "human:ZeyuLi", judgmentOnlyRationale: "Manual judgment" } },
  { name: "decision reckon", argv: ["decision", "reckon", "dec_TEST", "--task", "task_1"], kind: "decision-reckon", fields: { decisionId: "dec_TEST", taskId: "task_1" } },
  { name: "decision reject", argv: ["decision", "reject", "dec_TEST"], kind: "decision-reject", fields: { decisionId: "dec_TEST" } },
  { name: "decision defer", argv: ["decision", "defer", "dec_TEST"], kind: "decision-defer", fields: { decisionId: "dec_TEST" } },
  { name: "decision supersede", argv: ["decision", "supersede", "dec_TEST"], kind: "decision-supersede", fields: { decisionId: "dec_TEST" } },
  { name: "decision amend", argv: ["decision", "amend", "dec_TEST", "--title", "Updated", "--non-load-bearing", "C2", "--append", "rejected:{\"text\":\"Manual mapping\",\"why_not\":\"Coverage gate required\"}"], kind: "decision-amend", fields: { decisionId: "dec_TEST", title: "Updated", patches: [{ field: "claims", operation: "metadata", value: "{\"id\":\"C2\",\"load_bearing\":false}" }, { field: "rejected", operation: "append", value: "{\"text\":\"Manual mapping\",\"why_not\":\"Coverage gate required\"}" }] } },
  { name: "decision relate", argv: ["decision", "relate", "dec_TEST", "--anchor", "CH1", "--type", "supersedes", "--target", "decision/dec_OLD", "--rationale", "Newer decision replaces older storage claim"], kind: "decision-relate", fields: { decisionId: "dec_TEST", anchor: "CH1", relationType: "supersedes", target: "decision/dec_OLD", rationale: "Newer decision replaces older storage claim", dryRun: false } },
  { name: "decision relation retire", argv: ["decision", "relation", "retire", "dec_TEST", "--relation", "rel_0123456789abcdef"], kind: "decision-relation-retire", fields: { decisionId: "dec_TEST", relationId: "rel_0123456789abcdef", dryRun: false } },
  { name: "decision relation replace", argv: ["decision", "relation", "replace", "dec_TEST", "--relation", "rel_0123456789abcdef", "--anchor", "CH1", "--type", "relates", "--target", "decision/dec_OLD", "--rationale", "Replacement edge"], kind: "decision-relation-replace", fields: { decisionId: "dec_TEST", relationId: "rel_0123456789abcdef", anchor: "CH1", relationType: "relates", target: "decision/dec_OLD", rationale: "Replacement edge", dryRun: false } },
  { name: "decision retire", argv: ["decision", "retire", "dec_TEST"], kind: "decision-retire", fields: { decisionId: "dec_TEST" } },
  { name: "fact list", argv: ["fact", "list", "--task", "task_1"], kind: "fact-list", fields: { taskId: "task_1" } },
  { name: "fact show", argv: ["fact", "show", "--task", "task_1", "--id", "F-DEADBEEF"], kind: "fact-show", fields: { taskId: "task_1", factId: "F-DEADBEEF" } },
  { name: "fact record", argv: ["fact", "record", "--task", "task_1", "--id", "F-DEADBEEF", "--statement", "Fact", "--source", "Fixture", "--confidence", "high", "--memory-class", "procedural", "--memory-tag", "tool_memory,task_skill", "--observed-at", "2026-07-03T00:00:00.000Z"], kind: "record-fact", fields: { taskId: "task_1", factId: "F-DEADBEEF", statement: "Fact", source: "Fixture", confidence: "high", memoryClass: "procedural", memoryTags: ["tool_memory", "task_skill"], observedAt: "2026-07-03T00:00:00.000Z" } },
  { name: "fact invalidate", argv: ["fact", "invalidate", "--task", "task_1", "--id", "F-DEADBEEF", "--by", "F-FEEDFACE", "--rationale", "New fact"], kind: "fact-invalidate", fields: { taskId: "task_1", factId: "F-DEADBEEF", invalidatedByFactId: "F-FEEDFACE", rationale: "New fact", dryRun: false } },
  { name: "distill candidate", argv: ["distill", "candidate", "--task", "task_1", "--input", "source.md"], kind: "distill-candidate", fields: { taskId: "task_1", inputPath: "source.md" } },
  { name: "distill promote", argv: ["distill", "promote", "--task", "task_1", "--candidate", ".harness/generated/distill/task_1/candidate.json", "--claim", "Distilled claim", "--id", "F-DEADBEEF", "--confidence", "high", "--memory-class", "semantic", "--memory-tag", "pattern", "--observed-at", "2026-07-03T00:00:00.000Z"], kind: "distill-commit", fields: { taskId: "task_1", candidatePath: ".harness/generated/distill/task_1/candidate.json", claim: "Distilled claim", factId: "F-DEADBEEF", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], observedAt: "2026-07-03T00:00:00.000Z" } },
  { name: "event append", argv: ["event", "append", "--session", "codex-session-1", "--kind", "interrupt", "--runtime", "codex", "--task", "task_1", "--interrupt", "append", "--result", "succeeded", "--summary", "Guidance appended", "--total-tokens", "42"], kind: "runtime-event-append", fields: { sessionId: "codex-session-1", eventKind: "interrupt", runtime: "codex", taskId: "task_1", interrupt: "append", result: "succeeded", summary: "Guidance appended", totalTokens: 42 } },
  { name: "event list", argv: ["event", "list", "--session", "codex-session-1"], kind: "runtime-event-list", fields: { sessionId: "codex-session-1" } },
  { name: "materializer run", argv: ["materializer", "run", "--dry-run"], kind: "materializer-run", fields: { dryRun: true } },
  { name: "session export current", argv: ["session", "export"], kind: "session-export", fields: { sessionId: undefined, runtime: undefined } },
  { name: "session export explicit", argv: ["session", "export", "--session", "codex-thread", "--runtime", "codex", "--source", "manual", "--detected-at", "2026-07-04T00:00:00.000Z", "--user", "Zeyu", "--transcript-file", "/tmp/codex-thread.jsonl"], kind: "session-export", fields: { sessionId: "codex-thread", runtime: "codex", source: "manual", detectedAt: "2026-07-04T00:00:00.000Z", user: "Zeyu", transcriptFile: "/tmp/codex-thread.jsonl" } },
  { name: "session backfill", argv: ["session", "backfill", "--runtime", "codex", "--limit", "5"], kind: "session-backfill", fields: { runtime: "codex", limit: 5 } },
  { name: "session sync", argv: ["session", "sync"], kind: "session-sync", fields: {} },
  { name: "doc list", argv: ["doc", "list", "--module", "m4-loadbearing", "--product-line", "kernel"], kind: "doc-list", fields: { filters: { moduleKey: "m4-loadbearing", productLine: "kernel" } } },
  { name: "doc map", argv: ["doc", "map", "--module", "m4-loadbearing"], kind: "doc-map", fields: { filters: { moduleKey: "m4-loadbearing", productLine: undefined } } },
  { name: "doc generate", argv: ["doc", "generate", "--module", "m5-circulation", "--write"], kind: "doc-generate", fields: { filters: { moduleKey: "m5-circulation", productLine: undefined }, write: true } },
  { name: "doc status", argv: ["doc", "status"], kind: "doc-status" },
  { name: "doc sync dry-run", argv: ["doc", "sync", "--dry-run"], kind: "doc-sync-dry-run" },
  { name: "task list", argv: ["task", "list"], kind: "task-list", fields: { filters: { missingMaterials: false, includeArchived: false } } },
  {
    name: "task list filters",
    argv: ["task", "list", "--state", "active", "--module", "billing", "--queue", "open", "--preset", "module", "--kind", "fix", "--risk-tier", "medium", "--urgency", "high", "--review", "missing", "--lesson", "missing", "--missing-materials", "--include-archived", "--search", "checkout"],
    kind: "task-list",
    fields: {
      filters: {
        state: "active",
        moduleKey: "billing",
        queue: "open",
        preset: "module",
        workKind: "fix",
        riskTier: "medium",
        urgency: "high",
        review: "missing",
        lesson: "missing",
        missingMaterials: true,
        includeArchived: true,
        search: "checkout"
      }
    }
  },
  { name: "status", argv: ["status"], kind: "status" },
  { name: "version", argv: ["version"], kind: "version" },
  { name: "check", argv: ["check", "--profile", "target-project", "--strict", "--post-merge"], kind: "check", fields: { profile: "target-project", strict: true, postMerge: true } },
  { name: "governance rebuild", argv: ["governance", "rebuild", "--archive"], kind: "governance-rebuild", fields: { mode: "archive" } },
  { name: "lesson promote", argv: ["lesson", "promote", "task_1", "candidate-1", "--apply"], kind: "lesson-promote", fields: { taskId: "task_1", candidateId: "candidate-1", mode: "apply" } },
  { name: "lesson sediment", argv: ["lesson", "sediment", "task_1", "candidate-1", "--title", "Learning"], kind: "lesson-sediment", fields: { taskId: "task_1", candidateId: "candidate-1", title: "Learning", mode: "dry-run" } },
  { name: "adopt multica", argv: ["adopt", "multica", "EXT-1", "--task", "task_1", "--title", "External", "--status", "todo"], kind: "adopt-multica", fields: { ref: "EXT-1", taskId: "task_1", title: "External", status: "todo" } },
  { name: "snapshot multica", argv: ["snapshot", "multica", "EXT-1", "--title", "External", "--status", "todo"], kind: "snapshot-multica", fields: { ref: "EXT-1", title: "External", status: "todo" } },
  { name: "migrate plan", argv: ["migrate", "plan", "--limit", "5"], kind: "migrate-plan", fields: { limit: 5 } },
  { name: "migrate structure", argv: ["migrate", "structure", "--apply", "--confirm-plan"], kind: "migrate-structure", fields: { mode: "apply", confirmPlan: true } },
  { name: "migrate anchors", argv: ["migrate", "anchors", "--apply"], kind: "migrate-anchors", fields: { mode: "apply" } },
  { name: "migrate provenance", argv: ["migrate", "provenance", "--apply"], kind: "migrate-provenance", fields: { mode: "apply" } },
  { name: "migrate run", argv: ["migrate", "run", "--plan-only", "--session-dir", "session", "--locale", "en-US", "--assume-locale", "zh-CN", "--allow-dirty"], kind: "migrate-run", fields: { planOnly: true, outDir: "session", sessionDir: "session", locale: "en-US", assumeLocale: "zh-CN", allowDirty: true } },
  { name: "migrate verify", argv: ["migrate", "verify", "session.json"], kind: "migrate-verify", fields: { sessionPath: "session.json", fullCutover: false } },
  { name: "legacy scan", argv: ["legacy", "scan", "old"], kind: "legacy-scan", fields: { sourcePath: "old" } },
  { name: "legacy plan", argv: ["legacy", "plan", "old", "--out", "plan.json"], kind: "legacy-intake-plan", fields: { sourcePath: "old", outPath: "plan.json" } },
  { name: "legacy copy docs", argv: ["legacy", "copy-docs", "old", "--apply"], kind: "legacy-copy-safe-docs", fields: { sourcePath: "old", apply: true } },
  { name: "legacy index", argv: ["legacy", "index", "old", "--apply"], kind: "legacy-index", fields: { sourcePath: "old", apply: true } },
  { name: "legacy verify", argv: ["legacy", "verify"], kind: "legacy-verify" },
  { name: "git diff", argv: ["git", "diff", "--base", "origin/main"], kind: "git-diff", fields: { baseRef: "origin/main" } },
  { name: "doctor", argv: ["doctor"], kind: "doctor" },
  { name: "diagnostics command usage", argv: ["diagnostics", "command-usage"], kind: "diagnostics-command-usage" },
  { name: "worktree create", argv: ["worktree", "create", "--task", "task_1", "--agent", "codex", "--base", "HEAD", "--path", ".worktrees/task-1"], kind: "worktree-create", fields: { taskId: "task_1", agent: "codex", baseRef: "HEAD", worktreePath: ".worktrees/task-1" } },
  { name: "worktree status", argv: ["worktree", "status", "--task", "task_1"], kind: "worktree-status", fields: { taskId: "task_1" } },
  { name: "graph", argv: ["graph", "--out", ".harness/generated/graph-panorama/index.html", "--focus", "decision/dec_LEDGER_E51", "--projection", ".harness/cache/projections.sqlite"], kind: "graph", fields: { outputPath: ".harness/generated/graph-panorama/index.html", focus: "decision/dec_LEDGER_E51", projectionPath: ".harness/cache/projections.sqlite" } },
  { name: "entity list", argv: ["entity", "list"], kind: "entity-list" },
  { name: "capabilities index", argv: ["capabilities"], kind: "capabilities", fields: { entityKind: undefined } },
  { name: "capabilities by kind", argv: ["decision", "capabilities"], kind: "capabilities", fields: { entityKind: "decision" } },
  { name: "graph capabilities", argv: ["graph", "capabilities"], kind: "capabilities", fields: { entityKind: "graph" } },
  { name: "capabilities kind option", argv: ["capabilities", "--kind", "task"], kind: "capabilities", fields: { entityKind: "task" } },
  { name: "capabilities positional kind", argv: ["capabilities", "preset"], kind: "capabilities", fields: { entityKind: "preset" } },
  { name: "gui", argv: ["gui"], kind: "gui" },
  { name: "template list", argv: ["template", "list", "--catalog", "catalog.json"], kind: "template-list", fields: { catalogPath: "catalog.json" } },
  { name: "template render", argv: ["template", "render", "template://planning/task@1", "--catalog", "catalog.json", "--locale", "en-US"], kind: "template-render", fields: { templateRef: "template://planning/task@1", catalogPath: "catalog.json", locale: "en-US" } },
  { name: "preset validate", argv: ["preset", "validate", "preset.json", "--kernel-version", "1.2.3"], kind: "preset-validate", fields: { manifestPath: "preset.json", kernelVersion: "1.2.3" } },
  { name: "preset list", argv: ["preset", "list"], kind: "preset-list" },
  { name: "preset inspect", argv: ["preset", "inspect", "standard-task"], kind: "preset-inspect", fields: { presetId: "standard-task" } },
  { name: "preset check", argv: ["preset", "check", "standard-task"], kind: "preset-check", fields: { presetId: "standard-task" } },
  { name: "preset install project", argv: ["preset", "install", "preset-dir", "--project"], kind: "preset-install", fields: { sourcePath: "preset-dir", layer: "project" } },
  { name: "preset seed", argv: ["preset", "seed"], kind: "preset-seed" },
  { name: "preset audit", argv: ["preset", "audit"], kind: "preset-audit" },
  { name: "preset uninstall project", argv: ["preset", "uninstall", "standard-task", "--project"], kind: "preset-uninstall", fields: { presetId: "standard-task", layer: "project" } },
  { name: "preset run task option", argv: ["preset", "run", "standard-task", "plan", "--task", "task_1"], kind: "preset-run", fields: { presetId: "standard-task", entrypoint: "plan", taskId: "task_1", allowScripts: false } },
  { name: "preset run allow scripts", argv: ["preset", "run", "github-issue-repair", "plan", "--task", "task_1", "--allow-scripts", "--input", "repo=octo/example", "--input", "issue=next"], kind: "preset-run", fields: { presetId: "github-issue-repair", entrypoint: "plan", taskId: "task_1", allowScripts: true, inputs: { repo: "octo/example", issue: "next" } } },
  { name: "preset action", argv: ["preset", "action", "standard-task", "scaffold", "--task", "task_1"], kind: "preset-action", fields: { presetId: "standard-task", actionName: "scaffold", taskId: "task_1", allowScripts: false } },
  { name: "preset action allow scripts", argv: ["preset", "action", "github-issue-repair", "plan", "--task", "task_1", "--allow-scripts", "--input", "repo=octo/example"], kind: "preset-action", fields: { presetId: "github-issue-repair", actionName: "plan", taskId: "task_1", allowScripts: true, inputs: { repo: "octo/example" } } },
  { name: "script list", argv: ["script", "list", "--source", "preset", "--purpose", "scaffold"], kind: "script-list", fields: { source: "preset", purpose: "scaffold" } },
  { name: "script list kind", argv: ["script", "list", "--source", "vertical", "--kind", "check"], kind: "script-list", fields: { source: "vertical", scriptKind: "check" } },
  { name: "script inspect", argv: ["script", "inspect", "preset:github-issue-repair:plan"], kind: "script-inspect", fields: { scriptId: "preset:github-issue-repair:plan" } },
  { name: "script run", argv: ["script", "run", "preset:github-issue-repair:plan", "--task", "task_1", "--input", "repo=octo/example", "--dry-run"], kind: "script-run", fields: { scriptId: "preset:github-issue-repair:plan", taskId: "task_1", inputs: { repo: "octo/example" }, dryRun: true } },
  { name: "module list", argv: ["module", "list"], kind: "module-list" },
  { name: "module inspect", argv: ["module", "inspect", "billing"], kind: "module-inspect", fields: { moduleKey: "billing" } },
  { name: "module register", argv: ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**", "--prefix", "BILL", "--status", "active", "--branch", "main", "--owner", "team", "--current-step", "BILL-01", "--shared", "docs/**", "--depends-on", "kernel"], kind: "module-register", fields: { moduleKey: "billing", title: "Billing", scope: "packages/billing/**", prefix: "BILL", status: "active", branch: "main", owner: "team", currentStep: "BILL-01", shared: ["docs/**"], dependsOn: ["kernel"] } },
  { name: "module scaffold", argv: ["module", "scaffold", "billing"], kind: "module-scaffold", fields: { moduleKey: "billing" } },
  { name: "module unregister", argv: ["module", "unregister", "billing"], kind: "module-unregister", fields: { moduleKey: "billing" } },
  { name: "module step", argv: ["module", "step", "billing", "T-1", "--state", "done"], kind: "module-step", fields: { moduleKey: "billing", stepId: "T-1", state: "done" } },
  { name: "vertical validate", argv: ["vertical", "validate", "vertical.json"], kind: "vertical-validate", fields: { definitionPath: "vertical.json" } }
];

test("parseArgs has characterization coverage for every command registry kind", () => {
  const covered = new Set(parseCases.map((candidate) => candidate.kind));
  const registered = new Set(commandRegistry.map((entry) => entry.kind));
  assertNoDuplicates(commandRegistry.map((entry) => entry.kind), "command registry kind");
  assert.deepEqual(covered, registered);
});

test("parseArgs recognizes version as a global flag, short flag, and bare command", () => {
  for (const argv of [["--version"], ["-v"], ["version"], ["status", "--version"]]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true, argv.join(" "));
    assert.equal(parsed.ok && parsed.value.action.kind, "version", argv.join(" "));
  }
});

test("parseArgs strips explicit authored root global override", () => {
  const parsed = parseArgs(["--root", rootDir, "--authored-root", ".custom-harness", "doctor"]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.action.kind, "doctor");
  assert.deepEqual(parsed.value.layoutOverrides, { authoredRoot: ".custom-harness" });
  assert.equal(resolveHarnessLayout({ rootDir, layoutOverrides: parsed.value.layoutOverrides }).authoredRoot, path.join(rootDir, ".custom-harness"));
  assert.equal(resolveHarnessLayout(rootDir).authoredRoot, path.join(rootDir, "harness"));

  const next = parseArgs(["--root", rootDir, "doctor"]);
  assert.equal(next.ok, true);
  assert.equal(next.value.layoutOverrides, undefined);
  assert.equal(resolveHarnessLayout(rootDir).authoredRoot, path.join(rootDir, "harness"));
});

test("parseArgs carries the explicit actor global flag without exposing it to command parsers", () => {
  const parsed = parseArgs(["task", "claim", "task_1", "--actor", "human:person_zeyu"]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.action.kind, "task-claim");
  assert.equal(parsed.ok && parsed.value.actor, "human:person_zeyu");
});

test("parseArgs reads authored root env into command context only", () => {
  const previous = process.env.HARNESS_AUTHORED_ROOT;
  process.env.HARNESS_AUTHORED_ROOT = ".env-harness";
  try {
    const parsed = parseArgs(["--root", rootDir, "doctor"]);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value.layoutOverrides, { authoredRoot: ".env-harness" });
    assert.equal(resolveHarnessLayout({ rootDir, layoutOverrides: parsed.value.layoutOverrides }).authoredRoot, path.join(rootDir, ".env-harness"));
    assert.equal(resolveHarnessLayout(rootDir).authoredRoot, path.join(rootDir, "harness"));
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_AUTHORED_ROOT;
    } else {
      process.env.HARNESS_AUTHORED_ROOT = previous;
    }
  }
});

test("parser registry and command registry stay consistent", () => {
  const parserKindList = parserRegistry.flatMap((entry) => entry.commandKinds);
  const commandKindList = commandRegistry.map((entry) => entry.kind);
  assertNoDuplicates(parserKindList, "parser registry kind");
  assertNoDuplicates(commandKindList, "command registry kind");
  const parserKinds = new Set(parserKindList);
  const commandKinds = new Set(commandKindList);
  assert.deepEqual(parserKinds, commandKinds);
});

test("command descriptor projections are derived from the command spec", () => {
  assert.deepEqual(commandDescriptors.map((entry) => entry.kind), commandSpecs.map((entry) => entry.kind));
  for (const spec of commandSpecs) {
    const descriptor = commandDescriptors.find((entry) => entry.kind === spec.kind);
    assert.notEqual(descriptor, undefined, spec.kind);
    assert.equal(descriptor?.usage, spec.usage, spec.kind);
    assert.equal(descriptor?.summary, spec.summary, spec.kind);
    assert.deepEqual(descriptor?.examples, spec.examples, spec.kind);
    assert.deepEqual(descriptor?.options, spec.options, spec.kind);
    assert.deepEqual(commandRegistry.find((entry) => entry.kind === spec.kind)?.options, spec.options, spec.kind);
    assert.equal(descriptor?.parse, spec.parse, spec.kind);
    assert.equal(descriptor?.run, spec.run, spec.kind);
  }
});

test("command specs can directly share parser and runner function references", () => {
  const version = commandSpecs.find((entry) => entry.kind === "version");
  const init = commandSpecs.find((entry) => entry.kind === "init");
  const taskClaim = commandSpecs.find((entry) => entry.kind === "task-claim");

  assert.equal(version?.parse, parseVersionArgs);
  assert.equal(version?.run, runVersionCommand);
  assert.equal(init?.parse, parseCoreTaskArgs);
  assert.equal(init?.run, runInitCommand);
  assert.equal(taskClaim?.parse, init?.parse);
  assert.equal(taskClaim?.run, runTaskLifecycleCommand);
});

test("command specs own help option descriptions without a global fallback", () => {
  for (const spec of commandSpecs) {
    const usageFlags = new Set([...spec.usage.matchAll(/--[a-z0-9][a-z0-9-]*/gu)].map((match) => match[0]));
    const optionsByFlag = new Map(spec.options.map((option) => [option.flag, option.description]));
    for (const flag of usageFlags) {
      assert.equal(optionsByFlag.has(flag), true, `${spec.kind} must describe ${flag}`);
      assert.equal((optionsByFlag.get(flag) ?? "").length > 0, true, `${spec.kind} ${flag} needs a description`);
    }
  }

  const taskState = commandSpecs.find((entry) => entry.kind === "task-list")?.options?.find((entry) => entry.flag === "--state")?.description;
  const relationState = commandSpecs.find((entry) => entry.kind === "relation-list")?.options?.find((entry) => entry.flag === "--state")?.description;
  assert.match(taskState ?? "", /task state/u);
  assert.doesNotMatch(taskState ?? "", /relation state/u);
  assert.match(relationState ?? "", /relation state/u);
  assert.doesNotMatch(relationState ?? "", /task state/u);

  assert.equal(existsSync(new URL("../src/cli/command-option-descriptions.ts", import.meta.url)), false);
  const registrySource = readFileSync(new URL("../src/cli/command-registry.ts", import.meta.url), "utf8");
  assert.doesNotMatch(registrySource, /optionsFromUsage|optionDescription|command-option-descriptions/u);
});

test("conflict marker preflight classifies extension and migration write commands", () => {
  for (const kind of [
    "preset-run",
    "preset-action",
    "module-register",
    "module-scaffold",
    "module-step",
    "module-unregister",
    "init",
    "lesson-promote",
    "lesson-sediment",
    "migrate-run",
    "script-run"
  ] as const) {
    assert.equal(requiresConflictMarkerPreflight(kind), true, kind);
  }

  for (const kind of [
    "preset-list",
    "module-list",
    "script-list",
    "decision-list",
    "decision-show",
    "migrate-verify",
    "doctor"
  ] as const) {
    assert.equal(requiresConflictMarkerPreflight(kind), false, kind);
  }
});

test("command registry exposes help metadata for every command", () => {
  for (const entry of commandRegistry) {
    assert.equal(entry.commandPath.length > 0, true, entry.kind);
    assert.equal(entry.summary.length > 0, true, entry.kind);
    assert.equal(entry.resultEnvelope, "command-receipt/v2", entry.kind);
  }
});

test("extension parser classifier and executor mapping stay consistent", () => {
  const parsedByKind = new Map<ParsedAction["kind"], ParsedAction>();
  for (const candidate of parseCases) {
    const parsed = parseArgs(candidate.argv);
    assert.equal(parsed.ok, true, candidate.name);
    if (parsed.ok) parsedByKind.set(parsed.value.action.kind, parsed.value.action);
  }

  assert.deepEqual(new Set(extensionActionKinds), new Set(Object.keys(extensionExecutorGroups)));
  assertNoDuplicates(extensionActionKinds, "extension action kind");
  for (const kind of extensionActionKinds) {
    const action = parsedByKind.get(kind);
    assert.notEqual(action, undefined, `${kind} parser coverage`);
    assert.equal(isExtensionAction(action!), true, `${kind} classifier coverage`);
    assert.equal(["template", "preset", "script", "module", "vertical"].includes(extensionExecutorGroups[kind]), true, `${kind} executor group`);
  }

  const parsedExtensionKinds = new Set([...parsedByKind.values()].filter(isExtensionAction).map((action) => action.kind));
  assert.deepEqual(parsedExtensionKinds, new Set(extensionActionKinds));
});

for (const candidate of parseCases) {
  test(`parseArgs parses ${candidate.name}`, () => {
    const parsed = parseArgs(["--root", rootDir, "--json", ...candidate.argv]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.rootDir, rootDir);
    assert.equal(parsed.value.json, true);
    assert.equal(parsed.value.action.kind, candidate.kind);
    if (candidate.fields) {
      assertFields(parsed.value.action, candidate.fields);
    }
  });
}

test("parseArgs pins stable parse error envelopes", () => {
  const cases = [
    { argv: ["template", "render", "template://planning/task@1", "--locale", "fr-FR"], code: "invalid_locale" },
    { argv: ["task", "progress", "append", "task_1", "--text", "hello", "--evidence", "broken"], code: "invalid_evidence" },
    { argv: ["preset", "run", "standard-task", "deploy", "--task", "task_1"], code: "invalid_entrypoint" },
    { argv: ["module", "register", "billing", "--title", "Billing"], code: "missing_module_fields" },
    { argv: ["module-step", "billing", "T-1", "--state", "started"], code: "invalid_module_step_state" },
    { argv: ["decision", "amend", "dec_TEST", "--append", "state:active"], code: "invalid_decision_amend_patch" },
    { argv: ["fact", "record", "--json-input", "{\"taskId\":\"task_1\"}", "--from-file", "input.json"], code: "invalid_json_input" },
    { argv: ["init", "--name"], code: "missing_name" },
    { argv: ["init", "--name", "--add-npm-scripts"], code: "missing_name" },
    { argv: ["new-task"], code: "missing_title" },
    { argv: ["unknown"], code: "unknown_command", hintIncludes: "harness-anything task create --title <title>" }
  ] as const;

  for (const candidate of cases) {
    const parsed = parseArgs(candidate.argv);
    assert.equal(parsed.ok, false, candidate.code);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, candidate.code);
    if ("hintIncludes" in candidate) {
      assert.equal(parsed.error.hint.includes(candidate.hintIncludes), true);
    }
  }
});

test("parseArgs rejects invalid task metadata enum values", () => {
  const invalidCreateKind = parseArgs(["task", "create", "--title", "Bad", "--kind", "feature"]);
  assert.equal(invalidCreateKind.ok, false);
  assert.equal(invalidCreateKind.ok ? undefined : invalidCreateKind.error.code, "invalid_task_metadata");

  const invalidCreateTier = parseArgs(["task", "create", "--title", "Bad", "--risk-tier", "critical"]);
  assert.equal(invalidCreateTier.ok, false);
  assert.equal(invalidCreateTier.ok ? undefined : invalidCreateTier.error.code, "invalid_task_metadata");

  const invalidListUrgency = parseArgs(["task", "list", "--urgency", "soon"]);
  assert.equal(invalidListUrgency.ok, false);
  assert.equal(invalidListUrgency.ok ? undefined : invalidListUrgency.error.code, "invalid_task_metadata");
});

test("parseArgs injects inline JSON input before command parsers and keeps flags as overrides", () => {
  const payload = JSON.stringify({
    title: "JSON Decision",
    question: "Use global JSON input?",
    chosen: [{ text: "Use injected input" }],
    rejected: [{ text: "Per-parser payloads", whyNot: "They duplicate schema translation." }],
    riskTier: "medium",
    urgency: "high",
    modules: ["cli", "m5-circulation"],
    claims: [{ text: "JSON claim one" }, { id: "C9", text: "JSON claim two", load_bearing: false }],
    dryRun: true
  });
  const parsed = parseArgs([
    "decision",
    "propose",
    "--json-input",
    payload,
    "--title",
    "Flag Title"
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.action.kind, "decision-propose");
  assert.equal(parsed.value.action.title, "Flag Title");
  assert.equal(parsed.value.action.question, "Use global JSON input?");
  assert.deepEqual(parsed.value.action.chosen, [{ text: "Use injected input" }]);
  assert.deepEqual(parsed.value.action.rejected, [{ text: "Per-parser payloads", why_not: "They duplicate schema translation." }]);
  assert.deepEqual(parsed.value.action.modules, ["cli", "m5-circulation"]);
  assert.deepEqual(parsed.value.action.claims, [{ text: "JSON claim one" }, { id: "C9", text: "JSON claim two", load_bearing: false }]);
  assert.equal(parsed.value.action.dryRun, true);
});

test("parseArgs keeps deprecated command aliases during the E77/F6 transition", () => {
  const cases = [
    { argv: ["new-task", "--title", "Alias Task"], kind: "new-task" },
    { argv: ["task", "status", "set", "task_1", "active"], kind: "status-set" },
    { argv: ["task-review", "task_1"], kind: "task-review" },
    { argv: ["task-complete", "task_1", "--ci", "passed"], kind: "task-complete" },
    { argv: ["record", "fact", "--task", "task_1", "--statement", "Fact", "--source", "Fixture"], kind: "record-fact" },
    { argv: ["distill", "commit", "--task", "task_1", "--candidate", "candidate.json", "--claim", "Claim"], kind: "distill-commit" },
    { argv: ["runtime-event", "append", "--session", "s1", "--kind", "interrupt"], kind: "runtime-event-append" },
    { argv: ["runtime-event", "list", "--session", "s1"], kind: "runtime-event-list" },
    { argv: ["lesson-promote", "task_1", "candidate-1"], kind: "lesson-promote" },
    { argv: ["lesson-sediment", "task_1", "candidate-1"], kind: "lesson-sediment" },
    { argv: ["migrate-plan"], kind: "migrate-plan" },
    { argv: ["migrate-structure", "--plan"], kind: "migrate-structure" },
    { argv: ["migrate-provenance"], kind: "migrate-provenance" },
    { argv: ["migrate-run", "--plan-only"], kind: "migrate-run" },
    { argv: ["migrate-verify", "session.json"], kind: "migrate-verify" },
    { argv: ["legacy", "intake-plan", "old"], kind: "legacy-intake-plan" },
    { argv: ["legacy", "copy-safe-docs", "old"], kind: "legacy-copy-safe-docs" },
    { argv: ["git-diff", "--base", "origin/main"], kind: "git-diff" },
    { argv: ["module-step", "billing", "T-1", "--state", "done"], kind: "module-step" }
  ] as const;

  for (const candidate of cases) {
    const parsed = parseArgs(candidate.argv);
    assert.equal(parsed.ok, true, candidate.argv.join(" "));
    if (!parsed.ok) continue;
    assert.equal(parsed.value.action.kind, candidate.kind, candidate.argv.join(" "));
  }
});

test("parseArgs preserves option values that look like flags for optional parsers", () => {
  const parsed = parseArgs(["task", "progress", "append", "task_1", "--text", "--literal-value"]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.action.kind, "progress-append");
  assert.equal(parsed.value.action.text, "--literal-value");
});

test("parseArgs rejects flag-like tokens for required value options", () => {
  const parsed = parseArgs(["new-task", "--title", "Parser Task", "--vertical", "--preset", "standard-task"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, "missing_vertical");
});

test("parseArgs treats empty argv and help flags as help", () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]] as const) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.equal(parsed.value.action.kind, "help");
  }
});

test("parseArgs handles command-level help before command parsers", () => {
  const cases = [
    { argv: ["new-task", "--help"], commandKind: "new-task" },
    { argv: ["new-task", "-h"], commandKind: "new-task" },
    { argv: ["help", "new-task"], commandKind: "new-task" },
    { argv: ["task", "transition", "--help"], commandKind: "status-set" },
    { argv: ["task", "status", "set", "--help"], commandKind: "status-set" },
    { argv: ["task", "show", "--help"], commandKind: "task-show" },
    { argv: ["relation", "list", "--help"], commandKind: "relation-list" },
    { argv: ["task", "--help"], commandPrefix: ["task"] }
  ] as const;

  for (const candidate of cases) {
    const parsed = parseArgs(candidate.argv);
    assert.equal(parsed.ok, true, candidate.argv.join(" "));
    if (!parsed.ok) continue;
    assert.equal(parsed.value.action.kind, "help");
    if ("commandKind" in candidate) {
      assert.equal(parsed.value.action.commandKind, candidate.commandKind);
    }
    if ("commandPrefix" in candidate) {
      assert.deepEqual(parsed.value.action.commandPrefix, candidate.commandPrefix);
    }
  }
});

test("parseArgs rejects unknown help topics", () => {
  const parsed = parseArgs(["help", "missing-command"]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, "unknown_help_topic");
});

function assertFields(action: ParsedAction, fields: Readonly<Record<string, unknown>>): void {
  const record = action as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    assert.deepEqual(record[key], value, `${action.kind}.${key}`);
  }
}

function assertNoDuplicates(values: ReadonlyArray<string>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assert.equal(seen.has(value), false, `duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
