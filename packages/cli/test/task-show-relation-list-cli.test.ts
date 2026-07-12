// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI task show returns one projected task panorama with hierarchy, relations, and fact anchors", () => {
  withTempRoot((rootDir) => {
    const parent = runJson(rootDir, ["task", "create", "--title", "Parent Task"]);
    const child = runJson(rootDir, ["task", "create", "--title", "Child Task", "--parent", String(parent.taskId), "--kind", "feat", "--risk-tier", "medium", "--urgency", "high"]);
    runJson(rootDir, ["task", "relate", String(child.taskId), "depends-on", String(parent.taskId), "--rationale", "Child waits for parent"]);
    runJson(rootDir, [
      "fact",
      "record",
      "--task",
      String(child.taskId),
      "--id",
      "F-1234ABCD",
      "--statement",
      "Child task has evidence.",
      "--source",
      "task-show test",
      "--confidence",
      "high",
      "--memory-class",
      "episodic"
    ]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_TASK_SHOW",
      "--title",
      "Task Show Relation",
      "--question",
      "Should task show surface relation edges?",
      "--chosen",
      "Surface projected edges",
      "--rejected",
      "Scan markdown manually",
      "--why-not",
      "Agents need a projection read path",
      "--claim",
      "Task show should expose linked tasks.",
      "--evidence-relation",
      `C1:relates:task/${child.taskId}:Decision points at the task under inspection`
    ]);

    const result = runJson(rootDir, ["task", "show", String(child.taskId)]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-show");
    assert.equal(result.taskId, child.taskId);
    assert.equal(result.path, `${child.packagePath}/INDEX.md`);
    assert.equal(result.report.schema, "task-show-report/v1");
    assert.equal(result.report.task.taskId, child.taskId);
    assert.equal(result.report.task.workKind, "feat");
    assert.equal(result.report.task.riskTier, "medium");
    assert.equal(result.report.task.urgency, "high");
    assert.equal(result.report.hierarchy.parent.taskId, parent.taskId);
    assert.equal(result.report.evidence.factAnchorCount, 1);
    assert.equal(result.report.evidence.factAnchors[0].factRef, `fact/${child.taskId}/F-1234ABCD`);
    assert.equal(result.report.relations.summary.total, 2);
    assert.deepEqual(result.report.relations.edges.map((edge: Record<string, unknown>) => edge.relationType).sort(), ["depends-on", "relates"]);
    assert.equal(result.report.materials.readSetStatus, "not-projected");
    assert.equal(result.report.progress.summary, "not-projected");
  });
});

test("CLI task show returns structured not-found receipts", () => {
  withTempRoot((rootDir) => {
    const failure = runJson(rootDir, ["task", "show", "task_missing"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.command, "task-show");
    assert.equal(failure.error?.code, "task_not_found");
    assert.match(failure.error?.hint ?? "", /task_missing/u);
  });
});

test("CLI task show rebuilds stale projection instead of trusting generated cache rows", () => {
  withTempRoot((rootDir) => {
    const indexPath = writeIndex(rootDir, "task_stale", "Original Title");
    runJson(rootDir, ["task", "list"]);
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("Original Title", "Updated Title"), "utf8");

    const result = runJson(rootDir, ["task", "show", "task_stale"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.task.title, "Updated Title");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "projection_stale"), true);
  });
});

test("CLI relation list filters projected relation edges by entity, endpoint, type, and state", () => {
  withTempRoot((rootDir) => {
    const left = runJson(rootDir, ["task", "create", "--title", "Left"]);
    const right = runJson(rootDir, ["task", "create", "--title", "Right"]);
    runJson(rootDir, ["task", "relate", String(left.taskId), "depends-on", String(right.taskId), "--rationale", "Left waits for right"]);

    const byEntity = runJson(rootDir, ["relation", "list", "--entity", `task/${left.taskId}`]);
    const exact = runJson(rootDir, [
      "relation",
      "list",
      "--source",
      `task/${left.taskId}`,
      "--target",
      `task/${right.taskId}`,
      "--type",
      "depends-on",
      "--state",
      "active"
    ]);
    const none = runJson(rootDir, ["relation", "list", "--target", `task/${left.taskId}`, "--state", "active"]);

    assert.equal(byEntity.ok, true);
    assert.equal(byEntity.command, "relation-list");
    assert.equal(byEntity.rows, 1);
    assert.equal(byEntity.report.relations[0].sourceRef, `task/${left.taskId}`);
    assert.equal(exact.rows, 1);
    assert.deepEqual(exact.report.filters, {
      source: `task/${left.taskId}`,
      target: `task/${right.taskId}`,
      type: "depends-on",
      state: "active"
    });
    assert.equal(none.rows, 0);
  });
});

test("CLI help and capabilities expose task show and relation list", () => {
  withTempRoot((rootDir) => {
    const taskHelp = runJson(rootDir, ["task", "show", "--help"]);
    const relationHelp = runJson(rootDir, ["relation", "list", "--help"]);
    const taskCapabilities = runJson(rootDir, ["capabilities", "--kind", "task"]);
    const relationCapabilities = runJson(rootDir, ["capabilities", "--kind", "relation"]);

    assert.equal(taskHelp.command, "help");
    assert.deepEqual(taskHelp.commands.map((entry: Record<string, unknown>) => entry.kind), ["task-show"]);
    assert.equal(relationHelp.command, "help");
    assert.deepEqual(relationHelp.commands.map((entry: Record<string, unknown>) => entry.kind), ["relation-list"]);
    assert.equal(taskCapabilities.report.ops.some((op: Record<string, unknown>) => op.commandKind === "task-show"), true);
    assert.equal(relationCapabilities.report.ops.some((op: Record<string, unknown>) => op.commandKind === "relation-list"), true);
  });
});

function writeIndex(rootDir: string, taskId: string, title: string): string {
  const taskDir = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskDir, { recursive: true });
  const indexPath = path.join(taskDir, "INDEX.md");
  writeFileSync(indexPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-08T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "workKind: feat",
    "riskTier: low",
    "urgency: medium",
    "vertical: software/coding",
    "preset: standard-task",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
  return indexPath;
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: process.env
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-show-relation-list-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
