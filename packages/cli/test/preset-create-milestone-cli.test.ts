import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI create-milestone preset wins over --long-running and scaffolds milestone files", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    runJson(rootDir, [
      "decision",
      "propose",
      "--id",
      "dec_TEST_CHARTER",
      "--title",
      "Test Milestone Charter",
      "--question",
      "Should this milestone exist?",
      "--chosen",
      "Create the milestone through the preset",
      "--rejected",
      "Hand-build milestone files",
      "--why-not",
      "Hand-built milestone files drift"
    ]);

    const created = runJson(rootDir, [
      "task",
      "create",
      "--title",
      "Test milestone root",
      "--vertical",
      "software/coding",
      "--preset",
      "create-milestone",
      "--long-running"
    ]);

    assert.equal(created.report.preset, "create-milestone");
    assert.equal(created.generated.includes("task_plan.md"), true);
    assert.equal(created.generated.includes("long-running-task-contract.md"), true);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "task_plan.md"), "utf8"), /## Wave Decomposition/u);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "long-running-task-contract.md"), "utf8"), /## Goal Boundary/u);

    const scaffold = runJson(rootDir, [
      "script",
      "run",
      "preset:create-milestone:scaffold",
      "--task",
      created.taskId,
      "--input",
      "line=platform",
      "--input",
      "slug=plt-test",
      "--input",
      "charterDecision=dec_TEST_CHARTER",
      "--input",
      "milestoneName=PLT-Test",
      "--input",
      "mission=Prove milestone preset scaffolding.",
      "--input",
      "firstUser=CLI tests",
      "--input",
      "switchWhen=Immediately",
      "--input",
      "retireWhen=Manual scaffolding stops",
      "--input",
      "dependencies=dec_TEST_CHARTER"
    ]);

    assert.equal(scaffold.ok, true);
    assert.equal(scaffold.report.status, "passed");
    assert.equal(existsSync(path.join(rootDir, "harness/milestones/platform/plt-test/00-overview.md")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/milestones/platform/plt-test/00-overview.md"), "utf8"), /<!-- milestone-map:v1 -->/u);
    assert.match(readFileSync(path.join(rootDir, "harness/milestones/00-roadmap.md"), "utf8"), new RegExp(created.taskId, "u"));
    assert.match(readFileSync(path.join(rootDir, "harness/milestones/dossier-data.md"), "utf8"), new RegExp(created.taskId, "u"));

    const checked = runJson(rootDir, [
      "script",
      "run",
      "preset:create-milestone:check",
      "--task",
      created.taskId,
      "--input",
      "line=platform",
      "--input",
      "slug=plt-test",
      "--input",
      "requireDecisionAnchor=true"
    ]);

    assert.equal(checked.ok, true);
    assert.equal(checked.report.status, "passed");
    assert.equal(checked.report.summary.milestones, 1);
    assert.equal(checked.report.summary.missing, 0);
  });
});

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
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-milestone-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
