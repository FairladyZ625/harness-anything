// harness-test-tier: integration
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI create-milestone public default scaffolds and checks only the minimum three-artifact contract", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = createMilestoneTask(rootDir);

    assert.equal(created.report.preset, "create-milestone");
    assert.equal(created.generated.includes("task_plan.md"), true);
    assert.equal(created.generated.includes("long-running-task-contract.md"), true);

    const scaffold = scaffoldMilestone(rootDir, created.taskId);

    assert.equal(scaffold.ok, true);
    assert.equal(scaffold.report.status, "passed");
    const overviewPath = path.join(rootDir, "harness/milestones/platform/plt-test/overview.md");
    const indexPath = path.join(rootDir, "harness/milestones/milestones-index.md");
    const summaryPath = path.join(rootDir, "harness/milestones/milestones-summary.md");
    const htmlPath = path.join(rootDir, "harness/milestones/milestones.html");
    assert.equal(existsSync(overviewPath), true);
    assert.match(readFileSync(overviewPath, "utf8"), /<!-- milestone-map:v1 -->/u);
    assert.doesNotMatch(readFileSync(overviewPath, "utf8"), /PR\/merge 运维|npm run pr:doctor/u);
    assert.match(readFileSync(indexPath, "utf8"), new RegExp(created.taskId, "u"));
    assert.match(readFileSync(summaryPath, "utf8"), new RegExp(created.taskId, "u"));
    assert.equal(existsSync(htmlPath), false);

    const checked = checkMilestone(rootDir, created.taskId);
    assert.equal(checked.ok, true);
    assert.equal(checked.report.status, "passed");
    assert.equal(checked.report.summary.milestones, 1);
    assert.equal(checked.report.summary.missing, 0);
    assert.deepEqual(checked.report.contract.requiredArtifacts.map((artifact: { id: string }) => artifact.id), [
      "overview",
      "index",
      "machine-summary"
    ]);

    const rendered = runJson(rootDir, [
      "script", "run", "preset:create-milestone:render-html", "--task", created.taskId
    ]);
    assert.equal(rendered.report.html.path, "harness/milestones/milestones.html");
    assert.equal(existsSync(htmlPath), true);
    assert.equal(checkMilestone(rootDir, created.taskId).report.status, "passed");
    const checkedAll = runJson(rootDir, [
      "script", "run", "preset:create-milestone:check", "--task", created.taskId
    ]);
    assert.equal(checkedAll.report.summary.milestones, 1);
  });
});

test("CLI create-milestone policy selects and enforces this repository's five-artifact contract", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = createMilestoneTask(rootDir);
    createCharterDecision(rootDir);
    writePolicy(rootDir, fiveArtifactPolicy());

    const scaffold = scaffoldMilestone(rootDir, created.taskId, "dec_TEST_CHARTER");

    assert.equal(scaffold.report.status, "passed");
    const overviewPath = path.join(rootDir, "harness/milestones/platform/plt-test/00-overview.md");
    assert.equal(existsSync(overviewPath), true);
    assert.match(readFileSync(overviewPath, "utf8"), /Approval anchor.*dec_TEST_CHARTER/u);
    assert.match(readFileSync(overviewPath, "utf8"), /PR diagnostics.*npm run pr:doctor/u);
    assert.equal(existsSync(path.join(rootDir, "harness/milestones/00-roadmap.md")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/milestones/dossier-data.md")), true);
    const htmlPath = path.join(rootDir, "harness/milestones/milestones-dossier.html");
    assert.equal(existsSync(htmlPath), true);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "task_plan.md")), true);
    assert.deepEqual(scaffold.report.check.contract.requiredArtifacts.map((artifact: { id: string }) => artifact.id), [
      "overview",
      "index",
      "machine-summary",
      "html",
      "task-plan"
    ]);

    unlinkSync(htmlPath);
    const blocked = checkMilestone(rootDir, created.taskId, false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "script_result_failed");
    const checkReport = JSON.parse(readFileSync(
      path.join(rootDir, created.packagePath, "artifacts/create-milestone-check.json"),
      "utf8"
    )) as { missing: Array<{ missing: string }> };
    assert.match(checkReport.missing[0].missing, /html.*milestones-dossier\.html/u);
  });
});

test("CLI create-milestone rejects an unsafe required-artifact policy before running the preset", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const created = createMilestoneTask(rootDir);
    const policy = fiveArtifactPolicy();
    policy.rules.requiredArtifacts[0].path = "../outside.md";
    writePolicy(rootDir, policy);

    const result = checkMilestone(rootDir, created.taskId, false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_policy_invalid");
  });
});

function createMilestoneTask(rootDir: string): Record<string, any> {
  return runJson(rootDir, [
    "task", "create",
    "--title", "Test milestone root",
    "--vertical", "software/coding",
    "--preset", "create-milestone",
    "--long-running"
  ]);
}

function createCharterDecision(rootDir: string): void {
  runJson(rootDir, [
    "decision", "propose",
    "--id", "dec_TEST_CHARTER",
    "--title", "Test Milestone Charter",
    "--question", "Should this milestone exist?",
    "--chosen", "Create the milestone through the preset",
    "--rejected", "Hand-build milestone files",
    "--why-not", "Hand-built milestone files drift"
  ]);
}

function scaffoldMilestone(rootDir: string, taskId: string, charterDecision?: string): Record<string, any> {
  const args = [
    "script", "run", "preset:create-milestone:scaffold",
    "--task", taskId,
    "--input", "line=platform",
    "--input", "slug=plt-test",
    "--input", "milestoneName=PLT-Test",
    "--input", "mission=Prove milestone preset scaffolding.",
    "--input", "firstUser=CLI tests",
    "--input", "switchWhen=Immediately",
    "--input", "retireWhen=Manual scaffolding stops",
    "--input", "dependencies=None",
    "--input", "waves=W0,W1"
  ];
  if (charterDecision) args.push("--input", `charterDecision=${charterDecision}`);
  return runJson(rootDir, args);
}

function checkMilestone(rootDir: string, taskId: string, expectSuccess = true): Record<string, any> {
  return runJson(rootDir, [
    "script", "run", "preset:create-milestone:check",
    "--task", taskId,
    "--input", "line=platform",
    "--input", "slug=plt-test"
  ], expectSuccess);
}

function fiveArtifactPolicy(): Record<string, any> {
  return {
    schema: "preset-policy/create-milestone/v1",
    presetId: "create-milestone",
    rules: {
      requiredArtifacts: [
        { id: "overview", role: "overview", root: "milestones", path: "{{line}}/{{slug}}/00-overview.md" },
        { id: "index", role: "index", root: "milestones", path: "00-roadmap.md" },
        { id: "machine-summary", role: "machine-summary", root: "milestones", path: "dossier-data.md" },
        { id: "html", role: "html", root: "milestones", path: "milestones-dossier.html" },
        { id: "task-plan", role: "supporting", root: "task", path: "task_plan.md" }
      ],
      charterAnchor: { required: true, entityType: "decision", idPattern: "^dec_[A-Za-z0-9_]+$" },
      additionalReferences: [{ kind: "command", ref: "npm run pr:doctor", label: "PR diagnostics" }]
    }
  };
}

function writePolicy(rootDir: string, policy: unknown): void {
  const policyPath = path.join(rootDir, "harness/policies/presets/create-milestone.policy.json");
  mkdirSync(path.dirname(policyPath), { recursive: true });
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
    if (expectSuccess) assert.equal(parsed.ok, true, stdout);
    return parsed;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-milestone-"));
  ensureTestHarnessIdentity(rootDir);
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
