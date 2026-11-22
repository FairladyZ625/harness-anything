// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { AUTHORIZATION_CI_SHARD_COUNT } from "../authorization-ci-shards.mjs";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";
import { selectGuiSmokeCommand } from "../../gui-e2e/run-smoke.mjs";
import { parseManifestGateArgs, selectManifestGateIds } from "../../run-manifest-gates.mjs";
import { discoverTestTierManifest, parseTestTierMarker } from "../../test-tier-manifest.mjs";

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

test("CH2 keeps package policy green when its expensive step is not selected", () => {
  const install = workflow.get("install");
  const packagePolicy = workflow.get("package-policy");
  assert.ok(install && packagePolicy);
  assert.match(
    workflowText,
    /packagePolicy:\n\s+- 'package\.json'\n\s+- 'package-lock\.json'\n\s+- 'packages\/\*\*\/package\.json'/u,
  );
  assert.match(workflowText, /needs\.install\.outputs\.packagePolicy != 'false'/u);
  assert.equal(packagePolicy.isPullRequestJob, true);
  assert.equal(packagePolicy.isNonPullRequestJob, true, "package policy remains on main and schedule");
  assert.match(
    workflowText,
    /- if: github\.event_name != 'pull_request' \|\| needs\.install\.outputs\.packagePolicy != 'false'\n\s+run: node tools\/run-manifest-gates\.mjs --workflow-job package-policy/u,
  );
  assert.match(
    workflowText,
    /run: node tools\/run-manifest-gates\.mjs --workflow-job quick-gates --github-groups --parallel 4 --exclude typecheck/u,
  );
});

