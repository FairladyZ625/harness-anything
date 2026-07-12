// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Schema } from "effect";
import test from "node:test";
import { SubtaskPlanSchema } from "../../kernel/src/index.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("subtask-expansion preset validates and plans a subtask-plan/v1 artifact", () => {
  withTempRoot((rootDir) => {
    const manifest = path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets/subtask-expansion/preset.json");
    const validated = runJson(rootDir, ["preset", "validate", manifest]);
    assert.equal(validated.ok, true);

    const parent = runJson(rootDir, ["task", "create", "--title", "Parent Expansion"]);
    writeFileSync(path.join(rootDir, String(parent.packagePath), "task_plan.md"), "# Plan\n\nBuild the feature and verify it.\n", "utf8");

    const result = runJson(rootDir, ["preset", "action", "subtask-expansion", "plan", "--task", String(parent.taskId), "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.schema, "subtask-expansion-plan/v1");
    assert.equal(result.report.parentTaskId, parent.taskId);
    assert.equal(result.report.pendingCount, 4);
    assert.equal(result.report.existsCount, 0);
    assert.equal(result.report.edgeCount, 3);
    const plan = readPlan(rootDir, String(parent.packagePath));
    Schema.decodeUnknownSync(SubtaskPlanSchema)(plan);
    assert.equal(plan.schema, "subtask-plan/v1");
    assert.deepEqual(plan.children.map((child: Record<string, unknown>) => [child.role, child.status]), [
      ["implement", "pending"],
      ["test", "pending"],
      ["qa", "pending"],
      ["review", "pending"]
    ]);
    assert.deepEqual(plan.dependencies.map((edge: Record<string, unknown>) => [edge.sourceRole, edge.type, edge.targetRole]), [
      ["test", "depends-on", "implement"],
      ["qa", "depends-on", "test"],
      ["review", "depends-on", "qa"]
    ]);
    assert.match(readFileSync(path.join(rootDir, String(parent.packagePath), "artifacts/subtask-plan.md"), "utf8"), /Subtask Expansion Plan/u);
    assertNoTaskWritesExcept(rootDir, new Set([String(parent.taskId)]));
  });
});

test("subtask-expansion missing parent reports ok false without writing tasksRoot", () => {
  withTempRoot((rootDir) => {
    const before = snapshotTasksRoot(rootDir);

    const result = runJson(rootDir, ["preset", "action", "subtask-expansion", "plan", "--task", "task_MISSING", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_script_result_failed");
    assert.equal(result.report.parentTaskId, "task_MISSING");
    assert.equal(snapshotTasksRoot(rootDir), before);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task_MISSING/artifacts/preset-result.json")), true);
  });
});

test("subtask-expansion plan apply creates four children, three inert relations, and converges on rerun", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Expansion Apply"]);
    runJson(rootDir, ["preset", "action", "subtask-expansion", "plan", "--task", String(parent.taskId), "--allow-scripts"]);
    const firstPlan = readPlan(rootDir, String(parent.packagePath));
    const roleMap = applyCreateCommands(rootDir, firstPlan);
    const relationReports = applyRelationCommands(rootDir, firstPlan, roleMap);

    assert.equal(Object.keys(roleMap).length, 4);
    assert.equal(relationReports.length, 3);
    assert.equal(relationReports.every((report) => report.report.orchestration === "not-triggered"), true);
    const tree = runJson(rootDir, ["task", "tree", String(parent.taskId)]);
    assert.equal(tree.tasks.filter((row: Record<string, unknown>) => row.depth === 1).length, 4);
    for (const taskId of Object.values(roleMap)) {
      const index = readTaskIndex(rootDir, String(taskId));
      assert.match(index, new RegExp(`^parent: ${parent.taskId}$`, "mu"));
      assert.match(index, /^  status: planned$/mu);
    }

    runJson(rootDir, ["preset", "action", "subtask-expansion", "plan", "--task", String(parent.taskId), "--allow-scripts"]);
    const secondPlan = readPlan(rootDir, String(parent.packagePath));
    assert.equal(secondPlan.children.every((child: Record<string, unknown>) => child.status === "exists" && typeof child.existingTaskId === "string"), true);
    const beforeTaskCount = listTaskIndexFiles(rootDir).length;
    const beforeRelationIds = relationIds(rootDir);
    const secondRoleMap = applyCreateCommands(rootDir, secondPlan);
    const secondRelationReports = applyRelationCommands(rootDir, secondPlan, secondRoleMap);
    assert.equal(listTaskIndexFiles(rootDir).length, beforeTaskCount);
    assert.deepEqual(relationIds(rootDir), beforeRelationIds);
    assert.equal(secondRelationReports.every((report) => report.report.orchestration === "not-triggered"), true);
  });
});

