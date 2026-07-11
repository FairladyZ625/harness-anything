// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveRelationId, formatRelationFlowRecord, type EntityRelationRecord } from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("task create --parent stores immutable parent and task tree returns a three-level projection", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Parent"]);
    const child = runJson(rootDir, ["task", "create", "--title", "Child", "--parent", String(parent.taskId)]);
    const grandchild = runJson(rootDir, ["task", "create", "--title", "Grandchild", "--parent", String(child.taskId)]);

    assert.match(readFileSync(path.join(rootDir, String(child.packagePath), "INDEX.md"), "utf8"), new RegExp(`^parent: ${parent.taskId}$`, "mu"));
    assert.match(readFileSync(path.join(rootDir, String(grandchild.packagePath), "INDEX.md"), "utf8"), new RegExp(`^parent: ${child.taskId}$`, "mu"));

    const tree = runJson(rootDir, ["task", "tree", String(parent.taskId)]);
    assert.equal(tree.ok, true);
    assert.deepEqual(tree.tasks.map((row: Record<string, unknown>) => [row.taskId, row.parentTaskId, row.depth]), [
      [parent.taskId, undefined, 0],
      [child.taskId, parent.taskId, 1],
      [grandchild.taskId, child.taskId, 2]
    ]);
  });
});

test("task create rejects a parent cycle before writing the new child", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task_A", "Task A", "planned", { parent: "task_B" });

    const failure = runJson(rootDir, ["task", "create", "--id", "task_B", "--migration", "--title", "Task B", "--parent", "task_A"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "write_rejected");
    assert.match(failure.error?.hint ?? "", /parent cycle detected/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task_B-task-b/INDEX.md")), false);
  });
});

test("task relate depends-on rejects cycles and does not orchestrate status", () => {
  withTempRoot((rootDir) => {
    const a = runJson(rootDir, ["task", "create", "--title", "Task A"]);
    const b = runJson(rootDir, ["task", "create", "--title", "Task B"]);

    const relation = runJson(rootDir, ["task", "relate", String(a.taskId), "depends-on", String(b.taskId), "--rationale", "A waits for B"]);
    const cycle = runJson(rootDir, ["task", "relate", String(b.taskId), "depends-on", String(a.taskId), "--rationale", "B waits for A"], false);
    const list = runJson(rootDir, ["task", "list"]);

    assert.equal(relation.ok, true);
    assert.equal(relation.report.orchestration, "not-triggered");
    assert.equal(cycle.ok, false);
    assert.equal(cycle.error?.code, "invalid_task_relation");
    assert.match(cycle.error?.hint ?? "", /depends-on cycle detected/u);
    assert.deepEqual(list.tasks.map((row: Record<string, unknown>) => [row.taskId, row.canonicalStatus]), [
      [a.taskId, "planned"],
      [b.taskId, "planned"]
    ]);
  });
});

test("post-merge check reports relation_cycle_detected for parent and depends-on cycles", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task_A", "Task A", "planned", { parent: "task_B", relations: [dependsOn("task_A", "task_B")] });
    writeIndex(rootDir, "task_B", "Task B", "planned", { parent: "task_A", relations: [dependsOn("task_B", "task_A")] });

    const check = runJson(rootDir, ["check", "--post-merge"], false);

    assert.equal(check.ok, false);
    const cycleWarnings = check.warnings.filter((warning: Record<string, unknown>) => warning.code === "relation_cycle_detected");
    assert.equal(cycleWarnings.length >= 2, true);
    assert.equal(cycleWarnings.some((warning: Record<string, unknown>) => String(warning.message).includes("Task parent cycle detected")), true);
    assert.equal(cycleWarnings.some((warning: Record<string, unknown>) => String(warning.message).includes("Entity relation cycle detected")), true);
  });
});

test("closing a parent with open children warns without mutating child status", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Parent"]);
    const child = runJson(rootDir, ["task", "create", "--title", "Child", "--parent", String(parent.taskId)]);
    writeSubstantiveTaskPlan(rootDir, String(parent.packagePath));

    runJson(rootDir, ["task", "transition", String(parent.taskId), "active"]);
    const closed = runJson(rootDir, ["task", "transition", String(parent.taskId), "done", "--force", "--reason", "fixture close"]);
    const list = runJson(rootDir, ["task", "list"]);

    assert.equal(closed.ok, true);
    assert.equal(closed.warnings[0].code, "open_child_tasks");
    assert.match(closed.warnings[0].message, /WARNING/u);
    assert.deepEqual(list.tasks.find((row: Record<string, unknown>) => row.taskId === child.taskId)?.canonicalStatus, "planned");
  });
});

function dependsOn(sourceTaskId: string, targetTaskId: string): EntityRelationRecord {
  const base = {
    source: `task/${sourceTaskId}`,
    target: `task/${targetTaskId}`,
    type: "depends-on",
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: `${sourceTaskId} waits for ${targetTaskId}`,
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return { relation_id: deriveRelationId(base), ...base };
}

function writeIndex(
  rootDir: string,
  taskId: string,
  title: string,
  status: string,
  options: { readonly parent?: string; readonly relations?: ReadonlyArray<EntityRelationRecord> } = {}
): void {
  const taskDir = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    ...(options.parent ? [`parent: ${options.parent}`] : []),
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}",
    ...(options.relations && options.relations.length > 0 ? ["relations:", ...options.relations.map(formatRelationFlowRecord)] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], { encoding: "utf8" });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-tree-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
