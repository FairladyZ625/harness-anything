import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { commandRegistry } from "../src/cli/command-registry.ts";
import { parseArgs } from "../src/cli/parse-args.ts";
import { parserRegistry } from "../src/cli/parser-registry.ts";
import type { ParsedCommand } from "../src/cli/types.ts";
import { extensionActionKinds, extensionExecutorGroups, isExtensionAction } from "../src/commands/extensions/index.ts";
import { resolveHarnessLayout } from "../../kernel/src/layout/index.ts";

type ParsedAction = ParsedCommand["action"];

interface ParseCase {
  readonly name: string;
  readonly argv: ReadonlyArray<string>;
  readonly kind: ParsedAction["kind"];
  readonly fields?: Readonly<Record<string, unknown>>;
}

const rootDir = path.resolve("/tmp/harness-parser-root");

const parseCases: ReadonlyArray<ParseCase> = [
  { name: "help", argv: ["--help"], kind: "help" },
  { name: "init", argv: ["init"], kind: "init", fields: { addNpmScripts: false } },
  { name: "init add npm scripts", argv: ["init", "--add-npm-scripts"], kind: "init", fields: { addNpmScripts: true } },
  { name: "init project name", argv: ["init", "--name", "human-kernel"], kind: "init", fields: { projectName: "human-kernel" } },
  {
    name: "new-task preset task",
    argv: ["new-task", "--title", "Parser Task", "--vertical", "software/coding", "--preset", "standard-task", "--profile", "baseline", "--module", "billing", "--long-running", "--locale", "en-US"],
    kind: "new-task",
    fields: { title: "Parser Task", slug: "parser-task", vertical: "software/coding", preset: "standard-task", profile: "baseline", moduleKey: "billing", allowManualId: false, longRunning: true, locale: "en-US" }
  },
  {
    name: "new-task register module dry run",
    argv: ["new-task", "--title", "Parser Task", "--register-module", "billing", "--module-title", "Billing", "--module-prefix", "BILL", "--module-scope", "packages/billing/**", "--dry-run"],
    kind: "new-task",
    fields: { registerModule: { key: "billing", title: "Billing", prefix: "BILL", scope: "packages/billing/**" }, moduleKey: "billing", dryRun: true }
  },
  {
    name: "new-task legacy rebuild",
    argv: ["new-task", "--from-legacy", "legacy-1"],
    kind: "new-task",
    fields: { title: "Untitled task", fromLegacyId: "legacy-1", allowManualId: false }
  },
  {
    name: "status set forced",
    argv: ["task", "status", "set", "task_1", "done", "--force", "--reason", "verified"],
    kind: "status-set",
    fields: { taskId: "task_1", status: "done", force: true, reason: "verified" }
  },
  { name: "progress append", argv: ["task", "progress", "append", "task_1", "--text", "hello", "--evidence", "log:artifacts/run.log:passed"], kind: "progress-append", fields: { taskId: "task_1", text: "hello", evidence: { type: "log", path: "artifacts/run.log", summary: "passed" } } },
  { name: "task archive", argv: ["task", "archive", "task_1", "--reason", "done", "--archived-by", "alice", "--archive-field", "packageDisposition"], kind: "task-archive", fields: { taskId: "task_1", reason: "done", archivedBy: "alice", archiveField: "packageDisposition" } },
  { name: "task supersede", argv: ["task", "supersede", "task_old", "--title", "New Task", "--slug", "custom-slug", "--reason", "changed"], kind: "task-supersede", fields: { oldTaskId: "task_old", title: "New Task", slug: "custom-slug", reason: "changed", allowOpenFindings: false } },
  { name: "task supersede by existing", argv: ["task", "supersede", "task_old", "--by", "task_new", "--confirm", "task_old", "--allow-open-findings", "--deleted-by", "alice"], kind: "task-supersede", fields: { oldTaskId: "task_old", byTaskId: "task_new", confirm: "task_old", allowOpenFindings: true, deletedBy: "alice" } },
  { name: "task delete reason position", argv: ["task", "delete", "--hard", "--reason", "cleanup", "--confirm", "task_1", "--deleted-by", "alice", "task_1"], kind: "task-delete", fields: { taskId: "task_1", mode: "hard", reason: "cleanup", confirm: "task_1", deletedBy: "alice" } },
  { name: "task delete skips option values before id", argv: ["task", "delete", "--soft", "--reason", "cleanup", "--deleted-by", "alice", "task_1"], kind: "task-delete", fields: { taskId: "task_1", mode: "soft", reason: "cleanup", deletedBy: "alice" } },
  { name: "task reopen", argv: ["task", "reopen", "task_1", "--reason", "followup"], kind: "task-reopen", fields: { taskId: "task_1", reason: "followup" } },
  { name: "task review", argv: ["task-review", "task_1", "--reviewer", "alice"], kind: "task-review", fields: { taskId: "task_1", reviewerId: "alice" } },
  { name: "task complete", argv: ["task-complete", "task_1", "--ci", "passed", "--reviewer", "alice"], kind: "task-complete", fields: { taskId: "task_1", ciGate: "passed", reviewerId: "alice" } },
  { name: "task list", argv: ["task", "list"], kind: "task-list", fields: { filters: { missingMaterials: false, includeArchived: false } } },
  {
    name: "task list filters",
    argv: ["task", "list", "--state", "active", "--module", "billing", "--queue", "open", "--preset", "module", "--review", "missing", "--lesson", "missing", "--missing-materials", "--include-archived", "--search", "checkout"],
    kind: "task-list",
    fields: {
      filters: {
        state: "active",
        moduleKey: "billing",
        queue: "open",
        preset: "module",
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
  { name: "lesson promote", argv: ["lesson-promote", "task_1", "candidate-1", "--apply"], kind: "lesson-promote", fields: { taskId: "task_1", candidateId: "candidate-1", mode: "apply" } },
  { name: "lesson sediment", argv: ["lesson-sediment", "task_1", "candidate-1", "--title", "Learning"], kind: "lesson-sediment", fields: { taskId: "task_1", candidateId: "candidate-1", title: "Learning", mode: "dry-run" } },
  { name: "adopt multica", argv: ["adopt", "multica", "EXT-1", "--task", "task_1", "--title", "External", "--status", "todo"], kind: "adopt-multica", fields: { ref: "EXT-1", taskId: "task_1", title: "External", status: "todo" } },
  { name: "snapshot multica", argv: ["snapshot", "multica", "EXT-1", "--title", "External", "--status", "todo"], kind: "snapshot-multica", fields: { ref: "EXT-1", title: "External", status: "todo" } },
  { name: "migrate plan", argv: ["migrate-plan", "--limit", "5"], kind: "migrate-plan", fields: { limit: 5 } },
  { name: "migrate structure", argv: ["migrate-structure", "--apply", "--confirm-plan"], kind: "migrate-structure", fields: { mode: "apply", confirmPlan: true } },
  { name: "migrate run", argv: ["migrate-run", "--plan-only", "--session-dir", "session", "--locale", "en-US", "--assume-locale", "zh-CN", "--allow-dirty"], kind: "migrate-run", fields: { planOnly: true, outDir: "session", sessionDir: "session", locale: "en-US", assumeLocale: "zh-CN", allowDirty: true } },
  { name: "migrate verify", argv: ["migrate-verify", "session.json"], kind: "migrate-verify", fields: { sessionPath: "session.json", fullCutover: false } },
  { name: "legacy scan", argv: ["legacy", "scan", "old"], kind: "legacy-scan", fields: { sourcePath: "old" } },
  { name: "legacy intake plan", argv: ["legacy", "intake-plan", "old", "--out", "plan.json"], kind: "legacy-intake-plan", fields: { sourcePath: "old", outPath: "plan.json" } },
  { name: "legacy copy safe docs", argv: ["legacy", "copy-safe-docs", "old", "--apply"], kind: "legacy-copy-safe-docs", fields: { sourcePath: "old", apply: true } },
  { name: "legacy index", argv: ["legacy", "index", "old", "--apply"], kind: "legacy-index", fields: { sourcePath: "old", apply: true } },
  { name: "legacy verify", argv: ["legacy", "verify"], kind: "legacy-verify" },
  { name: "git diff", argv: ["git-diff", "--base", "origin/main"], kind: "git-diff", fields: { baseRef: "origin/main" } },
  { name: "doctor", argv: ["doctor"], kind: "doctor" },
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
  { name: "preset run allow scripts", argv: ["preset", "run", "publish-standard", "plan", "--task", "task_1", "--allow-scripts"], kind: "preset-run", fields: { presetId: "publish-standard", entrypoint: "plan", taskId: "task_1", allowScripts: true } },
  { name: "preset action", argv: ["preset", "action", "standard-task", "scaffold", "--task", "task_1"], kind: "preset-action", fields: { presetId: "standard-task", actionName: "scaffold", taskId: "task_1", allowScripts: false } },
  { name: "preset action allow scripts", argv: ["preset", "action", "publish-standard", "scaffold", "--task", "task_1", "--allow-scripts"], kind: "preset-action", fields: { presetId: "publish-standard", actionName: "scaffold", taskId: "task_1", allowScripts: true } },
  { name: "module list", argv: ["module", "list"], kind: "module-list" },
  { name: "module inspect", argv: ["module", "inspect", "billing"], kind: "module-inspect", fields: { moduleKey: "billing" } },
  { name: "module register", argv: ["module", "register", "billing", "--title", "Billing", "--scope", "packages/billing/**", "--prefix", "BILL", "--status", "active", "--branch", "main", "--owner", "team", "--current-step", "BILL-01", "--shared", "docs/**", "--depends-on", "kernel"], kind: "module-register", fields: { moduleKey: "billing", title: "Billing", scope: "packages/billing/**", prefix: "BILL", status: "active", branch: "main", owner: "team", currentStep: "BILL-01", shared: ["docs/**"], dependsOn: ["kernel"] } },
  { name: "module scaffold", argv: ["module", "scaffold", "billing"], kind: "module-scaffold", fields: { moduleKey: "billing" } },
  { name: "module unregister", argv: ["module", "unregister", "billing"], kind: "module-unregister", fields: { moduleKey: "billing" } },
  { name: "module step", argv: ["module-step", "billing", "T-1", "--state", "done"], kind: "module-step", fields: { moduleKey: "billing", stepId: "T-1", state: "done" } },
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

test("command registry exposes help metadata for every command", () => {
  for (const entry of commandRegistry) {
    assert.equal(entry.commandPath.length > 0, true, entry.kind);
    assert.equal(entry.summary.length > 0, true, entry.kind);
    assert.equal(entry.resultEnvelope, "CommandReceipt/v1", entry.kind);
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
    assert.equal(["template", "preset", "module", "vertical"].includes(extensionExecutorGroups[kind]), true, `${kind} executor group`);
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
    { argv: ["new-task"], code: "missing_title" },
    { argv: ["unknown"], code: "unknown_command", hintIncludes: "harness-anything new-task --title <title>" }
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
    { argv: ["task", "status", "set", "--help"], commandKind: "status-set" },
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
