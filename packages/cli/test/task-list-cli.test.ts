// harness-test-tier: integration
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI task list filters projection rows without treating generated cache as source truth", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-billing", "Billing Checkout", "active", {
      taskId: "task-billing",
      preset: "module",
      profile: "baseline",
      workKind: "feat",
      riskTier: "high",
      urgency: "medium",
      taskClass: "milestone",
      moduleKey: "billing",
      moduleTitle: "Billing",
      lessonCandidates: true
    });
    writeIndex(rootDir, "task-docs", "Docs Cleanup", "planned", {
      taskId: "task-docs",
      preset: "standard-task",
      packageDisposition: "archived"
    });
    writeIndex(rootDir, "task-deleted", "Deleted Task", "planned", {
      taskId: "task-deleted",
      preset: "standard-task",
      packageDisposition: "tombstoned"
    });
    writeIndex(rootDir, "task-missing", "Missing Closeout", "done", {
      taskId: "task-missing",
      preset: "standard-task"
    });
    writeIndex(rootDir, "task-review", "Review Queue", "in_review", {
      taskId: "task-review",
      preset: "standard-task",
      workKind: "fix",
      riskTier: "medium",
      urgency: "high",
      taskClass: "epic"
    });
    writeFileSync(path.join(rootDir, "harness/tasks/task-billing/progress.md"), "# Progress\n\nRecent work\n", "utf8");
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const moduleFiltered = runJson(rootDir, ["task", "list", "--module", "billing", "--preset", "module", "--state", "active", "--queue", "open", "--search", "checkout"]);
    assert.equal(moduleFiltered.ok, true);
    assert.deepEqual(moduleFiltered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);
    assert.equal(moduleFiltered.tasks[0].moduleKey, "billing");
    assert.equal(moduleFiltered.tasks[0].preset, "module");
    assert.equal(moduleFiltered.tasks[0].createdAt, null);
    assert.equal(moduleFiltered.tasks[0].treeRoot, "task-billing");
    assert.equal(moduleFiltered.tasks[0].liveness, "in_flight");

    const derivedFiltered = runJson(rootDir, ["task", "list", "--tree-root", "task-billing", "--liveness", "in_flight"]);
    assert.deepEqual(derivedFiltered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);

    const defaultList = runJson(rootDir, ["task", "list"]);
    assert.deepEqual(defaultList.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing", "task-missing", "task-review"]);

    const openList = runJson(rootDir, ["task", "list", "--state", "open"]);
    assert.deepEqual(openList.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);

    const reviewQueue = runJson(rootDir, ["task", "list", "--queue", "review"]);
    assert.deepEqual(reviewQueue.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-review"]);

    const metadataFiltered = runJson(rootDir, ["task", "list", "--kind", "feat", "--risk-tier", "high", "--urgency", "medium"]);
    assert.deepEqual(metadataFiltered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);
    assert.equal(metadataFiltered.tasks[0].workKind, "feat");
    assert.equal(metadataFiltered.tasks[0].riskTier, "high");
    assert.equal(metadataFiltered.tasks[0].urgency, "medium");

    const taskClassFiltered = runJson(rootDir, ["task", "list", "--taskClass", "milestone"]);
    assert.deepEqual(taskClassFiltered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);
    assert.deepEqual(taskClassFiltered.tasks[0].fieldExtensions, { taskClass: "milestone" });

    const noMetadataMatch = runJson(rootDir, ["task", "list", "--kind", "docs"]);
    assert.deepEqual(noMetadataMatch.tasks, []);

    const withArchived = runJson(rootDir, ["task", "list", "--include-archived", "--preset", "standard-task"]);
    assert.deepEqual(withArchived.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-deleted", "task-docs", "task-missing", "task-review"]);

    const missingMaterials = runJson(rootDir, ["task", "list", "--include-archived", "--missing-materials"]);
    assert.deepEqual(missingMaterials.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-missing", "task-review"]);
  });
});

test("CLI task amend rejects invalid vertical enum field values", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-review", "Review Queue", "in_review", {
      taskId: "task-review",
      preset: "standard-task",
      workKind: "fix",
      riskTier: "medium",
      urgency: "high",
      taskClass: "epic"
    });

    const failure = runJsonFailure(rootDir, ["task", "amend", "task-review", "--set", "taskClass:invalid-value"]);
    assert.equal(failure.ok, false);
    assert.equal(failure.command, "task-amend");
    assert.equal(failure.error?.code, "invalid_task_metadata");
    assert.match(failure.error?.hint ?? "", /taskClass/);
    assert.match(failure.error?.hint ?? "", /invalid-value/);
  });
});

function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: {
    readonly taskId: string;
    readonly packageDisposition?: string;
    readonly vertical?: string;
    readonly preset?: string;
    readonly profile?: string;
    readonly workKind?: string;
    readonly riskTier?: string;
    readonly urgency?: string;
    readonly taskClass?: string;
    readonly moduleKey?: string;
    readonly moduleTitle?: string;
    readonly lessonCandidates?: boolean;
  }
): void {
  const taskDir = path.join(rootDir, "harness/tasks", directoryName);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${options.taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    `packageDisposition: ${options.packageDisposition ?? "active"}`,
    ...(options.workKind ? [`workKind: ${options.workKind}`] : []),
    ...(options.riskTier ? [`riskTier: ${options.riskTier}`] : []),
    ...(options.urgency ? [`urgency: ${options.urgency}`] : []),
    ...(options.taskClass ? [`taskClass: ${options.taskClass}`] : []),
    `vertical: ${options.vertical ?? "software/coding"}`,
    `preset: ${options.preset ?? "standard-task"}`,
    ...(options.profile ? [`profile: ${options.profile}`] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
  if (options.moduleKey) {
    writeFileSync(path.join(taskDir, "module.md"), [
      "# Module Selection",
      "",
      `Module key: ${options.moduleKey}`,
      `Module title: ${options.moduleTitle ?? options.moduleKey}`,
      ""
    ].join("\n"), "utf8");
  }
  if (options.lessonCandidates) {
    writeFileSync(path.join(taskDir, "lesson_candidates.md"), "# Lesson Candidates\n", "utf8");
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8"
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function runJsonFailure(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  try {
    runJson(rootDir, args);
    assert.fail("expected command to fail");
  } catch (error) {
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-list-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