test("Node 26 storage jobs skip only a proven unrelated PR and keep main and nightly coverage", () => {
  const jobs = parse(workflowText).jobs;
  const { costBudgetReads: patterns } = parse(jobs.install.steps.find((step) => step.id === "policy").with.filters);
  const selected = (file) => patterns.some((pattern) => path.posix.matchesGlob(file, pattern));
  for (const file of [
    "packages/storage/src/pglite/storage-backend.ts",
    "packages/daemon/test/pglite-repo-cell.integration.test.ts",
    "packages/kernel/src/domain/task-lifecycle-publication.ts",
    "packages/application/src/commands.ts",
    "packages/preset/src/preset-resolver-common.ts",
    "packages/authorization-keycloak/src/index.ts",
    "packages/cli/src/cli-agent-rollback.ts",
    "packages/cli/test/fixtures/g38-read-rollback.mjs",
    "tools/gates/cost-budget-read-lane.mjs",
    "tools/gate-manifest.json",
    "package-lock.json",
    "packages/gui/package.json",
    "tsconfig.json",
    ".github/workflows/rewrite-ci.yml",
  ])
    assert.ok(selected(file), `${file} must run the storage jobs`);
  for (const file of [
    "packages/gui/src/App.tsx",
    "packages/cli/src/cli-version.ts",
    "packages/dsh-plugin/src/index.ts",
    "tools/check-gate-surface.mjs",
  ])
    assert.equal(selected(file), false, `${file} alone must skip the storage jobs`);
  for (const jobId of ["pglite-node26", "cost-budget-reads", "cost-budget-reads-sqlite"]) {
    const job = jobs[jobId];
    const push =
      jobId === "pglite-node26"
        ? "github.event_name == 'push'"
        : "(github.event_name == 'push' && github.ref == 'refs/heads/main')";
    assert.equal(job.needs, "install", jobId);
    assert.equal(
      job.if,
      `always() && ((github.event_name == 'pull_request' && needs.install.outputs.costBudgetReads != 'false') || ${push} || github.event_name == 'schedule')`,
      jobId,
    );
  }
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

test("the required quick-gates context depends on the pool and every durable authorization shard", () => {
  const jobs = parse(workflowText).jobs;
  const shard = jobs["authorization-shard"],
    summary = jobs["authorization-summary"];
  assert.deepEqual(
    shard.strategy.matrix.shard,
    Array.from({ length: AUTHORIZATION_CI_SHARD_COUNT }, (_, i) => i),
  );
  assert.equal(shard.strategy["fail-fast"], false);
  assert.deepEqual(summary.needs, ["install", "quick-gates", "authorization-shard"]);
  assert.equal(summary.name, "quick-gates");
  assert.notEqual(jobs["quick-gates"].name, summary.name);
  assert.match(summary.if, /^always\(\)/u);
  for (const job of [shard, summary]) {
    for (const event of ["pull_request", "merge_group", "push"]) assert.ok(job.if.includes(`== '${event}'`));
  }
  const producer = shard.steps.find((step) => step.env?.AUTHORIZATION_CI_MODE === "shard");
  const collector = summary.steps.find((step) => step.run?.includes("--workflow-job authorization-summary "));
  assert.ok(producer && collector);
  assert.match(
    collector.env.AUTHORIZATION_CI_MODE,
    /needs\.install\.result == 'success' && needs\.quick-gates\.result == 'success' && needs\.authorization-shard\.result == 'success' && 'collect' \|\| 'blocked'/u,
  );
  assert.equal(producer.env.AUTHORIZATION_CI_DATE, collector.env.AUTHORIZATION_CI_DATE);
  assert.equal(producer.env.AUTHORIZATION_BASE, collector.env.AUTHORIZATION_BASE);
  for (const eventName of ["pull_request", "merge_group", "push"]) {
    const gates = (job) => selectManifestGateIds(manifest, { workflowJob: job, eventName });
    const gateId = "ontology-durable-action-authorization";
    assert.ok(!gates("quick-gates").includes(gateId));
    assert.deepEqual(gates("authorization-shard"), [gateId]);
    assert.deepEqual(gates("authorization-summary"), [gateId]);
  }
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

function assertGateTestsInFastContractOnly({ workflowMap, manifestData, tierManifest, gateTestFiles }) {
  assert.equal(workflowMap.has("gate-contract-tests"), false, "duplicate unsharded gate-contract-tests job is retired");
  assert.equal(
    manifestData.gates.some((gate) => gate.id === "gate-contract-tests"),
    false,
    "gate-manifest must not retain retired gate-contract-tests",
  );
  const fastAndContract = new Set([...tierManifest.fast, ...tierManifest.contract]);
  assert.ok(gateTestFiles.length > 0);
  for (const file of gateTestFiles) {
    assert.equal(
      fastAndContract.has(file),
      true,
      `${file} must belong to fast or contract tier so the fast-contract matrix executes it`,
    );
  }
}

test("CH3 leaves the required PR evidence lanes intact and retires duplicate gate-contract-tests", () => {
  for (const jobId of [
    "fast-contract",
    "crlf-checkout",
    "integration-shard",
    "pglite-node26",
    "quick-gates",
    "gui-build",
    "cost-budget-reads",
  ]) {
    assert.equal(workflow.get(jobId)?.isPullRequestJob, true, `${jobId} must run on pull_request`);
  }
  // dec_307A99A9D25925FE559FE5E140/CH1: gate-contract-tests ran tools/gates/test/*.test.mjs unsharded
  // (~40m) after the 4-way sharded fast-contract lane already ran every file.
  const tierManifest = discoverTestTierManifest(rootDir),
    gateTestFiles = readdirSync(path.join(rootDir, "tools/gates/test"))
      .filter((entry) => entry.endsWith(".test.mjs"))
      .map((entry) => `tools/gates/test/${entry}`)
      .sort();
  assertGateTestsInFastContractOnly({ workflowMap: workflow, manifestData: manifest, tierManifest, gateTestFiles });
  // Positive controls execute the exact guard function above plus parseTestTierMarker: re-adding
  // gate-contract-tests, placing a gate test outside fast|contract, or omitting a tier marker fails.
  assert.throws(
    () =>
      assertGateTestsInFastContractOnly({
        workflowMap: parseGateWorkflow(`${workflowText}\n  gate-contract-tests:\n    runs-on: ubuntu-latest\n`),
        manifestData: manifest,
        tierManifest,
        gateTestFiles,
      }),
    /duplicate unsharded gate-contract-tests job is retired/u,
  );
  assert.throws(
    () =>
      assertGateTestsInFastContractOnly({
        workflowMap: workflow,
        manifestData: manifest,
        tierManifest,
        gateTestFiles: [...gateTestFiles, "tools/gates/test/orphaned-sample.test.mjs"],
      }),
    /orphaned-sample\.test\.mjs must belong to fast or contract tier/u,
  );
  assert.throws(
    () => parseTestTierMarker("import test from 'node:test';\n", "tools/gates/test/orphaned-sample.test.mjs"),
    /test tier marker missing/u,
  );
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
      gate.executionSurfaces.rewriteCi.pullRequestJobs.includes(
        gate.id === "ontology-durable-action-authorization" ? "authorization-summary" : "quick-gates",
      ),
      `${gate.id} must stay on the merged required PR lane`,
    );
    assert.deepEqual(gate.githubContext.requiredContexts, ["quick-gates"], `${gate.id} required context`);
  }
});

function assertGuiBuildRunsSmoke(workflowMap, manifestData) {
  const job = workflowMap.get("gui-build");
  assert.ok(job?.isPullRequestJob, "gui-build must run on pull_request");
  const xvfb = job.blockingRunCommands.indexOf("sudo apt-get update && sudo apt-get install -y xvfb");
  const runner = job.blockingRunCommands.indexOf("node tools/run-manifest-gates.mjs --workflow-job gui-build");
  assert.ok(xvfb >= 0 && runner > xvfb, "gui-build must install Xvfb before running its manifest gates");

  const args = parseManifestGateArgs(["--workflow-job", "gui-build"]);
  const prGates = selectManifestGateIds(manifestData, { ...args, eventName: "pull_request" });
  const build = prGates.indexOf("gui-package-build");
  assert.ok(build >= 0 && prGates.indexOf("gui-e2e-smoke") > build, "gui-build must select smoke after packaging");
  assert.equal(manifestData.gates.find(({ id }) => id === "gui-e2e-smoke").command, "npm run test:gui:smoke");
}

test("gui-build runs test:gui:smoke under Xvfb on headless Linux", () => {
  assertGuiBuildRunsSmoke(workflow, manifest);
  const { scripts } = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.equal(scripts["test:gui:smoke"], "node tools/gui-e2e/run-smoke.mjs");
  const command = selectGuiSmokeCommand({ platform: "linux", hasXvfbRun: true });
  assert.equal(command.command, "xvfb-run");
  assert.deepEqual(command.args, ["--auto-servernum", process.execPath, "tools/gui-e2e.mjs", "--smoke", "--no-build"]);

  assert.throws(
    () =>
      assertGuiBuildRunsSmoke(workflow, {
        ...manifest,
        gates: manifest.gates.filter(({ id }) => id !== "gui-e2e-smoke"),
      }),
    /gui-build must select smoke after packaging/u,
  );
  assert.throws(() => {
    const withoutXvfb = workflowText.replace(/(^  gui-build:\n[\s\S]*?apt-get install -y )xvfb\b/mu, "$1xauth");
    assertGuiBuildRunsSmoke(parseGateWorkflow(withoutXvfb), manifest);
  }, /gui-build must install Xvfb/u);
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
    "source-events,dispatches,runtime-sessions,task-history,relation-visibility",
    "task-outputs,relations,event-bytes",
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

test("integration-shard records duration logs and uploads them on main push or workflow_dispatch", () => {
  const shardStart = workflowText.indexOf("  integration-shard:");
  const shardEnd = workflowText.indexOf("\n  pglite-node26:", shardStart);
  const shardBlock = workflowText.slice(shardStart, shardEnd);
  assert.match(
    shardBlock,
    /HARNESS_INTEGRATION_DURATION_LOG: \$\{\{ runner\.temp \}\}\/integration-durations-shard-\$\{\{ matrix\.shard \}\}\.log/u,
  );
  assert.match(shardBlock, /name: integration-durations-shard-\$\{\{ matrix\.shard \}\}/u);
  assert.match(
    shardBlock,
    /if: always\(\) && \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \|\| github\.event_name == 'workflow_dispatch'\) && needs\.install\.outputs\.code != 'false'/u,
  );
});
