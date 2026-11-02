// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseGateWorkflow } from "../../gate-workflow-parser.mjs";

// dec_09C1CE4481EEF4096867FA034E: moving the database arm to Node 26 must keep it PR-visible.
const workflow = parseGateWorkflow(
  readFileSync(new URL("../../../.github/workflows/rewrite-ci.yml", import.meta.url), "utf8"),
);
const manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8"));

test("PGlite database assertions run on Node 26 for PRs and pushes without changing Node 24 shards", () => {
  const lane = workflow.get("pglite-node26");
  assert.ok(lane?.isPullRequestJob);
  assert.ok(lane.isNonPullRequestJob);
  assert.deepEqual(lane.nodeVersions, [26]);
  assert.ok(lane.blockingRunCommands.includes("node tools/run-manifest-gates.mjs --workflow-job pglite-node26"));
  assert.ok(lane.runCommands.includes("npm ci"), "Node 26 builds its own native dependencies");
  assert.deepEqual(workflow.get("integration-shard").nodeVersions, [24]);
  const gate = manifest.gates.find(({ id }) => id === "test-pglite-node26");
  assert.equal(gate.command, "node tools/run-node-tests.mjs --prefix packages/storage/test/pglite --concurrency 2");
  assert.deepEqual(gate.executionSurfaces.rewriteCi.pullRequestJobs, ["pglite-node26"]);
  assert.deepEqual(gate.executionSurfaces.rewriteCi.nonPullRequestJobs, ["pglite-node26"]);
});
