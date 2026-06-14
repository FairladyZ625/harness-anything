import assert from "node:assert/strict";
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
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const moduleFiltered = runJson(rootDir, ["task", "list", "--module", "billing", "--preset", "module", "--state", "active", "--queue", "open", "--search", "checkout"]);
    assert.equal(moduleFiltered.ok, true);
    assert.deepEqual(moduleFiltered.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing"]);
    assert.equal(moduleFiltered.tasks[0].moduleKey, "billing");
    assert.equal(moduleFiltered.tasks[0].preset, "module");

    const defaultList = runJson(rootDir, ["task", "list"]);
    assert.deepEqual(defaultList.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-billing", "task-missing"]);

    const withArchived = runJson(rootDir, ["task", "list", "--include-archived", "--preset", "standard-task"]);
    assert.deepEqual(withArchived.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-deleted", "task-docs", "task-missing"]);

    const missingMaterials = runJson(rootDir, ["task", "list", "--include-archived", "--missing-materials"]);
    assert.deepEqual(missingMaterials.tasks.map((row: Record<string, unknown>) => row.taskId), ["task-missing"]);
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
    readonly moduleKey?: string;
    readonly moduleTitle?: string;
    readonly lessonCandidates?: boolean;
  }
): void {
  const taskDir = path.join(rootDir, "harness/planning/tasks", directoryName);
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
  return JSON.parse(stdout) as Record<string, any>;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-list-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
