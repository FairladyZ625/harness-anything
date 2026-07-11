// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI migrate anchors backfills required task plan anchors and is idempotent", () => {
  withTempRoot((rootDir) => {
    writeContextDocs(rootDir);
    runJson(rootDir, ["init"]);

    const oldTask = runJson(rootDir, ["new-task", "--title", "Old Plan Task"]);
    const completeTask = runJson(rootDir, ["new-task", "--title", "Complete Plan Task"]);
    writeSubstantiveTaskPlan(rootDir, String(completeTask.packagePath));
    writeDefaultTask(rootDir);

    const oldPlanPath = path.join(rootDir, oldTask.packagePath, "task_plan.md");
    const completePlanPath = path.join(rootDir, completeTask.packagePath, "task_plan.md");
    writeFileSync(oldPlanPath, oldTaskPlan(), "utf8");
    const completeBefore = readFileSync(completePlanPath, "utf8");
    const defaultBefore = readFileSync(path.join(rootDir, "harness/tasks/default-task/task_plan.md"), "utf8");

    const beforeCheck = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(beforeCheck.ok, false);
    assert.deepEqual(requiredAnchorIssues(beforeCheck), [
      `${oldTask.packagePath}/task_plan.md is missing required anchor ## Checkpoint.`,
      `${oldTask.packagePath}/task_plan.md is missing required anchor ## Constraints.`
    ]);

    const dryRun = runJson(rootDir, ["migrate", "anchors", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.command, "migrate-anchors");
    assert.equal(dryRun.migrationMode, "plan");
    assert.equal(dryRun.rows, 2);
    assert.deepEqual(dryRun.report.entries.map((entry: Record<string, any>) => ({
      path: entry.path,
      anchors: entry.anchors.map((anchor: Record<string, string>) => anchor.anchor)
    })), [{
      path: `${oldTask.packagePath}/task_plan.md`,
      anchors: ["## Constraints", "## Checkpoint"]
    }]);

    const applied = runJson(rootDir, ["migrate", "anchors", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.migrationMode, "apply");
    assert.equal(applied.report.summary.appliedDocuments, 1);
    assert.equal(applied.report.summary.appliedAnchors, 2);

    const patched = readFileSync(oldPlanPath, "utf8");
    assert.equal(patched.match(/^## Constraints$/gmu)?.length, 1);
    assert.equal(patched.match(/^## Checkpoint$/gmu)?.length, 1);
    assert.equal(patched.indexOf("## Context") < patched.indexOf("## Constraints"), true);
    assert.equal(patched.indexOf("## Constraints") < patched.indexOf("## Checkpoint"), true);
    assert.equal(patched.indexOf("## Checkpoint") < patched.indexOf("## Implementation Plan"), true);
    assert.equal(readFileSync(completePlanPath, "utf8"), completeBefore);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/default-task/task_plan.md"), "utf8"), defaultBefore);

    const afterCheck = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(afterCheck.ok, true);

    const firstPatchedBody = readFileSync(oldPlanPath, "utf8");
    const secondApply = runJson(rootDir, ["migrate", "anchors", "--apply"]);
    assert.equal(secondApply.rows, 0);
    assert.equal(secondApply.report.summary.appliedDocuments, 0);
    assert.equal(readFileSync(oldPlanPath, "utf8"), firstPatchedBody);
  });
});

test("CLI migrate anchors fails closed on invalid settings without writing", () => {
  withTempRoot((rootDir) => {
    writeContextDocs(rootDir);
    runJson(rootDir, ["init"]);

    const oldTask = runJson(rootDir, ["new-task", "--title", "Bad Settings Plan"]);
    const oldPlanPath = path.join(rootDir, oldTask.packagePath, "task_plan.md");
    writeFileSync(oldPlanPath, oldTaskPlan(), "utf8");
    const before = readFileSync(oldPlanPath, "utf8");
    writeHarnessConfig(rootDir, [
      "schema: harness-anything/v1",
      "settings:",
      "  locale: fr-FR",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      ""
    ]);

    const failed = runJson(rootDir, ["migrate", "anchors", "--apply"], false);
    assert.equal(failed.ok, false);
    assert.equal(failed.command, "migrate-anchors");
    assert.equal(failed.error.code, "harness_settings_invalid");
    assert.equal(readFileSync(oldPlanPath, "utf8"), before);
  });
});

test("CLI migrate anchors skips unreadable materialized documents and keeps scanning", () => {
  withTempRoot((rootDir) => {
    writeContextDocs(rootDir);
    runJson(rootDir, ["init"]);

    const unreadableTask = runJson(rootDir, ["new-task", "--title", "Unreadable Plan"]);
    const patchableTask = runJson(rootDir, ["new-task", "--title", "Patchable Plan"]);
    const unreadablePlanPath = path.join(rootDir, unreadableTask.packagePath, "task_plan.md");
    const patchablePlanPath = path.join(rootDir, patchableTask.packagePath, "task_plan.md");
    rmSync(unreadablePlanPath);
    mkdirSync(unreadablePlanPath);
    writeFileSync(patchablePlanPath, oldTaskPlan(), "utf8");

    const dryRun = runJson(rootDir, ["migrate", "anchors", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.report.summary.needsBackfill, 1);
    assert.equal(dryRun.report.entries[0].path, `${patchableTask.packagePath}/task_plan.md`);
    assert.deepEqual(skippedReasons(dryRun), ["materialized_document_unreadable"]);

    const applied = runJson(rootDir, ["migrate", "anchors", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.report.summary.appliedDocuments, 1);
    assert.equal(applied.report.summary.appliedAnchors, 2);
    assert.deepEqual(skippedReasons(applied), ["materialized_document_unreadable"]);

    const patched = readFileSync(patchablePlanPath, "utf8");
    assert.equal(patched.match(/^## Constraints$/gmu)?.length, 1);
    assert.equal(patched.match(/^## Checkpoint$/gmu)?.length, 1);
  });
});

test("CLI migrate anchors skips duplicate task ids before coordinated writes", () => {
  withTempRoot((rootDir) => {
    writeContextDocs(rootDir);
    runJson(rootDir, ["init"]);

    const firstTask = runJson(rootDir, ["new-task", "--title", "Duplicate One"]);
    const secondTask = runJson(rootDir, ["new-task", "--title", "Duplicate Two"]);
    const firstIndexPath = path.join(rootDir, firstTask.packagePath, "INDEX.md");
    const secondIndexPath = path.join(rootDir, secondTask.packagePath, "INDEX.md");
    const duplicateTaskId = taskIdFromIndex(readFileSync(firstIndexPath, "utf8"));
    writeFileSync(secondIndexPath, readFileSync(secondIndexPath, "utf8").replace(/^task_id: .+$/mu, `task_id: ${duplicateTaskId}`), "utf8");

    const firstPlanPath = path.join(rootDir, firstTask.packagePath, "task_plan.md");
    const secondPlanPath = path.join(rootDir, secondTask.packagePath, "task_plan.md");
    writeFileSync(firstPlanPath, oldTaskPlan(), "utf8");
    writeFileSync(secondPlanPath, oldTaskPlan(), "utf8");
    const firstBefore = readFileSync(firstPlanPath, "utf8");
    const secondBefore = readFileSync(secondPlanPath, "utf8");

    const applied = runJson(rootDir, ["migrate", "anchors", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.rows, 0);
    assert.equal(applied.report.summary.appliedDocuments, 0);
    assert.deepEqual(skippedReasons(applied), ["duplicate_task_id", "duplicate_task_id"]);
    assert.equal(readFileSync(firstPlanPath, "utf8"), firstBefore);
    assert.equal(readFileSync(secondPlanPath, "utf8"), secondBefore);
  });
});

function requiredAnchorIssues(result: Record<string, any>): ReadonlyArray<string> {
  return (result.warnings as ReadonlyArray<Record<string, string>>)
    .filter((issue) => issue.code === "metadata_required_anchor_missing")
    .map((issue) => issue.message)
    .sort();
}

function skippedReasons(result: Record<string, any>): ReadonlyArray<string> {
  return (result.report.skipped as ReadonlyArray<Record<string, string>>)
    .map((entry) => entry.reason)
    .sort();
}

function taskIdFromIndex(body: string): string {
  const match = /^task_id:\s*(.+)$/mu.exec(body);
  assert.ok(match);
  return match[1];
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-anchor-backfill-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeContextDocs(rootDir: string): void {
  writeFile(rootDir, "AGENTS.md", "# Agent Context\n");
  writeFile(rootDir, "CLAUDE.md", "# Claude Context\n");
}

function writeHarnessConfig(rootDir: string, lines: ReadonlyArray<string>): void {
  writeFile(rootDir, "harness/harness.yaml", lines.join("\n"));
}

function writeDefaultTask(rootDir: string): void {
  writeFile(rootDir, "harness/tasks/default-task/INDEX.md", [
    "---",
    "schema: task-package/v2",
    "task_id: default-task",
    "title: Default Task",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: Default Task",
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-06-12T00:00:00.000Z\"}",
    "---",
    "",
    "# Default Task",
    ""
  ].join("\n"));
  writeFile(rootDir, "harness/tasks/default-task/task_plan.md", [
    "# Default Task",
    "",
    "Task Contract: harness-task v1",
    "",
    "## Brief",
    "",
    "Default vertical fixture.",
    "",
    "## Goal",
    "",
    "Keep default vertical documents untouched.",
    ""
  ].join("\n"));
  writeFile(rootDir, "harness/tasks/default-task/review.md", [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ""
  ].join("\n"));
  writeFile(rootDir, "harness/tasks/default-task/visual_map.md", [
    "# Visual Map",
    "",
    "| Phase ID | Kind | Depends On | State | Completion |",
    "| --- | --- | --- | --- | --- |",
    "| P1 | implementation | none | done | Fixture exists |",
    ""
  ].join("\n"));
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function oldTaskPlan(): string {
  return [
    "# Old Plan Task",
    "",
    "Task Contract: harness-task v1",
    "",
    "## Brief",
    "",
    "Backfill migration fixture.",
    "",
    "## Goal",
    "",
    "Produce a strict-checkable migrated task plan.",
    "",
    "## Context",
    "",
    "This fixture intentionally predates the added required anchors.",
    "",
    "## Implementation Plan",
    "",
    "- Run the migration.",
    "- Verify the task package.",
    "",
    "## Verification",
    "",
    "- Strict target-project check passes.",
    ""
  ].join("\n");
}