test("subtask-expansion plan relations hit existing depends-on cycle without dirty writes", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Expansion Cycle"]);
    runJson(rootDir, ["preset", "action", "subtask-expansion", "plan", "--task", String(parent.taskId), "--allow-scripts"]);
    const plan = readPlan(rootDir, String(parent.packagePath));
    const roleMap = applyCreateCommands(rootDir, plan);

    const reverse = runJson(rootDir, [
      "task",
      "relate",
      String(roleMap.implement),
      "depends-on",
      String(roleMap.review),
      "--rationale",
      "fixture reverse edge"
    ]);
    assert.equal(reverse.report.orchestration, "not-triggered");
    for (const dependency of plan.dependencies.filter((edge: Record<string, unknown>) => edge.sourceRole !== "review")) {
      const relation = runJson(rootDir, [
        "task",
        "relate",
        String(roleMap[dependency.sourceRole]),
        "depends-on",
        String(roleMap[dependency.targetRole]),
        "--rationale",
        String(dependency.rationale)
      ]);
      assert.equal(relation.report.orchestration, "not-triggered");
    }
    const beforeIndex = readTaskIndex(rootDir, String(roleMap.review));
    const firstPlanRelation = plan.dependencies.find((edge: Record<string, unknown>) => edge.sourceRole === "review");
    const cycle = runJson(rootDir, [
      "task",
      "relate",
      String(roleMap.review),
      "depends-on",
      String(roleMap.qa),
      "--rationale",
      String(firstPlanRelation.rationale)
    ], false);

    assert.equal(cycle.ok, false);
    assert.equal(cycle.error.code, "invalid_task_relation");
    assert.match(cycle.error.hint, /depends-on cycle detected/u);
    assert.equal(readTaskIndex(rootDir, String(roleMap.review)), beforeIndex);
  });
});

test("subtask-expansion sandbox blocks taskRoot writes from a patched local copy", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Sandbox Parent"]);
    const presetRoot = path.join(rootDir, ".harness/presets/subtask-expansion-escape");
    copyPresetPackage("subtask-expansion", presetRoot);
    const scriptPath = path.join(presetRoot, "scripts/subtask-plan.mjs");
    writeFileSync(scriptPath, `${readFileSync(scriptPath, "utf8")}\nwriteFileSync(path.join(paths.tasksRoot, "escape.txt"), "bad", "utf8");\n`, "utf8");
    const manifestPath = path.join(presetRoot, "preset.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.id = "subtask-expansion-escape";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = runJson(rootDir, ["preset", "action", "subtask-expansion-escape", "plan", "--task", String(parent.taskId), "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.match(result.error.code, /^preset_(read|write)_scope_violation$/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/escape.txt")), false);
  });
});

function applyCreateCommands(rootDir: string, plan: Record<string, any>): Record<string, string> {
  const roleMap: Record<string, string> = {};
  for (const child of plan.children) {
    if (child.status === "exists") {
      roleMap[child.role] = child.existingTaskId;
      continue;
    }
    const created = runJson(rootDir, [
      "task",
      "create",
      "--title",
      child.title,
      "--parent",
      plan.parentTaskId,
      "--vertical",
      "software/coding",
      "--preset",
      "standard-task"
    ]);
    roleMap[child.role] = created.taskId;
  }
  return roleMap;
}

function applyRelationCommands(rootDir: string, plan: Record<string, any>, roleMap: Record<string, string>): Array<Record<string, any>> {
  return plan.dependencies.map((dependency: Record<string, string>) => runJson(rootDir, [
    "task",
    "relate",
    roleMap[dependency.sourceRole],
    "depends-on",
    roleMap[dependency.targetRole],
    "--rationale",
    dependency.rationale
  ]));
}

function readPlan(rootDir: string, packagePath: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(rootDir, packagePath, "artifacts/subtask-plan.json"), "utf8")) as Record<string, any>;
}

function readTaskIndex(rootDir: string, taskId: string): string {
  const indexPath = listTaskIndexFiles(rootDir).find((candidate) => readFileSync(candidate, "utf8").includes(`task_id: ${taskId}`));
  assert.ok(indexPath, `INDEX.md for ${taskId} should exist`);
  return readFileSync(indexPath, "utf8");
}

function relationIds(rootDir: string): Array<string> {
  return listTaskIndexFiles(rootDir)
    .flatMap((filename) => [...readFileSync(filename, "utf8").matchAll(/relation_id: (rel_[a-f0-9]{16})/gu)].map((match) => match[1]))
    .sort();
}

function assertNoTaskWritesExcept(rootDir: string, allowedTaskIds: Set<string>): void {
  for (const filename of listTaskIndexFiles(rootDir)) {
    const body = readFileSync(filename, "utf8");
    const taskId = /^task_id: (.+)$/mu.exec(body)?.[1];
    assert.ok(taskId);
    assert.equal(allowedTaskIds.has(taskId), true, `unexpected task write: ${taskId}`);
  }
}

function snapshotTasksRoot(rootDir: string): string {
  const tasksRoot = path.join(rootDir, "harness/tasks");
  if (!existsSync(tasksRoot)) return "";
  return listTaskIndexFiles(rootDir).map((filename) => path.relative(tasksRoot, filename)).sort().join("\n");
}

function listTaskIndexFiles(rootDir: string): Array<string> {
  const tasksRoot = path.join(rootDir, "harness/tasks");
  if (!existsSync(tasksRoot)) return [];
  return findFiles(tasksRoot, "INDEX.md");
}

function findFiles(root: string, basename: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(entryPath, basename));
    if (entry.isFile() && entry.name === basename) files.push(entryPath);
  }
  return files;
}

function copyPresetPackage(presetId: string, targetRoot: string): void {
  const sourceRoot = path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets", presetId);
  for (const filename of findAllFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, filename);
    const target = path.join(targetRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(filename));
  }
}

function findAllFiles(root: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findAllFiles(entryPath));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-subtask-expansion-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
