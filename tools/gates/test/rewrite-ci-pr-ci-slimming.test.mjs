// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import { parseManifestGateArgs, selectManifestGateIds } from "../../run-manifest-gates.mjs";

const rootDir = path.resolve(import.meta.dirname, "../../..");
// The crlf-checkout lane materialises this workflow with CRLF line endings; normalise once so
// every contract below matches the same text shape on every checkout.
const workflowText = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8").replace(
  /\r\n/gu,
  "\n",
);
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
  assert.match(
    workflowText,
    /run: node tools\/run-manifest-gates\.mjs --workflow-job quick-gates --github-groups --parallel 4 --exclude typecheck/u,
  );
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

test("quick-gates keeps every gate while typecheck runs alone and the rest share a four-worker pool", () => {
  const start = workflowText.indexOf("  quick-gates:"),
    end = workflowText.indexOf("\n  fast-contract:", start),
    section = workflowText.slice(start, end);
  assert.match(section, /- name: Typecheck before the parallel gate pool\n\s+run: npm run typecheck/u);
  const runner = /run: node tools\/run-manifest-gates\.mjs --workflow-job quick-gates ([^\n]+)/u.exec(section);
  assert.ok(runner, "quick-gates must keep one manifest-runner invocation");
  assert.match(runner[1], /--parallel 4/u);
  assert.match(runner[1], /--exclude typecheck/u);
  assert.ok(
    section.indexOf("npm run typecheck") < section.indexOf("--workflow-job quick-gates"),
    "typecheck must finish before the pool starts",
  );

  const options = parseManifestGateArgs(["--workflow-job", "quick-gates", ...runner[1].trim().split(/\s+/u)]);
  options.eventName = "pull_request";
  const executed = [...selectManifestGateIds(manifest, options), "typecheck"].sort();
  const declared = manifest.gates
    .filter((gate) => gate.executionSurfaces.rewriteCi.pullRequestJobs.includes("quick-gates"))
    .map((gate) => gate.id)
    .sort();
  assert.deepEqual(executed, declared, "the separate typecheck step plus the pool cover the same gate set as before");
});

test("crlf-checkout runs one partition on PR and merge_group, four on main pushes", () => {
  assert.ok(workflowText.includes("fromJSON('[1]')"), "PR and merge_group expand a single partition");
  assert.ok(workflowText.includes("fromJSON('[1, 2, 3, 4]')"), "main pushes keep four partitions");
  const crlfNameLine = workflowText.split("\n").find((line) => line.trimStart().startsWith("name: ${{"));
  assert.ok(crlfNameLine, "crlf-checkout keeps an explicit job name");
  // GitHub expressions treat '' as falsy, so `condition && '' || format(...)` returns the suffix.
  // Run 42808598997 measured exactly that: the PR check run was `crlf-checkout (1)`, not the
  // required `crlf-checkout`. Keep the PR branch a non-empty literal and reject the old shape.
  assert.doesNotMatch(
    crlfNameLine,
    /&&\s*''\s*\|\|/u,
    "an empty-string PR branch is falsy and falls through to the partition suffix",
  );
  assert.match(
    crlfNameLine,
    /&&\s*'crlf-checkout'\s*\|\|\s*format\('crlf-checkout \(\{0\}\)', matrix\.partition\)/u,
    "pull_request and merge_group render exactly crlf-checkout; pushes keep the partition suffix",
  );
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("crlf-checkout"), true);
  assert.equal(
    manifest.surfaces.branchProtection.requiredContexts.some((context) => context.startsWith("crlf-checkout (")),
    false,
  );
  const gate = manifest.gates.find((candidate) => candidate.id === "check-poll-spin-boundary");
  assert.deepEqual(gate.githubContext.requiredContexts, ["crlf-checkout"]);
});

test("CH3 leaves the required PR evidence lanes intact", () => {
  for (const jobId of [
    "fast-contract",
    "crlf-checkout",
    "integration-shard",
    "pglite-node26",
    "quick-gates",
    "gui-build",
    "gate-contract-tests",
    "cost-budget-reads",
  ]) {
    assert.equal(workflow.get(jobId)?.isPullRequestJob, true, `${jobId} must run on pull_request`);
  }
  assert.equal(workflow.has("boundaries"), false, "the boundary gates run inside quick-gates");
  assert.ok(
    manifest.gates
      .find((gate) => gate.id === "cost-budget")
      .executionSurfaces.rewriteCi.pullRequestJobs.includes("cost-budget-reads"),
    "the PGlite G38 matrix remains a PR lane",
  );
  assert.equal(workflow.get("quick-gates")?.isPullRequestJob, true);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("quick-gates"), true);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("boundaries"), false);
  assert.equal(manifest.surfaces.branchProtection.requiredContexts.includes("typecheck (24)"), false);
  const boundaryGates = manifest.gates.filter((gate) => gate.category === "boundary" && gate.tier === "pr-required");
  assert.ok(boundaryGates.length > 0);
  for (const gate of boundaryGates) {
    assert.ok(
      gate.executionSurfaces.rewriteCi.pullRequestJobs.includes("quick-gates"),
      `${gate.id} must stay on the merged required PR lane`,
    );
    assert.deepEqual(gate.githubContext.requiredContexts, ["quick-gates"], `${gate.id} required context`);
  }
});

test("CH2 cuts the integration matrix to ten shards and rebalances from the measured run", () => {
  assert.match(workflowText, /shard: \[1, 2, 3, 4, 5, 6, 7, 8, 9, 10\]/u);
  assert.doesNotMatch(workflowText, /shard: \[[^\]]*11/u);
  const contexts = manifest.surfaces.branchProtection.requiredContexts.filter((context) =>
    context.startsWith("integration-shard ("),
  );
  assert.deepEqual(
    contexts,
    Array.from({ length: 10 }, (_, index) => `integration-shard (${index + 1})`),
  );
});

test("CH1 merges the G38 read matrix into two PGlite sets and one SQLite set", () => {
  const reads = workflow.get("cost-budget-reads");
  const sqlite = workflow.get("cost-budget-reads-sqlite");
  assert.ok(reads && sqlite);
  const pgliteSets = [...workflowText.matchAll(/dimensions: ([^\n]+)/gu)].map((match) => match[1]);
  assert.deepEqual(pgliteSets, [
    "task-history,runtime-sessions,dispatches,task-outputs",
    "relations,relation-visibility,event-bytes,source-events",
  ]);
  assert.match(workflowText, /G38_DIMENSION: \$\{\{ matrix\.dimensions \}\}/u);
  assert.match(
    workflowText,
    /G38_DIMENSION: task-history,runtime-sessions,dispatches,task-outputs,relations,relation-visibility,event-bytes,source-events/u,
  );
  assert.match(workflowText, /name: cost-budget-reads \(pglite, set \$\{\{ matrix\.set \}\}\)/u);
  assert.match(workflowText, /name: g38-read-pglite-set-\$\{\{ matrix\.set \}\}/u);
  assert.equal(sqlite.isPullRequestJob, true);
});
