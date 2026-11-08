// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const workflowText = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8");
const workflow = parseGateWorkflow(workflowText);
const manifest = JSON.parse(readFileSync(path.join(rootDir, "tools/gate-manifest.json"), "utf8"));

test("CH1 keeps clean-build and Windows-only smoke off pull_request", () => {
  for (const jobId of ["clean-build", "platform-smoke-windows", "windows-first-run-windows"]) {
    const job = workflow.get(jobId);
    assert.ok(job, `${jobId} must remain observable on main or nightly`);
    assert.equal(job.isPullRequestJob, false, `${jobId} must not run on pull_request`);
    assert.equal(job.isNonPullRequestJob, true, `${jobId} must run on a non-PR event`);
    const condition = job.ifExpressions[0];
    assert.match(condition, /github\.event_name == 'push'/u);
    assert.match(condition, /github\.ref == 'refs\/heads\/main'/u);
    assert.match(condition, /github\.event_name == 'schedule'/u);
  }
  const cleanBuild = workflow.get("clean-build"),
    cleanBuildStart = workflowText.indexOf("  clean-build:"),
    cleanBuildEnd = workflowText.indexOf("\n  cost-budget-reads:", cleanBuildStart),
    cleanBuildBlock = workflowText.slice(cleanBuildStart, cleanBuildEnd);
  assert.ok(cleanBuild);
  assert.equal(cleanBuild.isPullRequestJob, false);
  assert.match(cleanBuildBlock, /node-modules-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/u);
  assert.match(cleanBuildBlock, /run: npm ci\n\s+if: github\.event_name == 'schedule'/u);
  const pullRequestJobs = Object.fromEntries(
    manifest.gates
      .filter((gate) => ["clean-build", "platform-smoke"].includes(gate.id))
      .map((gate) => [gate.id, gate.executionSurfaces.rewriteCi.pullRequestJobs]),
  );
  assert.deepEqual(pullRequestJobs, { "platform-smoke": ["quick-gates"], "clean-build": [] });
});

test("CH2 keeps required path gates green when their expensive step is not selected", () => {
  const install = workflow.get("install");
  const packagePolicy = workflow.get("package-policy");
  const sqlite = workflow.get("cost-budget-reads-sqlite");
  assert.ok(install && packagePolicy && sqlite);
  assert.match(
    workflowText,
    /packagePolicy:\n\s+- 'package\.json'\n\s+- 'package-lock\.json'\n\s+- 'packages\/\*\*\/package\.json'/u,
  );
  assert.match(workflowText, /costBudgetReads:\n\s+- 'packages\/storage\/\*\*'\n\s+- 'packages\/daemon\/src\/\*\*'/u);
  assert.match(workflowText, /needs\.install\.outputs\.packagePolicy != 'false'/u);
  assert.match(workflowText, /needs\.install\.outputs\.costBudgetReads != 'false'/u);
  assert.equal(packagePolicy.isPullRequestJob, true);
  assert.equal(packagePolicy.isNonPullRequestJob, true, "package policy remains on main and schedule");
  assert.match(
    workflowText,
    /- if: github\.event_name != 'pull_request' \|\| needs\.install\.outputs\.packagePolicy != 'false'\n\s+run: node tools\/run-manifest-gates\.mjs --workflow-job package-policy/u,
  );
  assert.match(workflowText, /github\.event_name == 'schedule'/u);
  assert.equal(sqlite.isPullRequestJob, true, "SQLite remains a conditional PR observer job");
  assert.match(sqlite.ifExpressions[0], /needs\.install\.outputs\.costBudgetReads != 'false'/u);
  assert.match(sqlite.ifExpressions[0], /github\.event_name == 'schedule'/u);
  assert.match(
    workflowText,
    /G38_REQUIRED_BACKENDS: \$\{\{ github\.event_name == 'pull_request' && needs\.install\.outputs\.costBudgetReads == 'false' && 'pglite' \|\| 'pglite,sqlite' \}\}/u,
  );
  assert.match(workflowText, /run: node tools\/run-manifest-gates\.mjs --workflow-job quick-gates --github-groups/u);
});

test("CH4 assigns all twelve light gates to the serial quick-gates runner", () => {
  const gateIds = [
    "typecheck",
    "lint",
    "check-supply-chain",
    "dependency-policy",
    "test-selection",
    "schema-closure",
    "entity-id-links",
    "derived-contracts",
    "canonical-event-compat",
    "cost-budget",
    "platform-smoke",
    "windows-first-run",
  ];
  for (const id of gateIds) {
    const gate = manifest.gates.find((candidate) => candidate.id === id);
    assert.ok(gate, `${id} remains a registered check`);
    assert.ok(gate.executionSurfaces.rewriteCi.pullRequestJobs.includes("quick-gates"), `${id} uses quick-gates`);
  }
  for (const retiredJob of ["typecheck", "lint", "supply-chain", "dependency-policy", "test-selection"]) {
    assert.equal(workflow.has(retiredJob), false, `${retiredJob} no longer creates a standalone PR job`);
  }
});

test("CH3 leaves the required PR evidence lanes intact", () => {
  for (const jobId of [
    "fast-contract",
    "crlf-checkout",
    "integration-shard",
    "pglite-node26",
    "boundaries",
    "gui-build",
    "gate-contract-tests",
    "cost-budget-reads",
  ]) {
    assert.equal(workflow.get(jobId)?.isPullRequestJob, true, `${jobId} must run on pull_request`);
  }
  assert.ok(
    manifest.gates
      .find((gate) => gate.id === "cost-budget")
      .executionSurfaces.rewriteCi.pullRequestJobs.includes("cost-budget-reads"),
    "the PGlite G38 matrix remains a PR lane",
  );
  assert.equal(workflow.get("quick-gates")?.isPullRequestJob, true);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("quick-gates"), true);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("typecheck (24)"), false);
});
